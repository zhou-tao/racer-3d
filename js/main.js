/* ============================================================
 * main.js —— 应用入口：菜单 / 模式选择 / 联机大厅 / 结算接线
 * 个人挑战赛：玩家 + 4 台电脑（本地模拟）
 * 联机匹配：NetClient → 大厅 ≥2 人房主开局（服务器裁决）
 * ============================================================ */
(function () {
  'use strict';

  const CFG = window.RacerConfig;
  const $ = (id) => document.getElementById(id);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  const AI_NAMES = ['闪电手', '过弯王', '氮气侠', '漂移帝', '尾灯看客', '弯道幽灵', '老司机周'];

  /* ---------------- 档案 ---------------- */
  const profile = loadProfile();
  function loadProfile() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem('racer3d.profile') || '{}'); } catch (e) {}
    p.name = p.name || randomName();
    p.colorIdx = Number.isInteger(p.colorIdx) ? clampInt(p.colorIdx, 0, CFG.CAR_COLORS.length - 1) : 0;
    return p;
  }
  function saveProfile() {
    try { localStorage.setItem('racer3d.profile', JSON.stringify(profile)); } catch (e) {}
  }
  function randomName() {
    const pool = ['新晋车神', '萌新司机', '极速蜗牛', '赛道新手', '起步熄火', '弯道小白'];
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function clampInt(v, a, b) { return Math.max(a, Math.min(b, v)); }

  /* ---------------- 屏幕切换 ---------------- */
  const screens = {
    main: $('screenMain'), offline: $('screenOffline'),
    online: $('screenOnline'), results: $('screenResults'),
  };
  let cur = 'main';
  function goto(name) {
    for (const k in screens) screens[k].classList.add('hidden');
    if (screens[name]) show(screens[name]);   // 'game' 时无界面，只留 HUD
    cur = name;
    $('hud').classList.toggle('hidden', name !== 'game');
    $('stage').classList.toggle('dimmed', name === 'results');
  }

  /* ---------------- 游戏实例 ---------------- */
  let game = null;
  let lastOfflineTheme = 'desert';

  /* ---------------- Loading ---------------- */
  const LOAD_TIPS = [
    '小提示：漂移集氮，出弯喷氮最快',
    '小提示：空中点按 ↑ 触发空喷',
    '小提示：落地瞬间点按 ↑ 触发落地喷',
    '小提示：漂移撞墙会失败，控制好走线',
    '小提示：飞坡前别忘拉满速度',
    '小提示：松开方向键，赛车会自动沿路行驶',
  ];
  const loadingEl = () => document.getElementById('loading');
  function showLoading() {
    const el = loadingEl();
    $('ldTip').textContent = LOAD_TIPS[Math.floor(Math.random() * LOAD_TIPS.length)];
    setLoad(0);
    show(el);
    window.RacerAudio.resume();
    window.RacerAudio.rev();
  }
  function setLoad(p) {
    $('ldFill').style.width = Math.round(p * 100) + '%';
    $('ldPct').textContent = Math.round(p * 100) + '%';
  }
  function hideLoading() { hide(loadingEl()); }

  async function startOffline(theme) {
    lastOfflineTheme = theme;
    disposeGame();
    // 玩家 + 4 AI：颜色不与玩家重复
    const used = new Set([profile.colorIdx]);
    const colors = [];
    for (let i = 0; i < CFG.AI_COUNT; i++) {
      let c = Math.floor(Math.random() * CFG.CAR_COLORS.length);
      while (used.has(c)) c = (c + 1) % CFG.CAR_COLORS.length;
      used.add(c);
      colors.push(c);
    }
    const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
    const players = [{
      id: 0, name: profile.name, colorIdx: profile.colorIdx, isPlayer: true,
    }];
    for (let i = 0; i < CFG.AI_COUNT; i++) {
      players.push({ id: i + 1, name: names[i], colorIdx: colors[i], aiLevel: i + 1 });
    }
    game = new window.RacerGame({
      mode: 'offline', theme, seed: Math.floor(Math.random() * 0x7fffffff),
      laps: CFG.LAPS, players,
      onResults: showResults,
    });
    goto('game');
    showLoading();
    await game.start(setLoad);
    hideLoading();
  }

  /* ---------------- 联机 ---------------- */
  const net = new window.NetClient();
  let onlineTheme = 'desert';
  let lobbyState = { players: [], host: false, amHost: false, role: 'player' };
  let inOnlineRace = false;

  net.on('open', () => {
    setLobbyStatus('已连接，正在进入大厅…');
    net.send({ t: 'join', name: profile.name, color: profile.colorIdx });
  });
  net.on('reconnect', (d) => setLobbyStatus(`连接断开，正在重连（第 ${d.attempt} 次）…`));
  net.on('welcome', (m) => {
    lobbyState.role = m.role;
    lobbyState.amHost = !!m.host;
    onlineTheme = m.theme || onlineTheme;
    if (m.role === 'spec') setLobbyStatus('房间已满或比赛进行中，将以观战身份等待');
    renderLobby();
  });
  net.on('roster', (m) => {
    lobbyState.players = m.players || [];
    onlineTheme = m.theme || onlineTheme;
    const me = lobbyState.players.find(p => p.id === net.myId);
    lobbyState.amHost = !!(me && me.host);
    renderLobby();
  });
  net.on('start', (m) => {
    startOnlineRace(m);
  });
  net.on('st', (m) => {
    if (game && inOnlineRace) game.applyRemoteState(m.id, m);
  });
  net.on('fin', (m) => {
    const p = lobbyState.players.find(x => x.id === m.id);
    if (p) { p.fin = true; renderLobby(); }
  });
  net.on('results', (list) => {
    if (game && inOnlineRace) game.showOnlineResults(list.list || list);
  });
  net.on('reset', () => {
    inOnlineRace = false;
    disposeGame();
    goto('online');
    renderLobby();
  });
  net.on('close', () => {
    if (inOnlineRace || cur === 'online') setLobbyStatus('与服务器断开连接…');
  });
  net.on('error', () => {});

  function enterOnline() {
    goto('online');
    setLobbyStatus('正在连接服务器…');
    renderLobbyEmpty();
    if (!net.connected) net.connect();
    else net.send({ t: 'join', name: profile.name, color: profile.colorIdx });
  }

  function startOnlineRace(m) {
    disposeGame();
    inOnlineRace = true;
    const players = lobbyState.players.map(p => ({
      id: p.id, name: p.name, colorIdx: p.color,
      isPlayer: p.id === net.myId, isRemote: p.id !== net.myId,
    }));
    game = new window.RacerGame({
      mode: 'online', theme: m.theme, seed: m.seed, laps: m.laps,
      goAt: m.goAt, players, net, myId: net.myId,
      onResults: showResults,
    });
    goto('game');
    showLoading();
    game.start(setLoad).then(hideLoading);
  }

  function leaveOnline() {
    inOnlineRace = false;
    net.close();
    disposeGame();
  }

  /* ---------------- 大厅渲染 ---------------- */
  function setLobbyStatus(text) { $('lobbyStatus').textContent = text; }
  function renderLobbyEmpty() {
    $('lobbyList').innerHTML = '';
    $('btnStartOnline').disabled = true;
    $('themeRow').classList.add('hidden');
  }
  function renderLobby() {
    if (cur !== 'online') return;
    const box = $('lobbyList');
    box.innerHTML = '';
    lobbyState.players.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'lobby-row' + (p.id === net.myId ? ' me' : '');
      row.innerHTML =
        `<span class="ldot" style="background:${CFG.CAR_COLORS[p.color]}"></span>` +
        `<span class="lname">${escapeHtml(p.name)}</span>` +
        (p.host ? '<span class="lhost">房主</span>' : '') +
        (p.fin ? '<span class="lfin">已完赛</span>' : '');
      box.appendChild(row);
    });
    for (let i = lobbyState.players.length; i < CFG.MAX_PLAYERS; i++) {
      const row = document.createElement('div');
      row.className = 'lobby-row empty';
      row.innerHTML = `<span class="ldot"></span><span class="lname">等待玩家加入…</span>`;
      box.appendChild(row);
    }
    // 主题选择（房主）
    const canPick = lobbyState.amHost && lobbyState.role === 'player';
    $('themeRow').classList.toggle('hidden', !canPick);
    if (canPick) {
      document.querySelectorAll('#themeRow button').forEach(b => {
        b.classList.toggle('active', b.dataset.t === onlineTheme);
      });
    }
    // 开始按钮
    const btn = $('btnStartOnline');
    const enough = lobbyState.players.length >= 2;
    btn.disabled = !(lobbyState.amHost && lobbyState.role === 'player' && enough);
    btn.textContent = lobbyState.role === 'spec'
      ? '观战中（等待下一局）'
      : enough ? '开始比赛' : `等待玩家（${lobbyState.players.length}/2）`;
    if (enough && lobbyState.role === 'player') {
      setLobbyStatus(`已就绪！${lobbyState.players.length} 名玩家，房主可开始比赛 · 本机地址 ${location.host}`);
    } else if (lobbyState.role === 'player') {
      setLobbyStatus('至少 2 名玩家才能开始 · 把本页地址分享给朋友即可联机');
    }
  }

  /* ---------------- 结算界面 ---------------- */
  let resultsModeOnline = false;
  function showResults(list) {
    resultsModeOnline = !!(game && game.mode === 'online');
    goto('results');
    // 领奖台 3D
    if (game) game.enterPodium();
    // 名次列表
    const box = $('resultList');
    box.innerHTML = '';
    const medals = ['🥇', '🥈', '🥉'];
    list.forEach((r) => {
      const row = document.createElement('div');
      row.className = 'rrow' + (r.me ? ' me' : '');
      row.innerHTML =
        `<span class="rmedal">${medals[r.rank - 1] || `<b class="rrank">${r.rank}</b>`}</span>` +
        `<span class="rdot" style="background:${r.color}"></span>` +
        `<span class="rname">${escapeHtml(r.name)}</span>` +
        `<span class="rtime">${r.time ? fmtTime(r.time) : '未完赛'}</span>` +
        `<span class="rbest">${r.best ? '最快圈 ' + fmtTime(r.best) : ''}</span>`;
      box.appendChild(row);
    });
    // 按钮：离线全部可见；联机仅房主能直接重开
    $('btnAgain').classList.toggle('hidden', resultsModeOnline);
    $('btnAgainOnline').classList.toggle('hidden', !resultsModeOnline);
  }

  /* ---------------- 工具 ---------------- */
  function disposeGame() {
    if (game) { game.dispose(); game = null; }
  }
  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--:--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------------- UI 事件绑定 ---------------- */
  function bindProfileUI() {
    const nameInput = $('nameInput');
    nameInput.value = profile.name;
    nameInput.addEventListener('change', () => {
      const v = (nameInput.value || '').trim().slice(0, 12);
      profile.name = v || randomName();
      nameInput.value = profile.name;
      saveProfile();
    });
    const swatches = $('colorSwatches');
    CFG.CAR_COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch' + (i === profile.colorIdx ? ' active' : '');
      b.style.background = c;
      b.title = '车漆 ' + (i + 1);
      b.addEventListener('click', () => {
        profile.colorIdx = i;
        saveProfile();
        swatches.querySelectorAll('.swatch').forEach((x, j) => x.classList.toggle('active', j === i));
      });
      swatches.appendChild(b);
    });
  }

  function bindMenus() {
    // 主菜单
    $('btnSolo').addEventListener('click', () => goto('offline'));
    $('btnOnline').addEventListener('click', () => enterOnline());
    // 离线主题选择
    document.querySelectorAll('#screenOffline .theme-card').forEach(card => {
      card.addEventListener('click', () => startOffline(card.dataset.t));
    });
    $('btnBackMain1').addEventListener('click', () => goto('main'));
    // 在线大厅
    $('btnStartOnline').addEventListener('click', () => {
      if (!lobbyState.amHost) return;
      net.send({ t: 'start', theme: onlineTheme, laps: CFG.LAPS });
    });
    document.querySelectorAll('#themeRow button').forEach(b => {
      b.addEventListener('click', () => {
        if (!lobbyState.amHost) return;
        onlineTheme = b.dataset.t;
        renderLobby();
      });
    });
    $('btnBackMain2').addEventListener('click', () => { leaveOnline(); goto('main'); });
    // 结算
    $('btnAgain').addEventListener('click', () => {
      disposeGame();
      startOffline(lastOfflineTheme);
    });
    $('btnAgainOnline').addEventListener('click', () => {
      // 房主：直接重开一局（服务器处于 lobby 状态即可）
      if (lobbyState.amHost) {
        disposeGame();
        inOnlineRace = false;
        net.send({ t: 'start', theme: onlineTheme, laps: CFG.LAPS });
        goto('online');
        renderLobby();
      } else {
        disposeGame();
        inOnlineRace = false;
        goto('online');
        renderLobby();
      }
    });
    $('btnBackMain3').addEventListener('click', () => {
      if (resultsModeOnline) {
        disposeGame();
        inOnlineRace = false;
        net.close();
      } else {
        disposeGame();
      }
      goto('main');
    });
  }

  /* ---------------- 主题卡片：海报背景 + 路线小地图 ---------------- */
  const PREVIEW_SEED = 42;
  const POSTERS = {
    desert(g, w, h) {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#5a86c0'); sky.addColorStop(0.62, '#d8cfa8'); sky.addColorStop(1, '#c0a56b');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      // 太阳
      g.fillStyle = 'rgba(255,240,200,0.9)';
      g.beginPath(); g.arc(w * 0.78, h * 0.26, 13, 0, Math.PI * 2); g.fill();
      // 金字塔
      g.fillStyle = '#b39d74';
      g.beginPath(); g.moveTo(w * 0.18, h * 0.62); g.lineTo(w * 0.34, h * 0.3); g.lineTo(w * 0.5, h * 0.62); g.closePath(); g.fill();
      g.fillStyle = '#a68f68';
      g.beginPath(); g.moveTo(w * 0.4, h * 0.62); g.lineTo(w * 0.52, h * 0.4); g.lineTo(w * 0.64, h * 0.62); g.closePath(); g.fill();
      // 砂岩建筑
      g.fillStyle = '#b8a37a';
      g.fillRect(w * 0.66, h * 0.42, w * 0.13, h * 0.2);
      g.fillRect(w * 0.8, h * 0.5, w * 0.09, h * 0.12);
      // 路
      g.fillStyle = '#4a4d55';
      g.beginPath();
      g.moveTo(w * 0.05, h); g.quadraticCurveTo(w * 0.45, h * 0.72, w, h * 0.66);
      g.lineTo(w, h * 0.78); g.quadraticCurveTo(w * 0.45, h * 0.86, w * 0.05, h);
      g.closePath(); g.fill();
      // 路缘
      g.strokeStyle = '#e8433a'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(w * 0.05, h); g.quadraticCurveTo(w * 0.45, h * 0.72, w, h * 0.66); g.stroke();
      // 木箱
      g.fillStyle = '#8a6b42';
      g.fillRect(w * 0.12, h * 0.8, 12, 12); g.fillRect(w * 0.155, h * 0.8, 12, 12); g.fillRect(w * 0.138, h * 0.74, 12, 12);
    },
    forest(g, w, h) {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#3a6fb5'); sky.addColorStop(0.7, '#e8eef6'); sky.addColorStop(1, '#f2f6fb');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      // 雪 松树
      for (const [px, s] of [[0.12, 1], [0.24, 0.7], [0.55, 0.85], [0.68, 1.1], [0.85, 0.8], [0.94, 0.65]]) {
        const bx = w * px, by = h * 0.62, sc = s;
        g.fillStyle = '#5a4030';
        g.fillRect(bx - 3 * sc, by - 4 * sc, 6 * sc, 10 * sc);
        g.fillStyle = '#2a5a35';
        g.beginPath(); g.moveTo(bx - 16 * sc, by); g.lineTo(bx, by - 34 * sc); g.lineTo(bx + 16 * sc, by); g.closePath(); g.fill();
        g.fillStyle = '#f4f8fc';
        g.beginPath(); g.moveTo(bx - 10 * sc, by - 20 * sc); g.lineTo(bx, by - 34 * sc); g.lineTo(bx + 10 * sc, by - 20 * sc); g.closePath(); g.fill();
      }
      // 灯笼串
      g.strokeStyle = '#8a3a2a'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, h * 0.16); g.quadraticCurveTo(w * 0.5, h * 0.3, w, h * 0.14); g.stroke();
      for (const px of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const lx = w * px, ly = h * (0.16 + Math.sin(px * Math.PI) * 0.12) + 12;
        g.fillStyle = '#e03a2a';
        g.beginPath(); g.ellipse(lx, ly, 9, 11, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#ffc93c';
        g.fillRect(lx - 4, ly - 14, 8, 3); g.fillRect(lx - 4, ly + 10, 8, 3);
      }
      // 路 + 灯柱
      g.fillStyle = '#4a4d55';
      g.beginPath();
      g.moveTo(0, h); g.quadraticCurveTo(w * 0.5, h * 0.72, w, h * 0.68);
      g.lineTo(w, h * 0.8); g.quadraticCurveTo(w * 0.5, h * 0.86, 0, h);
      g.closePath(); g.fill();
      for (const px of [0.2, 0.62]) {
        const lx = w * px, ly = h * 0.7;
        g.fillStyle = '#b03a2a'; g.fillRect(lx, ly - 26, 4, 26);
        g.fillStyle = '#e03a2a';
        g.beginPath(); g.ellipse(lx + 2, ly - 30, 7, 9, 0, 0, Math.PI * 2); g.fill();
      }
    },
    sky(g, w, h) {
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#1c66d6'); sky.addColorStop(0.55, '#8fc4ee'); sky.addColorStop(1, '#dff3ff');
      g.fillStyle = sky; g.fillRect(0, 0, w, h);
      // 云
      for (const [px, py, s] of [[0.2, 0.3, 1], [0.55, 0.2, 0.7], [0.8, 0.38, 0.9], [0.35, 0.55, 0.6]]) {
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.beginPath(); g.ellipse(w * px, h * py, 34 * s, 12 * s, 0, 0, Math.PI * 2); g.fill();
      }
      // 浮岛 + 塔 + 水晶
      for (const [px, py, s] of [[0.3, 0.55, 1], [0.62, 0.42, 0.75], [0.86, 0.6, 0.9]]) {
        const ix = w * px, iy = h * py;
        g.fillStyle = '#62a84e';
        g.beginPath(); g.ellipse(ix, iy, 30 * s, 8 * s, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#8a7a68';
        g.beginPath(); g.moveTo(ix - 27 * s, iy + 4 * s); g.lineTo(ix, iy + 34 * s); g.lineTo(ix + 27 * s, iy + 4 * s); g.closePath(); g.fill();
        g.fillStyle = '#e8e2d2'; g.fillRect(ix - 7 * s, iy - 22 * s, 14 * s, 22 * s);
        g.fillStyle = '#4a7ec2';
        g.beginPath(); g.moveTo(ix - 9 * s, iy - 22 * s); g.lineTo(ix, iy - 36 * s); g.lineTo(ix + 9 * s, iy - 22 * s); g.closePath(); g.fill();
        g.fillStyle = 'rgba(127,227,255,0.9)';
        g.beginPath(); g.moveTo(ix + 18 * s, iy - 10 * s); g.lineTo(ix + 24 * s, iy - 22 * s); g.lineTo(ix + 28 * s, iy - 8 * s); g.closePath(); g.fill();
      }
      // 路（白色石板）
      g.fillStyle = '#e8eaee';
      g.beginPath();
      g.moveTo(0, h); g.quadraticCurveTo(w * 0.5, h * 0.7, w, h * 0.72);
      g.lineTo(w, h * 0.86); g.quadraticCurveTo(w * 0.5, h * 0.84, 0, h);
      g.closePath(); g.fill();
    },
  };
  function paintThemeCards() {
    document.querySelectorAll('#screenOffline .theme-card').forEach(card => {
      const theme = card.dataset.t;
      const bg = card.querySelector('.t-bg');
      const map = card.querySelector('.t-map');
      if (bg && POSTERS[theme]) {
        const g = bg.getContext('2d');
        POSTERS[theme](g, bg.width, bg.height);
      }
      if (map && window.RacerTrack) {
        try {
          const t = new window.RacerTrack(theme, PREVIEW_SEED);
          const mm = t.minimapData();
          const g = map.getContext('2d');
          g.clearRect(0, 0, map.width, map.height);
          g.lineWidth = 7; g.strokeStyle = 'rgba(8,12,18,0.55)';
          drawPath(g, mm, map.width);
          g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.95)';
          drawPath(g, mm, map.width);
          g.fillStyle = '#ff3b30';
          g.beginPath();
          g.arc(mm.start[0] * map.width, mm.start[1] * map.height, 3.5, 0, Math.PI * 2);
          g.fill();
        } catch (e) { /* 预览失败不阻塞菜单 */ }
      }
    });
    function drawPath(g, mm, S) {
      g.beginPath();
      mm.pts.forEach(([x, y], i) => {
        const px = x * S, py = y * S;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      });
      g.closePath();
      g.stroke();
    }
  }

  /* ---------------- 启动 ---------------- */
  bindProfileUI();
  bindMenus();
  paintThemeCards();
  goto('main');
})();
