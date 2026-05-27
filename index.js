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

// DoH 配置（仅系统 DNS 失败时使用）
const DOH_SERVERS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
  'https://dns.quad9.net/dns-query',
  'https://dns.alidns.com/dns-query'
];

// 无效 IP 黑名单（不缓存这些）
const INVALID_IPS = new Set(['0.0.0.0', '127.0.0.1', '::']);

function isValidIP(ip) {
  return ip && net.isIP(ip) !== 0 && !INVALID_IPS.has(ip);
}

// DNS 缓存
const dnsCache = new Map();
const DNS_CACHE_TTL = 300000; // 5分钟

// 主解析函数：优先系统 DNS，失败才用 DoH
async function resolveHostname(hostname) {
  // 如果已经是 IP 地址，直接返回
  if (net.isIP(hostname)) {
    return hostname;
  }

  // 检查缓存
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    console.log(`[DNS Cache Hit] ${hostname} -> ${cached.ip}`);
    return cached.ip;
  }

  // 第一步：尝试系统 DNS
  try {
    const addresses = await dns.resolve4(hostname);
    if (addresses && addresses.length > 0) {
      const ip = addresses[0];
      if (isValidIP(ip)) {
        dnsCache.set(hostname, { ip, timestamp: Date.now() });
        console.log(`[System DNS] ${hostname} -> ${ip}`);
        return ip;
      }
    }
  } catch (err) {
    console.warn(`[System DNS Failed] ${hostname}: ${err.message}, 尝试 DoH...`);
  }

  // 第二步：系统 DNS 失败，回退到 DoH
  console.log(`[DoH Fallback] 开始为 ${hostname} 查询 DoH...`);
  for (const dohServer of DOH_SERVERS) {
    try {
      const ip = await queryDoH(dohServer, hostname);
      if (isValidIP(ip)) {
        dnsCache.set(hostname, { ip, timestamp: Date.now() });
        console.log(`[DoH Success] ${hostname} -> ${ip} (via ${dohServer})`);
        return ip;
      }
    } catch (err) {
      console.error(`[DoH Failed] ${dohServer}: ${err.message}`);
    }
  }

  throw new Error(`无法解析域名: ${hostname}`);
}

// 查询 DoH 服务器
function queryDoH(dohServer, hostname) {
  return new Promise((resolve, reject) => {
    const url = `${dohServer}?name=${hostname}&type=A`;

    https.get(url, {
      headers: {
        'Accept': 'application/dns-json'
      },
      timeout: 2000  // 2秒快速失败
    }, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          // 防止返回 HTML 错误页导致 JSON 解析崩溃
          const trimmed = data.trimStart();
          if (!trimmed.startsWith('{')) {
            reject(new Error('非 JSON 响应（可能是错误页面）'));
            return;
          }

          const json = JSON.parse(trimmed);

          // 查找 A 记录
          if (json.Answer && json.Answer.length > 0) {
            for (const answer of json.Answer) {
              if (answer.type === 1) { // A 记录
                resolve(answer.data);
                return;
              }
            }
          }

          reject(new Error('未找到 A 记录'));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject).on('timeout', () => {
      reject(new Error('DoH 查询超时'));
    });
  });
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello-world');
  } else if (req.url === '/stats') {
    // DNS 缓存统计
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      cacheSize: dnsCache.size,
      cacheEntries: Array.from(dnsCache.entries()).map(([host, val]) => ({
        host,
        ip: val.ip,
        ageSeconds: Math.floor((Date.now() - val.timestamp) / 1000)
      })),
      dohServers: DOH_SERVERS
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
        } catch (err) {
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
        port: parseInt(addr.substring(end + 2), 10)
      };
    }
    const sep = addr.lastIndexOf(':');
    return {
      host: addr.substring(0, sep),
      port: parseInt(addr.substring(sep + 1), 10)
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

        // 使用统一解析函数（系统 DNS 优先，DoH 兜底）
        let resolvedHost = targetHost;
        try {
          resolvedHost = await resolveHostname(targetHost);
          console.log(`[Connect] ${targetHost} -> ${resolvedHost}:${port}`);
        } catch (err) {
          console.error(`[DNS Error] 无法解析 ${targetHost}: ${err.message}`);
          // 解析失败时仍尝试直接连接（让系统决定）
        }

        remoteSocket = net.connect({
          host: resolvedHost,
          port: port,
          timeout: 10000
        });

        await new Promise((resolve, reject) => {
          remoteSocket.once('connect', resolve);
          remoteSocket.once('error', reject);
        });

        // 发送首帧数据
        if (firstFrameData) {
          remoteSocket.write(firstFrameData);
        }

        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket(remoteSocket);
        return;

      } catch (err) {
        // 清理失败的连接
        if (remoteSocket) {
          try { remoteSocket.destroy(); } catch {}
          remoteSocket = null;
        }

        // 如果不是连接错误或已是最后尝试，抛出错误
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
          remoteSocket.write(message.substring(5));
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
  console.log(`DNS strategy: System DNS first, DoH fallback`);
  console.log(`DoH Servers: ${DOH_SERVERS.join(', ')}`);
  console.log(`DNS Cache TTL: ${DNS_CACHE_TTL / 1000}s`);
});
