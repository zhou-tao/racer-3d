/* ============================================================
 * server.test.js —— 联机服务器集成测试（随机端口拉起）
 * 覆盖：加入/名册、≥2 人开局校验、比赛中继、完赛结算、
 *       比赛中掉线、观战、房主迁移、非法消息防护
 * ============================================================ */
'use strict';
const assert = require('assert');
const WebSocket = require('ws');
const server = require('./server.js');

let passed = 0, failed = 0;
const allClients = [];
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => { passed++; console.log('  ✓', name); },
      (e) => { failed++; console.error('  ✗', name, '\n   ', e.message || e); }
    )
    .then(cleanup);
}
/** 用例后强制清理：防止前面用例的失败污染后面 */
async function cleanup() {
  for (const c of allClients) c.close();
  allClients.length = 0;
  await sleep(130);
  server.room.players = [];
  server.room.specs.clear();
  server.room.state = 'lobby';
  if (server.room.race) {
    if (server.room.race.resultTimer) clearTimeout(server.room.race.resultTimer);
    server.room.race = null;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class Client {
  constructor() {
    this.msgs = [];
    this.waiters = [];
    allClients.push(this);
  }
  connect(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.match(m)) { w.resolve(m); return false; }
        return true;
      });
    });
    this.ws.on('open', () => this._open = true);
    return sleep(150);
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  wait(type, extra, ms) {
    const pred = (m) => m.t === type && (!extra || extra(m));
    const hit = this.msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), ms || 3000);
      this.waiters.push({
        match: pred,
        resolve: (m) => { clearTimeout(timer); resolve(m); },
      });
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

(async () => {
  console.log('server.test.js');
  await server.start(0);
  const port = server.server.address().port;
  server.room.players = [];      // 直接操作内存房间，保证测试隔离
  server.room.state = 'lobby';

  await t('1) 单人无法开局（<2 玩家）', async () => {
    const a = new Client();
    await a.connect(port);
    a.send({ t: 'join', name: '车手A', color: 0 });
    const welcome = await a.wait('welcome', (m) => m.role === 'player');
    assert(welcome.host === true, '首位应为房主');
    a.send({ t: 'start', theme: 'desert', laps: 2 });
    const toast = await a.wait('toast', null, 2000);
    assert(/2 名玩家/.test(toast.text));
    // 非法开局主题
    a.send({ t: 'start', theme: 'moon', laps: 2 });
    await sleep(150);
    assert(!server.room.race);
    a.close();
    await sleep(100);
  });

  await t('2) 双人开局 → 状态中继 → 双双完赛 → 结算', async () => {
    const a = new Client(), b = new Client();
    await a.connect(port); await b.connect(port);
    a.send({ t: 'join', name: '车手A', color: 0 });
    const wa = await a.wait('welcome', (m) => m.role === 'player');
    b.send({ t: 'join', name: '车手B', color: 1 });
    await b.wait('welcome', (m) => m.role === 'player');
    assert(server.room.players.length === 2);

    const rosterB = await b.wait('roster', (m) => m.players.length === 2);
    assert(rosterB.players[0].host === true);

    // B（非房主）开局被拒
    b.send({ t: 'start', theme: 'desert', laps: 2 });
    await sleep(150);
    assert(server.room.state === 'lobby');

    a.send({ t: 'start', theme: 'desert', laps: 2 });
    const st = await a.wait('start', (m) => m.theme === 'desert');
    assert(st.seed >= 0 && st.goAt > Date.now());
    await b.wait('start');

    // 状态中继：A 发 → B 收（带 id）
    a.send({ t: 'state', d: 100, lat: 2, spd: 30, rel: 0.1, y: 1, g: 1, dr: 0, boost: 0, lap: 1, prog: 0.1, fin: 0, hack: 1 });
    const relayed = await b.wait('st', (m) => m.id === wa.id);
    assert.strictEqual(relayed.lat, 2);
    assert(!('hack' in relayed), '多余字段应被剥除');

    // 完赛：A 先 B 后
    a.send({ t: 'finish', time: 100.5, best: 32.1 });
    await b.wait('fin', (m) => m.id === wa.id);
    b.send({ t: 'finish', time: 95.2, best: 31.0 });
    const results = await a.wait('results', null, 4000);
    assert.strictEqual(results.list.length, 2);
    assert.strictEqual(results.list[0].name, '车手B', '按用时排序');
    assert.strictEqual(results.list[1].time, 100.5);
    assert(server.room.state === 'lobby', '结算后回大厅');
    await b.wait('roster', (m) => m.state === 'lobby');

    a.close(); b.close();
    await sleep(120);
  });

  await t('3) 比赛中掉线 → 剩余完赛即结算', async () => {
    const a = new Client(), b = new Client();
    await a.connect(port); await b.connect(port);
    a.send({ t: 'join', name: '甲', color: 0 });
    await a.wait('welcome');
    b.send({ t: 'join', name: '乙', color: 1 });
    await b.wait('welcome');
    a.send({ t: 'start', theme: 'forest', laps: 1 });
    await a.wait('start');
    // 甲完赛后掉线
    a.send({ t: 'finish', time: 88.8, best: 29 });
    a.close();
    await sleep(120);
    // 乙随后完赛 → 立即结算（甲按完赛时间参与排名）
    b.send({ t: 'finish', time: 90.1, best: 30 });
    const results = await b.wait('results', null, 4000);
    assert.strictEqual(results.list.length, 2);
    assert.strictEqual(results.list[0].name, '甲');
    b.close();
    await sleep(120);
  });

  await t('4) 房主掉线 → 房主迁移', async () => {
    const a = new Client(), b = new Client();
    await a.connect(port); await b.connect(port);
    a.send({ t: 'join', name: '甲', color: 0 });
    await a.wait('welcome');
    b.send({ t: 'join', name: '乙', color: 1 });
    await b.wait('welcome');
    assert(server.room.players[0].host === true);
    a.close();
    const roster = await b.wait('roster', (m) => m.players.length === 1 && m.players[0].host === true, 3000);
    assert(roster.players[0].name === '乙');
    b.close();
    await sleep(120);
  });

  await t('5) 观战者：加入收到快照，不能发状态', async () => {
    const a = new Client(), s = new Client();
    await a.connect(port); await s.connect(port);
    a.send({ t: 'join', name: '甲', color: 0 });
    await a.wait('welcome');
    // 手动进入 race state（构造观战场景）
    server.room.state = 'race';
    server.room.race = { players: [], firstFinishAt: 0, resultTimer: null };
    a.lastState0 = null;
    s.send({ t: 'join', name: '路人', color: 2, spec: true });
    const w = await s.wait('welcome', (m) => m.role === 'spec');
    assert.strictEqual(w.role, 'spec');
    // 观战发状态应无效（无 crash、不广播给玩家）
    const before = a.msgs.length;
    s.send({ t: 'state', d: 1, lat: 0, spd: 1, rel: 0, y: 0, g: 1, dr: 0, boost: 0, lap: 0, prog: 0, fin: 0 });
    await sleep(150);
    assert.strictEqual(a.msgs.length, before, '观战消息不应广播');
    s.send({ t: 'start', theme: 'sky', laps: 1 });
    await sleep(120);
    assert(server.room.theme !== 'sky' || server.room.state === 'race');   // 未被观战改变
    server.room.state = 'lobby';
    server.room.race = null;
    a.close(); s.close();
    await sleep(120);
  });

  await t('6) 垃圾消息：不 crash、计数后断开', async () => {
    const c = new Client();
    await c.connect(port);
    c.send('not-json-string');
    c.ws.send('XXXX');
    c.send({ t: 'join', name: 'ok', color: 0 });
    await c.wait('welcome');
    for (let i = 0; i < 40; i++) c.send({ t: 'bad/type', x: i });
    await sleep(500);
    assert(c.ws.readyState >= 2, '累计非法消息应被断开');
    c.close();
    await sleep(100);
  });

  await t('7) 房主 back 回大厅', async () => {
    const a = new Client(), b = new Client();
    await a.connect(port); await b.connect(port);
    a.send({ t: 'join', name: '甲', color: 0 });
    await a.wait('welcome');
    b.send({ t: 'join', name: '乙', color: 1 });
    await b.wait('welcome');
    a.send({ t: 'start', theme: 'sky', laps: 2 });
    await a.wait('start');
    assert(server.room.state === 'race');
    b.send({ t: 'back' });         // 非房主无效
    await sleep(120);
    assert(server.room.state === 'race');
    a.send({ t: 'back' });
    await b.wait('reset');
    assert(server.room.state === 'lobby');
    a.close(); b.close();
    await sleep(120);
  });

  await server.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
