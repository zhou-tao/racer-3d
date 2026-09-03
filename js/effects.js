/* ============================================================
 * effects.js —— 粒子特效（浏览器专用）
 *  - ParticlePool：着色器点精灵池（每粒子独立大小/颜色/透明度）
 *      smoke 池（普通混合）：漂移胎烟、落地尘土
 *      spark 池（加亮混合）：氮气尾焰、撞墙火花
 *  - Confetti：领奖台彩带（实例化四边形，旋转飘落）
 * ============================================================ */
(function (root) {
  'use strict';

  const VERT = `
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vAlpha = aAlpha;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * (240.0 / max(1.0, -mv.z));
      gl_Position = projectionMatrix * mv;
    }`;
  const FRAG = `
    uniform sampler2D uTex;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vec4 tex = texture2D(uTex, gl_PointCoord);
      gl_FragColor = vec4(vColor, tex.a * vAlpha);
      if (gl_FragColor.a < 0.01) discard;
    }`;

  class ParticlePool {
    constructor(scene, max, additive) {
      this.max = max;
      this.pos = new Float32Array(max * 3);
      this.vel = new Float32Array(max * 3);
      this.col = new Float32Array(max * 3);
      this.colEnd = new Float32Array(max * 3);
      this.size = new Float32Array(max);
      this.sizeEnd = new Float32Array(max);
      this.alpha = new Float32Array(max);
      this.life = new Float32Array(max);
      this.lifeMax = new Float32Array(max);
      this.grav = new Float32Array(max);
      this.cursor = 0;
      this.alive = 0;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
      geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
      geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
      geo.setDrawRange(0, 0);
      const mat = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: root.RacerScene.getSoftTex() } },
        vertexShader: VERT, fragmentShader: FRAG,
        transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      });
      this.points = new THREE.Points(geo, mat);
      this.points.frustumCulled = false;
      scene.add(this.points);
      this.geo = geo;
    }

    spawn(o) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      this.alive = Math.min(this.alive + 1, this.max);
      const i3 = i * 3;
      this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
      this.vel[i3] = o.vx || 0; this.vel[i3 + 1] = o.vy || 0; this.vel[i3 + 2] = o.vz || 0;
      const c = new THREE.Color(o.color);
      const ce = new THREE.Color(o.colorEnd != null ? o.colorEnd : o.color);
      this.col[i3] = c.r; this.col[i3 + 1] = c.g; this.col[i3 + 2] = c.b;
      this.colEnd[i3] = ce.r; this.colEnd[i3 + 1] = ce.g; this.colEnd[i3 + 2] = ce.b;
      this.size[i] = o.size; this.sizeEnd[i] = o.sizeEnd != null ? o.sizeEnd : o.size;
      this.alpha[i] = o.alpha != null ? o.alpha : 1;
      this.life[i] = this.lifeMax[i] = o.life;
      this.grav[i] = o.gravity || 0;
    }

    update(dt) {
      let alive = 0;
      for (let i = 0; i < this.max; i++) {
        if (this.life[i] <= 0) continue;
        this.life[i] -= dt;
        if (this.life[i] <= 0) { this.alpha[i] = 0; continue; }
        const i3 = i * 3;
        this.vel[i3 + 1] -= this.grav[i] * dt;
        this.pos[i3] += this.vel[i3] * dt;
        this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
        this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
        const t = 1 - this.life[i] / this.lifeMax[i];
        this.size[i] += (this.sizeEnd[i] - this.size[i]) * Math.min(1, t * 3 + 0.02);
        this.col[i3] += (this.colEnd[i3] - this.col[i3]) * Math.min(1, t * 4);
        this.col[i3 + 1] += (this.colEnd[i3 + 1] - this.col[i3 + 1]) * Math.min(1, t * 4);
        this.col[i3 + 2] += (this.colEnd[i3 + 2] - this.col[i3 + 2]) * Math.min(1, t * 4);
        this.alpha[i] = (1 - t) * (this.lifeMax[i] > 0 ? 1 : 0);
        alive++;
      }
      this.alive = alive;
      this.geo.setDrawRange(0, this.max);
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.aColor.needsUpdate = true;
      this.geo.attributes.aSize.needsUpdate = true;
      this.geo.attributes.aAlpha.needsUpdate = true;
    }

    dispose() {
      this.geo.dispose();
      this.points.material.dispose();
      this.points.parent && this.points.parent.remove(this.points);
    }
  }

  /* ---------------- 特效管理器 ---------------- */
  class Effects {
    constructor(scene) {
      this.scene = scene;
      this.smoke = new ParticlePool(scene, 700, false);
      this.spark = new ParticlePool(scene, 900, true);
      this._t = 0;
    }

    /** 每帧：绑定某辆车的漂移烟 + 喷射尾焰 */
    carEffects(track, sim, visual, dt) {
      this._t += dt;
      const p = visual.group.position;
      // 喷射尾焰：锥体伸缩 + 蓝橙粒子
      const boosting = sim.boostingNow;
      for (const f of visual.flames) {
        f.visible = boosting;
        if (boosting) {
          const s = 0.75 + Math.sin(this._t * 42 + f.position.x * 10) * 0.3;
          f.scale.set(1, s, 1);
          f.material.color.setHex(sim.nitroT > 0 ? 0x7fd4ff : 0xffc36e);
        }
      }
      if (boosting) {
        const back = new THREE.Vector3(0, 0.66, -2.0).applyEuler(visual.group.rotation);
        for (let k = 0; k < 2; k++) {
          this.spark.spawn({
            x: p.x + back.x, y: p.y + back.y, z: p.z + back.z,
            vx: -back.x * 9 + (Math.random() - 0.5) * 2.5,
            vy: -back.y * 9 + 0.5 + (Math.random() - 0.5) * 2.5,
            vz: -back.z * 9 + (Math.random() - 0.5) * 2.5,
            life: 0.28 + Math.random() * 0.18,
            size: 1.5, sizeEnd: 0.2,
            color: sim.nitroT > 0 ? 0x66ccff : 0xffb74d,
            colorEnd: 0xff5722,
            alpha: 0.9,
          });
        }
      }
      // 漂移胎烟：后轮位置喷灰白烟
      if (sim.drift && sim.grounded && sim.spd > 10) {
        const yaw = visual.group.rotation.y;
        for (const sx of [-0.95, 0.95]) {
          const wx = p.x - Math.sin(yaw) * 1.0 + Math.cos(yaw) * sx;
          const wz = p.z - Math.cos(yaw) * 1.0 - Math.sin(yaw) * sx;
          if (Math.random() < 0.75) {
            this.smoke.spawn({
              x: wx, y: p.y + 0.15, z: wz,
              vx: (Math.random() - 0.5) * 2.2, vy: 1.2 + Math.random(), vz: (Math.random() - 0.5) * 2.2,
              life: 0.55 + Math.random() * 0.4,
              size: 0.9, sizeEnd: 3.2,
              color: 0xf2f2f2, colorEnd: 0xdddddd,
              alpha: 0.5, gravity: -0.6,
            });
          }
        }
      }
      // 落地尘土
      if (sim.grounded && sim._justLanded > 0) {
        sim._justLanded -= dt;
        for (let k = 0; k < 5; k++) {
          const a = Math.random() * Math.PI * 2;
          this.smoke.spawn({
            x: p.x + Math.cos(a) * 1.2, y: p.y + 0.2, z: p.z + Math.sin(a) * 1.2,
            vx: Math.cos(a) * 3.5, vy: 1.5, vz: Math.sin(a) * 3.5,
            life: 0.4, size: 1.2, sizeEnd: 3.4,
            color: 0xd8c9a8, alpha: 0.55, gravity: 2,
          });
        }
      }
    }

    wallSpark(pos, side) {
      for (let k = 0; k < 14; k++) {
        this.spark.spawn({
          x: pos.x, y: pos.y + 0.4, z: pos.z,
          vx: (Math.random() - 0.5) * 9, vy: Math.random() * 5, vz: (Math.random() - 0.5) * 9,
          life: 0.3 + Math.random() * 0.25,
          size: 0.8, sizeEnd: 0.1,
          color: 0xffd54f, colorEnd: 0xff7043,
          alpha: 1, gravity: 14,
        });
      }
    }

    fallSplash(pos, color) {
      for (let k = 0; k < 18; k++) {
        const a = Math.random() * Math.PI * 2;
        this.smoke.spawn({
          x: pos.x, y: pos.y, z: pos.z,
          vx: Math.cos(a) * 5, vy: 3 + Math.random() * 4, vz: Math.sin(a) * 5,
          life: 0.6, size: 1.4, sizeEnd: 3.6,
          color: color || 0xcfe8ff, alpha: 0.7, gravity: 9,
        });
      }
    }

    update(dt) {
      this.smoke.update(dt);
      this.spark.update(dt);
    }

    dispose() {
      this.smoke.dispose();
      this.spark.dispose();
    }
  }

  /* ---------------- 领奖台彩带 ---------------- */
  class Confetti {
    constructor(scene, count, colors) {
      this.count = count;
      this.colors = colors || [0xff5252, 0xffd740, 0x69f0ae, 0x40c4ff, 0xe040fb, 0xffab40];
      const geo = new THREE.PlaneGeometry(0.28, 0.42);
      const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, vertexColors: false });
      this.mesh = new THREE.InstancedMesh(geo, mat, count);
      this.mesh.frustumCulled = false;
      this.parts = [];
      const m4 = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        this.parts.push({
          x: (Math.random() - 0.5) * 26,
          y: 8 + Math.random() * 14,
          z: (Math.random() - 0.5) * 14 - 2,
          vy: 1.6 + Math.random() * 2.2,
          phase: Math.random() * Math.PI * 2,
          spin: 1.5 + Math.random() * 3,
          sway: 0.8 + Math.random() * 1.6,
          rx: Math.random() * Math.PI, rz: Math.random() * Math.PI,
        });
        const c = new THREE.Color(this.colors[i % this.colors.length]);
        this.mesh.setColorAt(i, c);
        this.mesh.setMatrixAt(i, m4.makeScale(0, 0, 0));
      }
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
      scene.add(this.mesh);
      this._t = 0;
    }

    update(dt) {
      this._t += dt;
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const sc = new THREE.Vector3(1, 1, 1);
      for (let i = 0; i < this.count; i++) {
        const p = this.parts[i];
        p.y -= p.vy * dt;
        p.rx += p.spin * dt;
        p.rz += p.spin * 0.7 * dt;
        if (p.y < 0.1) { p.y = 10 + Math.random() * 12; p.x = (Math.random() - 0.5) * 26; }
        e.set(p.rx, p.phase, p.rz);
        q.setFromEuler(e);
        m4.compose(
          new THREE.Vector3(p.x + Math.sin(this._t * p.sway + p.phase) * p.sway, p.y, p.z),
          q, sc
        );
        this.mesh.setMatrixAt(i, m4);
      }
      this.mesh.instanceMatrix.needsUpdate = true;
    }

    dispose() {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
      this.mesh.parent && this.mesh.parent.remove(this.mesh);
    }
  }

  root.RacerEffects = { Effects, Confetti, ParticlePool };
})(window);
