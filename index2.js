const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const net = require('net');
const dgram = require('dgram');
const { URL } = require('url');
const crypto = require('crypto');

// ======================== 环境变量配置 ========================
const PORT = process.env.PORT || 3000;
const WS_PATH = process.env.WS_PATH || '/ws';
const TOKEN = process.env.TOKEN || '';
const CIDRS = process.env.CIDRS || '0.0.0.0/0,::/0';
const USE_TLS = process.env.USE_TLS === 'true';
const CERT_FILE = process.env.CERT_FILE || '';
const KEY_FILE = process.env.KEY_FILE || '';

// ======================== 工具函数 ========================
function parseCIDR(cidr) {
  const parts = cidr.split('/');
  const ip = parts[0];
  const bits = parseInt(parts[1]);
  
  const ipParts = ip.split('.').map(Number);
  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  const mask = ~((1 << (32 - bits)) - 1);
  
  return { network: ipNum & mask, mask };
}

function isIPInCIDR(ip, cidrList) {
  if (cidrList.includes('0.0.0.0/0') || cidrList.includes('::/0')) return true;
  
  const ipParts = ip.split('.').map(Number);
  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
  
  for (const cidr of cidrList) {
    if (cidr.includes(':')) continue; // Skip IPv6 for simplicity
    const { network, mask } = parseCIDR(cidr);
    if ((ipNum & mask) === network) return true;
  }
  return false;
}

function isNormalCloseError(err) {
  if (!err) return false;
  const msg = err.message || '';
  return msg.includes('ECONNRESET') || 
         msg.includes('EPIPE') || 
         msg.includes('EOF') ||
         err.code === 'ECONNRESET';
}

function generateSelfSignedCert() {
  const { generateKeyPairSync } = require('crypto');
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  
  // 简化版自签名证书（实际应使用 node-forge 或 selfsigned 库）
  return {
    key: privateKey.export({ type: 'pkcs1', format: 'pem' }),
    cert: publicKey.export({ type: 'spki', format: 'pem' })
  };
}

// ======================== HTTP 服务器 ========================
const allowedCIDRs = CIDRS.split(',').map(c => c.trim());

const requestHandler = (req, res) => {
  // IP 验证
  const clientIP = req.socket.remoteAddress?.replace('::ffff:', '') || '';
  if (!isIPInCIDR(clientIP, allowedCIDRs)) {
    console.log(`拒绝访问: IP ${clientIP} 不在允许的范围内`);
    res.writeHead(403, { 'Connection': 'close' });
    res.end('Forbidden');
    return;
  }

  // 提供游戏页面
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getGameHTML());
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
};

let server;
if (USE_TLS && CERT_FILE && KEY_FILE) {
  const options = {
    key: fs.readFileSync(KEY_FILE),
    cert: fs.readFileSync(CERT_FILE)
  };
  server = https.createServer(options, requestHandler);
  console.log(`HTTPS 服务器启动在端口 ${PORT}`);
} else {
  server = http.createServer(requestHandler);
  console.log(`HTTP 服务器启动在端口 ${PORT}`);
}

// ======================== WebSocket 服务器 ========================
const wss = new WebSocketServer({ 
  noServer: true,
  clientTracking: true
});

server.on('upgrade', (req, socket, head) => {
  const clientIP = socket.remoteAddress?.replace('::ffff:', '') || '';
  
  // IP 验证
  if (!isIPInCIDR(clientIP, allowedCIDRs)) {
    console.log(`WS 拒绝: IP ${clientIP} 不在允许范围内`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Token 验证
  if (TOKEN) {
    const protocol = req.headers['sec-websocket-protocol'];
    if (protocol !== TOKEN) {
      console.log(`Token 验证失败,来自 ${clientIP}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  if (req.url === WS_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ======================== WebSocket 连接处理 ========================
wss.on('connection', (ws, req) => {
  console.log(`新的 WebSocket 连接来自 ${req.socket.remoteAddress}`);
  
  const conns = new Map();
  const udpConns = new Map();
  const udpTargets = new Map();

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      handleBinaryMessage(data, ws, conns, udpConns, udpTargets);
    } else {
      handleTextMessage(data.toString(), ws, conns, udpConns, udpTargets);
    }
  });

  ws.on('close', () => {
    console.log(`WebSocket 连接关闭 ${req.socket.remoteAddress}`);
    cleanup(conns, udpConns);
  });

  ws.on('error', (err) => {
    if (!isNormalCloseError(err)) {
      console.error('WebSocket 错误:', err.message);
    }
  });

  ws.on('ping', (data) => {
    ws.pong(data);
  });
});

function handleBinaryMessage(data, ws, conns, udpConns, udpTargets) {
  const str = data.toString();
  
  // UDP 数据
  if (str.startsWith('UDP_DATA:')) {
    const content = str.slice(9);
    const pipeIndex = content.indexOf('|');
    if (pipeIndex > 0) {
      const connID = content.slice(0, pipeIndex);
      const payload = data.slice(9 + pipeIndex + 1);
      
      const udpConn = udpConns.get(connID);
      const targetAddr = udpTargets.get(connID);
      if (udpConn && targetAddr) {
        udpConn.send(payload, targetAddr.port, targetAddr.host, (err) => {
          if (err) {
            console.log(`[UDP:${connID}] 发送失败:`, err.message);
          } else {
            console.log(`[UDP:${connID}] 已发送数据到 ${targetAddr.host}:${targetAddr.port},大小: ${payload.length}`);
          }
        });
      }
    }
    return;
  }

  // TCP 数据
  if (str.startsWith('DATA:')) {
    const content = str.slice(5);
    const pipeIndex = content.indexOf('|');
    if (pipeIndex > 0) {
      const connID = content.slice(0, pipeIndex);
      const payload = data.slice(5 + pipeIndex + 1);
      
      const conn = conns.get(connID);
      if (conn && !conn.destroyed) {
        conn.write(payload);
      }
    }
  }
}

function handleTextMessage(data, ws, conns, udpConns, udpTargets) {
  // UDP_CONNECT
  if (data.startsWith('UDP_CONNECT:')) {
    const content = data.slice(12);
    const parts = content.split('|');
    if (parts.length === 2) {
      const [connID, targetAddr] = parts;
      handleUDPConnect(connID, targetAddr, ws, udpConns, udpTargets);
    }
    return;
  }

  // UDP_CLOSE
  if (data.startsWith('UDP_CLOSE:')) {
    const connID = data.slice(10);
    const udpConn = udpConns.get(connID);
    if (udpConn) {
      udpConn.close();
      udpConns.delete(connID);
      udpTargets.delete(connID);
      console.log(`[UDP:${connID}] 连接已关闭`);
    }
    return;
  }

  // CLAIM
  if (data.startsWith('CLAIM:')) {
    const content = data.slice(6);
    const parts = content.split('|');
    if (parts.length === 2) {
      ws.send(`CLAIM_ACK:${parts[0]}|${parts[1]}`);
    }
    return;
  }

  // TCP
  if (data.startsWith('TCP:')) {
    const content = data.slice(4);
    const parts = content.split('|');
    if (parts.length >= 2) {
      const connID = parts[0];
      const targetAddr = parts[1];
      const firstFrameData = parts[2] || '';
      console.log(`[TCP] 请求转发,ID: ${connID},目标: ${targetAddr},首帧: ${firstFrameData.length}`);
      handleTCPConnect(connID, targetAddr, firstFrameData, ws, conns);
    }
    return;
  }

  // DATA
  if (data.startsWith('DATA:')) {
    const content = data.slice(5);
    const parts = content.split('|');
    if (parts.length === 2) {
      const [connID, payload] = parts;
      const conn = conns.get(connID);
      if (conn && !conn.destroyed) {
        conn.write(payload);
      }
    }
    return;
  }

  // CLOSE
  if (data.startsWith('CLOSE:')) {
    const connID = data.slice(6);
    const conn = conns.get(connID);
    if (conn) {
      conn.destroy();
      conns.delete(connID);
      console.log(`[TCP] 客户端请求关闭: ${connID}`);
    }
    return;
  }
}

function handleUDPConnect(connID, targetAddr, ws, udpConns, udpTargets) {
  console.log(`[UDP:${connID}] 收到连接请求,目标: ${targetAddr}`);
  
  const [host, port] = targetAddr.split(':');
  const udpSocket = dgram.createSocket('udp4');
  
  udpConns.set(connID, udpSocket);
  udpTargets.set(connID, { host, port: parseInt(port) });

  udpSocket.on('message', (msg, rinfo) => {
    console.log(`[UDP:${connID}] 收到响应来自 ${rinfo.address}:${rinfo.port},大小: ${msg.length}`);
    
    const prefix = Buffer.from(`UDP_DATA:${connID}|${rinfo.address}:${rinfo.port}|`);
    const response = Buffer.concat([prefix, msg]);
    
    if (ws.readyState === 1) {
      ws.send(response);
    }
  });

  udpSocket.on('error', (err) => {
    console.log(`[UDP:${connID}] 错误:`, err.message);
    ws.send(`UDP_ERROR:${connID}|${err.message}`);
  });

  ws.send(`UDP_CONNECTED:${connID}`);
  console.log(`[UDP:${connID}] 已设置目标: ${targetAddr}`);
}

function handleTCPConnect(connID, targetAddr, firstFrameData, ws, conns) {
  const [host, port] = targetAddr.split(':');
  const conn = net.connect(parseInt(port), host);

  conn.on('connect', () => {
    console.log(`[TCP:${connID}] 已连接到 ${targetAddr}`);
    conns.set(connID, conn);

    if (firstFrameData) {
      conn.write(firstFrameData);
    }

    if (ws.readyState === 1) {
      ws.send(`CONNECTED:${connID}`);
    }
  });

  conn.on('data', (data) => {
    if (ws.readyState === 1) {
      const prefix = Buffer.from(`DATA:${connID}|`);
      const message = Buffer.concat([prefix, data]);
      ws.send(message);
    }
  });

  conn.on('end', () => {
    console.log(`[TCP:${connID}] 连接结束`);
    if (ws.readyState === 1) {
      ws.send(`CLOSE:${connID}`);
    }
    conns.delete(connID);
  });

  conn.on('error', (err) => {
    if (!isNormalCloseError(err)) {
      console.log(`[TCP:${connID}] 错误:`, err.message);
    }
    if (ws.readyState === 1) {
      ws.send(`CLOSE:${connID}`);
    }
    conns.delete(connID);
  });
}

function cleanup(conns, udpConns) {
  for (const [id, conn] of conns) {
    conn.destroy();
    console.log(`[清理] TCP连接: ${id}`);
  }
  conns.clear();

  for (const [id, udpConn] of udpConns) {
    udpConn.close();
    console.log(`[清理] UDP连接: ${id}`);
  }
  udpConns.clear();
}

// ======================== 游戏页面 ========================
function getGameHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>贪吃蛇游戏 - WebSocket 代理服务器</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      color: #fff;
    }
    .container {
      text-align: center;
      background: rgba(255,255,255,0.1);
      padding: 30px;
      border-radius: 20px;
      backdrop-filter: blur(10px);
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }
    h1 { margin-bottom: 10px; font-size: 2.5em; text-shadow: 2px 2px 4px rgba(0,0,0,0.3); }
    .info { margin-bottom: 20px; font-size: 1.2em; opacity: 0.9; }
    canvas {
      border: 3px solid #fff;
      border-radius: 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      background: #000;
    }
    .controls {
      margin-top: 20px;
      display: flex;
      gap: 15px;
      justify-content: center;
      flex-wrap: wrap;
    }
    button {
      padding: 12px 24px;
      font-size: 16px;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      color: #fff;
      font-weight: bold;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    button:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0,0,0,0.3);
    }
    button:active { transform: translateY(0); }
    .score {
      font-size: 1.5em;
      margin-top: 15px;
      font-weight: bold;
      text-shadow: 1px 1px 3px rgba(0,0,0,0.3);
    }
    .status {
      margin-top: 10px;
      padding: 10px;
      border-radius: 8px;
      background: rgba(0,0,0,0.2);
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🐍 贪吃蛇游戏</h1>
    <div class="info">WebSocket 代理服务器运行中</div>
    <canvas id="game" width="400" height="400"></canvas>
    <div class="score">得分: <span id="score">0</span></div>
    <div class="controls">
      <button onclick="startGame()">开始游戏</button>
      <button onclick="pauseGame()">暂停</button>
      <button onclick="resetGame()">重置</button>
    </div>
    <div class="status">使用方向键或 WASD 控制蛇的移动</div>
  </div>

  <script>
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    
    const gridSize = 20;
    const tileCount = canvas.width / gridSize;
    
    let snake = [{x: 10, y: 10}];
    let dx = 0, dy = 0;
    let food = {x: 15, y: 15};
    let score = 0;
    let gameLoop = null;
    let paused = false;

    function startGame() {
      if (gameLoop) clearInterval(gameLoop);
      paused = false;
      gameLoop = setInterval(update, 100);
    }

    function pauseGame() {
      paused = !paused;
    }

    function resetGame() {
      if (gameLoop) clearInterval(gameLoop);
      snake = [{x: 10, y: 10}];
      dx = 0; dy = 0;
      score = 0;
      scoreEl.textContent = score;
      generateFood();
      draw();
    }

    function update() {
      if (paused) return;

      const head = {x: snake[0].x + dx, y: snake[0].y + dy};

      // 墙壁碰撞
      if (head.x < 0 || head.x >= tileCount || head.y < 0 || head.y >= tileCount) {
        clearInterval(gameLoop);
        alert('游戏结束!得分: ' + score);
        return;
      }

      // 自身碰撞
      if (snake.some(s => s.x === head.x && s.y === head.y)) {
        clearInterval(gameLoop);
        alert('游戏结束!得分: ' + score);
        return;
      }

      snake.unshift(head);

      // 吃到食物
      if (head.x === food.x && head.y === food.y) {
        score++;
        scoreEl.textContent = score;
        generateFood();
      } else {
        snake.pop();
      }

      draw();
    }

    function generateFood() {
      food = {
        x: Math.floor(Math.random() * tileCount),
        y: Math.floor(Math.random() * tileCount)
      };
      // 确保食物不在蛇身上
      if (snake.some(s => s.x === food.x && s.y === food.y)) {
        generateFood();
      }
    }

    function draw() {
      // 背景
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 蛇
      snake.forEach((segment, index) => {
        ctx.fillStyle = index === 0 ? '#4ade80' : '#22c55e';
        ctx.fillRect(segment.x * gridSize, segment.y * gridSize, gridSize - 2, gridSize - 2);
      });

      // 食物
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(food.x * gridSize, food.y * gridSize, gridSize - 2, gridSize - 2);
    }

    document.addEventListener('keydown', (e) => {
      switch(e.key) {
        case 'ArrowUp':
        case 'w':
        case 'W':
          if (dy === 0) { dx = 0; dy = -1; }
          break;
        case 'ArrowDown':
        case 's':
        case 'S':
          if (dy === 0) { dx = 0; dy = 1; }
          break;
        case 'ArrowLeft':
        case 'a':
        case 'A':
          if (dx === 0) { dx = -1; dy = 0; }
          break;
        case 'ArrowRight':
        case 'd':
        case 'D':
          if (dx === 0) { dx = 1; dy = 0; }
          break;
      }
    });

    draw();
  </script>
</body>
</html>`;
}

// ======================== 启动服务器 ========================
server.listen(PORT, () => {
  console.log(`
========================================
WebSocket 代理服务器已启动
----------------------------------------
HTTP/WS 端口: ${PORT}
WebSocket 路径: ${WS_PATH}
游戏页面: http://localhost:${PORT}/
Token 验证: ${TOKEN ? '已启用' : '未启用'}
允许的 CIDR: ${CIDRS}
========================================
  `);
});
