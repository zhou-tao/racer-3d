/* ============================================================
 * ai.js —— 电脑车手
 * 在赛道空间里做决策：前瞻走线（切弯）、曲率限速、漂移、
 * 氮气（直道/落后追击）、橡皮筋（落后提速领先略降速）
 * personality：每台 AI 的走线偏移 / 激进度 / 失误率
 * ============================================================ */
(function (root) {
  'use strict';

  const CFG = root.RacerConfig;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class AIDriver {
    constructor(track, sim, level, rng) {
      this.track = track;
      this.sim = sim;
      this.level = level || 1;                    // 速度系数
      this.lineOff = (rng() - 0.5) * 5;           // 走线横向偏移
      this.aggro = 0.5 + rng() * 0.5;             // 漂移/氮气激进度
      this.oops = rng() * 0.06;                   // 失误率：偶尔松油/走歪
      this.baseScale = CFG.AI_LEVELS[Math.min(level - 1, CFG.AI_LEVELS.length - 1)] || 1;
      sim.speedScale = this.baseScale;
      this._errT = 0;
      this._driftHold = 0;
      this._tapHold = 0;       // 点按前进的松油窗口
      this._prevDrift = false;
    }

    /** 玩家进度差 → 橡皮筋（落后加速 / 领先略收） */
    rubber(playerScore) {
      const mine = this.sim.progressScore();
      const diff = clamp((playerScore - mine) / 40000, -1, 1);   // ±1 圈内
      const k = diff > 0
        ? CFG.AI_RUBBER * diff * 2
        : CFG.AI_RUBBER_MAX * diff * 0.55;
      this.sim.speedScale = clamp(this.baseScale * (1 + k), 0.72, 1.3);
    }

    /** 输出 input {throttle, brake, steer, drift} */
    think(dt) {
      const sim = this.sim, track = this.track;
      const spd = Math.max(0, sim.spd);

      /* 前瞻：速度越快看得越远 */
      const lookD = clamp(10 + spd * 0.55, 14, 46);
      const dAhead = sim.d + lookD;
      const curvAhead = track.curvatureAt(dAhead);
      const curvNow = track.curvatureAt(sim.d);
      const curvMax = Math.max(Math.abs(curvNow), Math.abs(curvAhead));

      /* 目标走线：弯心内侧（curv>0 = 左弯 → 往 +lat 切） */
      const latLim = CFG.ROAD_WIDTH / 2 - 3;
      const cut = clamp(curvAhead * 2600, -1, 1) * 4.6;
      let targetLat = clamp(cut + this.lineOff, -latLim, latLim);

      /* 偶发失误：短暂跑偏 */
      this._errT -= dt;
      if (this._errT < -3 && Math.random() < this.oops * dt * 60) this._errT = 0.5 + Math.random();
      if (this._errT > 0) targetLat = -targetLat * 1.4;

      /* 转向：弯道前馈（维持切线跟随的持续角速度）+ 航向修正 */
      const latErr = targetLat - sim.lat;
      const corr = clamp(latErr * 0.09, -0.55, 0.55);
      const wantRel = corr;
      const driftActive = this._driftHold > 0 || !!sim.drift;
      const fade = 1 / (1 + sim.spd * CFG.STEER_FADE);
      const ff = (curvNow * sim.spd) / Math.max(0.2,
        CFG.STEER_RATE * fade * (driftActive ? CFG.DRIFT_STEER_BOOST : 1));
      let steer = clamp(ff + (wantRel - sim.rel) * 1.5, -1, 1);

      /* 目标速度：曲率半径限制 v = sqrt(a_lat / |curv|) */
      const latG = 30 * this.aggro + 6;              // 可用横向加速度
      const vCurve = curvMax > 1e-5 ? Math.sqrt(latG / curvMax) : 999;
      const vTarget = Math.min(sim.effMax(), vCurve);

      let throttle = 0, brake = 0;
      if (spd < vTarget - 1.5) throttle = 1;
      else if (spd > vTarget + 3.5) brake = 1;
      else throttle = 0.5;
      if (this._errT > 0 && Math.random() < 0.3) throttle *= 0.4;

      /* 漂移：急弯 + 速度够 + 角度撑得起来 */
      let drift = false;
      if (this._driftHold > 0) {
        this._driftHold -= dt;
        drift = true;
        if (Math.abs(sim.rel) < 0.12 || spd < 12) this._driftHold = 0;
      } else if (curvMax > 0.0075 && spd > 24 && sim.grounded && Math.random() < this.aggro * dt * 22) {
        drift = true;
        this._driftHold = 0.7 + Math.random() * 0.9;
      }

      /* 模拟"点按前进"触发漂移喷 / 落地喷 / 空喷：
       * 短暂松油一瞬再踩回，形成前进键边沿 */
      if (this._tapHold > 0) { this._tapHold -= dt; throttle = 0; }
      if (this._prevDrift && !sim.drift && sim.grounded) this._tapHold = 0.1;   // 漂移刚结束
      if (!sim.grounded && sim.vy < -1 && sim.airTime > 0.3) this._tapHold = Math.max(this._tapHold || 0, 0.07); // 快落地
      this._prevDrift = !!sim.drift;

      /* 氮气：罐满/直道/追击时喷 */
      const nitroEdge = (sim.charges > 0 && Math.abs(curvAhead) < 0.004 && spd > 20
        && Math.random() < this.aggro * dt * 2.2);

      sim._aiNitroEdge = nitroEdge;
      return { throttle, brake, steer, drift, nitro: nitroEdge };
    }
  }

  root.RacerAI = { AIDriver };
})(window);
