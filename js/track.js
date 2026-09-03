/* ============================================================
 * track.js —— 赛道生成（纯逻辑 + 几何，不依赖 DOM）
 * 浏览器 window.RacerTrack / Node module.exports 共用。
 *
 * 设计：
 *   - 种子随机 + 主题参数 → 极坐标控制点（带 S 弯/发卡）→
 *     centripetal Catmull-Rom 闭环 → 按弧长等距采样
 *   - 赛道空间坐标：d=沿中心线里程(米)，lat=横向偏移(米)
 *     所有物理都在 (d, lat, y) 里做，护栏=|lat| 越界，简单可靠
 *   - 坡道(跳跃)：直线段上叠加线性上坡 bump + 之后一段 GAP 断崖；
 *     出坡时按坡度给 vy，抛物线落地（空喷/落地喷由此而来）
 *   - 主题差异：沙漠/森林是低洼坑（sand/water），天空之城是
 *     浮岛间隙（void，掉下去重生）
 * ============================================================ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root.THREE);
  else root.RacerTrack = factory(root.THREE);
})(typeof window !== 'undefined' ? window : globalThis, function (THREE) {
  'use strict';

  const CFG = (typeof globalThis !== 'undefined' && globalThis.RacerConfig) || {
    ROAD_WIDTH: 16, SAMPLE_STEP: 2.2, CP_COUNT: 12,
  };
  const ROAD_W = CFG.ROAD_WIDTH;

  /* ---- 主题赛道参数 ---- */
  const THEMES = {
    desert: {
      points: [13, 16], radius: [150, 200], elevAmp: 5,   // 缓起伏
      hairpinChance: 0.18,
      ramps: 2, rampLen: 20, rampH: 3.2, gapLen: 18, pit: 'sand',
    },
    forest: {
      points: [14, 17], radius: [140, 185], elevAmp: 7,
      hairpinChance: 0.22,
      ramps: 2, rampLen: 18, rampH: 2.8, gapLen: 16, pit: 'water',
    },
    sky: {
      points: [12, 15], radius: [130, 175], elevAmp: 15,  // 大起伏浮岛
      hairpinChance: 0.15,
      ramps: 3, rampLen: 22, rampH: 4.2, gapLen: 20, pit: 'void',
    },
  };

  /* mulberry32：种子随机，保证同 seed 同赛道 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Track {
    constructor(theme, seed) {
      const def = THEMES[theme] || THEMES.desert;
      this.theme = theme;
      this.def = def;
      this.seed = seed >>> 0;
      this.rng = mulberry32(this.seed ^ 0x9E3779B9);
      this._buildControlPoints();
      this._buildSamples();
      this._placeFeatures();
    }

    /* ---------------- 控制点 ---------------- */
    _buildControlPoints() {
      const rng = this.rng;
      const def = this.def;
      const n = def.points[0] + Math.floor(rng() * (def.points[1] - def.points[0] + 1));
      const R0 = def.radius[0] + rng() * (def.radius[1] - def.radius[0]);
      const pts = [];
      let lastR = R0;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + (rng() - 0.5) * (Math.PI * 2 / n) * 0.5;
        // 半径抖动 + 少量"内拉"点制造 S 弯 / 发卡
        let r = R0 * (0.78 + rng() * 0.42);
        if (rng() < def.hairpinChance) r = R0 * (0.42 + rng() * 0.16);
        r = r * 0.7 + lastR * 0.3;          // 平滑半径突变
        lastR = r;
        pts.push(new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r));
      }
      // 高程：正弦叠加噪声；钳制 ≥0.4 防止低谷沉入地面平面（地面在 -0.35）
      const amp = def.elevAmp;
      const ph1 = rng() * Math.PI * 2, ph2 = rng() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        let y = Math.sin(t * Math.PI * 2 + ph1) * amp * 0.7
              + Math.sin(t * Math.PI * 4 + ph2) * amp * 0.3
              + (rng() - 0.5) * amp * 0.35;
        if (i === 0 || i === n - 1) y = 0;
        pts[i].y = Math.round(Math.max(y, 0.45) * 10) / 10;
      }
      // 起点两个相邻点也压平，保证出发段水平
      pts[1] && (pts[1].y *= 0.2);
      pts[n - 1] && (pts[n - 1].y *= 0.2);
      this.ctrl = pts;
      this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal', 0.5);
    }

    /* ---------------- 弧长采样 ---------------- */
    _buildSamples() {
      const step = CFG.SAMPLE_STEP;
      const approx = this.curve.getLength();
      const segs = Math.max(64, Math.round(approx / step));
      const pos = [], tan = [];
      for (let i = 0; i < segs; i++) {
        const u = i / segs;
        pos.push(this.curve.getPoint(u));
        tan.push(this.curve.getTangent(u));
      }
      // 实际弧长（相邻点距离累计）
      const dist = [0];
      for (let i = 1; i < segs; i++) dist.push(dist[i - 1] + pos[i].distanceTo(pos[i - 1]));
      dist.push(dist[segs - 1] + pos[0].distanceTo(pos[segs - 1])); // 闭环
      const L = dist[segs];
      this.samples = { pos, tan, dist, count: segs };
      this.length = L;

      // 水平侧向单位向量（side ⊥ 切线的水平分量），与曲率
      const side = [], curv = [];
      const up = new THREE.Vector3(0, 1, 0);
      for (let i = 0; i < segs; i++) {
        const t = tan[i];
        const s = new THREE.Vector3(t.z, 0, -t.x);
        if (s.lengthSq() < 1e-8) s.set(1, 0, 0); else s.normalize();
        side.push(s);
      }
      for (let i = 0; i < segs; i++) {
        const a = tan[(i - 2 + segs) % segs], b = tan[(i + 2) % segs];
        const cross = a.x * b.z - a.z * b.x;         // 有符号水平转角
        const dArc = (dist[(i + 2) % segs] - dist[i] + L) % L + 1e-6;
        curv.push(cross / (dArc || 1));
      }
      this.samples.side = side;
      this.samples.curv = curv;
    }

    /* ---------------- 坡道 / 断崖布置 ---------------- */
    _placeFeatures() {
      const rng = this.rng, def = this.def;
      const L = this.length;
      const n = this.samples.count;
      const feats = [];
      // 三档直度阈值：先严后松，保证一定放得下
      for (const [straightMax, minGap] of [[0.009, 180], [0.014, 180], [0.018, 120]]) {
        const candidates = [];
        const spanLen = def.rampLen + def.gapLen;
        for (let i = 0; i < n; i++) {
          const d = this.samples.dist[i];
          if (d < 90 || d + spanLen + 50 > L - 70) continue;   // 避开起步区与终点区
          let ok = true;
          for (let k = 0; k <= spanLen; k += CFG.SAMPLE_STEP * 2) {
            if (Math.abs(this.curvatureAt(d + k)) > straightMax) { ok = false; break; }
          }
          if (ok) candidates.push(d);
        }
        // rng 洗牌后贪心选取（间隔 ≥180m）
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        for (const d of candidates) {
          if (feats.length >= def.ramps) break;
          if (feats.every(f => Math.abs(d - f.a) > minGap)) {
            feats.push({ a: d, b: d + def.rampLen, h: def.rampH * (0.85 + rng() * 0.4), gap: def.gapLen });
          }
        }
        if (feats.length >= def.ramps) break;
      }
      feats.sort((p, q) => p.a - q.a);
      this.features = feats;
      // 坑/深谷坠落判定深度：沙水坑浅（快溅落快重生），天空深渊深
      this.pitDepth = def.pit === 'void' ? 60 : 2.6;
    }

    _idxAtDist(d) {
      const { dist, count } = this.samples;
      const dd = ((d % this.length) + this.length) % this.length;
      let lo = 0, hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (dist[mid] <= dd) lo = mid; else hi = mid - 1;
      }
      return lo;
    }

    /* ---------------- 查询接口 ---------------- */

    /** 采样插值：返回 {i, t}（i 及下一采样间的线性系数） */
    _lerpAt(d) {
      const { pos, count } = this.samples;
      const dd = ((d % this.length) + this.length) % this.length;
      const i = this._idxAtDist(dd);
      const j = (i + 1) % count;
      const span = this.samples.dist[j] - this.samples.dist[i];
      const t = span > 1e-6 ? (dd - this.samples.dist[i]) / span : 0;
      return { i, j, t: Math.max(0, Math.min(1, t)) };
    }

    /** 中心线点（含高程） */
    pointAt(d) {
      const { i, j, t } = this._lerpAt(d);
      const a = this.samples.pos[i], b = this.samples.pos[j];
      return new THREE.Vector3(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t
      );
    }

    /** 切线单位向量（含坡度） */
    tangentAt(d) {
      const { i, j, t } = this._lerpAt(d);
      const a = this.samples.tan[i], b = this.samples.tan[j];
      return new THREE.Vector3(
        a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t
      ).normalize();
    }

    /** 水平侧向单位向量（右侧为正 lat） */
    sideAt(d) {
      const { i, j, t } = this._lerpAt(d);
      const a = this.samples.side[i], b = this.samples.side[j];
      return new THREE.Vector3(
        a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t
      ).normalize();
    }

    /** 有符号曲率（用于 AI 刹车/漂移决策） */
    curvatureAt(d) {
      const { i, j, t } = this._lerpAt(d);
      return this.samples.curv[i] * (1 - t) + this.samples.curv[j] * t;
    }

    /** 坡道 bump 高度（叠加在基础高程上） */
    _bumpAt(d) {
      const dd = ((d % this.length) + this.length) % this.length;
      let h = 0;
      for (const f of this.features) {
        if (dd >= f.a && dd <= f.b) {
          h = Math.max(h, f.h * (dd - f.a) / (f.b - f.a));   // 线性上坡
        }
      }
      return h;
    }

    /** 当前里程是否处于断崖 GAP（无路面） */
    inGap(d) {
      const dd = ((d % this.length) + this.length) % this.length;
      for (const f of this.features) {
        if (dd > f.b && dd < f.b + f.gap) return true;
      }
      return false;
    }

    /** 出坡点坡度（供起跳 vy = spd * slope） */
    rampSlopeAt(d) {
      const dd = ((d % this.length) + this.length) % this.length;
      for (const f of this.features) {
        if (dd >= f.b - 2 && dd <= f.b + 1) return f.h / (f.b - f.a);
      }
      return 0;
    }

    gapStart(d) {
      const dd = ((d % this.length) + this.length) % this.length;
      for (const f of this.features) {
        if (dd > f.b - 3 && dd <= f.b + f.gap) return f.b;
      }
      return -1;
    }

    /** 路面高度（含坡道）；GAP 段返回 NaN */
    roadHeightAt(d) {
      if (this.inGap(d)) return NaN;
      return this.pointAt(d).y + this._bumpAt(d);
    }

    /** 掉落判定：低于路面此深度视为坠落 */
    get fallDepth() { return this.pitDepth; }
    get pitKind() { return this.def.pit; }

    /** 赛道空间 → 世界坐标 */
    worldFromTrack(d, lat, yExtra) {
      const p = this.pointAt(d);
      const s = this.sideAt(d);
      const y = this.inGap(d) ? p.y : this.roadHeightAt(d);
      return new THREE.Vector3(
        p.x + s.x * lat,
        (isNaN(y) ? p.y : y) + (yExtra || 0),
        p.z + s.z * lat
      );
    }

    /** 就近路面上位置（重生/复位用）：hint 附近局部搜索 */
    nearest(x, z, hint) {
      const { pos, count } = this.samples;
      let best = -1, bestD2 = Infinity;
      const scan = (i0, i1, wrapLen) => {
        for (let k = i0; k <= i1; k++) {
          const idx = ((k % count) + count) % count;
          const dx = pos[idx].x - x, dz = pos[idx].z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < bestD2) { bestD2 = d2; best = idx; }
        }
      };
      if (hint === undefined || hint === null || !isFinite(hint)) {
        scan(0, count - 1);
      } else {
        const hintIdx = this._idxAtDist(hint);
        const win = Math.ceil(90 / CFG.SAMPLE_STEP);
        scan(hintIdx - win, hintIdx + win);
      }
      if (best < 0) best = 0;
      const p = pos[best];
      const s = this.samples.side[best];
      const lat = (x - p.x) * s.x + (z - p.z) * s.z;
      return { d: this.samples.dist[best], lat: Math.max(-ROAD_W / 2, Math.min(ROAD_W / 2, lat)) };
    }

    /** 圈进度 0~1 与检查点序号 */
    progressOf(d) {
      return (((d % this.length) + this.length) % this.length) / this.length;
    }
    cpIndexAt(d) {
      return Math.floor(this.progressOf(d) * CFG.CP_COUNT) % CFG.CP_COUNT;
    }

    /** 起跑格位（从前到后）：pole 在终点线之后 10m，每排 2 辆、间隔 7m */
    startGrid(n) {
      const slots = [];
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / 2);
        const col = i % 2;
        slots.push({
          d: 10 + row * 7,
          lat: col === 0 ? -4.2 : 4.2,
          heading: 0,
        });
      }
      return slots;
    }

    /** 小地图折线（归一化 0~1）+ 起点标记 */
    minimapData() {
      const pts = [];
      const { pos, count } = this.samples;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pos) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      }
      const pad = 0.14;                    // 上下左右留白比例
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      const span = Math.max(maxX - minX, maxZ - minZ) || 1;
      const project = (x, z) => [
        0.5 + ((x - cx) / span) * (1 - pad * 2),
        0.5 + ((z - cz) / span) * (1 - pad * 2),
      ];
      for (let i = 0; i < count; i += 3) pts.push(project(pos[i].x, pos[i].z));
      pts.push(pts[0]);
      const start = pos[0], st = this.samples.tan[0];
      return {
        pts,
        start: project(start.x, start.z),
        startAng: Math.atan2(st.x, st.z),
        project,
      };
    }

    /** 检查点世界坐标（渲染检查门用） */
    cpGate(cp) {
      const d = (cp / CFG.CP_COUNT) * this.length;
      return { d, center: this.pointAt(d), side: this.sideAt(d), half: ROAD_W / 2 };
    }
  }

  Track.THEMES = THEMES;
  Track.mulberry32 = mulberry32;
  return Track;
});
