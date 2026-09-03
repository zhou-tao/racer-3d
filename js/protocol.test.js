/* ============================================================
 * protocol.test.js —— 联机消息 schema 校验测试
 * ============================================================ */
'use strict';
const assert = require('assert');
require('./config.js');                 // 提供真实色板长度
const Protocol = require('./protocol.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.error('  ✗', name, '\n   ', e.message); }
}

console.log('protocol.test.js');

t('合法 join 通过并剥除多余字段', () => {
  const v = Protocol.validateJoin({ t: 'join', name: '车手甲', color: 3, hack: 'x', spec: undefined });
  assert(v);
  assert.strictEqual(v.name, '车手甲');
  assert.strictEqual(v.color, 3);
  assert(!('hack' in v));
});

t('join：空名/非法颜色拒绝，超长名截断到 12', () => {
  assert(!Protocol.validateJoin({ name: '   ', color: 0 }));
  const long = Protocol.validateJoin({ name: 'x'.repeat(30), color: 0 });
  assert(long && long.name.length === 12, '超长名应截断到 12');
  assert(!Protocol.validateJoin({ name: 'ok', color: 99 }));
  assert(!Protocol.validateJoin({ name: 'ok', color: 'red' }));
  assert(!Protocol.validateJoin({ nope: 1 }));
});

t('state：合法快照通过', () => {
  const v = Protocol.validateState({ d: 123.4, lat: -3.2, spd: 41.5, rel: -0.4, y: 1.2, g: 1, dr: -1, boost: 0, lap: 12, prog: 0.55 });
  assert(v);
  assert.strictEqual(v.lap, 12);
  assert.strictEqual(v.dr, -1);
  assert.strictEqual(v.g, 1);
});

t('state：NaN / 越界 / 字段缺失拒绝', () => {
  assert(!Protocol.validateState({ d: NaN, lat: 0, spd: 0, rel: 0, y: 0, lap: 0, prog: 0 }));
  assert(!Protocol.validateState({ d: 1e9, lat: 0, spd: 0, rel: 0, y: 0, lap: 0, prog: 0 }));
  assert(!Protocol.validateState({ d: 1, lat: 0, spd: 999, rel: 0, y: 0, lap: 0, prog: 0 }));
  assert(!Protocol.validateState({ d: 1, lat: 0, spd: 1, rel: 0, y: 0, lap: -3, prog: 0 }));
  assert(!Protocol.validateState({ d: 'many', lat: 0, spd: 1, rel: 0, y: 0, lap: 0, prog: 0 }));
  assert(!Protocol.validateState(null));
  assert(!Protocol.validateState([1, 2, 3]));
});

t('finish：合法用时通过，非法拒绝', () => {
  assert(Protocol.validateFinish({ time: 123.45, best: 40.1 }));
  assert(!Protocol.validateFinish({ time: 0, best: 40.1 }));
  assert(!Protocol.validateFinish({ time: 100, best: -1 }));
  assert(!Protocol.validateFinish({ time: 100 }));
});

t('start：主题白名单 + 圈数范围', () => {
  assert(Protocol.validateStart({ theme: 'sky', laps: 3 }));
  assert(!Protocol.validateStart({ theme: 'moon', laps: 3 }));
  assert(!Protocol.validateStart({ theme: 'sky', laps: 99 }));
});

t('roster / startCast / results：结构校验', () => {
  assert(Protocol.validateRoster({
    t: 'roster', state: 'race', specs: 1, theme: 'desert',
    players: [{ id: 1, name: 'a', color: 0, host: true, lap: 3, prog: 0.5, fin: false }],
  }));
  assert(!Protocol.validateRoster({ t: 'roster', players: 'all' }));
  assert(Protocol.validateStartCast({ t: 'start', theme: 'forest', laps: 3, seed: 123, goAt: 999 }));
  assert(!Protocol.validateStartCast({ t: 'start', theme: 'forest', laps: 3, seed: -1, goAt: 1 }));
  assert(Protocol.validateResults({
    t: 'results',
    list: [{ id: 1, name: '车手', color: 2, time: 100, best: 32 }],
  }));
  assert(!Protocol.validateResults({ t: 'results', list: [{ id: 1 }] }));
});

t('中继 st 携带合法 id', () => {
  const v = Protocol.validateStCast({ t: 'st', id: 4, d: 10, lat: 0, spd: 5, rel: 0, y: 0, g: 0, dr: 0, boost: 0, lap: 0, prog: 0.1, fin: 0 });
  assert(v && v.id === 4);
  assert(!Protocol.validateStCast({ t: 'st', d: 10, lat: 0, spd: 5, rel: 0, y: 0, g: 0, dr: 0, boost: 0, lap: 0, prog: 0.1, fin: 0 }));
});

process.exit(failed ? 1 : 0);
