/* ============================================================
 * car.js —— 赛车：QQ飞车风格卡丁车模型 + 赛道空间物理
 *
 *  CarModel —— 纯 Three.js 图元拼装的大轮小车身（Q 版卡丁车）：
 *    圆润车壳 + 座舱玻璃 + 头盔车手 + 大尾翼 + 双排气 + 大脚轮
 *  CarSim  —— 赛道空间 (d 里程, lat 横向, y 高度) 街机物理：
 *    - 漂移：Shift+方向，车身偏移甩尾、横向滑移、持续集氮
 *    - 氮气：集满 100 = 1 罐（最多 2 罐），喷射极速+火焰
 *    - 空喷：滞空中按氮气，免费前冲+上抬（每次滞空限一次）
 *    - 落地喷：滞空足够长落地自动小喷
 *    - 护栏、坠落重生、检查点计圈（防倒车刷圈）
 *  纯逻辑，可在 Node 下跑测试；渲染装饰由 effects.js 挂载。
 * ============================================================ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root.RacerConfig || require('./config.js'));
  } else {
    root.RacerCar = factory(root.RacerConfig);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (CFG) {
  'use strict';

  const ROAD_W = CFG.ROAD_WIDTH;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ============================================================
   * CarSim —— 物理模拟
   * event(type, data)：driftStart/driftEnd/nitroUse/airBoost/
   *   landing/wallHit/fallRespawn/lap/finish/cp
   * ============================================================ */
  class CarSim {
    constructor(track, opts) {
      opts = opts || {};
      this.track = track;
      this.isPlayer = !!opts.isPlayer;
      this.colorIdx = opts.colorIdx || 0;
      this.name = opts.name || '';
      this.laps = opts.laps || CFG.LAPS;
      this.onEvent = opts.onEvent || function () {};
      this.speedScale = opts.speedScale || 1;   // AI 难度 / 橡皮筋

      this.reset(opts.startD || 10, opts.startLat || 0);
      this.raceTime = 0;
      this.timing = false;       // 倒计时结束由比赛控制器置 true
      this.finished = false;
      this.totalTime = 0;
      this.bestLap = Infinity;
      this.lapTimes = [];
      this.wrongWayT = 0;
    }

    reset(d, lat) {
      this.d = d;
      this.lat = lat;
      this.spd = 0;
      this.rel = 0;              // 车头相对切线角（+ = 偏向 +lat 侧）
      this.y = this.track.roadHeightAt(d) || 0;
      this.vy = 0;
      this.grounded = true;
      this.airTime = 0;
      this.airBoostUsed = false;
      this.lastSlope = 0;

      this.steerVis = 0;         // 前轮视觉转角
      this.steerSmooth = 0;      // 平滑后的转向输入（数字键盘 → 模拟量）
      this.courseRel = 0;        // 速度航迹角（相对切线；追踪车头 → 甩尾/滑移感）
      this.drift = null;         // {dir: ±1, t}
      this.driftTapT = 0;        // 漂移喷点按窗口倒计时
      this.landTapT = 0;         // 落地喷点按窗口倒计时
      this._prevThrottle = false;
      this._wallContact = false;

      this.nitro = 0;            // 0~100 集气
      this.charges = 0;          // 已存氮气罐
      this.nitroT = 0;           // 喷射剩余时间
      this.airT = 0;             // 空喷加速剩余
      this.landT = 0;            // 落地喷剩余

      this.cpSeq = 0;            // 顺序通过的检查点总数
      this.lastCP = this.track.cpIndexAt(d);
      this.lastCpD = 0;
      this.lap = 0;              // 已完成整圈数
      this.frozen = 0;           // 重生冻结倒计时
    }

    get boostingNow() { return this.nitroT > 0 || this.airT > 0 || this.landT > 0; }

    /** 当前有效极速 */
    effMax() {
      let m = CFG.MAX_SPEED * this.speedScale;
      if (this.nitroT > 0) m *= CFG.NITRO_MAX_MULT;
      if (this.airT > 0) m *= 1.18;
      if (this.landT > 0) m *= 1.25;
      return m;
    }

    /**
     * @param dt      秒
     * @param input   {throttle, brake, steer(+1=左/-1=右), drift, nitro}
     * @param nitroEdge 氮气键刚按下（边沿）
     */
    update(dt, input, nitroEdge) {
      if (this.finished) { input = { throttle: 0, brake: 0, steer: 0, drift: false }; }
      if (!this.finished && this.timing) this.raceTime += dt;   // 倒计时阶段不计成绩
      if (this.frozen > 0) {
        this.frozen -= dt;
        this.spd = 0;
        return;
      }

      const track = this.track;
      const dPrev = this.d;

      /* ---- 漂移状态机 ---- */
      const throttleEdge = input.throttle > 0 && !this._prevThrottle;   // 前进键点按（边沿）
      const wantDrift = input.drift && this.spd > CFG.DRIFT_ENTER_SPD && !this._wallContact;
      if (this.grounded) {
        if (!this.drift && wantDrift && Math.abs(input.steer) > 0.1) {
          this.drift = { dir: input.steer > 0 ? 1 : -1, t: 0 };
          this.onEvent('driftStart', { dir: this.drift.dir });
        } else if (this.drift) {
          this.drift.t += dt;
          const keep = input.drift && this.spd > 8;
          if (!keep) {
            this.onEvent('driftEnd', { dir: this.drift.dir, t: this.drift.t });
            this.driftTapT = 0.5;               // 结束瞬间快速按↑ → 漂移喷
            this.drift = null;
          }
        }
      } else if (this.drift) {
        this.drift = null;   // 起跳中断漂移
        this.onEvent('driftEnd', { t: 0 });
      }

      /* ---- 点按喷射判定（空喷 / 落地喷 / 漂移喷）---- */
      if (this.driftTapT > 0) this.driftTapT -= dt;
      if (this.landTapT > 0) this.landTapT -= dt;
      if (throttleEdge && !this.grounded) {
        // 空喷：空中快速按一次前进，每次滞空限一次
        if (!this.airBoostUsed && this.airTime > 0.12) {
          this.airBoostUsed = true;
          this.spd += CFG.AIR_BOOST_SPD;
          this.vy = Math.max(this.vy, CFG.AIR_BOOST_VY);
          this.airT = CFG.AIR_BOOST_TIME;
          this.onEvent('airBoost', { spd: this.spd });
        }
      } else if (throttleEdge && this.grounded) {
        if (this.landTapT > 0) {
          // 落地喷：落地那一刻快速按一次前进
          this.landTapT = 0;
          this.landT = Math.max(this.landT, CFG.LANDING_BOOST_TIME);
          this.onEvent('landing', { tapped: true, impact: 0 });
        } else if (this.driftTapT > 0) {
          // 漂移喷：漂移结束快速按一次前进
          this.driftTapT = 0;
          this.landT = Math.max(this.landT, 0.55);
          this.onEvent('driftJet', {});
        }
      }
      this._prevThrottle = input.throttle > 0;

      /* ---- 转向输入平滑（满舵约 0.2s 渐进，消除键盘窜动）---- */
      const sRate = Math.abs(input.steer) > Math.abs(this.steerSmooth)
        ? CFG.STEER_ATTACK : CFG.STEER_RELEASE;
      this.steerSmooth += clamp(input.steer - this.steerSmooth, -sRate * dt, sRate * dt);
      const steerIn = this.steerSmooth;

      /* ---- 车头（heading）：转向给持续角速度 ----
       *  - 弯道几何项：切线随里程旋转，rel 相应减小（沿曲线行驶必需）
       *  - 打舵：轻自阻尼（保留转向权威）
       *  - 松手：循迹伺服——车头以 HEADING_ASSIST_RATE 主动对齐切线，
       *    每帧清掉几何项带来的偏角 → 不打舵也基本沿路行驶 */
      const fade = 1 / (1 + this.spd * CFG.STEER_FADE);
      let steerRate = steerIn * CFG.STEER_RATE * fade;
      if (this.drift) steerRate *= CFG.DRIFT_STEER_BOOST;
      const curv = track.curvatureAt(this.d);
      this.rel += (steerRate - curv * this.spd * Math.cos(this.courseRel)) * dt;
      const idleSteer = Math.abs(steerIn) < 0.12;
      if (this.drift) {
        this.rel -= this.rel * clamp(CFG.DRIFT_HEADING_DAMP * dt, 0, 0.5);
      } else if (idleSteer) {
        // 循迹伺服：目标 = 回中 + 近场弯道补偿（小增益+钳制，防过冲蛇形）
        const curvNear = track.curvatureAt(this.d + 8);
        const target = clamp(-this.lat * 0.045 + curvNear * (10 + this.spd * 0.35) * 0.6, -0.16, 0.16);
        const err = target - this.rel;
        this.rel += clamp(err, -CFG.HEADING_ASSIST_RATE * dt, CFG.HEADING_ASSIST_RATE * dt);
      } else {
        this.rel -= this.rel * clamp(CFG.HEADING_DAMP * dt, 0, 0.6);
      }
      const maxRel = this.drift ? 1.05 : 0.82;
      this.rel = clamp(this.rel, -maxRel, maxRel);

      /* ---- 航迹角（velocity course）：按抓地向车头收敛 ----
       * 差值 = 滑移角；普通驾驶快速贴合（轨迹跟着车头弯），
       * 漂移时贴合慢 → 车头甩出去、轨迹扫外侧；
       * 松方向时航迹也加辅助 → 出弯残余滑移快速收敛，基本沿路走 */
      const chase = this.drift ? CFG.DRIFT_GRIP : CFG.GRIP;
      this.courseRel += (this.rel - this.courseRel) * clamp(chase * dt, 0, 1);
      if (idleSteer && !this.drift) {
        this.courseRel -= this.courseRel * clamp(CFG.COURSE_ASSIST_FREE * dt, 0, 1);
      }

      /* ---- 纵向动力 ---- */
      const effMax = this.effMax();
      if (input.throttle > 0) {
        const a = CFG.ACCEL * (this.nitroT > 0 ? CFG.NITRO_ACCEL_MULT : 1);
        this.spd += a * (1 - clamp(this.spd / effMax, 0, 1)) * input.throttle * dt;
      } else {
        this.spd -= this.spd * CFG.DRAG * dt + (this.spd > 0 ? 3.5 * dt : 0);
      }
      if (input.brake > 0) {
        if (this.spd > 0.5) this.spd -= CFG.BRAKE * input.brake * dt;
        else this.spd = Math.max(this.spd - 12 * dt, -CFG.REVERSE_MAX);
      }
      if (this.drift) this.spd -= this.spd * 0.035 * dt;   // 漂移略掉速
      if (this.spd > effMax) this.spd = lerp(this.spd, effMax, clamp(3 * dt, 0, 1));

      /* ---- 氮气：集气 / 存储（贴墙刮蹭期间不集氮）---- */
      if (this.drift && this.spd > CFG.NITRO_GAIN_MIN_SPD && !this._wallContact) {
        const q = clamp(this.spd / CFG.MAX_SPEED, CFG.NITRO_GAIN_FLOOR, 1.2);
        this.nitro += CFG.NITRO_GAIN_RATE * q * dt;
      }
      while (this.nitro >= CFG.NITRO_MAX) {
        if (this.charges < CFG.NITRO_CHARGES_MAX) {
          this.charges++;
          this.nitro -= CFG.NITRO_MAX;
          this.onEvent('nitroFull', { charges: this.charges });
        } else {
          this.nitro = CFG.NITRO_MAX;   // 满罐不再吸
          break;
        }
      }
      /* ---- 氮气键：地面喷罐 / 空中也可喷罐 ---- */
      if (nitroEdge && this.charges > 0) {
        this.charges--;
        this.nitroT = CFG.NITRO_BOOST_TIME;
        this.onEvent('nitroUse', { charges: this.charges, air: !this.grounded });
      }
      if (this.nitroT > 0) this.nitroT -= dt;
      if (this.airT > 0) this.airT -= dt;
      if (this.landT > 0) this.landT -= dt;

      /* ---- 位移：赛道空间积分（沿航迹角移动）---- */
      const dd = this.spd * Math.cos(this.courseRel) * dt;
      const dlat = this.spd * Math.sin(this.courseRel) * dt;
      this.d += dd;
      this.lat += dlat;

      /* ---- 护栏：反弹 + 刮蹭（漂移中撞墙 = 漂移失败）---- */
      const lim = ROAD_W / 2 - CFG.RAIL_MARGIN;
      if (Math.abs(this.lat) > lim) {
        const side = Math.sign(this.lat);
        this.lat = clamp(this.lat, -lim, lim);
        const firstTouch = !this._wallContact;
        this._wallContact = true;
        if (this.drift) {
          // 漂移撞墙即失败：立即中断，本段接触不集氮
          this.drift = null;
          this.driftTapT = 0;
          this.onEvent('driftFail', { side });
        }
        const outward = this.spd * Math.sin(this.courseRel) * side;   // 横向速度是否冲向墙
        if (outward > 1.0) {
          // 反弹：横向速度反射保留，车头与航迹一起弹离墙面
          this.courseRel = -this.courseRel * CFG.WALL_REL_KEEP;
          this.rel = -this.rel * CFG.WALL_REL_KEEP;
          this.spd *= CFG.WALL_BOUNCE;
          this._scrapeT = 0;
          this.onEvent('wallHit', { side, spd: this.spd, bounce: true });
        } else if (firstTouch) {
          // 轻蹭上墙
          this.spd *= 0.8;
          this._scrapeT = 0;
          this.onEvent('wallHit', { side, spd: this.spd });
        } else {
          // 持续刮蹭：掉速 + 车头/航迹被护栏捋顺（防卡死）
          this.spd -= this.spd * 0.9 * dt;
          this.rel += (0 - this.rel) * clamp(3.5 * dt, 0, 1);
          this.courseRel += (0 - this.courseRel) * clamp(3.5 * dt, 0, 1);
          this._scrapeT = (this._scrapeT || 0) + dt;
          if (this._scrapeT > 0.4) {
            this._scrapeT = 0;
            this.onEvent('wallHit', { side: Math.sign(this.lat), spd: this.spd, scrape: true });
          }
        }
      } else {
        this._wallContact = false;
        this._scrapeT = 0;
      }

      /* ---- 计圈：检查点顺序判定 ---- */
      this._checkpoints(dPrev);

      /* ---- 垂直：贴地 / 起跳 / 抛物线 ---- */
      this._vertical(dt, dPrev);

      /* ---- 逆行检测 ---- */
      if (this.spd > 5 && dd < 0) this.wrongWayT += dt;
      else this.wrongWayT = 0;

      /* ---- 视觉量 ---- */
      this.steerVis = this.steerSmooth * 0.38;
    }

    _checkpoints(dPrev) {
      const track = this.track;
      const L = track.length;
      const prevCP = track.cpIndexAt(dPrev);
      const nowCP = track.cpIndexAt(this.d);
      if (prevCP === nowCP) return;
      const forward = ((nowCP - prevCP + CFG.CP_COUNT) % CFG.CP_COUNT) === 1 && this.d - dPrev > -L / 2;
      if (forward) {
        this.cpSeq++;
        this.lastCP = nowCP;
        this.lastCpD = nowCP * L / CFG.CP_COUNT;
        this.onEvent('cp', { cp: nowCP });
        const lapNow = Math.floor(this.cpSeq / CFG.CP_COUNT);
        if (lapNow > this.lap) {
          this.lap = lapNow;
          if (this.lap >= this.laps) {
            this.finished = true;
            this.totalTime = this.raceTime;
            this.onEvent('finish', { time: this.totalTime, best: this.bestLap });
          } else {
            this.onEvent('lap', { lap: this.lap, time: this.raceTime, best: this.bestLap });
          }
        }
      } else if (((prevCP - nowCP) % CFG.CP_COUNT + CFG.CP_COUNT) % CFG.CP_COUNT === 1) {
        this.cpSeq = Math.max(0, this.cpSeq - 1);   // 倒穿回退
        this.lastCP = nowCP;
      }
    }

    _vertical(dt, dPrev) {
      const track = this.track;
      const groundH = track.roadHeightAt(this.d);

      if (this.grounded) {
        if (isNaN(groundH)) {
          // 冲出断崖 → 起跳（带出坡速度与坡度）
          const slope = track.rampSlopeAt(dPrev) || this.lastSlope;
          this.grounded = false;
          this.vy = Math.max(this.spd * slope, 1.2) + 0.5;
          this.airTime = 0;
          this.airBoostUsed = false;
          this.onEvent('launch', { vy: this.vy });
          return;
        }
        const prevH = track.roadHeightAt(dPrev);
        if (!isNaN(prevH) && this.d - dPrev > 1e-4) {
          this.lastSlope = (groundH - prevH) / (this.d - dPrev);
        }
        // 上坡贴地；突然下坠（坡顶飞出台阶）→ 离地
        if (groundH < this.y - 1.1 && this.spd > 18) {
          this.grounded = false;
          this.vy = clamp(this.lastSlope * this.spd, -6, 12);
          this.airTime = 0;
          this.airBoostUsed = false;
          this.onEvent('launch', { vy: this.vy });
        } else {
          this.y = groundH;
        }
      } else {
        // 抛物线
        this.vy -= CFG.GRAVITY * dt;
        this.y += this.vy * dt;
        this.airTime += dt;
        if (!isNaN(groundH) && this.y <= groundH && this.vy <= 0) {
          // 落地
          const impact = -this.vy;
          this.grounded = true;
          this.y = groundH;
          this.vy = 0;
          const big = this.airTime > CFG.LANDING_AIR_MIN;
          this.airBoostUsed = false;
          if (big) {
            // 落地喷机会：落地那一刻快速按一次前进
            this.landTapT = 0.42;
            this.onEvent('landingReady', { airTime: this.airTime, impact });
          } else {
            this.onEvent('touchdown', { impact });
          }
        } else if (this.y < (this.track.pointAt(this.d).y - track.fallDepth)) {
          // 坠入坑/深渊 → 重生
          this._respawn();
        }
      }
    }

    _respawn() {
      const track = this.track;
      let d = this.lastCpD;
      let guard = 0;
      while (track.inGap(d) && guard++ < 200) d += CFG.SAMPLE_STEP * 2;
      this.d = d;
      this.lat = 0;
      this.spd = 0;
      this.rel = 0;
      this.courseRel = 0;
      this.vy = 0;
      this.y = track.roadHeightAt(d) || track.pointAt(d).y;
      this.grounded = true;
      this.drift = null;
      this.nitroT = 0; this.airT = 0; this.landT = 0;
      this.driftTapT = 0; this.landTapT = 0;
      this.frozen = CFG.RESPAWN_PENALTY;
      this.airBoostUsed = false;
      this.onEvent('fallRespawn', { d });
    }

    /* 名次排序用总进度：检查点序 × 大数 + 圈内里程 */
    progressScore() {
      return this.cpSeq * 100000 + (this.d % this.track.length);
    }

    /** 状态快照（联机上报用） */
    snapshot() {
      return {
        d: Math.round(this.d * 100) / 100,
        lat: Math.round(this.lat * 100) / 100,
        spd: Math.round(this.spd * 10) / 10,
        rel: Math.round(this.rel * 100) / 100,
        y: Math.round(this.y * 10) / 10,
        g: this.grounded,
        dr: this.drift ? this.drift.dir : 0,
        boost: this.boostingNow,
        lap: this.cpSeq,
        prog: Math.round(this.track.progressOf(this.d) * 1000) / 1000,
        fin: this.finished,
      };
    }
  }

  /* ============================================================
   * CarModel —— QQ飞车风格默认车外观（Three.js 图元拼装）
   * 特征：圆锥车鼻 / 气泡座舱+防滚架 / 四轮独立轮眉 / 侧裙 /
   *       大尾翼+端板 / 中置双排气 / 前窄后宽的卡丁车比例
   * 车头朝 +Z。返回 { group, body, steerL/R, wheels, flames, ... }
   * ============================================================ */
  function buildCarModel(colorHex, opts) {
    opts = opts || {};
    const THREE = rootTHREE();
    const color = new THREE.Color(colorHex);
    const g = new THREE.Group();
    const body = new THREE.Group();
    g.add(body);

    const mat = (c, rough, metal) => new THREE.MeshStandardMaterial({
      color: c, roughness: rough == null ? 0.45 : rough, metalness: metal == null ? 0.35 : metal,
    });
    const paint = mat(color, 0.3, 0.55);
    const accent = mat(color.clone().offsetHSL(0, -0.08, 0.14), 0.35, 0.5);   // 浅一档车漆
    const dark = mat(0x1d2026, 0.7, 0.25);
    const chrome = mat(0xcfd4dd, 0.25, 0.9);
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fd8ff, roughness: 0.06, metalness: 0.15, transparent: true, opacity: 0.72 });
    const tireMat = mat(0x15171b, 0.92, 0.05);
    const hubMat = mat(0xe4e7ec, 0.28, 0.85);

    /* 主车壳：中窄后宽的座舱壳体 */
    const hull = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.44, 2.5), paint);
    hull.position.set(0, 0.5, 0.05); body.add(hull);
    // 圆锥车鼻（前收细）
    const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.58, 0.95, 14), paint);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, 0.48, 1.7); body.add(nose);
    // 前唇铲
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.09, 0.55), dark);
    splitter.position.set(0, 0.2, 1.95); body.add(splitter);
    // 后甲板
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.34, 0.26, 0.85), paint);
    deck.position.set(0, 0.64, -1.05); body.add(deck);

    /* 气泡座舱 + 防滚架 + 车手 */
    const canopy = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.58), glass
    );
    canopy.position.set(0, 0.7, -0.12);
    canopy.scale.set(1.08, 0.98, 1.4);
    body.add(canopy);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.05, 8, 18, Math.PI), chrome);
    hoop.position.set(0, 0.78, -0.82); body.add(hoop);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 14, 10), mat(0xffd9b0, 0.6, 0.05));
    head.position.set(0, 0.88, -0.5); body.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.6), mat(0xf4f6f8, 0.35, 0.4));
    helmet.position.set(0, 0.88, -0.5); body.add(helmet);
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.11, 0.09), mat(0x222831, 0.2, 0.6));
    visor.position.set(0, 0.86, -0.28); body.add(visor);

    /* 侧裙（导流侧箱） */
    for (const sx of [-1, 1]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.26, 1.35), accent);
      pod.position.set(sx * 0.72, 0.4, 0.2); body.add(pod);
      const skirt = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.1, 1.1), dark);
      skirt.position.set(sx * 0.74, 0.24, 0.25); body.add(skirt);
    }

    /* 车轮 + 轮眉：前小后大 */
    const wheels = [], steers = [], fenders = [];
    const wdef = [
      [-0.78, 0.36, 0.98, 0.36, 0.26, true, 0.47],   // x, y, z, r, w, 前轮?, 轮眉半径
      [0.78, 0.36, 0.98, 0.36, 0.26, true, 0.47],
      [-0.84, 0.44, -1.02, 0.44, 0.36, false, 0.57],
      [0.84, 0.44, -1.02, 0.44, 0.36, false, 0.57],
    ];
    for (const [x, y, z, r, w, isFront, fr] of wdef) {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, z);
      const spin = new THREE.Group();
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 16), tireMat);
      tire.rotation.z = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.52, r * 0.52, w + 0.02, 12), hubMat);
      hub.rotation.z = Math.PI / 2;
      spin.add(tire, hub);
      pivot.add(spin);
      body.add(pivot);
      wheels.push(spin);
      if (isFront) steers.push(pivot);
      // 轮眉（半环拱）
      const fender = new THREE.Mesh(new THREE.TorusGeometry(fr, 0.085, 8, 16, Math.PI), paint);
      fender.position.set(x > 0 ? x + 0.03 : x - 0.03, y, z);
      fender.material = paint;
      body.add(fender);
      fenders.push(fender);
    }

    /* 大尾翼 + 端板 + 双支柱 */
    const wing = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.07, 0.44), accent);
    wing.position.set(0, 1.06, -1.5);
    wing.rotation.x = -0.1; body.add(wing);
    for (const sx of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.22, 0.48), dark);
      plate.position.set(sx * 0.76, 1.04, -1.5); body.add(plate);
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.3, 0.12), dark);
      strut.position.set(sx * 0.34, 0.86, -1.5); body.add(strut);
    }

    /* 中置双排气（火焰挂点） */
    const flames = [];
    for (const sx of [-0.17, 0.17]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.42, 10), chrome);
      pipe.rotation.x = Math.PI / 2 + 0.22;
      pipe.position.set(sx, 0.6, -1.55); body.add(pipe);
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.13, 1.05, 10),
        new THREE.MeshBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.95 })
      );
      flame.rotation.x = -Math.PI / 2 + 0.22;
      flame.position.set(sx, 0.68, -2.05);
      flame.visible = false;
      body.add(flame);
      flames.push(flame);
    }

    /* 车灯 / 尾灯 */
    for (const sx of [-0.26, 0.26]) {
      const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xfff2b0 }));
      hl.position.set(sx, 0.5, 2.1); body.add(hl);
    }
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.09, 0.05),
      new THREE.MeshBasicMaterial({ color: 0xff3524 }));
    tail.position.set(0, 0.66, -1.5); body.add(tail);

    /* 底部假阴影 */
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(1.5, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.06;
    g.add(shadow);

    return {
      group: g, body, wheels, steers, flames, shadow,
      flameMaterials: flames.map(f => f.material),
      setPaint(c) {
        paint.color.set(c);
        accent.color.set(new THREE.Color(c).offsetHSL(0, -0.08, 0.14));
      },
    };
  }

  /* 将模型对齐到赛道状态（每帧调用） */
  function syncCarVisual(visual, track, sim, dt) {
    const THREE = rootTHREE();
    const p = track.pointAt(sim.d);
    const s = track.sideAt(sim.d);
    visual.group.position.set(p.x + s.x * sim.lat, sim.y, p.z + s.z * sim.lat);

    const t = track.tangentAt(sim.d);
    // 车头方向 = 切线绕 Y 偏转 rel（rel>0 偏向 +lat=side 方向）
    const cos = Math.cos(sim.rel), sin = Math.sin(sim.rel);
    const hx = t.x * cos + s.x * sin;
    const hz = t.z * cos + s.z * sin;
    const hy = clamp(t.y * cos, -0.6, 0.6);
    visual.group.rotation.order = 'YXZ';
    visual.group.rotation.y = Math.atan2(hx, hz);
    visual.group.rotation.x = -Math.asin(clamp(hy, -1, 1)) * (sim.grounded ? 1 : 0.4);

    // 漂移"偏移"：车身额外甩尾角 + 弯道外倾（车顶甩向弯外）
    let yawOff = 0, roll = 0;
    if (sim.drift) {
      const amt = clamp(Math.abs(sim.rel) / 0.9, 0, 1);
      yawOff = -sim.drift.dir * CFG.DRIFT_BODY_YAW * amt;
      roll = -sim.drift.dir * 0.10 * amt;
    }
    roll -= clamp(sim.rel * 0.12, -0.12, 0.12);
    visual.body.rotation.y += ((yawOff) - visual.body.rotation.y) * clamp(10 * dt, 0, 1);
    visual.body.rotation.z += ((roll) - visual.body.rotation.z) * clamp(8 * dt, 0, 1);

    // 车轮
    const spin = (sim.spd / 0.4) * dt;
    for (const w of visual.wheels) w.rotation.x -= spin;
    for (const st of visual.steers) st.rotation.y = sim.steerVis;   // + = 左转

    // 空中姿态：轻微前倾/后仰
    if (!sim.grounded) visual.body.rotation.x = clamp(-sim.vy * 0.012, -0.2, 0.28);

    // 阴影贴地
    const gh = track.roadHeightAt(sim.d);
    const h = isNaN(gh) ? 10 : Math.max(0, sim.y - gh);
    visual.shadow.visible = h < 9 && !isNaN(gh);
    visual.shadow.position.y = (isNaN(gh) ? 0 : gh - sim.y) + 0.06;
    const sc = clamp(1 - h * 0.07, 0.45, 1);
    visual.shadow.scale.set(sc, sc, sc);
    visual.shadow.material.opacity = 0.32 * sc;
  }

  let _THREE = null;
  function rootTHREE() {
    if (_THREE) return _THREE;
    if (typeof THREE !== 'undefined') _THREE = THREE;
    else if (typeof window !== 'undefined' && window.THREE) _THREE = window.THREE;
    else if (typeof globalThis !== 'undefined' && globalThis.THREE) _THREE = globalThis.THREE;
    if (!_THREE) throw new Error('THREE 未加载');
    return _THREE;
  }

  return { CarSim, buildCarModel, syncCarVisual };
});
