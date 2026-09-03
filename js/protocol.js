/* ============================================================
 * protocol.js —— 联机消息 schema 校验层（纯函数，零依赖）
 * 浏览器（window.Protocol）与 Node 服务端（module.exports）共用。
 *
 * 原则（与台球项目一致）：
 *   - 所有字段只接受白名单结构，多余字段一律丢弃（防字段走私）
 *   - 数值必须为有限数且落在物理合理区间，NaN/Infinity 直接拒绝
 *   - 文案字段限制长度与字符种类
 *   - 校验失败返回 null，调用方丢弃整条消息
 * ============================================================ */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.Protocol = factory(root);
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const CFG = root.RacerConfig || {
    MAX_PLAYERS: 8, ROAD_WIDTH: 16, LAPS: 3,
    CAR_COLORS: [
      '#ff4d4d', '#ffa726', '#ffee58', '#66bb6a', '#26c6da',
      '#42a5f5', '#ab47bc', '#ec407a', '#8d6e63', '#26a69a',
      '#ff7043', '#9ccc65',
    ],
  };

  const THEMES = ['desert', 'forest', 'sky'];

  function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
  function inR(v, lo, hi) { return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi; }
  function clampN(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* 昵称：1~12 个可见字符（emoji 允许），去首尾空白 */
  function cleanName(s) {
    if (typeof s !== 'string') return null;
    const t = s.trim().slice(0, 12);
    if (!t || /[\u0000-\u001f]/.test(t)) return null;
    return t;
  }

  /* 车漆：必须是色板内颜色（下标） */
  function cleanColorIdx(i) {
    return isInt(i) && i >= 0 && i < CFG.CAR_COLORS.length ? i : null;
  }

  /* ---- C→S：加入房间 ---- */
  function validateJoin(m) {
    if (!m || typeof m !== 'object') return null;
    const out = { t: 'join' };
    const name = cleanName(m.name);
    if (!name) return null;
    const color = cleanColorIdx(m.color);
    if (color === null) return null;
    if (m.spec === true) out.spec = true;
    out.name = name;
    out.color = color;
    return out;
  }

  /* ---- C→S（房主）：开局参数 ---- */
  function validateStart(m) {
    if (!m || typeof m !== 'object') return null;
    if (!THEMES.includes(m.theme)) return null;
    if (!isInt(m.laps) || m.laps < 1 || m.laps > 9) return null;
    return { t: 'start', theme: m.theme, laps: m.laps };
  }

  /* ---- C→S：车辆状态上报（12Hz）----
   * d 里程(可>圈长)  lat 横向  spd 车速  rel 相对切线角
   * y 高度  g 是否着地  dr 漂移方向  boost 喷射中
   * lap 已完成圈  prog 本圈进度(0~1)  fin 已完赛
   */
  function validateState(m) {
    if (!m || typeof m !== 'object') return null;
    if (!inR(m.d, 0, 1e7)) return null;
    if (!inR(m.lat, -400, 400)) return null;
    if (!inR(m.spd, -30, 90)) return null;
    if (!inR(m.rel, -3.2, 3.2)) return null;
    if (!inR(m.y, -120, 400)) return null;
    if (!inR(m.prog, 0, 1)) return null;
    if (!isInt(m.lap) || m.lap < 0 || m.lap > 99) return null;
    const out = {
      t: 'st',
      d: m.d, lat: clampN(m.lat, -400, 400), spd: m.spd, rel: m.rel, y: m.y,
      g: m.g ? 1 : 0,
      dr: m.dr === -1 || m.dr === 1 ? m.dr : 0,
      boost: m.boost ? 1 : 0,
      lap: m.lap, prog: m.prog,
      fin: m.fin ? 1 : 0,
    };
    if (m.vy !== undefined && inR(m.vy, -120, 120)) out.vy = m.vy;
    return out;
  }

  /* ---- C→S：完赛上报 ---- */
  function validateFinish(m) {
    if (!m || typeof m !== 'object') return null;
    if (!inR(m.time, 1, 36000)) return null;      // 总用时秒
    if (!inR(m.best, 1, 36000)) return null;      // 最快单圈
    return { t: 'finish', time: m.time, best: m.best };
  }

  /* ---- C→S：房主要求回大厅 ---- */
  function validateBack(m) { return m && typeof m === 'object' ? { t: 'back' } : null; }

  /* ---- S→C：房间名册 ---- */
  function validateRoster(m) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.players)) return null;
    if (m.players.length > CFG.MAX_PLAYERS + 1) return null;
    const players = [];
    for (const p of m.players) {
      if (!p || typeof p !== 'object') return null;
      if (!isInt(p.id) || p.id < 0) return null;
      const name = cleanName(p.name);
      if (!name) return null;
      const color = cleanColorIdx(p.color);
      if (color === null) return null;
      players.push({
        id: p.id, name, color,
        host: !!p.host,
        lap: isInt(p.lap) ? p.lap : undefined,
        prog: inR(p.prog, 0, 1) ? p.prog : undefined,
        fin: !!p.fin,
      });
    }
    const out = { t: 'roster', players, state: m.state === 'race' ? 'race' : 'lobby' };
    if (isInt(m.specs)) out.specs = m.specs;
    if (THEMES.includes(m.theme)) out.theme = m.theme;
    return out;
  }

  /* ---- S→C：开局 ---- */
  function validateStartCast(m) {
    if (!m || typeof m !== 'object') return null;
    if (!THEMES.includes(m.theme)) return null;
    if (!isInt(m.laps) || m.laps < 1 || m.laps > 9) return null;
    if (!isInt(m.seed) || m.seed < 0) return null;
    if (!isInt(m.goAt) || m.goAt < 0) return null;
    return { t: 'start', theme: m.theme, laps: m.laps, seed: m.seed, goAt: m.goAt };
  }

  /* ---- S→C：他人车辆状态中继 ---- */
  function validateStCast(m) {
    if (!m || typeof m !== 'object' || !isInt(m.id) || m.id < 0) return null;
    const st = validateState(m);
    if (!st) return null;
    return Object.assign({ id: m.id }, st);
  }

  /* ---- S→C：完赛/结果 ---- */
  function validateResults(m) {
    if (!m || typeof m !== 'object' || !Array.isArray(m.list)) return null;
    if (m.list.length > CFG.MAX_PLAYERS) return null;
    const list = [];
    for (const r of m.list) {
      if (!r || typeof r !== 'object') return null;
      if (!isInt(r.id) || r.id < 0) return null;
      const name = cleanName(r.name);
      if (!name) return null;
      const color = cleanColorIdx(r.color);
      if (color === null) return null;
      if (!inR(r.time, 1, 36000)) return null;
      if (!inR(r.best, 1, 36000)) return null;
      list.push({ id: r.id, name, color, time: r.time, best: r.best });
    }
    return { t: 'results', list };
  }

  return {
    THEMES,
    cleanName, cleanColorIdx,
    validateJoin, validateStart, validateState, validateFinish, validateBack,
    validateRoster, validateStartCast, validateStCast, validateResults,
  };
});
