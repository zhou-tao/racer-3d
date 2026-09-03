/* ============================================================
 * game.js —— 比赛编排器
 *  离线：玩家 + 4 AI；联机：本地车权威上报，远端车插值呈现
 *  流程：构建赛道 → 倒计时 → 比赛 → 完赛等待 → 结算（领奖台）
 * ============================================================ */
(function (root) {
  'use strict';

  const CFG = root.RacerConfig;
  const Track = root.RacerTrack;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class RaceGame {
    /**
     * opts = {
     *   mode: 'offline'|'online',
     *   theme, seed, laps,
     *   players: [{id, name, colorIdx, isPlayer, isRemote, aiLevel}],
     *   net,                    // NetClient（联机）
     *   onResults(results),     // 结算数据
     *   onLeave(),              // 请求退出比赛回大厅
     * }
     */
    constructor(opts) {
      this.opts = opts;
      this.mode = opts.mode;
      this.theme = opts.theme;
      this.laps = opts.laps || CFG.LAPS;
      this.net = opts.net || null;
      this.state = 'count';          // count → race → done
      this.racers = [];
      this.bySlot = new Map();
      this.myIdx = 0;
      this.finishWait = 0;
      this._raf = 0;
      this._last = 0;
      this._netAcc = 0;
      this._prevNitro = false;
      this._shake = 0;
      this._t = 0;
      this._disposed = false;
      this.results = null;
      this.podium = null;
    }

    /** 分阶段启动：每阶段让出一帧给 loading 动画，onProgress(0~1) */
    async start(onProgress) {
      const stage = async (p, fn) => {
        if (this._disposed) return;
        fn && fn();
        onProgress && onProgress(p);
        await new Promise(r => setTimeout(r, 40));
      };

      const opts = this.opts;
      await stage(0.12, () => {
        /* 渲染器 */
        const stage = document.getElementById('stage');
        this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        if (THREE.sRGBEncoding) this.renderer.outputEncoding = THREE.sRGBEncoding;
        stage.appendChild(this.renderer.domElement);
      });

      await stage(0.35, () => {
        /* 赛道生成 */
        this.track = new Track(this.theme, opts.seed || 1);
      });

      await stage(0.62, () => {
        /* 主题世界（装饰最重） */
        this.world = root.RacerScene.buildWorld(this.theme, this.track, opts.seed || 1);
        this.scene = this.world.scene;
        this.camera = new THREE.PerspectiveCamera(CFG.FOV_BASE, window.innerWidth / window.innerHeight, 0.1, 1600);
        this.effects = new root.RacerEffects.Effects(this.scene);
      });

      await stage(0.85, () => {
        /* 车辆 */
        const grid = this.track.startGrid(opts.players.length);
        opts.players.forEach((p, i) => {
          const colorHex = CFG.CAR_COLORS[p.colorIdx % CFG.CAR_COLORS.length];
          const g = grid[i];
          const racer = {
            id: p.id, name: p.name, colorHex, colorIdx: p.colorIdx,
            isPlayer: !!p.isPlayer, isRemote: !!p.isRemote,
            slot: i,
          };
          if (p.isRemote) {
            racer.remote = {
              d: g.d, lat: g.lat, y: 0, spd: 0, rel: 0, grounded: true,
              drift: null, steerVis: 0, vy: 0, boostingNow: false, nitro: 0, charges: 0,
              tD: g.d, tLat: g.lat, tY: 0, tSpd: 0, tRel: 0, tG: true, tDr: 0, tFin: false,
              lap: 0, prog: 0, fin: false,
            };
            racer.remote.y = this.track.roadHeightAt(g.d) || 0;
            racer.remote.tY = racer.remote.y;
            racer.sim = racer.remote;
          } else {
            racer.sim = new root.RacerCar.CarSim(this.track, {
              isPlayer: !!p.isPlayer,
              colorIdx: p.colorIdx, name: p.name,
              laps: this.laps,
              startD: g.d, startLat: g.lat,
              speedScale: p.aiLevel ? p.aiLevel : 1,
              onEvent: this._carEvents(racer),
            });
            racer.ai = p.aiLevel ? new root.RacerAI.AIDriver(this.track, racer.sim, p.aiLevel, Math.random) : null;
          }
          racer.visual = root.RacerCar.buildCarModel(colorHex);
          this.scene.add(racer.visual.group);
          root.RacerCar.syncCarVisual(racer.visual, this.track, racer.sim, 0);
          this.racers.push(racer);
          if (racer.isPlayer) this.myIdx = i;
        });
        this.me = this.racers[this.myIdx];
      });

      await stage(1, () => {
        /* HUD / 输入 / 音频 / 主循环 */
        const themeEnv = root.RacerScene.THEME_ENV[this.theme];
        root.RacerHUD.init({ themeName: themeEnv.emoji + ' ' + themeEnv.name });
        root.RacerHUD.setRace(this.track.minimapData(), CFG.CAR_COLORS, this.myIdx);

        if (this.mode === 'online') {
          const off = this.net ? this.net.clockOffset : 0;
          const goAtLocalUnix = (opts.goAt || 0) + off;
          this.goAt = goAtLocalUnix - Date.now() + performance.now();
        } else {
          this.goAt = performance.now() + 3800;
        }

        this.keys = {};
        this._onKeyDown = (e) => {
          if (e.repeat) return;
          const k = e.key.toLowerCase();
          if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift', 'control'].includes(k)) e.preventDefault();
          this.keys[k] = true;
          if (k === 'r') this._resetCar();
          root.RacerAudio.resume();
        };
        this._onKeyUp = (e) => { this.keys[e.key.toLowerCase()] = false; };
        this._onResize = () => {
          this.renderer.setSize(window.innerWidth, window.innerHeight);
          this.camera.aspect = window.innerWidth / window.innerHeight;
          this.camera.updateProjectionMatrix();
        };
        window.addEventListener('keydown', this._onKeyDown);
        window.addEventListener('keyup', this._onKeyUp);
        window.addEventListener('resize', this._onResize);

        root.RacerAudio.resume();
        root.RacerAudio.startEngine();
        root.RacerAudio.startWind();
        window.__game = this;      // 调试/测试钩子
        this._camera(1);           // 相机开局直接就位

        this._last = performance.now();
        this._loop = this._loop.bind(this);
        this._raf = requestAnimationFrame(this._loop);
      });
    }

    /* ---------------- 车辆事件（声音/吐司/特效） ---------------- */
    _carEvents(racer) {
      const isMe = racer.isPlayer;
      return (type, data) => {
        const A = root.RacerAudio, H = root.RacerHUD;
        switch (type) {
          case 'driftStart':
            if (isMe) A.setDrift(true, 0.7);
            break;
          case 'driftEnd':
            if (isMe) A.setDrift(false);
            break;
          case 'nitroFull':
            if (isMe) { A.nitroFull(); H.toast('full', '氮气集满！'); }
            break;
          case 'nitroUse':
            if (isMe) { A.nitroWhoosh(); H.toast('nitro', '氮气喷射！'); this._shake = Math.max(this._shake, 0.08); }
            break;
          case 'airBoost':
            if (isMe) { A.airBoostSfx(); H.toast('air', '空喷！'); }
            break;
          case 'landing':
            if (isMe) { A.landingSfx(); H.toast('land', '落地喷！'); }
            racer.sim._justLanded = 0.25;
            this._shake = Math.max(this._shake, clamp(data.impact * 0.012, 0.03, 0.12));
            break;
          case 'landingReady':
            if (isMe) H.toast('land', '落地喷：快按 ↑！');
            break;
          case 'driftFail':
            if (isMe) { A.wallHit(); H.toast('fall', '漂移失败！'); }
            break;
          case 'driftJet':
            if (isMe) { A.landingSfx(); H.toast('drift', '漂移喷！'); }
            break;
          case 'wallHit':
            if (isMe) { A.wallHit(); this._shake = Math.max(this._shake, 0.12); }
            this.effects.wallSpark(racer.visual.group.position, data.side);
            break;
          case 'launch':
            if (isMe) root.RacerAudio.checkpointBlip();
            break;
          case 'fallRespawn':
            if (isMe) { A.fallSfx(); H.toast('fall', '坠落！回到检查点'); }
            this.effects.fallSplash(racer.visual.group.position,
              this.theme === 'forest' ? 0x8ecfff : (this.theme === 'desert' ? 0xe8c98f : 0xffffff));
            break;
          case 'lap':
            if (isMe) { A.lapSfx(); H.toast('lap', `第 ${data.lap + 1} 圈！`); }
            break;
          case 'finish':
            if (isMe) { A.finishFanfare(); }
            this._onAnyFinish(racer, data);
            break;
          case 'cp':
            if (isMe) A.checkpointBlip();
            break;
        }
      };
    }

    _onAnyFinish(racer, data) {
      racer.finData = { time: data.time, best: data.best };
      if (this.mode === 'online' && racer.isPlayer && this.net) {
        this.net.send({ t: 'finish', time: data.time, best: data.best });
        root.RacerHUD.banner('🏁 完赛！', `用时 ${fmtTime(data.time)} · 等待其他车手…`);
      }
    }

    _resetCar() {
      const sim = this.me.sim;
      if (sim.finished || this.state !== 'race') return;
      const p = this.me.visual.group.position;
      const near = this.track.nearest(p.x, p.z, sim.d);
      sim.d = near.d;
      sim.lat = near.lat;
      sim.spd = 0;
      sim.rel = 0;
      sim.vy = 0;
      sim.y = this.track.roadHeightAt(sim.d) || sim.y;
      sim.grounded = true;
      sim.drift = null;
      sim.frozen = 0.4;
    }

    /* ---------------- 主循环 ---------------- */
    _loop(now) {
      if (this._disposed) return;
      this._raf = requestAnimationFrame(this._loop);
      let dt = Math.min(0.05, (now - this._last) / 1000);
      this._last = now;
      this._t += dt;

      if (this.podium) { this._renderPodium(dt); return; }

      /* 倒计时状态 */
      if (this.state === 'count') {
        const remain = (this.goAt - now) / 1000;
        if (remain > 0.2) {
          root.RacerHUD.countdown(Math.ceil(remain - 0.2));
          root.RacerAudio.updateEngine(0.12, 0.4, false);
        } else {
          this.state = 'race';
          for (const r of this.racers) if (r.sim && r.sim.timing !== undefined) r.sim.timing = true;
          root.RacerHUD.countdown(0);
          root.RacerAudio.countBeep(0);
        }
      }

      /* 本地车：倒计时全员锁车；比赛中玩家输入 / AI 决策 */
      const ZERO_INPUT = { throttle: 0, brake: 0, steer: 0, drift: false };
      const input = this._playerInput();
      const nitroEdge = input.nitro && !this._prevNitro;
      this._prevNitro = input.nitro;
      for (const r of this.racers) {
        if (r.isRemote || !r.sim.update) continue;
        if (this.state === 'count') {
          r.sim.update(dt, ZERO_INPUT, false);   // 倒计时锁车：谁都不能动
          continue;
        }
        if (r.isPlayer) {
          if (r.sim.finished && !r.autoPilot) {
            r.autoPilot = new root.RacerAI.AIDriver(this.track, r.sim, 1, Math.random);
            r.autoPilot.cruise = true;
            r.sim.speedScale = 0.55;
          }
          if (r.autoPilot) {
            const ai = r.autoPilot.think(dt);
            r.sim.update(dt, { throttle: ai.throttle, brake: 0, steer: ai.steer, drift: false }, false);
          } else {
            r.sim.update(dt, input, nitroEdge && this.state === 'race');
          }
        } else if (r.ai) {
          const ai = r.ai.think(dt);
          if (this.state !== 'race') { ai.throttle = 0; ai.brake = 0; }   // 结束后滑行停车（不要倒车）
          r.sim.update(dt, { throttle: ai.throttle, brake: ai.brake, steer: ai.steer, drift: ai.drift }, !!ai.nitroEdge && this.state === 'race');
          if (this.mode === 'offline' && this.state === 'race') {
            r.ai.rubber(this.me.sim.progressScore());
          }
        }
      }

      /* 碰撞（离线） */
      if (this.mode === 'offline' && this.state === 'race') this._collisions();

      /* 远端车插值 */
      for (const r of this.racers) {
        if (r.isRemote) this._remoteStep(r, dt);
      }

      /* 视觉同步 + 特效 */
      for (const r of this.racers) {
        root.RacerCar.syncCarVisual(r.visual, this.track, r.sim, dt);
        if (r.sim.update) this.effects.carEffects(this.track, r.sim, r.visual, dt);
      }

      /* 相机 */
      this._camera(dt);

      /* 世界动画 */
      this.world.update(this._t, dt);
      this.effects.update(dt);

      /* 音频 */
      const mySim = this.me.sim;
      const spd01 = clamp(Math.abs(mySim.spd) / (CFG.MAX_SPEED * CFG.NITRO_MAX_MULT), 0, 1);
      root.RacerAudio.updateEngine(spd01, this._playerInput().throttle, mySim.boostingNow);
      root.RacerAudio.updateWind(spd01);
      if (mySim.drift && mySim.grounded) root.RacerAudio.setDrift(true, clamp(Math.abs(mySim.rel), 0.3, 1));
      else if (!mySim.drift) root.RacerAudio.setDrift(false);

      /* 联机上报 */
      if (this.mode === 'online' && this.net && this.net.connected) {
        this._netAcc += dt;
        if (this._netAcc >= 1 / CFG.NET_STATE_HZ) {
          this._netAcc = 0;
          this.net.sendState(mySim.snapshot());
        }
      }

      /* HUD */
      const standings = this._standings();
      const myPos = standings.findIndex(s => s.me) + 1 || this.myIdx + 1;
      root.RacerHUD.update({
        lap: mySim.cpSeq !== undefined ? Math.floor(mySim.cpSeq / CFG.CP_COUNT) : (mySim.lap || 0),
        laps: this.laps,
        pos: myPos, total: this.racers.length,
        time: mySim.raceTime || 0,
        speedKmh: Math.abs(mySim.spd) * CFG.SPEED_DISPLAY,
        nitro: mySim.nitro || 0,
        charges: mySim.charges || 0,
        boosting: mySim.boostingNow,
        boostIntensity: mySim.boostingNow ? clamp(spd01, 0.4, 1) : 0,
        wrongWay: mySim.wrongWayT > 1.1,
        standings,
        mapCars: this.racers.map(r => ({
          x: r.visual.group.position.x,
          z: r.visual.group.position.z,
          color: r.colorHex,
          me: r.isPlayer,
          ang: r.visual.group.rotation.y,
        })),
      }, dt);

      /* 离线完赛推进 */
      if (this.mode === 'offline' && this.state === 'race') {
        const allFin = this.racers.every(r => r.sim.finished);
        const anyFin = this.racers.some(r => r.sim.finished);
        if (anyFin) this.finishWait += dt;
        if (allFin || this.finishWait > 18) {
          this.state = 'done';
          this._offlineResults();
        }
      }

      this.renderer.render(this.scene, this.camera);
    }

    /* ---------------- 输入 ---------------- */
    _playerInput() {
      const k = this.keys || {};
      const locked = this.state !== 'race' || this.me.sim.finished;
      if (locked) return { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false };
      const up = k['arrowup'] || k['w'] || k['z'];
      const down = k['arrowdown'] || k['s'];
      const left = k['arrowleft'] || k['a'] || k['q'];
      const right = k['arrowright'] || k['d'];
      return {
        throttle: up ? 1 : 0,
        brake: down ? 1 : 0,
        steer: (left ? 1 : 0) - (right ? 1 : 0),
        drift: !!(k['shift'] || k['x']),
        nitro: !!(k[' '] || k['control'] || k['e'] || k['control']),
      };
    }

    /* ---------------- 碰撞（赛道空间）：反弹 + 分离，防穿模防卡死 ---------------- */
    _collisions() {
      const L = this.track.length;
      const sims = this.racers.filter(r => r.sim.update && r.sim.grounded).map(r => r.sim);
      const D_SEP = 3.0, L_SEP = 1.9;
      for (let i = 0; i < sims.length; i++) {
        for (let j = i + 1; j < sims.length; j++) {
          const a = sims[i], b = sims[j];
          let dd = ((b.d - a.d) % L + L * 1.5) % L - L / 2;
          const dl = b.lat - a.lat;
          if (Math.abs(dd) >= D_SEP || Math.abs(dl) >= L_SEP) continue;
          const overlapD = D_SEP - Math.abs(dd);
          const overlapL = L_SEP - Math.abs(dl);
          const hit = (a === this.me.sim || b === this.me.sim);
          if (overlapD < overlapL) {
            /* 纵向（追尾/顶撞）：前后各推一半硬分离 + 动量交换 */
            const s = dd >= 0 ? 1 : -1;          // dd>0 → b 在前
            const front = dd >= 0 ? b : a;
            const rear = dd >= 0 ? a : b;
            const half = overlapD / 2 + 0.02;
            a.d -= s * half; b.d += s * half;
            const relSpd = rear.spd - front.spd;
            if (relSpd > 0) {
              rear.spd = front.spd - relSpd * 0.45;   // 后车反弹（不穿不贴）
              front.spd += relSpd * 0.6;              // 前车被顶加速
            }
            if (hit && relSpd > 2) {
              root.RacerAudio.wallHit();
              this._shake = Math.max(this._shake, 0.09);
            }
          } else {
            /* 横向（刮蹭挤压）：横向弹开 + 航迹角互推 */
            const s = dl >= 0 ? 1 : -1;
            const half = overlapL / 2 + 0.02;
            a.lat -= s * half; b.lat += s * half;
            a.courseRel = (a.courseRel || 0) - s * 0.14;
            b.courseRel = (b.courseRel || 0) + s * 0.14;
            a.spd *= 0.965; b.spd *= 0.965;
            if (hit) {
              root.RacerAudio.wallHit();
              this._shake = Math.max(this._shake, 0.06);
            }
          }
        }
      }
    }

    /* ---------------- 远端车插值 ---------------- */
    _remoteStep(r, dt) {
      const rm = r.remote;
      const L = this.track.length;
      const k = clamp(CFG.NET_REMOTE_LERP * (dt * 60), 0, 1);
      let dd = rm.tD - rm.d;
      dd = ((dd % L) + L * 1.5) % L - L / 2;    // 最短环绕差
      rm.d += dd * k;
      rm.lat += (rm.tLat - rm.lat) * k;
      rm.y += (rm.tY - rm.y) * k;
      rm.spd += (rm.tSpd - rm.spd) * k;
      rm.rel += (rm.tRel - rm.rel) * k;
      rm.grounded = rm.tG;
      rm.boostingNow = !!rm.tBoost;
      rm.nitro = rm.tNitro || 0;
      rm.drift = rm.tDr ? { dir: rm.tDr } : null;
      rm.steerVis = clamp(rm.rel * 1.6, -0.42, 0.42);
      rm.finished = rm.tFin;
    }

    /** 联机：收到某人状态 */
    applyRemoteState(id, st) {
      const r = this.racers.find(x => x.id === id);
      if (!r || !r.remote) return;
      const rm = r.remote;
      const L = this.track.length;
      rm.tD = st.d;
      rm.tLat = st.lat;
      rm.tY = st.y !== undefined ? st.y : this.track.roadHeightAt(st.d) || rm.tY;
      rm.tSpd = st.spd;
      rm.tRel = st.rel;
      rm.tG = !!st.g;
      rm.tDr = st.dr;
      rm.tBoost = !!st.boost;
      rm.tNitro = 0;
      rm.tFin = !!st.fin;
      rm.lap = st.lap || 0;
      rm.prog = st.prog || 0;
    }

    /* ---------------- 相机 ---------------- */
    _camera(dt) {
      const me = this.me;
      const p = me.visual.group.position;
      const yaw = me.visual.group.rotation.y;
      // 车头方向 = (sin yaw, cos yaw)，相机挂在车尾上方
      const backX = -Math.sin(yaw) * CFG.CAMERA_DIST;
      const backZ = -Math.cos(yaw) * CFG.CAMERA_DIST;
      const want = new THREE.Vector3(p.x + backX, p.y + CFG.CAMERA_HEIGHT, p.z + backZ);
      const k = clamp(CFG.CAMERA_LAG * dt, 0, 1);
      this.camera.position.lerp(want, k);
      this._shake = Math.max(0, this._shake - dt * 2.4);
      if (this._shake > 0.01) {
        const s = this._shake * 0.5;
        this.camera.position.x += (Math.random() - 0.5) * s;
        this.camera.position.y += (Math.random() - 0.5) * s * 0.6;
        this.camera.position.z += (Math.random() - 0.5) * s;
      }
      // 看向车前方
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      this.camera.lookAt(p.x + fx * 6, p.y + 1.2, p.z + fz * 6);
      // FOV：氮气拉升
      const wantFov = me.sim.boostingNow ? CFG.FOV_BOOST : CFG.FOV_BASE;
      this.camera.fov += (wantFov - this.camera.fov) * clamp(4 * dt, 0, 1);
      this.camera.updateProjectionMatrix();
    }

    /* ---------------- 排名 ---------------- */
    _standings() {
      const list = this.racers.map(r => {
        const s = r.sim;
        let score;
        if (s.update) score = s.progressScore();
        else score = (r.remote.lap || 0) * 100000 + (r.remote.prog || 0) * this.track.length;
        return {
          name: r.name, color: r.colorHex, me: r.isPlayer,
          fin: s.finished !== undefined ? s.finished : !!s.fin,
          time: s.totalTime !== undefined ? s.totalTime : null,
          best: (s.bestLap !== undefined && isFinite(s.bestLap)) ? s.bestLap : null,
          score,
        };
      });
      list.sort((a, b) => {
        if (a.fin && b.fin) return (a.time || 0) - (b.time || 0);
        if (a.fin) return -1;
        if (b.fin) return 1;
        return b.score - a.score;
      });
      return list;
    }

    /* ---------------- 结算 ---------------- */
    _offlineResults() {
      const list = this._standings().map((s, i) => ({
        rank: i + 1, id: i, name: s.name, color: s.color,
        time: s.fin && s.time ? s.time : null,
        best: s.best,
        me: s.me,
      }));
      this.results = list;
      if (this.opts.onResults) this.opts.onResults(list);
    }

    /** 联机：服务器结算广播 */
    showOnlineResults(list) {
      if (this.results) return;
      this.results = list.map((r, i) => ({
        rank: i + 1, id: r.id, name: r.name, color: CFG.CAR_COLORS[r.color % CFG.CAR_COLORS.length],
        time: r.time, best: r.best, me: r.id === (this.opts.myId),
      }));
      if (this.opts.onResults) this.opts.onResults(this.results);
    }

    /* ---------------- 领奖台视图 ---------------- */
    enterPodium() {
      if (!this.results) return;
      this.podium = root.RacerPodium.build(this.theme, this.results, CFG.CAR_COLORS);
      root.RacerHUD.hideBanner();
      this._podiumT = 0;
    }

    _renderPodium(dt) {
      this._podiumT += dt;
      this.podium.update(this._podiumT, dt);
      this.renderer.render(this.podium.scene, this.podium.camera);
    }

    /* ---------------- 清理 ---------------- */
    dispose() {
      this._disposed = true;
      if (window.__game === this) window.__game = null;
      cancelAnimationFrame(this._raf);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
      window.removeEventListener('resize', this._onResize);
      root.RacerAudio.stopEngine();
      root.RacerAudio.stopWind();
      root.RacerAudio.stopDrift();
      if (this.podium && this.podium.dispose) this.podium.dispose();
      if (this.effects) this.effects.dispose();
      const stage = document.getElementById('stage');
      if (this.renderer) {
        this.renderer.dispose();
        this.renderer.domElement && this.renderer.domElement.remove();
      }
      if (stage) stage.innerHTML = '';
    }
  }

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--:--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }

  root.RacerGame = RaceGame;
})(window);
