/* ============================================================
 * net.js —— 联机客户端
 * 事件式回调：net.on('welcome'|'roster'|'start'|'st'|'fin'|
 *   'results'|'reset'|'close'|'error', fn)
 * 地址：?ws= 参数 > window.RACER_WS_URL(config) > 同源 ws://host
 * 断线自动指数退避重连；welcome 携带服务器时钟做倒计时对齐
 * ============================================================ */
(function (root) {
  'use strict';

  class NetClient {
    constructor() {
      this.ws = null;
      this.handlers = {};
      this.connected = false;
      this.url = '';
      this._attempt = 0;
      this._stopped = true;
      this.myId = -1;
      this.role = 'spec';
      this.clockOffset = 0;      // 服务器时钟 - 本地时钟（ms）
    }

    on(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); return this; }
    _emit(type, data) { (this.handlers[type] || []).forEach(fn => { try { fn(data); } catch (e) { console.error(e); } }); }

    resolveUrl(explicit) {
      if (explicit) return explicit;
      const qs = new URLSearchParams(location.search);
      if (qs.get('ws')) return qs.get('ws');
      if (window.RACER_WS_URL) return window.RACER_WS_URL;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}`;
    }

    connect(explicit) {
      this.url = this.resolveUrl(explicit);
      this._stopped = false;
      this._open();
    }

    _open() {
      if (this._stopped) return;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this._retry(); return; }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        this._attempt = 0;
        this._emit('open');
      };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (!m || typeof m.t !== 'string') return;
        if (m.t === 'welcome') {
          this.myId = m.id;
          this.role = m.role;
          if (typeof m.now === 'number') this.clockOffset = m.now - Date.now();
        }
        this._emit(m.t, m);
      };
      ws.onclose = () => {
        this.connected = false;
        this.myId = -1;
        this.role = 'spec';
        this._emit('close');
        if (!this._stopped) this._retry();
      };
      ws.onerror = () => { /* close 跟随 */ };
    }

    _retry() {
      this._attempt++;
      const delay = Math.min(8000, 600 * Math.pow(2, this._attempt - 1));
      this._emit('reconnect', { attempt: this._attempt, delay });
      setTimeout(() => this._open(), delay);
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    }

    /** 状态上报（联机赛车主通道） */
    sendState(snapshot) {
      this.send(Object.assign({ t: 'state' }, snapshot));
    }

    /** 主动断开（回主菜单） */
    close() {
      this._stopped = true;
      if (this.ws) { try { this.ws.close(); } catch (e) {} }
      this.connected = false;
    }
  }

  root.NetClient = NetClient;
})(window);
