/* ============================================================
 * track.test.js —— 赛道生成不变量（三主题 × 多种子）
 * ============================================================ */
'use strict';
global.THREE = require('../lib/three.min.js');
global.window = global;          // config.js 双端挂载
require('./config.js');
const Track = require('./track.js');
const CFG = require('./config.js');

const assert = require('assert');
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.error('  ✗', name, '\n   ', e.message); }
}

console.log('track.test.js');

for (const theme of ['desert', 'forest', 'sky']) {
  for (const seed of [1, 42, 20260903]) {
    const track = new Track(theme, seed);

    t(`${theme}#${seed}：闭环长度合理（800~2600m）`, () => {
      assert(track.length > 800 && track.length < 2600, `L=${track.length}`);
    });

    t(`${theme}#${seed}：采样/切线/侧向一致且单位化`, () => {
      for (let d = 0; d < track.length; d += 97.3) {
        const tan = track.tangentAt(d);
        const side = track.sideAt(d);
        assert(Math.abs(tan.length() - 1) < 1e-3);
        assert(Math.abs(side.length() - 1) < 1e-3);
        assert(Math.abs(side.y) < 1e-6);
        assert(Math.abs(tan.x * side.x + tan.z * side.z) < 0.02);   // 水平正交
      }
    });

    t(`${theme}#${seed}：roadHeight 连续且与 pointAt 高程吻合`, () => {
      let prev = track.roadHeightAt(0), prevD = 0;
      assert(!isNaN(prev));
      for (let d = 1; d < track.length; d += 3.1) {
        const h = track.roadHeightAt(d);
        if (isNaN(h)) continue;                    // GAP 段跳过
        // 跨越断崖 GAP 的两点允许高差（本就是跳台落差）
        // 采样步长 3.1m，跨度异常大说明中间是 GAP
        const crossGap = track.inGap(prevD) || track.inGap(d) || (d - prevD > CFG.SAMPLE_STEP * 3);
        if (!crossGap) {
          assert(Math.abs(h - prev) < 1.6, `d=${d} Δ=${Math.abs(h - prev)}`);
        }
        const base = track.pointAt(d).y;
        assert(h >= base - 0.01 && h <= base + 8, `h=${h} base=${base}`);
        prev = h; prevD = d;
      }
    });

    t(`${theme}#${seed}：坡道与断崖配置正确`, () => {
      assert(track.features.length === Track.THEMES[theme].ramps,
        `features=${track.features.length}`);
      for (const f of track.features) {
        assert(f.b > f.a && f.gap > 8);
        assert(track.inGap(f.b + f.gap / 2) === true, 'gap 中段应为空');
        assert(track.inGap(f.a + 1) === false, '坡道上应有路面');
        assert(Math.abs(track.rampSlopeAt(f.b) - f.h / (f.b - f.a)) < 1e-6);
        assert(f.a > 90 && f.b + f.gap + 50 < track.length - 20, '避开起终点');
      }
    });

    t(`${theme}#${seed}：startGrid 槽位在起点附近且互不重叠`, () => {
      const grid = track.startGrid(8);
      assert.strictEqual(grid.length, 8);
      for (const g of grid) {
        assert(g.d >= 0 && g.d < 80);
        assert(Math.abs(g.lat) <= CFG.ROAD_WIDTH / 2);
        assert(!track.inGap(g.d));
      }
    });

    t(`${theme}#${seed}：nearest 恢复赛道坐标`, () => {
      const d0 = track.length * 0.37, lat0 = 4;
      const w = track.worldFromTrack(d0, lat0, 0);
      const near = track.nearest(w.x, w.z, d0);
      const dd = Math.abs(((near.d - d0 + track.length * 1.5) % track.length) - track.length / 2);
      assert(dd < 4, `d 误差 ${dd}`);
      assert(Math.abs(near.lat - lat0) < 1.5, `lat 误差 ${Math.abs(near.lat - lat0)}`);
    });

    t(`${theme}#${seed}：小地图数据归一化`, () => {
      const mm = track.minimapData();
      assert(mm.pts.length > 50);
      for (const [x, y] of mm.pts) {
        assert(x >= 0 && x <= 1 && y >= 0 && y <= 1);
      }
      assert(typeof mm.project(10, 10) === 'object');
    });

    t(`${theme}#${seed}：同种子可复现`, () => {
      const t2 = new Track(theme, seed);
      assert(Math.abs(t2.length - track.length) < 1e-6);
      assert.strictEqual(t2.features.length, track.features.length);
      assert(track.features.length > 0, '坡道数量为 0');
      assert(Math.abs(t2.features[0].a - track.features[0].a) < 1e-6);
    });
  }
}

process.exit(failed ? 1 : 0);
