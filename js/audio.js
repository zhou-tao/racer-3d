/* ============================================================
 * audio.js —— WebAudio 合成音效（无音频文件，零资源）
 * 引擎轰鸣（速度→音高）/ 漂移啸叫 / 氮气喷射 / 空喷·落地喷 /
 * 撞栏刮擦 / 坠落 / 倒计时哔哔 / 完赛号角 / 领奖台喝彩掌声
 * ============================================================ */
(function (root) {
  'use strict';

  class GameAudio {
    constructor() {
      this.ctx = null;
      this.enabled = true;
      this._engineNodes = null;
      this._driftNodes = null;
      this._windNodes = null;
    }

    _ensure() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.55;
      this.master.connect(this.ctx.destination);
      return this.ctx;
    }

    resume() {
      const ctx = this._ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }

    setEnabled(on) {
      this.enabled = on;
      if (this.master) this.master.gain.value = on ? 0.55 : 0;
    }

    /* ---------- 持续音源 ---------- */

    /** 引擎：锯齿波 + 低通，速度/油门调制 */
    startEngine() {
      const ctx = this._ensure();
      if (!ctx || this._engineNodes) return;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 60;
      const sub = ctx.createOscillator();
      sub.type = 'square';
      sub.frequency.value = 30;
      const filt = ctx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = 500;
      filt.Q.value = 2;
      const gain = ctx.createGain();
      gain.gain.value = 0.0;
      osc.connect(filt); sub.connect(filt);
      filt.connect(gain); gain.connect(this.master);
      osc.start(); sub.start();
      this._engineNodes = { osc, sub, filt, gain };
    }

    /** speed 0..1（相对极速），throttle 0..1 */
    updateEngine(speed, throttle, boosting) {
      if (!this._engineNodes || !this.enabled) return;
      const n = this._engineNodes, t = this.ctx.currentTime;
      const f = 55 + speed * 210 + (boosting ? 40 : 0);
      n.osc.frequency.setTargetAtTime(f, t, 0.06);
      n.sub.frequency.setTargetAtTime(f / 2, t, 0.06);
      n.filt.frequency.setTargetAtTime(400 + speed * 1900 + throttle * 500, t, 0.08);
      n.gain.gain.setTargetAtTime(0.10 + speed * 0.14 + throttle * 0.06, t, 0.1);
    }

    stopEngine() {
      if (!this._engineNodes) return;
      try {
        this._engineNodes.osc.stop();
        this._engineNodes.sub.stop();
      } catch (e) {}
      this._engineNodes = null;
    }

    /** 风噪：粉噪 + 带通，随速度 */
    startWind() {
      const ctx = this._ensure();
      if (!ctx || this._windNodes) return;
      const buf = this._noiseBuffer(2);
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const filt = ctx.createBiquadFilter();
      filt.type = 'bandpass'; filt.frequency.value = 800; filt.Q.value = 0.6;
      const gain = ctx.createGain(); gain.gain.value = 0;
      src.connect(filt); filt.connect(gain); gain.connect(this.master);
      src.start();
      this._windNodes = { filt, gain };
    }

    updateWind(speed) {
      if (!this._windNodes || !this.enabled) return;
      const t = this.ctx.currentTime;
      this._windNodes.filt.frequency.setTargetAtTime(500 + speed * 1400, t, 0.1);
      this._windNodes.gain.gain.setTargetAtTime(speed * 0.08, t, 0.15);
    }

    stopWind() {
      if (this._windNodes) {
        try { this._windNodes.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); } catch (e) {}
        this._windNodes = null;
      }
    }

    /** 漂移啸叫：带通噪声循环，漂移中开启 */
    setDrift(on, intensity) {
      const ctx = this._ensure();
      if (!ctx) return;
      if (on && !this._driftNodes) {
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuffer(1); src.loop = true;
        const filt = ctx.createBiquadFilter();
        filt.type = 'bandpass'; filt.frequency.value = 1100; filt.Q.value = 6;
        const gain = ctx.createGain(); gain.gain.value = 0;
        src.connect(filt); filt.connect(gain); gain.connect(this.master);
        src.start();
        this._driftNodes = { filt, gain, src };
      }
      if (this._driftNodes) {
        const t = this.ctx.currentTime;
        if (on) {
          this._driftNodes.filt.frequency.setTargetAtTime(900 + intensity * 700, t, 0.05);
          this._driftNodes.gain.gain.setTargetAtTime(0.12 * intensity, t, 0.05);
        } else {
          this._driftNodes.gain.gain.setTargetAtTime(0, t, 0.08);
        }
      }
    }

    stopDrift() { this.setDrift(false); }

    /* ---------- 一次性音效 ---------- */

    _noiseBuffer(sec) {
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    }

    _blip(freq, dur, type, vol, when, slide) {
      const ctx = this._ensure();
      if (!ctx || !this.enabled) return;
      const t = (when || 0) + ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, slide), t + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol || 0.2, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + dur + 0.05);
    }

    _noiseBurst(dur, filterFreq, vol, type, when) {
      const ctx = this._ensure();
      if (!ctx || !this.enabled) return;
      const t = (when || 0) + ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer(Math.max(dur, 0.2));
      const filt = ctx.createBiquadFilter();
      filt.type = type || 'lowpass';
      filt.frequency.value = filterFreq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(filt); filt.connect(g); g.connect(this.master);
      src.start(t); src.stop(t + dur + 0.05);
    }

    nitroWhoosh() {         // 氮气喷射
      this._noiseBurst(0.7, 2400, 0.3, 'highpass');
      this._blip(180, 0.5, 'sawtooth', 0.12, 0, 720);
    }
    airBoostSfx() {         // 空喷（更清脆短促）
      this._noiseBurst(0.3, 3000, 0.22, 'highpass');
      this._blip(320, 0.25, 'square', 0.1, 0, 880);
    }
    landingSfx() {          // 落地喷
      this._noiseBurst(0.25, 700, 0.3, 'lowpass');
      this._blip(140, 0.2, 'triangle', 0.18, 0, 90);
      this._blip(500, 0.18, 'sine', 0.1, 0.06, 900);
    }
    wallHit() {
      this._noiseBurst(0.2, 900, 0.35, 'lowpass');
      this._blip(90, 0.15, 'square', 0.15, 0, 50);
    }
    fallSfx() {
      this._blip(600, 0.9, 'sine', 0.16, 0, 60);
    }
    nitroFull() {           // 集满一声
      this._blip(660, 0.1, 'sine', 0.14);
      this._blip(990, 0.12, 'sine', 0.14, 0.09);
    }
    checkpointBlip() {
      this._blip(1200, 0.06, 'sine', 0.07);
    }
    lapSfx() {
      this._blip(784, 0.12, 'sine', 0.18);
      this._blip(988, 0.12, 'sine', 0.18, 0.12);
      this._blip(1319, 0.2, 'sine', 0.18, 0.24);
    }
    countBeep(n) {          // 3·2·1 低音，GO 高音
      this._blip(n === 0 ? 880 : 440, n === 0 ? 0.5 : 0.18, 'square', 0.2);
    }
    finishFanfare() {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => this._blip(f, 0.3, 'triangle', 0.2, i * 0.16));
      this._blip(1319, 0.6, 'triangle', 0.2, notes.length * 0.16);
    }
    applause(dur) {         // 掌声：密集噪声簇
      const ctx = this._ensure();
      if (!ctx || !this.enabled) return;
      dur = dur || 6;
      const n = Math.floor(dur * 26);
      for (let i = 0; i < n; i++) {
        const when = Math.random() * dur * 0.8;
        this._noiseBurst(0.05 + Math.random() * 0.05, 1400 + Math.random() * 2400,
          0.05 + Math.random() * 0.06, 'bandpass', when);
      }
      this._noiseBurst(dur * 0.85, 900, 0.10, 'lowpass');  // 底噪欢呼
    }
    hornSfx() {
      this._blip(392, 0.4, 'sawtooth', 0.12);
      this._blip(494, 0.4, 'sawtooth', 0.12, 0.02);
    }
    rev() {                    // 加载页引擎轰鸣
      this._blip(70, 0.55, 'sawtooth', 0.16, 0, 260);
      this._blip(140, 0.4, 'square', 0.06, 0.08, 420);
    }
  }

  root.RacerAudio = new GameAudio();
})(window);
