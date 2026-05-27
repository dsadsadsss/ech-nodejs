const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const tls = require('tls');
const dns = require('dns').promises;

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.TOKEN || '123';
const CF_FALLBACK_IPS = process.env.PRIP
  ? process.env.PRIP.split(',')
  : ['ProxyIP.JP.CMLiussss.net'];

// DoT 服务器配置（DNS over TLS，853端口，非443）
const DOT_SERVERS = [
  { host: '1.1.1.1',     port: 853, name: 'Cloudflare'  },
  { host: '8.8.8.8',     port: 853, name: 'Google'      },
  { host: '9.9.9.9',     port: 853, name: 'Quad9'       },
  { host: '223.5.5.5',   port: 853, name: 'Alidns'      },
];

// 无效 IP 黑名单
const INVALID_IPS = new Set(['0.0.0.0', '127.0.0.1', '::']);
function isValidIP(ip) {
  return ip && net.isIP(ip) !== 0 && !INVALID_IPS.has(ip);
}

// DNS 缓存
const dnsCache    = new Map();
const dnsFailCache = new Map();
const dnsInflight = new Map();
const DNS_CACHE_TTL = 300000; // 5分钟
const DNS_FAIL_TTL  =  30000; // 失败冷却30秒

// ─── DoT 查询核心 ───────────────────────────────────────────────────────────
// DNS wire format 构造：查询 A 记录
function buildDnsQuery(hostname) {
  const labels = hostname.split('.');
  // 计算 QNAME 长度
  let qnameLen = 1; // 末尾 0x00
  for (const label of labels) qnameLen += 1 + label.length;

  const buf = Buffer.alloc(12 + qnameLen + 4);
  let offset = 0;

  // Header
  const txid = Math.floor(Math.random() * 0xFFFF);
  buf.writeUInt16BE(txid,  offset); offset += 2; // Transaction ID
  buf.writeUInt16BE(0x0100, offset); offset += 2; // Flags: standard query, recursion desired
  buf.writeUInt16BE(1,      offset); offset += 2; // QDCOUNT = 1
  buf.writeUInt16BE(0,      offset); offset += 2; // ANCOUNT = 0
  buf.writeUInt16BE(0,      offset); offset += 2; // NSCOUNT = 0
  buf.writeUInt16BE(0,      offset); offset += 2; // ARCOUNT = 0

  // QNAME
  for (const label of labels) {
    buf.writeUInt8(label.length, offset++);
    buf.write(label, offset, 'ascii');
    offset += label.length;
  }
  buf.writeUInt8(0, offset++); // 终止符

  // QTYPE=A(1), QCLASS=IN(1)
  buf.writeUInt16BE(1, offset); offset += 2;
  buf.writeUInt16BE(1, offset); offset += 2;

  return { buf, txid };
}

// 解析 DNS 响应，提取第一条 A 记录 IP
function parseDnsResponse(response) {
  if (response.length < 12) throw new Error('响应太短');

  const ancount = response.readUInt16BE(6);
  if (ancount === 0) throw new Error('无 Answer 记录');

  // 跳过 Header(12) + Question section
  let offset = 12;

  // 跳过 Question
  while (offset < response.length) {
    const len = response.readUInt8(offset++);
    if (len === 0) break;
    if ((len & 0xC0) === 0xC0) { offset++; break; } // 压缩指针
    offset += len;
  }
  offset += 4; // QTYPE + QCLASS

  // 遍历 Answer
  for (let i = 0; i < ancount; i++) {
    if (offset >= response.length) break;

    // 跳过 NAME（可能是压缩指针）
    const firstByte = response.readUInt8(offset);
    if ((firstByte & 0xC0) === 0xC0) {
      offset += 2; // 压缩指针
    } else {
      while (offset < response.length) {
        const len = response.readUInt8(offset++);
        if (len === 0) break;
        offset += len;
      }
    }

    if (offset + 10 > response.length) break;
    const type     = response.readUInt16BE(offset);     offset += 2;
    /* class */                                          offset += 2;
    /* ttl   */                                          offset += 4;
    const rdlength = response.readUInt16BE(offset);     offset += 2;

    if (type === 1 && rdlength === 4) {
      // A 记录
      const ip = `${response[offset]}.${response[offset+1]}.${response[offset+2]}.${response[offset+3]}`;
      return ip;
    }
    offset += rdlength;
  }

  throw new Error('未找到 A 记录');
}

// 通过 DoT 查询单台服务器
function queryDoT(server, hostname, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const { buf: query, txid } = buildDnsQuery(hostname);

    // DoT: 在 TLS 连接上发送 2字节长度前缀 + DNS消息
    const socket = tls.connect({
      host: server.host,
      port: server.port,
      servername: server.host, // SNI（可选但推荐）
      rejectUnauthorized: false, // 部分平台证书可能有问题，先关闭验证
    });

    let timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`DoT 查询超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    socket.once('secureConnect', () => {
      // 发送：2字节长度 + DNS 查询
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([lenBuf, query]));
    });

    let recvBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      recvBuf = Buffer.concat([recvBuf, chunk]);

      // DoT 响应格式：2字节长度 + DNS响应
      if (recvBuf.length < 2) return;
      const msgLen = recvBuf.readUInt16BE(0);
      if (recvBuf.length < 2 + msgLen) return;

      clearTimeout(timer);
      socket.destroy();

      try {
        const response = recvBuf.slice(2, 2 + msgLen);
        const ip = parseDnsResponse(response);
        resolve(ip);
      } catch (err) {
        reject(err);
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('close', () => {
      clearTimeout(timer);
      // 如果还没 resolve/reject，说明连接关闭但没收到数据
      reject(new Error('连接关闭但未收到响应'));
    });
  });
}

// ─── 主解析函数 ──────────────────────────────────────────────────────────────
async function resolveHostname(hostname) {
  if (net.isIP(hostname)) return hostname;

  // 正向缓存
  const cached = dnsCache.get(hostname);
  if (cached && Date.now() - cached.timestamp < DNS_CACHE_TTL) {
    console.log(`[DNS Cache] ${hostname} -> ${cached.ip}`);
    return cached.ip;
  }

  // 失败缓存（冷却中）
  const failed = dnsFailCache.get(hostname);
  if (failed && Date.now() - failed.timestamp < DNS_FAIL_TTL) {
    const remaining = Math.ceil((DNS_FAIL_TTL - (Date.now() - failed.timestamp)) / 1000);
    throw new Error(`[DNS 冷却] ${hostname} (剩余 ${remaining}s)`);
  }

  // 并发合并
  if (dnsInflight.has(hostname)) {
    return dnsInflight.get(hostname);
  }

  const promise = _doResolve(hostname).finally(() => dnsInflight.delete(hostname));
  dnsInflight.set(hostname, promise);
  return promise;
}

async function _doResolve(hostname) {
  // 第一步：系统 DNS（最快，优先）
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
    console.warn(`[System DNS Failed] ${hostname}: ${err.message}`);
  }

  // 第二步：DoT 兜底（853端口，非443）
  console.log(`[DoT Fallback] 开始为 ${hostname} 查询 DoT (853端口)...`);
  for (const server of DOT_SERVERS) {
    try {
      const ip = await queryDoT(server, hostname);
      if (isValidIP(ip)) {
        dnsCache.set(hostname, { ip, timestamp: Date.now() });
        console.log(`[DoT Success] ${hostname} -> ${ip} (via ${server.name} ${server.host}:${server.port})`);
        return ip;
      }
    } catch (err) {
      console.error(`[DoT Failed] ${server.name} (${server.host}:${server.port}): ${err.message}`);
    }
  }

  // 全部失败，写入失败缓存
  dnsFailCache.set(hostname, { timestamp: Date.now() });
  throw new Error(`无法解析域名: ${hostname}`);
}

// ─── HTTP 服务器 ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Hello-world');
  } else if (req.url === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      dnsCache: {
        size: dnsCache.size,
        entries: Array.from(dnsCache.entries()).map(([host, val]) => ({
          host, ip: val.ip,
          ageSeconds: Math.floor((Date.now() - val.timestamp) / 1000)
        }))
      },
      dnsFailCache: {
        size: dnsFailCache.size,
        entries: Array.from(dnsFailCache.entries()).map(([host, val]) => ({
          host,
          cooldownSeconds: Math.ceil((DNS_FAIL_TTL - (Date.now() - val.timestamp)) / 1000)
        }))
      },
      dnsInflight: Array.from(dnsInflight.keys()),
      dotServers: DOT_SERVERS.map(s => `${s.name} ${s.host}:${s.port}`)
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ─── WebSocket 服务器 ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({
  server,
  verifyClient: (info) => {
    const protocol = info.req.headers['sec-websocket-protocol'];
    if (TOKEN && protocol !== TOKEN) return false;
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
        try { webSocket.send(data); } catch { cleanup(); }
      }
    });
    socket.on('end', () => {
      if (!isClosed) {
        try { webSocket.send('CLOSE'); } catch {}
        cleanup();
      }
    });
    socket.on('error', cleanup);
  };

  const parseAddress = (addr) => {
    if (addr[0] === '[') {
      const end = addr.indexOf(']');
      return { host: addr.substring(1, end), port: parseInt(addr.substring(end + 2), 10) };
    }
    const sep = addr.lastIndexOf(':');
    return { host: addr.substring(0, sep), port: parseInt(addr.substring(sep + 1), 10) };
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
        try {
          resolvedHost = await resolveHostname(targetHost);
          console.log(`[Connect] ${targetHost} -> ${resolvedHost}:${port}`);
        } catch (err) {
          console.error(`[DNS Error] ${err.message}`);
        }

        remoteSocket = net.connect({ host: resolvedHost, port, timeout: 10000 });

        await new Promise((resolve, reject) => {
          remoteSocket.once('connect', resolve);
          remoteSocket.once('error', reject);
        });

        if (firstFrameData) remoteSocket.write(firstFrameData);
        webSocket.send('CONNECTED');
        pumpRemoteToWebSocket(remoteSocket);
        return;

      } catch (err) {
        if (remoteSocket) {
          try { remoteSocket.destroy(); } catch {}
          remoteSocket = null;
        }
        if (!isCFError(err) || i === attempts.length - 1) throw err;
      }
    }
  };

  webSocket.on('message', async (data) => {
    if (isClosed) return;
    try {
      const message = data.toString();
      if (message.startsWith('CONNECT:')) {
        const sep = message.indexOf('|', 8);
        await connectToRemote(message.substring(8, sep), message.substring(sep + 1));
      } else if (message.startsWith('DATA:')) {
        if (remoteSocket && !remoteSocket.destroyed) remoteSocket.write(message.substring(5));
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
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
      ws.close(1000, 'Server closed');
    }
  } catch {}
}

// ─── 启动 ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Web listening on port ${PORT}`);
  console.log(`Token authentication: ${TOKEN ? 'enabled' : 'disabled'}`);
  console.log(`DNS strategy: System DNS → DoT fallback (port 853)`);
  console.log(`DoT Servers: ${DOT_SERVERS.map(s => `${s.name}(${s.host}:${s.port})`).join(', ')}`);
  console.log(`DNS Cache TTL: ${DNS_CACHE_TTL / 1000}s | Fail TTL: ${DNS_FAIL_TTL / 1000}s`);
});
