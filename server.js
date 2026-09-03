/* ============================================================
 * server.js —— 极速飞车 联机服务器
 * 同一端口：HTTP 静态托管 + WebSocket 房间匹配与消息中继
 *
 * 房间规则：
 *   玩家位最多 8 人（config.MAX_PLAYERS），先到先得；
 *   第 1 位连接者 = 房主（唯一可发起开局/回大厅）
 *   ≥ 2 名玩家时房主可开局；开局后加入者自动成为观战
 *   每个客户端是"自己那辆车"的权威模拟端，服务器只做
 *   校验、中继、计时汇聚与名次裁决（防字段走私，见 protocol.js）
 *
 * 安全防护（沿用台球项目框架）：
 *   HTTP：CSP / nosniff / frame-ancestors；非法编码 400；目录穿越加严
 *   WS：maxPayload 限幅、Origin 白名单、每 IP 连接数与观战上限、
 *       令牌桶限速、ping/pong 心跳、广播背压保护
 * ============================================================ */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const CFG = require('./js/config.js');
const Protocol = require('./js/protocol.js');

const PORT = process.env.PORT || 8252;
const ROOT = __dirname;

/* ---------------- 可调安全参数 ---------------- */
const MAX_PAYLOAD = 8 * 1024;
const MAX_PER_IP = 16;
const MAX_SPECTATORS = 64;
const RATE_PER_SEC = 30;
const RATE_BURST = 60;
const BAD_MSG_LIMIT = 30;
const BUFFER_LIMIT = 128 * 1024;
const HEARTBEAT_MS = 30 * 1000;

/* ---------------- HTTP 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; " +
    "base-uri 'self'; frame-ancestors 'none'");
}

const server = http.createServer((req, res) => {
  securityHeaders(res);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (!urlPath || urlPath.includes('\0')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

/* ---------------- WebSocket 房间 ---------------- */
const EXTRA_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://zhou-tao.github.io')
    .split(',').map(s => s.trim()).filter(Boolean)
);

function originAllowed(origin, req) {
  if (!origin) return true;
  let u;
  try { u = new URL(origin); } catch (e) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (req.headers.host && u.host === req.headers.host) return true;
  return EXTRA_ORIGINS.has(origin);
}

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  verifyClient: (info, cb) => {
    const origin = info.origin || (info.req.headers && info.req.headers.origin) || '';
    if (!originAllowed(origin, info.req)) {
      secLog(`拒绝跨站 Origin 连接: ${origin}`);
      cb(false, 403, 'Origin Not Allowed');
      return;
    }
    cb(true);
  },
});

const room = {
  players: [],            // [{ws, id, name, colorIdx, host, lastState, finish}]
  specs: new Set(),
  state: 'lobby',         // lobby | race
  theme: 'desert',
  race: null,             // {players:[快照], resultsAt, firstFinishAt}
};
let nextId = 1;

/* ---- 安全日志 / 限流（沿用台球项目） ---- */
const ipCount = new Map();
let _lastSecLog = 0, _secLogCount = 0;
function secLog(msg) {
  const now = Date.now();
  if (now - _lastSecLog < 6000 && _secLogCount >= 10) return;
  if (now - _lastSecLog >= 6000) _secLogCount = 0;
  _lastSecLog = now;
  _secLogCount++;
  console.log('[安全] ' + msg);
}

function allowRate(ws) {
  const now = Date.now();
  if (!ws._rate) ws._rate = { tokens: RATE_BURST, last: now };
  const r = ws._rate;
  r.tokens = Math.min(RATE_BURST, r.tokens + ((now - r.last) / 1000) * RATE_PER_SEC);
  r.last = now;
  if (r.tokens < 1) return false;
  r.tokens -= 1;
  return true;
}

function badMsg(ws, why) {
  ws._bad = (ws._bad || 0) + 1;
  if (ws._bad <= 3) secLog(`非法消息(${why}) from ${ws._ip || '?'} 累计=${ws._bad}`);
  if (ws._bad > BAD_MSG_LIMIT) { try { ws.close(1002, 'bad message'); } catch (e) {} }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const raw = JSON.stringify(obj);
  for (const p of room.players) {
    if (p.ws.readyState === 1 && p.ws.bufferedAmount <= BUFFER_LIMIT) p.ws.send(raw);
  }
  for (const ws of room.specs) {
    if (ws.readyState === 1 && ws.bufferedAmount <= BUFFER_LIMIT) ws.send(raw);
  }
}

/* 名册消息（大厅/比赛通用） */
function rosterMsg(extra) {
  return Object.assign({
    t: 'roster',
    state: room.state,
    theme: room.theme,
    specs: room.specs.size,
    maxPlayers: CFG.MAX_PLAYERS,
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.colorIdx, host: p.host,
      lap: p.lastState ? p.lastState.lap : undefined,
      prog: p.lastState ? p.lastState.prog : undefined,
      fin: !!(p.finish || (p.lastState && p.lastState.fin)),
    })),
  }, extra || {});
}

function hostOf() { return room.players.find(p => p.host) || null; }
function promoteHost() {
  const p = room.players[0];
  if (p && !p.host) {
    p.host = true;
    console.log(`[👑] ${p.name} 成为新房主`);
  }
}

/* ---------------- 连接 ---------------- */
wss.on('connection', (ws, req) => {
  ws._ip = (req && req.socket && req.socket.remoteAddress) || '?';
  const n = ipCount.get(ws._ip) || 0;
  if (n >= MAX_PER_IP) {
    secLog(`超过单 IP 连接上限(${MAX_PER_IP})：${ws._ip}`);
    try { ws.close(1013, 'too many connections'); } catch (e) {}
    return;
  }
  ipCount.set(ws._ip, n + 1);
  ws._ipCounted = true;
  ws._player = null;      // 加入后指向 room.players 元素

  /* 首条消息必须是合法 join */
  ws.on('message', (raw) => {
    if (ws.readyState !== 1) return;
    if (!allowRate(ws)) {
      secLog(`消息频率超限，断开：${ws._name || '?'}`);
      try { ws.close(1008, 'rate limit'); } catch (e) {}
      return;
    }
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { badMsg(ws, 'json'); return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') {
      badMsg(ws, 'shape'); return;
    }

    if (!ws._player && !ws._spec) return handleJoin(ws, m);

    switch (m.t) {
      case 'state': {
        const p = ws._player;
        if (!p || room.state !== 'race' || p.finish) return;
        const v = Protocol.validateState(m);
        if (!v) { badMsg(ws, 'state'); return; }
        p.lastState = v;
        broadcast(Object.assign({ t: 'st', id: p.id }, v));
        break;
      }
      case 'finish': {
        const p = ws._player;
        if (!p || room.state !== 'race' || p.finish) return;
        const v = Protocol.validateFinish(m);
        if (!v) { badMsg(ws, 'finish'); return; }
        p.finish = v;
        // 同步写入比赛花名册：之后即使掉线，结算仍保留其成绩
        if (room.race) {
          const rp = room.race.players.find(x => x.id === p.id);
          if (rp) rp.finish = v;
        }
        console.log(`[🏁] ${p.name} 完赛 ${v.time.toFixed(2)}s`);
        broadcast({ t: 'fin', id: p.id, time: v.time, best: v.best });
        checkResults();
        break;
      }
      case 'start': {
        const p = ws._player;
        if (!p || !p.host) { badMsg(ws, 'start-role'); return; }
        if (room.state !== 'lobby') { badMsg(ws, 'start-state'); return; }
        if (room.players.length < 2) {
          send(ws, { t: 'toast', kind: 'warn', text: '至少 2 名玩家才能开始联机赛' });
          return;
        }
        const v = Protocol.validateStart(m);
        if (!v) { badMsg(ws, 'start'); return; }
        startRace(v.theme, v.laps);
        break;
      }
      case 'back': {
        const p = ws._player;
        if (!p || !p.host) { badMsg(ws, 'back-role'); return; }
        endRace('host');
        break;
      }
      default:
        badMsg(ws, 'unknown:' + m.t.slice(0, 24));
    }
  });

  ws.on('close', () => {
    release(ws);
    console.log(`[-] 断开 在线=${room.players.length + room.specs.size}`);
  });
  ws.on('error', () => { /* close 会随后触发 */ });
});

/* 首条 join：分配玩家位或观战（比赛进行中加入者一律观战） */
function handleJoin(ws, m) {
  const v = Protocol.validateJoin(m);
  if (!v) { badMsg(ws, 'join'); try { ws.close(1002, 'bad join'); } catch (e) {} return; }

  if (v.spec === true || room.state === 'race' || room.players.length >= CFG.MAX_PLAYERS) {
    if (room.specs.size >= MAX_SPECTATORS) {
      try { ws.close(1013, 'room full'); } catch (e) {}
      return;
    }
    ws._spec = true;
    room.specs.add(ws);
    send(ws, {
      t: 'welcome', id: -1, role: 'spec', name: v.name, color: v.color,
      now: Date.now(), state: room.state, theme: room.theme,
      players: room.players.map(p => ({ id: p.id, name: p.name, color: p.colorIdx })),
    });
    // 观战者补发当前局面
    for (const p of room.players) {
      if (p.lastState) send(ws, Object.assign({ t: 'st', id: p.id }, p.lastState));
    }
    send(ws, rosterMsg());
    console.log(`[+] 观战进入 在线=${room.players.length + room.specs.size}`);
    return;
  }

  // 玩家位：昵称/颜色去重
  const name = dedupName(v.name);
  const colorIdx = pickColor(v.color);
  const player = {
    ws, id: nextId++, name, colorIdx,
    host: room.players.length === 0,
    lastState: null, finish: null,
  };
  ws._player = player;
  room.players.push(player);

  send(ws, {
    t: 'welcome', id: player.id, role: 'player', host: player.host,
    name, color: colorIdx, now: Date.now(),
    state: room.state, theme: room.theme,
  });
  broadcast(rosterMsg());
  console.log(`[+] ${name}${player.host ? '（房主）' : ''} 进入大厅 在线=${room.players.length + room.specs.size}`);
}

function dedupName(name) {
  const used = new Set(room.players.map(p => p.name));
  if (!used.has(name)) return name;
  for (let i = 2; i < 99; i++) {
    const cand = name.slice(0, 10) + i;
    if (!used.has(cand)) return cand;
  }
  return name + Math.floor(Math.random() * 100);
}

function pickColor(want) {
  const used = new Set(room.players.map(p => p.colorIdx));
  if (!used.has(want)) return want;
  for (let i = 0; i < CFG.CAR_COLORS.length; i++) {
    if (!used.has(i)) return i;
  }
  return want;
}

/* ---------------- 开局 / 结算 ---------------- */
function startRace(theme, laps) {
  room.state = 'race';
  room.theme = theme;
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const goAt = Date.now() + 3500;
  // 比赛花名册快照（中途退出者仍参与排名，按进度垫底）
  room.race = {
    players: room.players.map(p => ({
      id: p.id, name: p.name, color: p.colorIdx,
      finish: null, prog: 0, lap: 0,
    })),
    firstFinishAt: 0,
    resultTimer: null,
  };
  broadcast({ t: 'start', theme, laps, seed, goAt });
  broadcast(rosterMsg());
  console.log(`[★] 开局：${theme} ${laps}圈 ${room.players.length}人 seed=${seed}`);
}

/** 收到完赛上报后判定：全员完赛 / 超时 → 结算 */
function checkResults() {
  const race = room.race;
  if (!race || room.state !== 'race') return;
  const now = Date.now();
  if (!race.firstFinishAt) race.firstFinishAt = now;

  const done = (p) => p.finish;
  const allDone = room.players.length > 0 && room.players.every(p => done(p));

  if (allDone) return finishRace();
  if (!race.resultTimer) {
    const wait = CFG.FINISH_WAIT * 1000 - (now - race.firstFinishAt);
    race.resultTimer = setTimeout(() => {
      if (room.state === 'race' && room.race === race) finishRace();
    }, Math.max(1000, wait));
  }
}

function finishRace() {
  const race = room.race;
  if (!race) return;
  if (race.resultTimer) { clearTimeout(race.resultTimer); race.resultTimer = null; }
  // 用最新进度补全未完赛者
  for (const p of room.players) {
    const rp = race.players.find(x => x.id === p.id);
    if (rp && p.lastState) {
      rp.prog = p.lastState.prog;
      rp.lap = p.lastState.lap;
    }
    if (rp && p.finish) rp.finish = p.finish;
  }
  const finished = race.players.filter(p => p.finish).sort((a, b) => a.finish.time - b.finish.time);
  const rest = race.players.filter(p => !p.finish).sort((a, b) => (b.lap * 1000 + b.prog) - (a.lap * 1000 + a.prog));
  const list = [...finished, ...rest].map(p => ({
    id: p.id, name: p.name, color: p.color,
    time: p.finish ? Math.round(p.finish.time * 100) / 100 : null,
    best: p.finish ? Math.round(p.finish.best * 100) / 100 : null,
  }));
  broadcast({ t: 'results', list });
  console.log(`[🏆] 结算：${list.map(r => `${r.name}${r.time ? '#' + (list.indexOf(r) + 1) : 'DNF'}`).join(' ')}`);
  room.state = 'lobby';
  room.race = null;
  for (const p of room.players) { p.finish = null; p.lastState = null; }
  broadcast(rosterMsg());
}

/** 房主回大厅 / 比赛中止 */
function endRace(why) {
  if (room.race && room.race.resultTimer) {
    clearTimeout(room.race.resultTimer);
    room.race.resultTimer = null;
  }
  room.state = 'lobby';
  room.race = null;
  for (const p of room.players) { p.finish = null; p.lastState = null; }
  broadcast({ t: 'reset', why });
  broadcast(rosterMsg());
  console.log(`[↩] 回到大厅（${why}）`);
}

/* ---------------- 断开清理 ---------------- */
function release(ws) {
  if (ws._ipCounted) {
    ws._ipCounted = false;
    const n = (ipCount.get(ws._ip) || 1) - 1;
    if (n <= 0) ipCount.delete(ws._ip); else ipCount.set(ws._ip, n);
  }
  if (ws._spec) {
    room.specs.delete(ws);
    ws._spec = false;
    broadcast(rosterMsg());
    return;
  }
  if (!ws._player) return;
  const p = ws._player;
  ws._player = null;
  const idx = room.players.indexOf(p);
  if (idx === -1) return;
  room.players.splice(idx, 1);

  if (room.state === 'race' && room.race) {
    // 比赛中退出：标记离开，剩余完赛即结算
    console.log(`[!] ${p.name} 比赛中离开`);
    const remaining = room.players;
    broadcast(rosterMsg());
    if (remaining.length === 0) return endRace('empty');
    if (remaining.every(x => x.finish)) return finishRace();
    checkResults();
  } else {
    broadcast(rosterMsg());
  }
  if (p.host) {
    p.host = false;
    promoteHost();
    broadcast(rosterMsg());
  }
}

/* ---- 心跳 ---- */
wss.on('connection', (ws) => {
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) { try { ws.terminate(); } catch (e) {} continue; }
    ws._alive = false;
    try { ws.ping(); } catch (e) {}
  }
}, HEARTBEAT_MS);

/* ---------------- 启动 / 停止（供测试复用） ---------------- */
function start(port, host) {
  if (server.listening) return Promise.resolve(server);
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListen); reject(e); };
    const onListen = () => { server.off('error', onError); resolve(server); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(port, host || '0.0.0.0');
  });
}

function stop() {
  for (const ws of wss.clients) {
    try { ws.terminate(); } catch (e) {}
  }
  room.players = [];
  room.specs.clear();
  room.state = 'lobby';
  room.race = null;
  if (room.race && room.race.resultTimer) clearTimeout(room.race.resultTimer);
  ipCount.clear();
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });
}

module.exports = { server, wss, room, start, stop, startRace, finishRace };

if (require.main === module) {
  start(PORT).then(() => {
    const ips = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list) {
        if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
      }
    }
    console.log('========================================');
    console.log('  🏎️  极速飞车 联机服务器已启动');
    console.log(`  本机访问:   http://localhost:${PORT}/`);
    for (const ip of ips) console.log(`  局域网访问: http://${ip}:${PORT}/`);
    console.log(`  联机规则：≥2 名玩家，房主点击"开始比赛"`);
    console.log('========================================');
  }).catch((e) => {
    console.error('服务器启动失败:', e.message);
    process.exit(1);
  });
}
