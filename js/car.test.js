/* ============================================================
 * car.test.js —— CarSim 物理测试
 * 油门跑圈 / 漂移集氮 / 氮气喷射 / 飞坡空喷与落地喷 / 坠落重生
 * ============================================================ */
'use strict';
global.THREE = require('../lib/three.min.js');
global.window = global;
require('./config.js');
const CFG = require('./config.js');
const Track = require('./track.js');
const { CarSim } = require('./car.js');

const assert = require('assert');
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.error('  ✗', name, '\n   ', e.message); }
}

const DT = 1 / 60;
function simulate(sim, seconds, inputFn, events) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const input = inputFn(sim, i);
    sim.update(DT, input, input.nitroEdge || false);
  }
}

console.log('car.test.js');

const track = new Track('desert', 42);

t('全油门可跑完整圈并计圈', () => {
  const sim = new CarSim(track, { laps: 3, startD: 10, startLat: 0, name: 'T' });
  sim.timing = true;
  let finished = false, maxSpd = 0;
  sim.onEvent = (type) => { if (type === 'finish') finished = true; };
  // 呆瓜司机：每 1.5s 换向的蛇形满舵（新转向模型下恒定小舵无法过弯）
  for (let i = 0; i < 60 * 200 && !finished; i++) {
    const sg = (Math.floor(i / 90) % 2 === 0 ? 1 : -1) * 0.4;
    sim.update(DT, { throttle: 1, brake: 0, steer: sg, drift: false }, false);
    maxSpd = Math.max(maxSpd, sim.spd);
  }
  assert(finished, `200s 内未完赛 cpSeq=${sim.cpSeq} d=${sim.d.toFixed(0)}/${track.length.toFixed(0)}`);
  assert(sim.totalTime < 200, `单圈过慢 total=${sim.totalTime}`);
  assert(maxSpd > CFG.MAX_SPEED * 0.8, `极速异常 ${maxSpd}`);
});

t('倒计时阶段不计时', () => {
  const sim = new CarSim(track, { laps: 1, startD: 10 });
  assert.strictEqual(sim.timing, false);
  sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, false);
  assert.strictEqual(sim.raceTime, 0);
});

t('漂移持续集氮，集满转化为罐', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  // 先加速
  simulate(sim, 4, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  const spdBefore = sim.spd;
  assert(spdBefore > CFG.DRIFT_ENTER_SPD, `加速失败 ${spdBefore}`);
  // 漂移 6 秒（按住转向）
  let full = 0;
  sim.onEvent = (type) => { if (type === 'nitroFull') full++; };
  simulate(sim, 6, () => ({ throttle: 1, brake: 0, steer: 1, drift: true }));
  assert(sim.charges >= 1, `未集满罐 charges=${sim.charges} nitro=${sim.nitro.toFixed(1)}`);
  assert(full >= 1);
  assert(sim.drift || sim.rel !== 0, '漂移状态异常');
});

t('氮气喷射提升极速且有持续时间', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  simulate(sim, 6, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  // 手动注满 1 罐（baseMax 取纯极速，排除落地喷等瞬时加成的干扰）
  sim.charges = 1;
  const baseMax = CFG.MAX_SPEED * sim.speedScale;
  sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, true);  // 按下氮气
  assert.strictEqual(sim.charges, 0, '未消耗罐');
  assert(sim.nitroT > CFG.NITRO_BOOST_TIME - DT * 2, '喷射未生效');
  assert(Math.abs(sim.effMax() - baseMax * CFG.NITRO_MAX_MULT) < 0.01, '极速倍率未生效');
});

t('空喷：空中点按一次前进，免费且每次滞空限一次', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  simulate(sim, 4, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  // 强制进入滞空
  sim.grounded = false;
  sim.vy = 3;
  sim.airTime = 0.2;
  sim.airBoostUsed = false;
  // 先松油一帧（制造边沿）
  sim.update(DT, { throttle: 0, brake: 0, steer: 0, drift: false }, false);
  const spdBefore = sim.spd;
  sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, false);  // 点按 → 空喷
  assert(sim.airBoostUsed === true, '空喷未标记');
  assert(sim.spd > spdBefore + CFG.AIR_BOOST_SPD - 1, `空喷未加速 ${spdBefore}→${sim.spd}`);
  assert(sim.airT > 0, '空喷加速计时未生效');
  // 同一次滞空第二次点按无效（空喷不复用，也不消耗氮气罐）
  sim.charges = 2;
  const spd2 = sim.spd;
  sim.update(DT, { throttle: 0, brake: 0, steer: 0, drift: false }, false);
  sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, false);
  assert.strictEqual(sim.charges, 2, '空喷不应消耗氮气罐');
  assert(sim.spd - spd2 < CFG.AIR_BOOST_SPD - 1, '第二次点按不应再空喷');
});

t('氮气键在空中消耗罐喷射（与空喷独立）', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  simulate(sim, 4, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  sim.grounded = false; sim.vy = 2; sim.airTime = 0.3;
  sim.charges = 1;
  sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, true);   // 空中按氮气
  assert.strictEqual(sim.charges, 0, '空中氮气应消耗罐');
  assert(sim.nitroT > CFG.NITRO_BOOST_TIME - DT * 2, '空中喷射未生效');
});

t('漂移喷：结束漂移后 0.5s 内点按前进', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  simulate(sim, 4, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  // 漂移 1.5s
  simulate(sim, 1.5, () => ({ throttle: 1, brake: 0, steer: 1, drift: true }));
  // 松漂移（driftTapT=0.5s 开始计时），同时松油
  sim.update(DT, { throttle: 0, brake: 0, steer: 0, drift: false }, false);
  sim.update(DT, { throttle: 0, brake: 0, steer: 0, drift: false }, false);
  // 点按前进 → 漂移喷
  let jet = false;
  sim.onEvent = (type) => { if (type === 'driftJet') jet = true; };
  sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, false);
  assert(jet, '漂移喷未触发');
  assert(sim.landT > 0.4, `漂移喷加速未生效 landT=${sim.landT.toFixed(2)}`);
});

t('落地喷：落地瞬间点按前进触发，超时无效', () => {
  const f = track.features[0];
  const sim = new CarSim(track, { laps: 1, startD: f.a - 120 });
  sim.timing = true;
  let launched = false, landed = false, landingEvent = false;
  sim.onEvent = (type) => {
    if (type === 'launch') launched = true;
    if (type === 'landingReady') landingEvent = true;
    if (type === 'landing') landed = true;   // 现语义：落地喷成功
  };
  let thr = 1;
  for (let i = 0; i < 60 * 20 && !landed; i++) {
    if (launched && !sim.grounded) {
      thr = 0;                                          // 空中松油（避免误触空喷）
      if (sim.grounded === false && sim.airTime > 0.5 && sim.vy < 0) thr = 0;
    }
    // 落地后的下一帧立刻点按
    if (landingEvent && sim.landTapT > 0 && thr === 0) thr = 1;
    sim.update(DT, { throttle: thr, brake: 0, steer: 0, drift: false }, false);
    if (sim.d > f.b + f.gap + 80) break;
  }
  assert(landingEvent, '未出现落地喷机会（落地就绪）');
  assert(landed, '点按后落地喷未触发');
});

t('漂移中撞墙 = 漂移失败，且接触期间不集氮', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  simulate(sim, 4, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  let failed = false, contactDriftFrames = 0;
  sim.onEvent = (type) => { if (type === 'driftFail') failed = true; };
  // 满舵朝右墙漂移（反弹离墙后漂移可重新起，但贴墙帧必须无漂移）
  for (let i = 0; i < 60 * 3; i++) {
    sim.update(DT, { throttle: 1, brake: 0, steer: -1, drift: true }, false);
    if (sim._wallContact && sim.drift) contactDriftFrames++;
  }
  assert(failed, '漂移撞墙未判定失败');
  assert.strictEqual(contactDriftFrames, 0, `贴墙期间带漂移 ${contactDriftFrames} 帧`);
});

t('飞坡：起跳→滞空→落地（落地喷由点按触发，见专项用例）', () => {
  // 找一个坡道，从坡前 120m 处全速冲
  const f = track.features[0];
  const sim = new CarSim(track, { laps: 1, startD: f.a - 120 });
  sim.timing = true;
  let launched = false;
  sim.onEvent = (type) => {
    if (type === 'launch') launched = true;
  };
  let sawAir = false;
  for (let i = 0; i < 60 * 20; i++) {
    sim.update(DT, { throttle: 1, brake: 0, steer: 0, drift: false }, false);
    if (!sim.grounded) sawAir = true;
    if (sim.landTapT > 0) break;                 // 落地喷窗口出现 = 成功落地
    if (sim.d > f.b + f.gap + 60) break;
  }
  assert(launched, '未起跳');
  assert(sawAir, '未进入滞空');
  assert(sim.landTapT > 0 || sim.grounded, '未落地');
  assert(sim.grounded, '落地后应着地');
});

t('低速冲坡跳不过断崖 → 坠落重生到检查点', () => {
  const f = track.features[0];
  const sim = new CarSim(track, { laps: 1, startD: f.a - 40 });
  sim.timing = true;
  let fell = false;
  sim.onEvent = (type) => { if (type === 'fallRespawn') fell = true; };
  for (let i = 0; i < 60 * 20 && !fell; i++) {
    sim.update(DT, { throttle: 0.1, brake: 0, steer: 0, drift: false }, false);  // 慢速
  }
  assert(fell, '慢速应坠落');
  assert(sim.frozen > 0, '重生应有冻结惩罚');
  assert(sim.grounded && !track.inGap(sim.d), '重生点应在路面');
});

t('撞护栏被限制在路面上', () => {
  const sim = new CarSim(track, { laps: 1, startD: 300 });
  sim.timing = true;
  simulate(sim, 3, () => ({ throttle: 1, brake: 0, steer: -1, drift: false }));
  for (let i = 0; i < 60 * 6; i++) {
    sim.update(DT, { throttle: 1, brake: 0, steer: -1, drift: false }, false);
  }
  const lim = CFG.ROAD_WIDTH / 2;
  assert(Math.abs(sim.lat) <= lim + 0.6, `横向越界 lat=${sim.lat}`);
  assert(sim.spd > 5, '撞墙后应仍可行驶');
});

t('倒车穿过起点不会刷圈（检查点顺序保护）', () => {
  const sim = new CarSim(track, { laps: 3, startD: track.length - 6, startLat: 0 });
  sim.timing = true;
  // 倒车 3 秒（倒着穿过起点线），再前进
  simulate(sim, 3, () => ({ throttle: 0, brake: 1, steer: 0, drift: false }));
  const cpSeqAfterReverse = sim.cpSeq;
  simulate(sim, 4, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  assert(sim.cpSeq <= cpSeqAfterReverse + 2, `cpSeq 异常增长 ${cpSeqAfterReverse}→${sim.cpSeq}`);
});

t('progressScore 随前进单调增加', () => {
  const sim = new CarSim(track, { laps: 1, startD: 100 });
  sim.timing = true;
  const s0 = sim.progressScore();
  simulate(sim, 3, () => ({ throttle: 1, brake: 0, steer: 0, drift: false }));
  assert(sim.progressScore() > s0 + 1000);
});

t('snapshot 输出联机协议字段', () => {
  const sim = new CarSim(track, { laps: 1, startD: 50 });
  sim.timing = true;
  simulate(sim, 1, () => ({ throttle: 1, brake: 0, steer: 0.2, drift: false }));
  const snap = sim.snapshot();
  for (const k of ['d', 'lat', 'spd', 'rel', 'y', 'g', 'dr', 'boost', 'lap', 'prog', 'fin']) {
    assert(k in snap, `缺少字段 ${k}`);
  }
  assert(typeof snap.d === 'number' && isFinite(snap.d));
});

process.exit(failed ? 1 : 0);
