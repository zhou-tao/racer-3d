/* ============================================================
 * hud.js —— 比赛 HUD（DOM + canvas）
 *  左上角小地图（赛道全景 + 所有车实时位置）
 *  顶部：圈数 / 名次 / 计时；右上：实时排名
 *  左下：速度表；右下：氮气条+罐数；中下：动作提示吐司
 *  中央：倒计时、逆行警告、氮气全屏速度线
 * ============================================================ */
(function (root) {
  'use strict';

  const CFG = root.RacerConfig;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const $ = (id) => document.getElementById(id);

  const HUD = {
    els: {},
    mapData: null,
    mapPath: null,
    cars: [],
    toasts: [],
    _lineT: 0,

    init(opts) {
      opts = opts || {};
      this.els = {
        minimap: $('minimap'),
        lapNum: $('lapNum'), lapTotal: $('lapTotal'),
        posNum: $('posNum'), posTotal: $('posTotal'),
        timer: $('timer'),
        standings: $('standings'),
        speedNum: $('speedNum'), speedArc: $('speedArc'),
        nitroFill: $('nitroFill'), nitroPips: $('nitroPips'),
        toasts: $('toasts'),
        countdown: $('countdown'),
        wrongway: $('wrongway'),
        banner: $('banner'),
        lines: $('speedLines'),
        themeTag: $('themeTag'),
      };
      this.ctx = this.els.minimap.getContext('2d');
      this.linesCtx = this.els.lines.getContext('2d');
      this._lastCountdown = null;
      if (opts.themeName) this.els.themeTag.textContent = opts.themeName;
      this.els.banner.classList.add('hidden');
      this.els.wrongway.classList.add('hidden');
      this.els.countdown.textContent = '';
      this.els.toasts.innerHTML = '';
      this._resizeLines();
    },

    /** 注入小地图静态数据与车辆颜色表 */
    setRace(mapData, colorList, myIdx) {
      this.mapData = mapData;
      this.colorList = colorList;
      this.myIdx = myIdx || 0;
      const S = this.els.minimap.width;
      const path = new Path2D();
      mapData.pts.forEach(([x, y], i) => {
        const px = x * S, py = y * S;
        if (i === 0) path.moveTo(px, py); else path.lineTo(px, py);
      });
      path.closePath();
      this.mapPath = path;
    },

    reset() {
      this.els.toasts.innerHTML = '';
      this.toasts = [];
      this._lastCountdown = null;
    },

    /* ---------------- 每帧更新 ---------------- */
    update(st, dt) {
      const e = this.els;
      // 顶部信息
      e.lapNum.textContent = Math.min(st.lap + 1, st.laps);
      e.lapTotal.textContent = st.laps;
      e.posNum.textContent = st.pos;
      e.posTotal.textContent = st.total;
      e.timer.textContent = fmtTime(st.time);

      // 速度
      e.speedNum.textContent = Math.round(st.speedKmh);
      this._drawSpeedArc(st.speedKmh / 240);

      // 氮气
      e.nitroFill.style.width = (clamp(st.nitro, 0, 100)) + '%';
      e.nitroFill.classList.toggle('ready', st.charges > 0 || st.nitro >= 100);
      e.nitroFill.classList.toggle('boosting', st.boosting);
      if (this._pipN !== st.charges) {
        this._pipN = st.charges;
        e.nitroPips.innerHTML = '';
        for (let i = 0; i < CFG.NITRO_CHARGES_MAX; i++) {
          const pip = document.createElement('span');
          pip.className = 'pip' + (i < st.charges ? ' on' : '');
          e.nitroPips.appendChild(pip);
        }
      }

      // 排名列表
      if (st.standings) {
        let html = '';
        st.standings.forEach((s, i) => {
          html += `<div class="srow${s.me ? ' me' : ''}${s.fin ? ' fin' : ''}">`
            + `<span class="spos">${i + 1}</span>`
            + `<span class="sdot" style="background:${s.color}"></span>`
            + `<span class="sname">${escapeHtml(s.name)}</span>`
            + (s.fin ? '<span class="sflag">🏁</span>' : '')
            + `</div>`;
        });
        e.standings.innerHTML = html;
      }

      // 逆行
      e.wrongway.classList.toggle('hidden', !st.wrongWay);

      // 小地图
      this._drawMinimap(st.mapCars || []);

      // 氮气速度线
      this._drawSpeedLines(st.boostIntensity || 0, dt);
    },

    _drawSpeedArc(t) {
      const c = this.els.speedArc;
      const ctx = c.getContext('2d');
      const W = c.width, H = c.height;
      ctx.clearRect(0, 0, W, H);
      const cx = W / 2, cy = H, r = W / 2 - 6;
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, Math.PI * 2);
      ctx.stroke();
      const tt = clamp(t, 0, 1);
      const grd = ctx.createLinearGradient(0, 0, W, 0);
      grd.addColorStop(0, '#42a5f5');
      grd.addColorStop(0.6, '#ffee58');
      grd.addColorStop(1, '#ff4d4d');
      ctx.strokeStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, Math.PI + Math.PI * tt);
      ctx.stroke();
    },

    _drawMinimap(mapCars) {
      const S = this.els.minimap.width;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, S, S);
      if (!this.mapPath) return;
      // 底板
      ctx.save();
      // 赛道
      ctx.lineWidth = 9; ctx.strokeStyle = 'rgba(10,14,20,0.55)';
      ctx.stroke(this.mapPath);
      ctx.lineWidth = 5.5; ctx.strokeStyle = 'rgba(235,240,250,0.85)';
      ctx.stroke(this.mapPath);
      // 起点标记
      const st = this.mapData.start;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(st[0] * S, st[1] * S, 3.2, 0, Math.PI * 2);
      ctx.fill();
      // 车
      for (const car of mapCars) {
        const [mx, my] = this.mapData.project(car.x, car.z);
        const px = mx * S, py = my * S;
        if (car.me) {
          // 玩家：方向三角
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(car.ang);
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.moveTo(0, -7); ctx.lineTo(4.8, 5); ctx.lineTo(-4.8, 5);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = car.color;
          ctx.beginPath();
          ctx.moveTo(0, -4.4); ctx.lineTo(3, 3.4); ctx.lineTo(-3, 3.4);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = car.color;
          ctx.beginPath();
          ctx.arc(px, py, 3.4, 0, Math.PI * 2);
          ctx.fill();
          ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,0.45)';
          ctx.stroke();
        }
      }
      ctx.restore();
    },

    _drawSpeedLines(intensity, dt) {
      const c = this.els.lines;
      const ctx = this.linesCtx;
      if (c.width !== window.innerWidth) this._resizeLines();
      ctx.clearRect(0, 0, c.width, c.height);
      if (intensity <= 0.01) { this._lineT = 0; return; }
      this._lineT += dt * 30;
      const cx = c.width / 2, cy = c.height / 2;
      const R = Math.hypot(cx, cy);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + Math.sin(this._lineT * 0.13 + i) * 0.2;
        const r0 = R * (0.42 + ((this._lineT * 0.07 + i * 0.37) % 0.55));
        const r1 = r0 + R * 0.16 * intensity;
        ctx.lineWidth = 1.6;
        ctx.globalAlpha = 0.5 * intensity * Math.random();
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
        ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();
    },

    _resizeLines() {
      this.els.lines.width = window.innerWidth;
      this.els.lines.height = window.innerHeight;
    },

    /* ---------------- 倒计时 ---------------- */
    countdown(n) {
      if (this._lastCountdown === n) return;
      this._lastCountdown = n;
      const el = this.els.countdown;
      el.textContent = n > 0 ? String(n) : 'GO!';
      el.classList.remove('pop');
      void el.offsetWidth;
      el.classList.add('pop');
      if (n === 0) {
        setTimeout(() => { if (this._lastCountdown === 0) el.textContent = ''; }, 900);
      }
    },

    /* ---------------- 吐司 ---------------- */
    toast(type, text) {
      const box = this.els.toasts;
      while (this.toasts.length >= 4) {
        const old = this.toasts.shift();
        old.remove();
      }
      const el = document.createElement('div');
      el.className = 'toast ' + type;
      el.textContent = text;
      box.appendChild(el);
      this.toasts.push(el);
      setTimeout(() => {
        el.classList.add('out');
        setTimeout(() => {
          el.remove();
          const i = this.toasts.indexOf(el);
          if (i >= 0) this.toasts.splice(i, 1);
        }, 350);
      }, 1400);
    },

    banner(text, sub) {
      const el = this.els.banner;
      el.innerHTML = `<div class="b1">${text}</div>` + (sub ? `<div class="b2">${sub}</div>` : '');
      el.classList.remove('hidden');
    },
    hideBanner() { this.els.banner.classList.add('hidden'); },
  };

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return "--:--";
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  root.RacerHUD = HUD;
})(window);
