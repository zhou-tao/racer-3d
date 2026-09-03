/* ============================================================
 * podium.js —— 结算领奖台（3D）
 *  前三名登台：金银铜台阶 + 各自赛车 + 名字牌，冠军头顶
 *  旋转大金杯，彩带纷飞，聚光灯 + 环绕镜头
 *  喝彩：掌声（audio.js）+ 彩带 + 车手小幅弹跳
 * ============================================================ */
(function (root) {
  'use strict';

  /* 金杯：碗身 + 杯颈 + 底座 + 双耳 */
  function buildTrophy() {
    const gold = new THREE.MeshStandardMaterial({ color: 0xffc93c, roughness: 0.18, metalness: 0.95 });
    const gold2 = new THREE.MeshStandardMaterial({ color: 0xffe082, roughness: 0.25, metalness: 0.85 });
    const g = new THREE.Group();
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.3, 0.7, 18), gold);
    bowl.position.y = 0.62;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.07, 10, 22), gold2);
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.97;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, 0.34, 12), gold);
    stem.position.y = 0.22;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 0.16, 16), gold2);
    base.position.y = 0.08;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), gold);
    knob.position.y = 0.42;
    g.add(bowl, rim, stem, base, knob);
    for (const s of [-1, 1]) {
      const ear = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.05, 8, 18, Math.PI * 1.2), gold);
      ear.position.set(0.62 * s, 0.72, 0);
      ear.rotation.z = s * -0.35;
      ear.rotation.y = Math.PI / 2;
      g.add(ear);
    }
    return g;
  }

  /* 名字牌（canvas 文字精灵） */
  function labelSprite(text, colorHex, sub) {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 160;
    const g = c.getContext('2d');
    g.textAlign = 'center';
    g.font = '900 64px "PingFang SC", "Microsoft YaHei", sans-serif';
    g.lineWidth = 10; g.strokeStyle = 'rgba(10,12,18,0.9)';
    g.strokeText(text, 256, 68);
    g.fillStyle = colorHex;
    g.fillText(text, 256, 68);
    g.font = '700 44px "PingFang SC", "Microsoft YaHei", sans-serif';
    g.strokeText(sub, 256, 132);
    g.fillStyle = '#ffffff';
    g.fillText(sub, 256, 132);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.scale.set(4.4, 1.375, 1);
    return sp;
  }

  function fmtTime(t) {
    if (t == null || !isFinite(t)) return '--:--';
    const m = Math.floor(t / 60), s = Math.floor(t % 60), ms = Math.floor((t % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
  }

  const STEP_COLORS = [0xffd75e, 0xcfd8dc, 0xd9905a];   // 金 银 铜

  /**
   * results: [{rank, name, color(hex), time, best, me}] 已按名次排序
   * 返回 { scene, camera, update(t,dt), dispose() }
   */
  function build(theme, results) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1220);
    scene.fog = new THREE.Fog(0x0d1220, 24, 70);

    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);

    /* 灯光：暗场 + 三束聚光 */
    scene.add(new THREE.HemisphereLight(0x8fa8d8, 0x1a1e2c, 0.5));
    const spots = [];
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.SpotLight(0xffffff, 1.6, 60, 0.5, 0.45, 1.2);
      const x = (i - 1) * 5.2;
      sp.position.set(x * 0.6, 14, 8);
      sp.target.position.set(x, 0, 0);
      scene.add(sp, sp.target);
      spots.push(sp);
    }
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-10, 6, -12);
    scene.add(rim);

    /* 地面（反光圆台） */
    const floor = new THREE.Mesh(
      new THREE.CylinderGeometry(16, 16, 0.5, 48),
      new THREE.MeshStandardMaterial({ color: 0x141a2a, roughness: 0.35, metalness: 0.6 })
    );
    floor.position.y = -0.25;
    scene.add(floor);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(14.2, 0.06, 8, 80),
      new THREE.MeshBasicMaterial({ color: 0x3a4a7a })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.01;
    scene.add(ring);

    /* 领奖台：1 号居中最高 */
    const layout = [
      { rank: 1, x: 0, h: 2.4 },
      { rank: 2, x: -4.6, h: 1.6 },
      { rank: 3, x: 4.6, h: 1.0 },
    ];
    const carVisuals = [];
    const labels = [];
    const trophies = [];
    for (const L of layout) {
      const res = results.find(r => r.rank === L.rank);
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(3.9, L.h, 3.9),
        new THREE.MeshStandardMaterial({ color: STEP_COLORS[L.rank - 1], roughness: 0.3, metalness: 0.55 })
      );
      step.position.set(L.x, L.h / 2, 0);
      scene.add(step);
      // 台阶正面号牌
      const num = new THREE.Mesh(
        new THREE.PlaneGeometry(1.4, 1.4),
        new THREE.MeshBasicMaterial({ map: numTex(L.rank), transparent: true })
      );
      num.position.set(L.x, L.h * 0.55, 1.96);
      scene.add(num);

      if (res) {
        // 赛车停上台
        const car = root.RacerCar.buildCarModel(res.color);
        car.group.position.set(L.x, L.h + 0.02, 0);
        car.group.rotation.y = Math.PI;           // 车头面向镜头
        scene.add(car.group);
        carVisuals.push(car);
        // 名字牌
        const label = labelSprite(res.name, res.color,
          `#${L.rank} · ${res.time ? fmtTime(res.time) : '未完赛'}`);
        label.position.set(L.x, L.h + 2.6, 0);
        scene.add(label);
        labels.push(label);
        // 冠军金杯
        if (L.rank === 1) {
          const tr = buildTrophy();
          tr.position.set(L.x, L.h + 3.6, 0);
          tr.scale.setScalar(1.5);
          scene.add(tr);
          trophies.push(tr);
        }
      }
    }

    /* 彩带 + 掌声 */
    const confetti = new root.RacerEffects.Confetti(scene, 160);
    root.RacerAudio.applause(7);

    /* 星空背景点 */
    const starGeo = new THREE.BufferGeometry();
    const sp = [];
    for (let i = 0; i < 300; i++) {
      const a = Math.random() * Math.PI * 2, r = 30 + Math.random() * 40;
      sp.push(Math.cos(a) * r, Math.random() * 30, Math.sin(a) * r);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x5a6a9a, size: 0.12 })));

    let t0 = null;
    function update(t, dt) {
      if (t0 === null) t0 = t;
      const lt = t - t0;
      // 镜头缓慢环绕
      const a = lt * 0.16;
      const r = 13.5;
      camera.position.set(Math.sin(a) * r, 4.6 + Math.sin(lt * 0.3) * 0.5, Math.cos(a) * r);
      camera.lookAt(0, 2.1, 0);
      // 金杯旋转悬浮
      for (const tr of trophies) {
        tr.rotation.y = lt * 1.2;
        tr.position.y = 2.4 + 3.6 + Math.sin(lt * 2) * 0.12;
      }
      // 冠军车弹跳欢呼
      if (carVisuals[0]) {
        const hop = Math.max(0, Math.sin(lt * 3.4)) * 0.5;
        carVisuals[0].group.position.y = 2.4 + 0.02 + hop;
        carVisuals[0].wheels.forEach(w => { w.rotation.x -= dt * 2; });
      }
      confetti.update(dt);
    }

    function dispose() {
      scene.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          const ms = Array.isArray(o.material) ? o.material : [o.material];
          ms.forEach(m => { m.map && m.map.dispose(); m.dispose(); });
        }
      });
      confetti.dispose();
    }

    return { scene, camera, update, dispose };
  }

  let _numTexCache = {};
  function numTex(n) {
    if (_numTexCache[n]) return _numTexCache[n];
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.font = '900 92px "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.strokeText(String(n), 64, 70);
    g.fillStyle = 'rgba(30,34,44,0.92)';
    g.fillText(String(n), 64, 70);
    const tex = new THREE.CanvasTexture(c);
    if (THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
    _numTexCache[n] = tex;
    return tex;
  }

  root.RacerPodium = { build };
})(window);
