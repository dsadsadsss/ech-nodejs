const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const dns = require('dns').promises;

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || '123';
const CF_FALLBACK_IPS = process.env.PRIP
  ? process.env.PRIP.split(',')
  : ['ProxyIP.JP.CMLiussss.net'];

// DNS 缓存
const dnsCache = new Map();
const DNS_CACHE_TTL = 300000; // 5分钟

// DNS 解析（系统 DNS + 缓存）
async function resolveDNS(hostname) {
  if (net.isIP(hostname)) return hostname;

  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    console.log(`[DNS Cache Hit] ${hostname} -> ${cached.ip}`);
    return cached.ip;
  }

  console.log(`[DNS Query] Resolving ${hostname}...`);
  try {
    const addresses = await dns.resolve4(hostname);
    const ip = addresses[0];
    dnsCache.set(hostname, { ip, timestamp: Date.now() });
    console.log(`[DNS Success] ${hostname} -> ${ip}`);
    return ip;
  } catch (err) {
    console.error(`[DNS Failed] ${hostname}: ${err.message}`);
    throw new Error(`Failed to resolve ${hostname}`);
  }
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
      cacheEntries: Array.from(dnsCache.entries()).map(([k, v]) => ({
        hostname: k,
        ip: v.ip,
        expiresIn: Math.round((v.timestamp + DNS_CACHE_TTL - Date.now()) / 1000) + 's',
      })),
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
            resolvedHost = await resolveDNS(targetHost);
            console.log(`[Connect] ${targetHost} -> ${resolvedHost}:${port}`);
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
  console.log(`DNS Cache TTL: ${DNS_CACHE_TTL / 1000}s`);
});
