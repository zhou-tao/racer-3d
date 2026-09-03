/* ============================================================
 * scene.js —— 主题环境 + 赛道网格（浏览器专用，依赖 DOM canvas）
 *
 *  buildWorld(theme, track, seed) → { group, update(dt), dispose() }
 *    - 天空渐变穹顶 / 雾 / 光照
 *    - 主题装饰：沙漠(仙人掌·岩石·金字塔) 森林(树海·浓雾)
 *                天空之城(云海·浮岛·城堡塔)
 *    - 赛道网格：沥青路面(canvas 纹理: 路缘红白+中线) / 双侧护栏
 *      / 起点拱门 / 检查点光柱 / 断崖下的沙坑与水面
 * ============================================================ */
(function (root) {
  'use strict';

  const CFG = root.RacerConfig;
  const TrackCls = root.RacerTrack;
  const ROAD_W = CFG.ROAD_WIDTH;

  /* ---------------- 主题参数 ---------------- */
  const THEME_ENV = {
    desert: {
      skyTop: 0x5a86c0, skyBottom: 0xd8cfa8, fog: 0xd6cbb0,
      fogDensity: 0.0012, ground: 0xc0a56b, sun: 0xfff1d0, sunInt: 0.8,
      hemiSky: 0xc4cfe0, hemiGround: 0x9d8b64, hemiInt: 0.5,
      name: '沙漠灰', emoji: '🏜️',
    },
    forest: {
      skyTop: 0x3a6fb5, skyBottom: 0xe8eef6, fog: 0xe3ebf4,
      fogDensity: 0.002, ground: 0xe8edf4, sun: 0xfff5e8, sunInt: 0.7,
      hemiSky: 0xd8e6ff, hemiGround: 0xb8c4d8, hemiInt: 0.55,
      name: '新年广场', emoji: '🏮',
    },
    sky: {
      skyTop: 0x1c66d6, skyBottom: 0xdff3ff, fog: 0xd8ecff,
      fogDensity: 0.0009, ground: null, sun: 0xffffff, sunInt: 0.9,
      hemiSky: 0xcfe8ff, hemiGround: 0x9fc4e8, hemiInt: 0.6,
      name: '天空之城', emoji: '☁️',
    },
  };

  /* ---------------- 纹理工厂 ---------------- */
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (THREE.sRGBEncoding) t.encoding = THREE.sRGBEncoding;
    return t;
  }

  let roadTex = null, cloudTex = null, softTex = null;
  function getRoadTex() {
    if (roadTex) return roadTex;
    roadTex = canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#3a3d44'; g.fillRect(0, 0, w, h);
      // 沥青噪点
      for (let i = 0; i < 900; i++) {
        g.fillStyle = `rgba(${180 + Math.random() * 60 | 0},${180 + Math.random() * 60 | 0},${190 + Math.random() * 60 | 0},${Math.random() * 0.06})`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      // 中线（虚线）
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(w / 2 - 3, 20, 6, h / 2 - 40);
      // 两侧红白路缘
      for (let y = 0; y < h; y += 32) {
        g.fillStyle = (y / 32) % 2 ? '#e8433a' : '#f5f5f5';
        g.fillRect(0, y, 14, 32);
        g.fillRect(w - 14, y, 14, 32);
      }
      // 边缘暗角
      const grd = g.createLinearGradient(0, 0, w, 0);
      grd.addColorStop(0, 'rgba(0,0,0,0.25)'); grd.addColorStop(0.2, 'rgba(0,0,0,0)');
      grd.addColorStop(0.8, 'rgba(0,0,0,0)'); grd.addColorStop(1, 'rgba(0,0,0,0.25)');
      g.fillStyle = grd; g.fillRect(0, 0, w, h);
    });
    roadTex.repeat.set(1, 1);
    return roadTex;
  }
  function getCloudTex() {
    if (cloudTex) return cloudTex;
    cloudTex = canvasTex(256, 256, (g) => {
      g.clearRect(0, 0, 256, 256);
      for (const [x, y, r] of [[128, 150, 70], [88, 150, 48], [172, 148, 52], [110, 128, 44], [150, 126, 40]]) {
        const grd = g.createRadialGradient(x, y, 4, x, y, r);
        grd.addColorStop(0, 'rgba(255,255,255,0.95)');
        grd.addColorStop(0.7, 'rgba(255,255,255,0.5)');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    });
    return cloudTex;
  }
  function getSoftTex() {
    if (softTex) return softTex;
    softTex = canvasTex(128, 128, (g) => {
      const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    });
    return softTex;
  }

  /* ---------------- 天空穹顶 ---------------- */
  function buildSkyDome(env) {
    const geo = new THREE.SphereGeometry(880, 24, 14);
    const top = new THREE.Color(env.skyTop), bot = new THREE.Color(env.skyBottom);
    const colors = [];
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 880;               // -1..1
      const t = clamp01((y + 0.25) / 1.1);
      const c = bot.clone().lerp(top, Math.pow(t, 0.8));
      colors.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false });
    const dome = new THREE.Mesh(geo, mat);
    dome.renderOrder = -10;
    return dome;
  }
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  /* ---------------- 赛道网格 ---------------- */
  function buildTrackMeshes(track) {
    const group = new THREE.Group();
    const N = track.samples.count;
    const { pos, side, dist } = track.samples;
    const half = ROAD_W / 2;
    const railH = 1.1;

    const gapAt = (d) => track.inGap(d);

    /* 路面：连续段分批建（跳过 GAP） */
    const runs = [];
    let s = -1;
    for (let i = 0; i <= N; i++) {
      const gap = i === N || gapAt(dist[i % N]);
      if (!gap && s < 0) s = i;
      if (gap && s >= 0) { runs.push([s, i - 1]); s = -1; }
    }
    const roadTex = getRoadTex();
    const roadMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.85, metalness: 0.05 });
    for (const [i0, i1] of runs) {
      const count = i1 - i0 + 1;
      const verts = new Float32Array(count * 2 * 3);
      const uvs = new Float32Array(count * 2 * 2);
      const idx = [];
      for (let k = 0; k < count; k++) {
        const i = (i0 + k) % N;
        const d = dist[i];
        const h = track.roadHeightAt(d);
        const p = pos[i], sd = side[i];
        const o = k * 6;
        verts[o] = p.x - sd.x * half; verts[o + 1] = h; verts[o + 2] = p.z - sd.z * half;
        verts[o + 3] = p.x + sd.x * half; verts[o + 4] = h; verts[o + 5] = p.z + sd.z * half;
        const v = d / 9;
        uvs[k * 4] = 0; uvs[k * 4 + 1] = v;
        uvs[k * 4 + 2] = 1; uvs[k * 4 + 3] = v;
        if (k < count - 1) {
          const a = k * 2;
          idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);   // 法线朝上（可从上方看到路面）
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      group.add(new THREE.Mesh(geo, roadMat));

      /* 护栏：双面立墙 + 顶条 */
      for (const sg of [-1, 1]) {
        const rv = new Float32Array(count * 2 * 3);
        const ruv = new Float32Array(count * 2 * 2);
        const ridx = [];
        for (let k = 0; k < count; k++) {
          const i = (i0 + k) % N;
          const d = dist[i];
          const h = track.roadHeightAt(d);
          const p = pos[i], sd = side[i];
          const bx = p.x + sd.x * (half - 0.15) * sg;
          const bz = p.z + sd.z * (half - 0.15) * sg;
          const o = k * 6;
          rv[o] = bx; rv[o + 1] = h; rv[o + 2] = bz;
          rv[o + 3] = bx; rv[o + 4] = h + railH; rv[o + 5] = bz;
          const v = d / 6;
          ruv[k * 4] = sg < 0 ? 0 : 1; ruv[k * 4 + 1] = v;
          ruv[k * 4 + 2] = sg < 0 ? 0.5 : 0.5; ruv[k * 4 + 3] = v;
          if (k < count - 1) {
            const a = k * 2;
            ridx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
          }
        }
        const rgeo = new THREE.BufferGeometry();
        rgeo.setAttribute('position', new THREE.BufferAttribute(rv, 3));
        rgeo.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
        rgeo.setIndex(ridx);
        rgeo.computeVertexNormals();
        const railMat = new THREE.MeshStandardMaterial({
          color: 0xe8eaee, roughness: 0.5, metalness: 0.3,
          side: THREE.DoubleSide,
        });
        group.add(new THREE.Mesh(rgeo, railMat));
      }
    }

    /* 护栏立柱：每 ~22m 一对 */
    const postGeo = new THREE.BoxGeometry(0.22, 1.5, 0.22);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.4 });
    const postCount = Math.floor(track.length / 22) * 2;
    const posts = new THREE.InstancedMesh(postGeo, postMat, postCount);
    const m4 = new THREE.Matrix4();
    let pi = 0;
    for (let d = 0; d < track.length && pi < postCount; d += 22) {
      if (track.inGap(d)) continue;
      const p = track.pointAt(d), sd = track.sideAt(d), h = track.roadHeightAt(d);
      for (const sg of [-1, 1]) {
        m4.makeTranslation(p.x + sd.x * (half - 0.3) * sg, h + 0.7, p.z + sd.z * (half - 0.3) * sg);
        posts.setMatrixAt(pi++, m4);
      }
    }
    posts.count = pi;
    group.add(posts);

    /* 断崖下的坑：沙坑 / 水面（钳在地面之上保证可见） */
    const pit = track.pitKind;
    for (const f of track.features) {
      const dMid = f.b + f.gap / 2;
      const c = track.pointAt(dMid);
      if (pit === 'water') {
        const w = new THREE.Mesh(
          new THREE.CircleGeometry(f.gap * 1.1, 24),
          new THREE.MeshStandardMaterial({ color: 0x3f8fce, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.9 })
        );
        w.rotation.x = -Math.PI / 2;
        w.position.set(c.x, Math.max(c.y - 1.8, -0.15), c.z);
        group.add(w);
      } else if (pit === 'sand') {
        const w = new THREE.Mesh(
          new THREE.CircleGeometry(f.gap * 1.1, 24),
          new THREE.MeshStandardMaterial({ color: 0xb98f4e, roughness: 1 })
        );
        w.rotation.x = -Math.PI / 2;
        w.position.set(c.x, Math.max(c.y - 2.4, -0.2), c.z);
        group.add(w);
      }
      // 断口警示条纹（路沿末端挡板）
      for (const dd of [f.b - 0.4, f.b + f.gap + 0.4]) {
        const p = track.pointAt(dd), sd = track.sideAt(dd), h = track.roadHeightAt(dd);
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(ROAD_W, 0.5, 0.3),
          new THREE.MeshStandardMaterial({ color: 0xe8433a, roughness: 0.6 })
        );
        strip.position.set(p.x, h + 0.1, p.z);
        strip.rotation.y = Math.atan2(sd.x, sd.z) + Math.PI / 2;
        group.add(strip);
      }
    }

    /* 起点拱门 */
    group.add(buildStartArch(track));
    /* 检查点光柱 */
    const cpGroup = new THREE.Group();
    const cpPillars = [];
    for (let c = 1; c < CFG.CP_COUNT; c++) {
      const gate = track.cpGate(c);
      const geo = new THREE.CylinderGeometry(0.5, 0.5, 26, 8, 1, true);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x6ee7ff, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false,
      });
      const pil = new THREE.Mesh(geo, mat);
      pil.position.set(gate.center.x, gate.center.y + 12, gate.center.z);
      cpGroup.add(pil);
      cpPillars.push(pil);
    }
    group.add(cpGroup);

    return { group, cpPillars };
  }

  function buildStartArch(track) {
    const g = new THREE.Group();
    const gate = track.cpGate(0);
    const p = gate.center, sd = gate.side, h = track.roadHeightAt(0);
    const pillarGeo = new THREE.BoxGeometry(1.1, 9, 1.1);
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.4, metalness: 0.3 });
    for (const sg of [-1, 1]) {
      const pil = new THREE.Mesh(pillarGeo, pillarMat);
      pil.position.set(p.x + sd.x * (ROAD_W / 2 + 1) * sg, h + 4.5, p.z + sd.z * (ROAD_W / 2 + 1) * sg);
      g.add(pil);
    }
    // 横梁 + 格纹
    const yaw = Math.atan2(sd.x, sd.z);
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_W + 4.4, 1.8, 0.7),
      new THREE.MeshStandardMaterial({ map: checkerTex(), roughness: 0.5 })
    );
    beam.position.set(p.x, h + 8.2, p.z);
    beam.rotation.y = yaw + Math.PI / 2;
    g.add(beam);
    // 起跑线
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(ROAD_W - 1, 2.2),
      new THREE.MeshStandardMaterial({ map: checkerTex(), roughness: 0.6 })
    );
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -yaw;
    line.position.set(p.x, h + 0.03, p.z);
    g.add(line);
    return g;
  }

  let checker = null;
  function checkerTex() {
    if (checker) return checker;
    checker = canvasTex(128, 128, (g) => {
      const n = 8, s = 128 / n;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        g.fillStyle = (x + y) % 2 ? '#16181d' : '#f4f6f8';
        g.fillRect(x * s, y * s, s, s);
      }
    });
    return checker;
  }

  /* ---------------- 地面与装饰 ---------------- */
  function distToTrackOk(track, x, z, min) {
    const { pos } = track.samples;
    const min2 = min * min;
    for (let i = 0; i < pos.length; i += 4) {
      const dx = pos[i].x - x, dz = pos[i].z - z;
      if (dx * dx + dz * dz < min2) return false;
    }
    return true;
  }

  /* ---------------- 沙漠灰（CF 风格：灰褐砂岩 + 建筑群 + 木箱）---------------- */
  function buildDesert(track, rng, group) {
    const env = THEME_ENV.desert;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(700, 48),
      new THREE.MeshStandardMaterial({ color: env.ground, roughness: 1 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.35;
    group.add(ground);

    // 砂岩建筑群（沿赛道外围，城垛顶中东小镇风）
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xc7b28c, roughness: 0.9 });
    const wallMat2 = new THREE.MeshStandardMaterial({ color: 0xb39d76, roughness: 0.9 });
    const winMat = new THREE.MeshStandardMaterial({ color: 0x2e2a24, roughness: 0.8 });
    for (let b = 0; b < 9; b++) {
      const a = (b / 9) * Math.PI * 2 + rng() * 0.5;
      const r = 130 + rng() * 220;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 14)) continue;
      const w = 8 + rng() * 10, hgt = 6 + rng() * 9, dep = 8 + rng() * 8;
      const bd = new THREE.Group();
      const box = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, dep), b % 2 ? wallMat : wallMat2);
      box.position.y = hgt / 2;
      bd.add(box);
      // 城垛顶
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.6, 0.7, dep + 0.6), wallMat2);
      top.position.y = hgt + 0.35;
      bd.add(top);
      // 窗（正面两排）
      for (let wy = 0; wy < 2; wy++) {
        for (let wx = -1; wx <= 1; wx++) {
          const win = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.4, 0.2), winMat);
          win.position.set(wx * w * 0.28, hgt * (0.3 + wy * 0.32), dep / 2 + 0.05);
          bd.add(win);
        }
      }
      bd.position.set(x, 0, z);
      bd.rotation.y = rng() * Math.PI;
      group.add(bd);
    }

    // 跨路石拱门 ×2（砂岩色，赛道上方）
    for (let gi = 0; gi < 2; gi++) {
      let d = track.length * (0.3 + gi * 0.38) + rng() * 60;
      if (track.inGap(d)) d += 60;
      const p = track.pointAt(d), sd = track.sideAt(d), h = track.roadHeightAt(d);
      const archMat = new THREE.MeshStandardMaterial({ color: 0xbfa87e, roughness: 0.85 });
      const arch = new THREE.Group();
      for (const sg of [-1, 1]) {
        const col = new THREE.Mesh(new THREE.BoxGeometry(1.6, 8.5, 1.6), archMat);
        col.position.set(sd.x * (ROAD_W / 2 + 1.4) * sg, 4.25, sd.z * (ROAD_W / 2 + 1.4) * sg);
        arch.add(col);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD_W + 6, 1.6, 2), archMat);
      beam.position.y = 8.6;
      beam.rotation.y = Math.atan2(sd.x, sd.z) + Math.PI / 2;
      arch.add(beam);
      arch.position.set(p.x, h, p.z);
      group.add(arch);
    }

    // 木箱堆（CF 经典元素）
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x9a7b4f, roughness: 0.85 });
    const crateMat2 = new THREE.MeshStandardMaterial({ color: 0x8a6b42, roughness: 0.85 });
    for (let c = 0; c < 16; c++) {
      const a = rng() * Math.PI * 2, r = 95 + rng() * 320;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 5)) continue;
      const stack = new THREE.Group();
      const n = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < n; k++) {
        const s = 1.3 - k * 0.15;
        const box = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), k % 2 ? crateMat2 : crateMat);
        box.position.y = s / 2 + k * s;
        box.rotation.y = rng() * 0.5;
        stack.add(box);
      }
      stack.position.set(x, 0, z);
      group.add(stack);
    }

    // 沙丘（扁球）
    const duneGeo = new THREE.SphereGeometry(1, 10, 7);
    const duneMat = new THREE.MeshStandardMaterial({ color: 0xbaa06a, roughness: 1 });
    const dunes = new THREE.InstancedMesh(duneGeo, duneMat, 46);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();
    let n = 0;
    for (let tries = 0; tries < 400 && n < 46; tries++) {
      const a = rng() * Math.PI * 2, r = 120 + rng() * 480;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const s = 8 + rng() * 26;
      // 沙丘很大：按实际半径留距，避免挡住赛道视野
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 8 + s)) continue;
      sc.set(s, s * (0.16 + rng() * 0.1), s * 0.8);
      pv.set(x, -0.5, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
      m4.compose(pv, q, sc);
      dunes.setMatrixAt(n++, m4);
    }
    dunes.count = n;
    group.add(dunes);

    // 仙人掌
    const cacGroup = new THREE.Group();
    const cacMat = new THREE.MeshStandardMaterial({ color: 0x4a7a50, roughness: 0.8 });
    for (let i = 0; i < 60; i++) {
      const a = rng() * Math.PI * 2, r = 110 + rng() * 420;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 7)) continue;
      const hgt = 2.2 + rng() * 2.4;
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.4, hgt, 8), cacMat);
      t.position.set(x, hgt / 2, z);
      cacGroup.add(t);
      if (rng() > 0.4) {
        const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 1.2, 8), cacMat);
        arm.position.set(x + 0.5, hgt * 0.6, z);
        arm.rotation.z = -0.9;
        cacGroup.add(arm);
      }
    }
    group.add(cacGroup);

    // 岩石
    const rockGeo = new THREE.DodecahedronGeometry(1, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a8a6e, roughness: 0.95 });
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 40);
    let rn = 0;
    for (let tries = 0; tries < 300 && rn < 40; tries++) {
      const a = rng() * Math.PI * 2, r = 90 + rng() * 460;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 6)) continue;
      const s = 1 + rng() * 4;
      sc.set(s, s * (0.6 + rng() * 0.5), s);
      pv.set(x, s * 0.3, z);
      q.setFromEuler(new THREE.Euler(rng() * 0.4, rng() * Math.PI, rng() * 0.4));
      m4.compose(pv, q, sc);
      rocks.setMatrixAt(rn++, m4);
    }
    rocks.count = rn;
    group.add(rocks);

    // 远景金字塔
    for (let i = 0; i < 3; i++) {
      const a = rng() * Math.PI * 2;
      const r = 480 + rng() * 160;
      const hgt = 60 + rng() * 50;
      const py = new THREE.Mesh(
        new THREE.ConeGeometry(hgt * 0.95, hgt, 4),
        new THREE.MeshStandardMaterial({ color: 0xbfa478, roughness: 1, flatShading: true })
      );
      py.position.set(Math.cos(a) * r, hgt / 2 - 4, Math.sin(a) * r);
      py.rotation.y = rng() * Math.PI;
      group.add(py);
    }

    // 太阳精灵
    const sun = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getSoftTex(), color: 0xffe9b0, transparent: true, opacity: 0.9, fog: false, depthWrite: false,
    }));
    sun.scale.set(180, 180, 1);
    sun.position.set(400, 260, -500);
    group.add(sun);
  }

  /* ---------------- 新年广场（CF 风格：雪地 + 红灯笼 + 新春横幅）---------------- */
  function buildForest(track, rng, group) {
    const env = THEME_ENV.forest;
    // 雪地
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(700, 48),
      new THREE.MeshStandardMaterial({ color: env.ground, roughness: 0.85 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.35;
    group.add(ground);

    const Y = new THREE.Vector3(0, 1, 0);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pv = new THREE.Vector3();

    // 雪松：深绿锥体叠白雪
    const trunkGeo = new THREE.CylinderGeometry(0.28, 0.4, 2.2, 6);
    const crownGeo = new THREE.ConeGeometry(1.7, 4.6, 8);
    const snowGeo = new THREE.ConeGeometry(1.15, 2.2, 8);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4030, roughness: 0.9 });
    const crownMat = new THREE.MeshStandardMaterial({ color: 0x2a5a35, roughness: 0.85, flatShading: true });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xf4f8fc, roughness: 0.75 });
    const MAX = 180;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, MAX);
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, MAX);
    const snows = new THREE.InstancedMesh(snowGeo, snowMat, MAX);
    let n = 0;
    for (let tries = 0; tries < 1200 && n < MAX; tries++) {
      const a = rng() * Math.PI * 2, r = 95 + rng() * 430;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 6)) continue;
      const s = 0.8 + rng() * 1.5;
      q.setFromAxisAngle(Y, rng() * Math.PI * 2);
      pv.set(x, 1.0 * s, z); sc.set(s, s, s);
      m4.compose(pv, q, sc); trunks.setMatrixAt(n, m4);
      pv.set(x, 4.3 * s, z);
      m4.compose(pv, q, sc); crowns.setMatrixAt(n, m4);
      pv.set(x, 5.7 * s, z);
      m4.compose(pv, q, sc); snows.setMatrixAt(n, m4);
      n++;
    }
    trunks.count = crowns.count = snows.count = n;
    group.add(trunks, crowns, snows);

    // 红灯笼灯柱：沿赛道交替左右布置
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xb03a2a, roughness: 0.6 });
    const lanternMat = new THREE.MeshStandardMaterial({
      color: 0xe03a2a, emissive: 0xd42a1a, emissiveIntensity: 0.85, roughness: 0.4,
    });
    const tasselMat = new THREE.MeshStandardMaterial({ color: 0xffc93c, roughness: 0.5 });
    const glowMat = new THREE.SpriteMaterial({
      map: getSoftTex(), color: 0xff5a3c, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const lanternPosts = [];
    for (let d = 60; d < track.length - 40; d += 55 + rng() * 45) {
      if (track.inGap(d)) continue;
      const p = track.pointAt(d), sd = track.sideAt(d), h = track.roadHeightAt(d);
      const sg = lanternPosts.length % 2 ? 1 : -1;
      const bx = p.x + sd.x * (ROAD_W / 2 + 2.2) * sg;
      const bz = p.z + sd.z * (ROAD_W / 2 + 2.2) * sg;
      const post = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 4.6, 8), poleMat);
      pole.position.y = 2.3;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.12), poleMat);
      arm.position.set(-0.6 * sg, 4.5, 0);
      const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.55, 14, 10), lanternMat);
      lantern.scale.set(1, 1.15, 1);
      lantern.position.set(-1.15 * sg, 4.1, 0);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.14, 8), tasselMat);
      cap.position.set(-1.15 * sg, 4.75, 0);
      const tassel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), tasselMat);
      tassel.position.set(-1.15 * sg, 3.4, 0);
      const glow = new THREE.Sprite(glowMat);
      glow.scale.set(3.2, 3.2, 1);
      glow.position.copy(lantern.position);
      post.add(pole, arm, lantern, cap, tassel, glow);
      post.position.set(bx, h, bz);
      post.rotation.y = Math.atan2(sd.x, sd.z);
      group.add(post);
      lanternPosts.push(post);
    }

    // 新春横幅门 ×2（红色横梁 + 金字"新年快乐"）
    const bannerTex = canvasTex(512, 96, (g2, w, h) => {
      g2.fillStyle = '#c62828'; g2.fillRect(0, 0, w, h);
      g2.strokeStyle = '#ffd54f'; g2.lineWidth = 6;
      g2.strokeRect(8, 8, w - 16, h - 16);
      g2.fillStyle = '#ffd54f';
      g2.font = '900 56px "PingFang SC", "Microsoft YaHei", sans-serif';
      g2.textAlign = 'center'; g2.textBaseline = 'middle';
      g2.fillText('新 年 快 乐', w / 2, h / 2 + 4);
    });
    for (let gi = 0; gi < 2; gi++) {
      let d = track.length * (0.18 + gi * 0.45) + rng() * 50;
      if (track.inGap(d)) d += 50;
      const p = track.pointAt(d), sd = track.sideAt(d), h = track.roadHeightAt(d);
      const gate = new THREE.Group();
      for (const sg of [-1, 1]) {
        const col = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7.5, 0.8), poleMat);
        col.position.set(sd.x * (ROAD_W / 2 + 1) * sg, 3.75, sd.z * (ROAD_W / 2 + 1) * sg);
        gate.add(col);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), lanternMat);
        lamp.position.set(sd.x * (ROAD_W / 2 + 1) * sg, 6.9, sd.z * (ROAD_W / 2 + 1) * sg);
        gate.add(lamp);
      }
      const beam = new THREE.Mesh(
        new THREE.BoxGeometry(ROAD_W + 4, 1.5, 0.5),
        new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.5 })
      );
      beam.position.y = 7;
      beam.rotation.y = Math.atan2(sd.x, sd.z) + Math.PI / 2;
      gate.add(beam);
      gate.position.set(p.x, h, p.z);
      group.add(gate);
    }

    // 礼盒堆
    const giftColors = [0xd84343, 0xd8a543, 0x4a7ec2, 0x4caf7d];
    const ribbonMat = new THREE.MeshStandardMaterial({ color: 0xffd54f, roughness: 0.4 });
    for (let c = 0; c < 14; c++) {
      const a = rng() * Math.PI * 2, r = 90 + rng() * 300;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 5)) continue;
      const s = 0.8 + rng() * 0.9;
      const box = new THREE.Mesh(new THREE.BoxGeometry(s, s, s),
        new THREE.MeshStandardMaterial({ color: giftColors[c % 4], roughness: 0.6 }));
      box.position.set(x, s / 2, z);
      box.rotation.y = rng() * Math.PI;
      const rx = new THREE.Mesh(new THREE.BoxGeometry(s * 1.04, s * 1.04, s * 0.18), ribbonMat);
      rx.position.copy(box.position); rx.rotation.y = box.rotation.y;
      const rz = new THREE.Mesh(new THREE.BoxGeometry(s * 0.18, s * 1.04, s * 1.04), ribbonMat);
      rz.position.copy(box.position); rz.rotation.y = box.rotation.y;
      group.add(box, rx, rz);
    }

    // 雪人 ×2
    for (let i = 0; i < 2; i++) {
      const a = rng() * Math.PI * 2, r = 100 + rng() * 200;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 6)) continue;
      const sm = new THREE.Group();
      const b1 = new THREE.Mesh(new THREE.SphereGeometry(1.1, 14, 10), snowMat);
      b1.position.y = 0.9;
      const b2 = new THREE.Mesh(new THREE.SphereGeometry(0.75, 14, 10), snowMat);
      b2.position.y = 2.3;
      const b3 = new THREE.Mesh(new THREE.SphereGeometry(0.5, 14, 10), snowMat);
      b3.position.y = 3.3;
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.5, 8),
        new THREE.MeshStandardMaterial({ color: 0xe8762c, roughness: 0.7 }));
      nose.rotation.x = Math.PI / 2;
      nose.position.set(0, 3.32, 0.55);
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.5, 10),
        new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 0.6 }));
      hat.position.y = 3.85;
      sm.add(b1, b2, b3, nose, hat);
      sm.position.set(x, 0, z);
      group.add(sm);
    }
  }

  function buildSkyCity(track, rng, group) {
    // 云海（两层：远处大片 + 近处漂浮）
    const cloudMat = new THREE.SpriteMaterial({ map: getCloudTex(), transparent: true, opacity: 0.9, depthWrite: false });
    const sea = new THREE.Group();
    for (let i = 0; i < 130; i++) {
      const a = rng() * Math.PI * 2, r = 60 + rng() * 560;
      const sp = new THREE.Sprite(cloudMat.clone());
      sp.material.opacity = 0.5 + rng() * 0.45;
      const s = 40 + rng() * 110;
      sp.scale.set(s, s * 0.42, 1);
      sp.position.set(Math.cos(a) * r, -34 - rng() * 26, Math.sin(a) * r);
      sea.add(sp);
    }
    group.add(sea);

    // 高空散云
    const high = new THREE.Group();
    for (let i = 0; i < 40; i++) {
      const a = rng() * Math.PI * 2, r = 120 + rng() * 460;
      const sp = new THREE.Sprite(cloudMat.clone());
      sp.material.opacity = 0.35 + rng() * 0.3;
      const s = 30 + rng() * 70;
      sp.scale.set(s, s * 0.4, 1);
      sp.position.set(Math.cos(a) * r, 14 + rng() * 46, Math.sin(a) * r);
      high.add(sp);
    }
    group.add(high);

    // 浮岛：岩柱倒锥 + 草顶
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a7a68, roughness: 0.9, flatShading: true });
    const grassMat = new THREE.MeshStandardMaterial({ color: 0x62a84e, roughness: 0.9 });
    const islands = [];
    for (let i = 0; i < 16; i++) {
      const a = rng() * Math.PI * 2, r = 100 + rng() * 380;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const R = 10 + rng() * 26;
      // 浮岛很大：按实际半径留距
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 10 + R)) continue;
      const y = track.pointAt(rng() * track.length).y + (rng() - 0.5) * 40;
      const isl = new THREE.Group();
      const top = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 0.92, 2.4, 9), grassMat);
      const under = new THREE.Mesh(new THREE.ConeGeometry(R * 0.92, R * 1.1, 9), rockMat);
      under.rotation.x = Math.PI;
      under.position.y = -R * 0.55 - 1.2;
      isl.add(top, under);
      isl.position.set(x, y, z);
      group.add(isl);
      islands.push(isl);

      // 城堡塔（1/3 岛上）
      if (rng() > 0.62) {
        const towerMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d2, roughness: 0.6 });
        const roofMat = new THREE.MeshStandardMaterial({ color: 0x4a7ec2, roughness: 0.4, metalness: 0.3 });
        const goldMat = new THREE.MeshStandardMaterial({
          color: 0xffc93c, roughness: 0.25, metalness: 0.9, emissive: 0x8a6a10, emissiveIntensity: 0.35,
        });
        const tw = new THREE.Group();
        const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.22, R * 0.26, R * 0.9, 10), towerMat);
        body.position.y = R * 0.45;
        const roof = new THREE.Mesh(new THREE.ConeGeometry(R * 0.32, R * 0.5, 10), roofMat);
        roof.position.y = R * 0.9 + R * 0.25;
        const finial = new THREE.Mesh(new THREE.SphereGeometry(R * 0.06, 10, 8), goldMat);
        finial.position.y = R * 1.42;
        const flag = new THREE.Mesh(
          new THREE.PlaneGeometry(2.2, 1.3),
          new THREE.MeshBasicMaterial({ color: 0xffd54f, side: THREE.DoubleSide })
        );
        flag.position.y = R * 1.62;
        tw.add(body, roof, finial, flag);
        tw.position.set(x, y + 1.2, z);
        group.add(tw);
        islands.push(tw);
      }
    }

    // 浮空水晶簇（半透明青色发光）
    const crystalMat = new THREE.MeshStandardMaterial({
      color: 0x7fe3ff, emissive: 0x2a9fd8, emissiveIntensity: 0.7,
      transparent: true, opacity: 0.82, roughness: 0.1, metalness: 0.2,
    });
    const crystals = new THREE.Group();
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2, r = 90 + rng() * 360;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (!distToTrackOk(track, x, z, ROAD_W / 2 + 14)) continue;
      const y = track.pointAt(rng() * track.length).y + 8 + rng() * 26;
      const cl = new THREE.Group();
      const nC = 2 + Math.floor(rng() * 2);
      for (let k = 0; k < nC; k++) {
        const hgt = 2 + rng() * 4;
        const c = new THREE.Mesh(new THREE.OctahedronGeometry(hgt * 0.4, 0), crystalMat);
        c.scale.set(1, hgt / (hgt * 0.4) * 0.5, 1);
        c.position.set((rng() - 0.5) * 2.4, hgt * 0.3, (rng() - 0.5) * 2.4);
        c.rotation.y = rng() * Math.PI;
        c.rotation.z = (rng() - 0.5) * 0.4;
        cl.add(c);
      }
      cl.position.set(x, y, z);
      crystals.add(cl);
    }
    group.add(crystals);
    return { sea, high };
  }

  /* ---------------- 主入口 ---------------- */
  function buildWorld(theme, track, seed) {
    const env = THEME_ENV[theme] || THEME_ENV.desert;
    const rng = TrackCls.mulberry32((seed ^ 0x51ED270B) >>> 0);
    const group = new THREE.Group();
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(env.fog, env.fogDensity);
    scene.add(buildSkyDome(env));

    // 光照
    const hemi = new THREE.HemisphereLight(env.hemiSky, env.hemiGround, env.hemiInt);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(env.sun, env.sunInt);
    sun.position.set(180, 320, 140);
    scene.add(sun);

    // 赛道网格
    const tm = buildTrackMeshes(track);
    scene.add(tm.group);

    // 主题装饰
    let animated = null;
    if (theme === 'desert') buildDesert(track, rng, scene);
    else if (theme === 'forest') buildForest(track, rng, scene);
    else animated = buildSkyCity(track, rng, scene);

    return {
      scene, env,
      cpPillars: tm.cpPillars,
      update(t, dt) {
        if (animated) {
          animated.high.position.y = Math.sin(t * 0.18) * 3;
          let i = 0;
          for (const c of animated.sea.children) {
            c.position.x += Math.sin(t * 0.3 + i++) * 0.02;
          }
        }
        // 检查点光柱呼吸
        const pulse = 0.12 + Math.sin(t * 2.4) * 0.05;
        for (const p of tm.cpPillars) p.material.opacity = pulse;
      },
    };
  }

  root.RacerScene = {
    THEME_ENV, buildWorld, getRoadTex, getSoftTex, getCloudTex, checkerTex,
  };
})(window);
