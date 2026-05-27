const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || '123';
const CF_FALLBACK_IPS = process.env.PRIP 
  ? process.env.PRIP.split(',') 
  : ['ProxyIP.JP.CMLiussss.net'];

// DoH 配置 —— 直接用 IP，避免鸡生蛋问题
const DOH_SERVERS = [
  { url: 'https://1.1.1.1/dns-query',   host: 'cloudflare-dns.com' },
  { url: 'https://8.8.8.8/dns-query',   host: 'dns.google'         },
  { url: 'https://223.5.5.5/dns-query', host: 'dns.alidns.com'     },
];

// DNS 缓存
const dnsCache = new Map();
const DNS_CACHE_TTL = 300000; // 5分钟

// DoH 解析函数
async function resolveDoH(hostname) {
  // 检查缓存
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    console.log(`[DoH Cache Hit] ${hostname} -> ${cached.ip}`);
    return cached.ip;
  }

  // 如果是 IP 地址，直接返回
  if (net.isIP(hostname)) {
    return hostname;
  }

  console.log(`[DoH Query] Resolving ${hostname}...`);

  // 尝试多个 DoH 服务器
  for (const dohServer of DOH_SERVERS) {
    try {
      const ip = await queryDoH(dohServer, hostname);
      if (ip) {
        dnsCache.set(hostname, { ip, timestamp: Date.now() });
        console.log(`[DoH Success] ${hostname} -> ${ip} (via ${dohServer.url})`);
        return ip;
      }
    } catch (err) {
      console.error(`[DoH Failed] ${dohServer.url}: ${err.message}`);
    }
  }

  // 如果所有 DoH 都失败，回退到系统 DNS
  console.log(`[DoH Fallback] Using system DNS for ${hostname}`);
  try {
    const addresses = await dns.resolve4(hostname);
    if (addresses && addresses.length > 0) {
      const ip = addresses[0];
      dnsCache.set(hostname, { ip, timestamp: Date.now() });
      return ip;
    }
  } catch (err) {
    console.error(`[System DNS Failed] ${hostname}: ${err.message}`);
  }

  throw new Error(`Failed to resolve ${hostname}`);
}

// 查询 DoH 服务器（用 IP 直连，附带 Host header 解决虚拟主机/SNI）
function queryDoH({ url, host }, hostname) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(`${url}?name=${encodeURIComponent(hostname)}&type=A`);

    const options = {
      hostname: parsedUrl.hostname, // 直接是 IP
      path: parsedUrl.pathname + parsedUrl.search,
      headers: {
        'Accept': 'application/dns-json',
        'Host': host,
      },
      timeout: 5000,
      rejectUnauthorized: false, // IP 直连时证书 hostname 不匹配，需关闭校验
    };

    https.get(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (json.Answer && json.Answer.length > 0) {
            for (const answer of json.Answer) {
              if (answer.type === 1) { // A 记录
                resolve(answer.data);
                return;
              }
            }
          }

          reject(new Error('No A record found'));
        } catch (err) {
          reject(new Error(`JSON parse error (got: ${data.substring(0, 80)})`));
        }
      });
    }).on('error', reject).on('timeout', () => {
      reject(new Error('DoH query timeout'));
    });
  });
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello-world');
  } else if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cacheSize: dnsCache.size,
      dohServers: DOH_SERVERS.map(s => s.url),
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({
  server,
  verifyClient: (info) => {
    const protocol = info.req.headers['sec-websocket-protocol'];
    if (TOKEN && protocol !== TOKEN) {
      return false;
    }
    return true;
  }
});

wss.on('connection', (ws, req) => {
  if (TOKEN && req.headers['sec-websocket-protocol']) {
    ws.protocol = TOKEN;
  }

  handleSession(ws).catch(() => safeCloseWebSocket(ws));
});

async function handleSession(webSocket) {
  let remoteSocket = null;
  let isClosed = false;

  const cleanup = () => {
    if (isClosed) return;
    isClosed = true;

    if (remoteSocket) {
      try { remoteSocket.destroy(); } catch {}
      remoteSocket = null;
    }

    safeCloseWebSocket(webSocket);
  };

  const pumpRemoteToWebSocket = (socket) => {
    socket.on('data', (data) => {
      if (!isClosed && webSocket.readyState === WebSocket.OPEN) {
        try {
          webSocket.send(data);
        } catch {
          cleanup();
        }
      }
    });

    socket.on('end', () => {
      if (!isClosed) {
        try { webSocket.send('CLOSE'); } catch {}
        cleanup();
      }
    });

    socket.on('error', () => {
      cleanup();
    });
  };

  const parseAddress = (addr) => {
    if (addr[0] === '[') {
      const end = addr.indexOf(']');
      return {
        host: addr.substring(1, end),
        port: parseInt(addr.substring(end + 2), 10),
      };
    }
    const sep = addr.lastIndexOf(':');
    return {
      host: addr.substring(0, sep),
      port: parseInt(addr.substring(sep + 1), 10),
    };
  };

  const isCFError = (err) => {
    const msg = err?.message?.toLowerCase() || '';
    return msg.includes('proxy request') ||
           msg.includes('cannot connect') ||
           msg.includes('econnrefused') ||
           msg.includes('etimedout');
  };

  const connectToRemote = async (targetAddr, firstFrameData) => {
    const { host, port } = parseAddress(targetAddr);
    const attempts = [null, ...CF_FALLBACK_IPS];

    for (let i = 0; i < attempts.length; i++) {
      try {
        const targetHost = attempts[i] || host;

        let resolvedHost = targetHost;
        if (!net.isIP(targetHost)) {
          try {
            resolvedHost = await resolveDoH(targetHost);
            console.log(`[Connect] ${targetHost} resolved to ${resolvedHost}`);
          } catch (err) {
            console.error(`[DNS Error] Failed to resolve ${targetHost}: ${err.message}`);
          }
        }

        remoteSocket = net.connect({
          host: resolvedHost,
          port: port,
          timeout: 10000,
        });

        await new Promise((resolve, reject) => {
          remoteSocket.once('connect', resolve);
          remoteSocket.once('error', reject);
        });

        if (firstFrameData) {
          remoteSocket.write(Buffer.isBuffer(firstFrameData)
            ? firstFrameData
            : Buffer.from(firstFrameData));
        }

        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket(remoteSocket);
        return;

      } catch (err) {
        if (remoteSocket) {
          try { remoteSocket.destroy(); } catch {}
          remoteSocket = null;
        }

        if (!isCFError(err) || i === attempts.length - 1) {
          throw err;
        }
      }
    }
  };

  webSocket.on('message', async (data) => {
    if (isClosed) return;

    try {
      const message = data.toString();

      if (message.startsWith('CONNECT:')) {
        const sep = message.indexOf('|', 8);
        await connectToRemote(
          message.substring(8, sep),
          message.substring(sep + 1)
        );
      } else if (message.startsWith('DATA:')) {
        if (remoteSocket && !remoteSocket.destroyed) {
          // 修复：写入 Buffer 而非字符串，避免编码问题
          remoteSocket.write(Buffer.from(message.substring(5)));
        }
      } else if (message === 'CLOSE') {
        cleanup();
      } else if (data instanceof Buffer && remoteSocket && !remoteSocket.destroyed) {
        remoteSocket.write(data);
      }
    } catch (err) {
      try { webSocket.send('ERROR:' + err.message); } catch {}
      cleanup();
    }
  });

  webSocket.on('close', cleanup);
  webSocket.on('error', cleanup);
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web listening on port ${PORT}`);
  console.log(`Token authentication: ${TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`DoH Servers: ${DOH_SERVERS.map(s => s.url).join(', ')}`);
  console.log(`DNS Cache TTL: ${DNS_CACHE_TTL / 1000}s`);
});
