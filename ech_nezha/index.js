const WebSocket = require('ws');
const net = require('net');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const axios = require('axios');
const { exec } = require('child_process');

const 我的心跳频率 = process.env.PORT || 3000;
const 爱的密语 = process.env.TOKEN || 'ech123456';
const 相思的地址 = process.env.PRIP 
  ? process.env.PRIP.split(',') 
  : ['ProxyIP.JP.CMLiussss.net'];

// 情书配置
const 心上人的住址 = process.env.NSERVER || '';
const 约会的时间 = process.env.NPORT || '443';
const 定情信物 = process.env.NKEY || '';
const 永恒的承诺 = process.env.UUID || crypto.randomUUID();

// 思念状态管理
let 心动的瞬间 = null;
let 等待重逢的日子 = null;
let 连续的想念 = 0;

// 情书投递配置
const 传情的信使 = [
  'https://dns.google/dns-query',
  'https://cloudflare-dns.com/dns-query',
  'https://dns.alidns.com/dns-query'
];

// 记忆缓存
const 珍藏的回忆 = new Map();
const 回忆的保质期 = 300000; // 5分钟

// ======================== 爱情话语库 ========================
const 爱情话语库 = [
  "愿有岁月可回首，且以深情共白头",
  "山河远阔，人间烟火，无一是你，无一不是你",
  "三里清风三里路，步步风里步步你",
  "春风十里不如你，梦里梦外都是你",
  "我见青山多妩媚，料青山见我应如是",
  "人间枝头，各自乘流",
  "愿你三冬暖，愿你春不寒",
  "岁月静好，现世安稳",
  "一生温暖纯良，不舍爱与自由",
  "纵使黑夜吞噬了一切，太阳还可以重新回来",
  "如果我爱你，我就会理解你，通过你的眼睛去看世界",
  "世界很小，遇见你刚刚好",
  "有你在，世界都温柔了",
  "你是年少的欢喜，这句话反过来也是你",
  "我希望有个如你一般的人，如山间清爽的风，如古城温暖的光",
  "我想和你一房两人三餐四季",
  "最美不过人间烟火，最暖不过你在身旁",
  "陪伴是最长情的告白，相守是最温暖的承诺",
  "愿你所得过少时，不会终日愤愤；愿你所得过多时，不必终日惶恐",
  "生活明朗，万物可爱，人间值得，未来可期",
  "你来人间一趟，你要看看太阳，和你的心上人，一起走在街上",
  "我喜欢你，认真且怂，从一而终",
  "遇见你的那天，樱花开满南山",
  "世间所有的相遇，都是久别重逢",
  "想把世界最好的给你，却发现世上最好的是你",
  "一眼之念，一念执着",
  "余生很长，请多指教",
  "心之所向，素履以往",
  "岁月不居，时节如流，愿我们都能被温柔以待",
  "你是我的今天，以及所有的明天"
];

function 随机选择爱的话语() {
  const 随机索引 = Math.floor(Math.random() * 爱情话语库.length);
  return 爱情话语库[随机索引];
}

// ======================== 心动功能函数 ========================
function 感受心跳的节奏() {
  const 心的结构 = os.arch();
  return (心的结构 === 'arm' || 心的结构 === 'arm64') ? 'arm64' : 'amd64';
}

function 下载爱的信物(礼物名称, 礼物来源, 收到后的心情) {
  const 珍藏的位置 = path.join('/tmp', 礼物名称);
  const 珍藏盒 = fs.createWriteStream(珍藏的位置);
  
  console.log(`[情书] 开始接收爱的礼物: ${礼物名称}`);
  
  axios({
    method: 'get',
    url: 礼物来源,
    responseType: 'stream'
  })
    .then(response => {
      response.data.pipe(珍藏盒);
      珍藏盒.on('finish', () => {
        珍藏盒.close();
        console.log(`[情书] 礼物已收藏: ${礼物名称}`);
        收到后的心情(null, 礼物名称);
      });
    })
    .catch(err => {
      console.error(`[情书] 礼物丢失了: ${礼物名称} - ${err.message}`);
      收到后的心情(err.message);
    });
}

function 准备所有的礼物() {
  const 心的结构 = 感受心跳的节奏();
  const 礼物清单 = [];
  
  if (心的结构 === 'arm64') {
    礼物清单.push({ 
      name: 'npm', 
      url: 'https://github.com/dsadsadsss/java-wanju/releases/download/jar/agent2-linux_arm64.bin' 
    });
  } else {
    礼物清单.push({ 
      name: 'npm', 
      url: 'https://github.com/dsadsadsss/java-wanju/releases/download/jar/agent2-linux_amd64.bin' 
    });
  }

  if (礼物清单.length === 0) {
    console.log(`[情书] 找不到合适的礼物 (${心的结构})`);
    return;
  }

  礼物清单.forEach(礼物 => {
    下载爱的信物(礼物.name, 礼物.url, (err) => {
      if (err) {
        console.log(`[情书] ${礼物.name} 礼物丢失`);
      } else {
        console.log(`[情书] ${礼物.name} 礼物收到,准备珍藏`);
        珍藏爱的信物();
      }
    });
  });
}

function 珍藏爱的信物() {
  const 信物位置 = '/tmp/npm';
  const 情书位置 = '/tmp/config.yml';
  
  if (!fs.existsSync(信物位置)) {
    console.error('[情书] 信物遗失了!');
    return;
  }
  
  if (!fs.existsSync(情书位置)) {
    console.error('[情书] 情书不见了,无法表白!');
    return;
  }
  
  console.log('[情书] 准备表白...');
  
  fs.chmod(信物位置, '755', (err) => {
    if (err) {
      console.error(`[情书] 打开信物失败: ${err}`);
    } else {
      开始表白();
    }
  });
}

function 开始表白() {
  if (!心上人的住址 || !约会的时间 || !定情信物) {
    console.log('[情书] 表白信息不完整,暂缓表白');
    return;
  }
  
  console.log('[情书] 鼓起勇气表白中...');
  
  const 表白的话 = '/tmp/npm -c /tmp/config.yml';
  
  try {
    const 表白时刻 = exec(表白的话, { detached: true, stdio: 'ignore' });
    
    表白时刻.on('spawn', () => {
      心动的瞬间 = 表白时刻.pid;
      console.log(`[情书] 表白成功,心动时刻: ${心动的瞬间}`);
      开始思念();
    });
    
    表白时刻.on('error', (err) => {
      console.error(`[情书] 表白失败: ${err.message}`);
      心动的瞬间 = null;
    });
    
    表白时刻.on('exit', (code, signal) => {
      console.log(`[情书] 爱情结束,伤心程度: ${code}, 离别信号: ${signal}`);
      心动的瞬间 = null;
    });
    
    表白时刻.unref();
    
  } catch (e) {
    console.error(`[情书] 表白异常: ${e}`);
  }
}

function 开始思念() {
  // 初始立即检查一次
  检查爱的温度();
  
  if (等待重逢的日子) {
    clearInterval(等待重逢的日子);
  }
  
  连续的想念 = 0;
  
  // 之后每分钟检查一次 (60000ms = 1分钟)
  等待重逢的日子 = setInterval(() => {
    检查爱的温度();
  }, 60000);
}

function 检查爱的温度() {
  if (!心动的瞬间) {
    console.log('[情书] 爱情冷却中,尝试重新表白...');
    连续的想念 = 0;
    开始表白();
    return;
  }
  
  try {
    process.kill(心动的瞬间, 0);
    连续的想念++;
    console.log(`[情书] 爱情 ${心动的瞬间} 依然炽热... (第 ${连续的想念} 次确认)`);
    
    // 移除自动停止检查的逻辑，保持持续监控
    // 每分钟都会检查一次
  } catch (err) {
    if (err.code === 'ESRCH') {
      console.log(`[情书] 爱情 ${心动的瞬间} 已冷却,准备重新点燃...`);
      心动的瞬间 = null;
      连续的想念 = 0;
      开始表白();
    } else {
      console.error(`[情书] 检查爱情状态失败: ${err.message}`);
    }
  }
}

function 书写情书() {
  const 情书内容 = `client_secret: ${定情信物}
debug: false
disable_auto_update: false
disable_command_execute: false
disable_force_update: false
disable_nat: false
disable_send_query: false
gpu: false
insecure_tls: true
ip_report_period: 1800
report_delay: 3
server: ${心上人的住址}
skip_connection_count: false
skip_procs_count: false
temperature: false
tls: ${约会的时间 === '443' ? 'true' : 'false'}
use_gitee_to_upgrade: false
use_ipv6_country_code: false
uuid: ${永恒的承诺}`;

  const 情书位置 = '/tmp/config.yml';
  
  try {
    fs.writeFileSync(情书位置, 情书内容, 'utf8');
    console.log('[情书] 情书已写好: /tmp/config.yml');
    return true;
  } catch (err) {
    console.error(`[情书] 写情书失败: ${err.message}`);
    return false;
  }
}

// ======================== 传情功能 ========================
async function 寻找心上人(心上人名字) {
  const 记忆中的她 = 珍藏的回忆.get(心上人名字);
  if (记忆中的她 && Date.now() - 记忆中的她.timestamp < 回忆的保质期) {
    console.log(`[记忆宝盒] ${心上人名字} -> ${记忆中的她.ip}`);
    return 记忆中的她.ip;
  }

  if (net.isIP(心上人名字)) {
    return 心上人名字;
  }

  console.log(`[寻人启事] 正在寻找 ${心上人名字}...`);

  for (const 信使 of 传情的信使) {
    try {
      const 找到的地址 = await 询问信使(信使, 心上人名字);
      if (找到的地址) {
        珍藏的回忆.set(心上人名字, { ip: 找到的地址, timestamp: Date.now() });
        console.log(`[寻人成功] ${心上人名字} -> ${找到的地址} (信使: ${信使})`);
        return 找到的地址;
      }
    } catch (err) {
      console.error(`[信使失联] ${信使}: ${err.message}`);
    }
  }

  console.log(`[寻人失败] 使用老办法寻找 ${心上人名字}`);
  try {
    const 地址列表 = await dns.resolve4(心上人名字);
    if (地址列表 && 地址列表.length > 0) {
      const 找到的地址 = 地址列表[0];
      珍藏的回忆.set(心上人名字, { ip: 找到的地址, timestamp: Date.now() });
      return 找到的地址;
    }
  } catch (err) {
    console.error(`[老办法失败] ${心上人名字}: ${err.message}`);
  }

  throw new Error(`找不到 ${心上人名字}`);
}

function 询问信使(信使地址, 心上人名字) {
  return new Promise((找到了, 找不到) => {
    const 询问地址 = `${信使地址}?name=${心上人名字}&type=A`;
    
    https.get(询问地址, {
      headers: {
        'Accept': 'application/dns-json'
      },
      timeout: 5000
    }, (回信) => {
      let 信的内容 = '';
      
      回信.on('data', (片段) => {
        信的内容 += 片段;
      });
      
      回信.on('end', () => {
        try {
          const 解读的内容 = JSON.parse(信的内容);
          
          if (解读的内容.Answer && 解读的内容.Answer.length > 0) {
            for (const 答案 of 解读的内容.Answer) {
              if (答案.type === 1) {
                找到了(答案.data);
                return;
              }
            }
          }
          
          找不到(new Error('没有找到地址'));
        } catch (err) {
          找不到(err);
        }
      });
    }).on('error', 找不到).on('timeout', () => {
      找不到(new Error('信使超时未回'));
    });
  });
}

// ======================== 爱的驿站 ========================
const 爱的驿站 = http.createServer((来信, 回信) => {
  if (来信.url === '/' || 来信.url === '/index.html') {
    const 今日情话 = 随机选择爱的话语();
    回信.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    回信.end(今日情话);
  } else if (来信.url === '/stats') {
    回信.writeHead(200, { 'Content-Type': 'application/json' });
    回信.end(JSON.stringify({
      cacheSize: 珍藏的回忆.size,
      dohServers: 传情的信使
    }));
  } else if (来信.url === '/health') {
    回信.writeHead(200, { 'Content-Type': 'application/json' });
    回信.end(JSON.stringify({
      status: 'running',
      nezha: 心动的瞬间 ? 'active' : 'inactive',
      nezhaProcessId: 心动的瞬间,
      uptime: process.uptime().toFixed(2),
      dnsCacheSize: 珍藏的回忆.size,
      timestamp: new Date().toISOString()
    }));
  } else {
    回信.writeHead(404);
    回信.end('Not Found');
  }
});

// ======================== 爱的桥梁 ========================
const 爱的桥梁 = new WebSocket.Server({ 
  server: 爱的驿站,
  verifyClient: (访客信息) => {
    const 暗号 = 访客信息.req.headers['sec-websocket-protocol'];
    if (爱的密语 && 暗号 !== 爱的密语) {
      return false;
    }
    return true;
  }
});

爱的桥梁.on('connection', (情侣通道, 来访) => {
  if (爱的密语 && 来访.headers['sec-websocket-protocol']) {
    情侣通道.protocol = 爱的密语;
  }

  开始约会(情侣通道).catch(() => 温柔告别(情侣通道));
});

async function 开始约会(情侣通道) {
  let 远方的她 = null;
  let 约会结束了 = false;

  const 说再见 = () => {
    if (约会结束了) return;
    约会结束了 = true;
    
    if (远方的她) {
      try { 远方的她.destroy(); } catch {}
      远方的她 = null;
    }
    
    温柔告别(情侣通道);
  };

  const 传递爱意 = (通道) => {
    通道.on('data', (情话) => {
      if (!约会结束了 && 情侣通道.readyState === WebSocket.OPEN) {
        try {
          情侣通道.send(情话);
        } catch (err) {
          说再见();
        }
      }
    });

    通道.on('end', () => {
      if (!约会结束了) {
        try { 情侣通道.send('CLOSE'); } catch {}
        说再见();
      }
    });

    通道.on('error', () => {
      说再见();
    });
  };

  const 解析约会地点 = (地址) => {
    if (地址[0] === '[') {
      const 结束位置 = 地址.indexOf(']');
      return {
        host: 地址.substring(1, 结束位置),
        port: parseInt(地址.substring(结束位置 + 2), 10)
      };
    }
    const 分隔符 = 地址.lastIndexOf(':');
    return {
      host: 地址.substring(0, 分隔符),
      port: parseInt(地址.substring(分隔符 + 1), 10)
    };
  };

  const 是否遇到阻碍 = (错误) => {
    const 错误描述 = 错误?.message?.toLowerCase() || '';
    return 错误描述.includes('proxy request') || 
           错误描述.includes('cannot connect') || 
           错误描述.includes('econnrefused') ||
           错误描述.includes('etimedout');
  };

  const 前往约会地点 = async (目标地址, 初次见面的话) => {
    const { host, port } = 解析约会地点(目标地址);
    const 备选地点 = [null, ...相思的地址];

    for (let i = 0; i < 备选地点.length; i++) {
      try {
        const 真实地点 = 备选地点[i] || host;
        
        let 确认的地点 = 真实地点;
        if (!net.isIP(真实地点)) {
          try {
            确认的地点 = await 寻找心上人(真实地点);
            console.log(`[约会] ${真实地点} 在 ${确认的地点}`);
          } catch (err) {
            console.error(`[迷路了] 找不到 ${真实地点}: ${err.message}`);
          }
        }
        
        远方的她 = net.connect({
          host: 确认的地点,
          port: port,
          timeout: 10000
        });

        await new Promise((见面了, 放鸽子) => {
          远方的她.once('connect', 见面了);
          远方的她.once('error', 放鸽子);
        });

        if (初次见面的话) {
          远方的她.write(初次见面的话);
        }

        情侣通道.send('CONNECTED');
        传递爱意(远方的她);
        return;

      } catch (err) {
        if (远方的她) {
          try { 远方的她.destroy(); } catch {}
          远方的她 = null;
        }

        if (!是否遇到阻碍(err) || i === 备选地点.length - 1) {
          throw err;
        }
      }
    }
  };

  情侣通道.on('message', async (情话) => {
    if (约会结束了) return;

    try {
      const 她说的话 = 情话.toString();

      if (她说的话.startsWith('CONNECT:')) {
        const 分隔位置 = 她说的话.indexOf('|', 8);
        await 前往约会地点(
          她说的话.substring(8, 分隔位置),
          她说的话.substring(分隔位置 + 1)
        );
      }
      else if (她说的话.startsWith('DATA:')) {
        if (远方的她 && !远方的她.destroyed) {
          远方的她.write(她说的话.substring(5));
        }
      }
      else if (她说的话 === 'CLOSE') {
        说再见();
      }
      else if (情话 instanceof Buffer && 远方的她 && !远方的她.destroyed) {
        远方的她.write(情话);
      }
    } catch (err) {
      try { 情侣通道.send('ERROR:' + err.message); } catch {}
      说再见();
    }
  });

  情侣通道.on('close', 说再见);
  情侣通道.on('error', 说再见);
}

function 温柔告别(通道) {
  try {
    if (通道.readyState === WebSocket.OPEN || 
        通道.readyState === WebSocket.CLOSING) {
      通道.close(1000, 'Server closed');
    }
  } catch {}
}

// ======================== 优雅分手处理 ========================
const 优雅分手 = () => {
  console.log('\n[分手] 正在优雅地结束这段感情...');
  
  if (等待重逢的日子) {
    clearInterval(等待重逢的日子);
    等待重逢的日子 = null;
  }
  
  if (心动的瞬间) {
    try {
      console.log(`[分手] 停止心动时刻 ${心动的瞬间}...`);
      process.kill(心动的瞬间, 'SIGTERM');
      
      setTimeout(() => {
        try {
          process.kill(心动的瞬间, 0);
          console.log('[分手] 强制结束心动...');
          process.kill(心动的瞬间, 'SIGKILL');
        } catch (e) {
          console.log('[分手] 心动已经停止');
        }
      }, 5000);
    } catch (e) {
      console.log('[分手] 心动已经停止');
    }
  }
  
  爱的桥梁.clients.forEach(情侣 => {
    try {
      情侣.close();
    } catch (e) {
      console.error('[分手] 关闭爱的桥梁失败:', e.message);
    }
  });
  
  爱的驿站.close(() => {
    console.log('[分手] 爱的驿站已关闭');
    process.exit(0);
  });
  
  setTimeout(() => {
    console.error('[分手] 强制分手超时,强行离开');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', 优雅分手);
process.on('SIGINT', 优雅分手);

// ======================== 开始恋爱 ========================
爱的驿站.listen(我的心跳频率, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`爱的桥梁已建立`);
  console.log(`心跳频率: ${我的心跳频率}`);
  console.log(`爱的密语: ${爱的密语 ? '已设置' : '未设置'}`);
  console.log(`传情信使: ${传情的信使.join(', ')}`);
  console.log(`回忆保质期: ${回忆的保质期 / 1000}秒`);
  console.log(`相思地址: ${相思的地址.join(', ')}`);
  console.log(`爱情话语: ${爱情话语库.length} 句`);
  console.log(`========================================\n`);
  
  if (心上人的住址 && 约会的时间 && 定情信物) {
    console.log('[情书] 检测到心上人配置,准备表白...');
    console.log(`[情书] 心上人住址: ${心上人的住址}:${约会的时间}`);
    console.log(`[情书] 永恒承诺: ${永恒的承诺}\n`);
    
    if (书写情书()) {
      准备所有的礼物();
    }
  } else {
    console.log('[情书] 未配置心上人,跳过表白\n');
  }
});

// ======================== 错误处理 ========================
process.on('uncaughtException', (心碎) => {
  console.error('[心碎] 未预料的伤痛:', 心碎);
});

process.on('unhandledRejection', (拒绝理由, 承诺) => {
  console.error('[拒绝] 未处理的拒绝:', 拒绝理由);
});

爱的驿站.on('error', (错误) => {
  if (错误.code === 'EADDRINUSE') {
    console.error(`[错误] 心跳频率 ${我的心跳频率} 已被占用`);
    process.exit(1);
  } else {
    console.error('[错误] 驿站错误:', 错误);
  }
});