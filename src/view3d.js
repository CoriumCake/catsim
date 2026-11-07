/* CatSim — 3D view of the circuit (Three.js, loaded on first use).
 * Read-only mirror of the 2D diagram: 2D (x, y) maps to 3D (x, z) with Y up, 1 unit = 1 px.
 * Live state (LEDs, servo, LCD, buzzer…) comes from the same def.state() the 2D canvas uses. */
import { DEFS, LED_COLORS } from './components.js';
const DIRS = { l: [-1, 0], r: [1, 0], t: [0, -1], b: [0, 1] };
const BTN_COLORS = { red: '#e5484d', blue: '#3d8bff', green: '#2fbf71', yellow: '#f5c518', black: '#30343c' };
const PIN_TOP = 10, ESP_PIN_TOP = 15, DEG = Math.PI / 180;

// Three.js is code-split: it is only downloaded the first time someone opens the 3D view.
let THREE = null, OrbitControls = null, libPromise = null;
const loadLibs = () => libPromise || (libPromise = Promise.all([import('three'), import('three/examples/jsm/controls/OrbitControls.js')])
  .then(([three, orbit]) => {
    THREE = three; OrbitControls = orbit.OrbitControls;
    THREE.ColorManagement.enabled = false; // keep the colours as authored (r128 look)
  })
  .catch((e) => { libPromise = null; throw e; }));

function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4;
  return t;
}

class View3D {
  constructor(app, stage) {
    this.app = app; this.stage = stage;
    this.active = false; this.dirty = true; this.ready = false;
    this.updaters = []; this.disp = []; this.picks = [];
    this.camFitted = false;
  }

  // ---------- lifecycle ----------
  async show() {
    await loadLibs();
    if (!this.ready) this.init();
    this.active = true;
    this.el.hidden = false;
    this.resize();
    if (this.dirty) this.rebuild();
    if (!this.camFitted) this.fit();
    this.loop();
  }

  hide() {
    this.active = false;
    if (this.el) this.el.hidden = true;
    this.release();
  }

  init() {
    const T = THREE;
    this.renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.outputColorSpace = T.LinearSRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = T.PCFSoftShadowMap;
    this.el = this.renderer.domElement;
    this.el.className = 'view3d';
    this.el.hidden = true;
    this.stage.insertBefore(this.el, this.stage.querySelector('.float-bar'));

    this.scene = new T.Scene();
    this.scene.background = new T.Color('#fdf5e8');
    this.camera = new T.PerspectiveCamera(38, 1, 5, 20000);
    this.scene.add(new T.HemisphereLight(0xffffff, 0xb9a98a, 0.75 * Math.PI));
    const sun = this.sun = new T.DirectionalLight(0xffffff, 0.75 * Math.PI);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0008; sun.shadow.radius = 3;
    this.scene.add(sun, sun.target);
    const under = new T.DirectionalLight(0xfff4e0, 0.45 * Math.PI); under.position.set(0.3, -1, 0.4); this.scene.add(under); // fill light for the undersides
    this.root = new T.Group(); this.scene.add(this.root);

    this.glowTex = canvasTex(64, 64, (g) => {
      const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    });

    const c = this.controls = new OrbitControls(this.camera, this.el);
    c.enableDamping = true; c.dampingFactor = 0.12; c.screenSpacePanning = true;
    c.minPolarAngle = 0; c.maxPolarAngle = Math.PI; // full 360°: look under the boards too c.minDistance = 60; c.maxDistance = 4000;

    this.ray = new T.Raycaster(); this.ptr = new T.Vector2();
    this.el.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', () => this.release());
    this.el.addEventListener('pointermove', (e) => this.onMove(e));
    this.el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    this.el.addEventListener('drop', (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('text/catsim-part'); if (type) this.app.addComponent(type);
    });
    new ResizeObserver(() => this.resize()).observe(this.stage);
    this.ready = true;
  }

  resize() {
    if (!this.renderer) return;
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (w < 2 || h < 2) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  loop() {
    if (!this.active || this._raf) return;
    const tick = () => {
      this._raf = 0;
      if (!this.active) return;
      if (this.dirty) this.rebuild();
      this.update();
      this.controls.update();
      this.seeThrough();
      this.renderer.render(this.scene, this.camera);
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  // ---------- camera ----------
  bounds() {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const c of this.app.project.components) {
      const d = DEFS[c.type]; if (!d) continue;
      x0 = Math.min(x0, c.x); z0 = Math.min(z0, c.y); x1 = Math.max(x1, c.x + d.w); z1 = Math.max(z1, c.y + d.h);
    }
    if (x0 === Infinity) return { x0: 0, z0: 0, x1: 300, z1: 300 };
    return { x0, z0, x1, z1 };
  }

  fit() {
    if (!this.ready) return;
    const b = this.bounds();
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const span = Math.max(b.x1 - b.x0, (b.z1 - b.z0) * this.camera.aspect, 200);
    const dist = (span / 2) / Math.tan((this.camera.fov / 2) * DEG) / Math.max(1, this.camera.aspect) * 1.25 + 120;
    const elev = 52 * DEG;
    this.controls.target.set(cx, 0, cz);
    this.camera.position.set(cx, Math.sin(elev) * dist, cz + Math.cos(elev) * dist);
    this.controls.update();
    this.camFitted = true;
  }

  // From below, fade the cutting mat to glass and hide the shadow floor so the PCB backs are visible.
  seeThrough() {
    if (!this.matMesh) return;
    const below = this.camera.position.y < 0;
    const m = this.matMesh.material, want = below ? 0.18 : 1;
    if (Math.abs(m.opacity - want) > 0.005) m.opacity += (want - m.opacity) * 0.2; else m.opacity = want;
    m.depthWrite = m.opacity > 0.95;
    this.floorMesh.visible = !below;
  }

  zoom(f) {
    if (!this.ready) return;
    const t = this.controls.target, p = this.camera.position;
    const v = p.clone().sub(t).multiplyScalar(1 / f);
    const len = Math.min(this.controls.maxDistance, Math.max(this.controls.minDistance, v.length()));
    p.copy(t).add(v.setLength(len));
  }

  // ---------- building blocks ----------
  mat(color, extra = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, ...extra });
    this.disp.push(m); if (m.map) this.disp.push(m.map);
    return m;
  }
  geo(g) { this.disp.push(g); return g; }
  mesh(geo, mat, parent, x = 0, y = 0, z = 0, shadow = true) {
    const m = new THREE.Mesh(this.geo(geo), mat);
    m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = true;
    parent.add(m); return m;
  }
  // box by its footprint in part-local 2D coords: (x, z) top-left, size w×d, from y0 to y1
  box(g, x, z, w, d, y0, y1, mat) { return this.mesh(new THREE.BoxGeometry(w, y1 - y0, d), mat, g, x + w / 2, (y0 + y1) / 2, z + d / 2); }
  cyl(g, x, z, r, y0, y1, mat, seg = 24) { return this.mesh(new THREE.CylinderGeometry(r, r, y1 - y0, seg), mat, g, x, (y0 + y1) / 2, z); }
  rod(g, a, b, r, mat) { // thin cylinder between two local points
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const m = this.mesh(new THREE.CylinderGeometry(r, r, A.distanceTo(B), 8), mat, g, 0, 0, 0, false);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    return m;
  }
  glow(g, x, y, z, size, color) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.disp.push(s.material);
    s.position.set(x, y, z); s.scale.set(size, size, 1); s.raycast = () => {};
    g.add(s); return s;
  }
  tex(w, h, draw) { const t = canvasTex(w, h, draw); this.disp.push(t); return t; }
  // floor-level leg from a body point to a pin
  leg(g, x0, z0, x1, z1) { this.rod(g, [x0, 1, z0], [x1, 1, z1], 0.9, this.M.lead); }

  pinTop(c, p) {
    if (c.type === 'esp32') return { x: c.x + (p.x === 0 ? 5 : 145), y: ESP_PIN_TOP, z: c.y + p.y };
    return { x: c.x + p.x, y: PIN_TOP, z: c.y + p.y };
  }

  // ---------- scene ----------
  clear() {
    for (const o of this.disp) o.dispose();
    this.disp = []; this.updaters = []; this.picks = [];
    while (this.root.children.length) this.root.remove(this.root.children[0]);
  }

  rebuild() {
    this.dirty = false;
    this.clear();
    const T = THREE;
    this.M = {
      lead: this.mat('#b9bec7', { metalness: 0.7, roughness: 0.35 }),
      gold: this.mat('#d8b24a', { metalness: 0.8, roughness: 0.3 }),
      header: this.mat('#1b1d22', { roughness: 0.8 }),
      metal: this.mat('#c9ced6', { metalness: 0.75, roughness: 0.3 }),
    };
    const P = this.app.project;

    // cutting mat under the parts + soft shadow catcher around it
    const b = this.bounds(); const pad = 90;
    const mw = b.x1 - b.x0 + pad * 2, md = b.z1 - b.z0 + pad * 2;
    const grid = this.tex(128, 128, (g) => {
      g.fillStyle = '#2f6d55'; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(255,255,255,.10)'; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
      g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1;
      for (let i = 32; i < 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.moveTo(0, i); g.lineTo(128, i); g.stroke(); }
    });
    grid.wrapS = grid.wrapT = T.RepeatWrapping; grid.repeat.set(mw / 80, md / 80);
    const mat = this.mesh(new T.BoxGeometry(mw, 2, md), this.mat('#ffffff', { map: grid, roughness: 0.95 }), this.root, (b.x0 + b.x1) / 2, -1, (b.z0 + b.z1) / 2, false);
    mat.userData.ground = true; this.matMesh = mat;
    mat.material.transparent = true;
    const floor = this.mesh(new T.PlaneGeometry(20000, 20000), (() => { const m = new T.ShadowMaterial({ opacity: 0.12 }); this.disp.push(m); return m; })(), this.root, 0, -2.01, 0, false);
    floor.rotation.x = -Math.PI / 2; this.floorMesh = floor;

    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2, r = Math.max(mw, md) / 2 + 60;
    this.sun.position.set(cx - r * 0.5, r * 1.6, cz - r * 0.35); this.sun.target.position.set(cx, 0, cz);
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: r * 4 });
    this.sun.shadow.camera.updateProjectionMatrix();

    for (const c of P.components) {
      const d = DEFS[c.type]; if (!d) continue;
      const g = new T.Group(); g.position.set(c.x, 0, c.y); g.userData.compId = c.id;
      this.root.add(g); this.picks.push(g);
      const build = this['build_' + c.type];
      if (build) build.call(this, g, c, d);
      if (c.type !== 'esp32') for (const p of d.pins) {
        this.box(g, p.x - 2.5, p.y - 2.5, 5, 5, 0, 3.5, this.M.header);
        this.cyl(g, p.x, p.y, 0.9, 3.5, PIN_TOP, this.M.gold, 8);
      }
    }

    // wires: tubes arching up between pin tops
    P.wires.forEach((w, i) => {
      const pa = this.app.canvas.pinPos(w.from), pb = this.app.canvas.pinPos(w.to); if (!pa || !pb) return;
      const a = this.pinTop(pa.comp, pa.pin), z = this.pinTop(pb.comp, pb.pin);
      const A = new T.Vector3(a.x, a.y, a.z), B = new T.Vector3(z.x, z.y, z.z);
      const dist = A.distanceTo(B);
      const h = Math.min(90, Math.max(18, dist * 0.32)), d = Math.min(70, Math.max(10, dist * 0.25));
      const da = DIRS[pa.pin.dir] || [0, 0], db = DIRS[pb.pin.dir] || [0, 0];
      const curve = new T.CubicBezierCurve3(A,
        new T.Vector3(a.x + da[0] * d, a.y + h, a.z + da[1] * d),
        new T.Vector3(z.x + db[0] * d, z.y + h, z.z + db[1] * d), B);
      const m = this.mesh(new T.TubeGeometry(curve, Math.max(24, Math.round(dist / 6)), 1.6, 8, false),
        this.mat(this.app.canvas.wireColor(w, i), { roughness: 0.45 }), this.root);
      m.userData.wireId = w.id; this.picks.push(m);
      for (const e of [A, B]) this.mesh(new T.SphereGeometry(1.9, 10, 8), m.material, this.root, e.x, e.y, e.z, false);
    });
  }

  update() {
    const sim = this.app.sim;
    for (const u of this.updaters) {
      const c = u.c; const d = DEFS[c.type];
      let s = {};
      try { s = d.state ? d.state(c, sim) : {}; } catch (_) { /* part not ready */ }
      u.fn(s, c, sim);
    }
  }
  live(c, fn) { this.updaters.push({ c, fn }); }

  // ---------- parts ----------
  build_esp32(g, c) {
    const T = THREE;
    const PCB_Y0 = 4, PCB_Y1 = 7;
    const pins = DEFS.esp32.pins;
    const top = this.tex(600, 1048, (x) => {
      const k = 4; x.scale(k, k);
      x.fillStyle = '#151b28'; x.fillRect(0, 0, 150, 262);
      x.fillStyle = '#c4cbd8'; x.font = '600 6.5px ui-monospace, Menlo, monospace'; x.textBaseline = 'middle';
      for (const p of pins) { x.textAlign = p.x === 0 ? 'left' : 'right'; x.fillText(p.label, p.x === 0 ? 11 : 139, p.y + 0.5); }
      x.fillStyle = '#7f8aa3'; x.textAlign = 'center'; x.font = '600 7px system-ui, sans-serif'; x.fillText('DEVKIT V1', 75, 146);
      x.font = '600 5px system-ui, sans-serif'; x.fillText('PWR', 62, 214); x.fillText('IO2', 90, 214); x.fillText('EN', 51, 230); x.fillText('BOOT', 101, 230);
    });
    // Back side. The -Y box face shows the image flipped about the X axis, so physical z maps to row 262 - z.
    const back = this.tex(600, 1048, (x) => {
      const k = 4; x.scale(k, k);
      x.fillStyle = '#151b28'; x.fillRect(0, 0, 150, 262);
      x.strokeStyle = 'rgba(201,162,39,.35)'; x.lineWidth = 1.1; x.lineCap = 'round';
      const traces = [[[18, 70], [40, 70], [52, 82], [52, 150]], [[132, 90], [110, 90], [98, 102], [98, 170]], [[18, 160], [60, 160], [75, 175], [75, 220]], [[132, 200], [100, 200], [90, 210]], [[30, 230], [120, 230]]];
      for (const t of traces) { x.beginPath(); t.forEach(([a, b], i) => (i ? x.lineTo(a, b) : x.moveTo(a, b))); x.stroke(); }
      x.fillStyle = 'rgba(201,162,39,.5)';
      for (const [a, b] of [[52, 150], [98, 170], [75, 220], [90, 210], [40, 120], [110, 60]]) { x.beginPath(); x.arc(a, b, 1.6, 0, Math.PI * 2); x.fill(); }
      x.textBaseline = 'middle'; x.font = '600 6.5px ui-monospace, Menlo, monospace';
      for (const p of pins) {
        const row = 262 - p.y, px = p.x === 0 ? 5 : 145;
        x.fillStyle = '#d8b24a'; x.beginPath(); x.arc(px, row, 3.4, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#151b28'; x.beginPath(); x.arc(px, row, 1.3, 0, Math.PI * 2); x.fill();
        x.fillStyle = '#c4cbd8'; x.textAlign = p.x === 0 ? 'left' : 'right'; x.fillText(p.label, p.x === 0 ? 11 : 139, row + 0.5);
      }
      x.fillStyle = '#d8b24a'; x.fillRect(57, 262 - 266, 36, 14);
      x.fillStyle = '#c4cbd8'; x.textAlign = 'center';
      x.font = '700 9px system-ui, sans-serif'; x.fillText('ESP32 DEVKIT V1', 75, 118);
      x.font = '600 6px system-ui, sans-serif'; x.fillText('CP2102 · AMS1117-3.3', 75, 130); x.fillText('sim.catcodehq.com', 75, 140);
      x.strokeStyle = '#c4cbd8'; x.lineWidth = 0.8; x.strokeRect(46, 100, 58, 46);
    });
    const side = this.mat('#151b28', { roughness: 0.7 });
    const pcb = this.mesh(new T.BoxGeometry(150, PCB_Y1 - PCB_Y0, 262),
      [side, side, this.mat('#ffffff', { map: top, roughness: 0.7 }), this.mat('#ffffff', { map: back, roughness: 0.7 }), side, side], g, 75, (PCB_Y0 + PCB_Y1) / 2, 131);
    pcb.material.forEach((m) => this.disp.includes(m) || this.disp.push(m));
    // header strips (underneath, holding the board up) and pins on top
    for (const x of [0, 140]) this.box(g, x, 30, 10, 212, 0, PCB_Y0, this.M.header);
    for (const p of pins) {
      const px = p.x === 0 ? 5 : 145;
      this.box(g, px - 2.6, p.y - 2.6, 5.2, 5.2, PCB_Y1, PCB_Y1 + 2.5, this.M.header);
      this.cyl(g, px, p.y, 0.9, PCB_Y1 + 2.5, ESP_PIN_TOP, this.M.gold, 8);
    }
    // WROOM module: antenna PCB + metal shield
    this.box(g, 34, 6, 82, 120, PCB_Y1, PCB_Y1 + 1.6, this.mat('#1f232d'));
    const ant = this.tex(328, 112, (x) => { x.strokeStyle = '#c9a227'; x.lineWidth = 8; x.beginPath(); x.moveTo(24, 96); [[24, 20], [56, 20], [56, 96], [88, 96], [88, 20], [120, 20], [120, 96], [152, 96], [152, 20], [184, 20], [184, 96], [216, 96], [216, 20], [248, 20], [248, 96], [280, 96], [280, 20], [304, 20]].forEach(([a, b]) => x.lineTo(a, b)); x.stroke(); });
    const antM = this.mesh(new T.PlaneGeometry(82, 28), this.mat('#ffffff', { map: ant, transparent: true, roughness: 0.4, metalness: 0.4 }), g, 75, PCB_Y1 + 1.65, 20, false);
    antM.rotation.x = -Math.PI / 2;
    const shieldTop = this.tex(280, 344, (x) => {
      const gr = x.createLinearGradient(0, 0, 280, 344); gr.addColorStop(0, '#e6e9ed'); gr.addColorStop(0.5, '#bcc2cb'); gr.addColorStop(1, '#d7dbe1');
      x.fillStyle = gr; x.fillRect(0, 0, 280, 344);
      x.fillStyle = '#4b525c'; x.textAlign = 'center'; x.font = '700 44px system-ui, sans-serif'; x.fillText('ESP32', 140, 160);
      x.font = '600 26px system-ui, sans-serif'; x.fillText('WROOM-32', 140, 205);
    });
    const sm = this.M.metal;
    const shield = this.mesh(new T.BoxGeometry(70, 3, 86), [sm, sm, this.mat('#ffffff', { map: shieldTop, metalness: 0.5, roughness: 0.35 }), sm, sm, sm], g, 75, PCB_Y1 + 3.1, 77);
    shield.material.forEach((m) => this.disp.includes(m) || this.disp.push(m));
    // LEDs
    const ledY = PCB_Y1 + 1;
    const pwr = this.box(g, 58, 200, 8, 5, PCB_Y1, ledY + 0.6, this.mat('#3a1418', { emissive: '#ff3344', emissiveIntensity: 0 }));
    const io2 = this.box(g, 86, 200, 8, 5, PCB_Y1, ledY + 0.6, this.mat('#14233d', { emissive: '#3d8bff', emissiveIntensity: 0 }));
    const gp = this.glow(g, 62, ledY + 3, 202.5, 26, '#ff3344'), gi = this.glow(g, 90, ledY + 3, 202.5, 34, '#3d8bff');
    // EN / BOOT buttons and USB
    for (const x of [44, 94]) { this.box(g, x, 236, 14, 10, PCB_Y1, PCB_Y1 + 3, this.M.metal); this.cyl(g, x + 7, 241, 3, PCB_Y1 + 3, PCB_Y1 + 4.5, this.mat('#2b2f38')); }
    this.box(g, 58, 250, 34, 16, PCB_Y1, PCB_Y1 + 7, this.M.metal);
    this.box(g, 63, 265.5, 24, 1, PCB_Y1 + 2, PCB_Y1 + 5, this.mat('#555c66'));
    this.live(c, (s) => {
      pwr.material.emissiveIntensity = s.power ? 1.6 : 0; gp.material.opacity = s.power ? 0.7 : 0;
      const l = s.led2 || 0; io2.material.emissiveIntensity = l * 2; gi.material.opacity = l * 0.9;
    });
  }

  build_led(g, c) {
    const m = this.mat('#ff3b3b', { transparent: true, opacity: 0.88, roughness: 0.25, emissive: '#000000' });
    this.cyl(g, 15, 16, 12.5, 12, 14.5, m);
    this.cyl(g, 15, 16, 10.5, 14.5, 26, m);
    const dome = this.mesh(new THREE.SphereGeometry(10.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m, g, 15, 26, 16);
    dome.castShadow = true;
    for (const x of [10, 20]) { this.rod(g, [x, 1, 16], [x, 12, 16], 0.9, this.M.lead); this.leg(g, x, 16, x, 56); }
    const glow = this.glow(g, 15, 24, 16, 60, '#ff3b3b');
    let last = '';
    this.live(c, (s) => {
      const col = LED_COLORS[c.props.color] || LED_COLORS.red; const b = s.b || 0;
      if (col !== last) { m.color.set(col); m.emissive.set(col); glow.material.color.set(col); last = col; }
      m.emissiveIntensity = b * 1.4; m.opacity = 0.72 + 0.28 * b;
      glow.material.opacity = b > 0.02 ? 0.25 + 0.6 * b : 0; glow.scale.setScalar(44 + 30 * b);
    });
  }

  build_resistor(g, c) {
    const T = THREE;
    this.rod(g, [0, 7, 8], [70, 7, 8], 0.9, this.M.lead);
    for (const x of [0, 70]) this.rod(g, [x, PIN_TOP - 1, 8], [x, 7, 8], 0.9, this.M.lead);
    const body = this.mesh(new T.CylinderGeometry(5.5, 5.5, 36, 20), this.mat('#d9c49a'), g, 35, 7, 8);
    body.rotation.z = Math.PI / 2;
    const bands = [];
    for (const x of [23.5, 30.5, 37.5, 47.5]) {
      const band = this.mesh(new T.CylinderGeometry(5.7, 5.7, 3, 20), this.mat('#000'), g, x, 7, 8);
      band.rotation.z = Math.PI / 2; bands.push(band);
    }
    let last = '';
    this.live(c, () => {
      const k = String(c.props.ohms); if (k === last) return; last = k;
      const cols = ['#111', '#8b4513', '#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#8e24aa', '#9e9e9e', '#fafafa'];
      const s = String(Math.max(1, Math.round(+c.props.ohms || 220)));
      const bc = s.length < 2 ? [cols[0], cols[+s], cols[0], '#c9a227'] : [cols[+s[0]], cols[+s[1]], cols[Math.min(9, s.length - 2)], '#c9a227'];
      bands.forEach((b, i) => b.material.color.set(bc[i]));
    });
  }

  build_button(g, c) {
    this.box(g, 4, 4, 36, 36, 0, 10, this.mat('#2a2e36'));
    for (const [x, z] of [[8, 8], [36, 8], [8, 36], [36, 36]]) this.cyl(g, x, z, 1.6, 10, 10.6, this.mat('#555'));
    this.cyl(g, 22, 22, 9, 10, 12, this.mat('#1a1c21'));
    const capM = this.mat('#e5484d', { roughness: 0.4 });
    const cap = this.cyl(g, 22, 22, 11, 0, 7, capM, 28);
    for (const x of [12, 32]) this.leg(g, x, 40, x, 54);
    let last = '';
    this.live(c, (s) => {
      const col = BTN_COLORS[c.props.color] || BTN_COLORS.red;
      if (col !== last) { capM.color.set(col); last = col; }
      cap.position.y = (s.pressed ? 8.5 : 12) + 3.5;
    });
  }

  build_pot(g, c) {
    this.box(g, 2, 2, 52, 44, 0, 3, this.mat('#1e5bb8'));
    this.cyl(g, 28, 23, 16, 3, 9, this.mat('#d7dbe2', { metalness: 0.4, roughness: 0.4 }), 32);
    const knob = new THREE.Group(); knob.position.set(28, 9, 23); g.add(knob);
    this.cyl(knob, 0, 0, 10, 0, 10, this.mat('#eef0f3'), 24);
    this.box(knob, -1.5, -14, 3, 9, 10, 10.8, this.mat('#2a2e36'));
    for (const x of [12, 28, 44]) this.leg(g, x, 46, x, 60);
    this.live(c, () => { knob.rotation.y = -(-135 + 270 * (+c.props.value)) * DEG; });
  }

  build_dht22(g, c) {
    const T = THREE;
    const draw = (x) => {
      x.fillStyle = '#f4f6f8'; x.fillRect(0, 0, 144, 216);
      x.fillStyle = '#c4cad4';
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) { x.beginPath(); x.roundRect ? x.roundRect(28 + k * 28, 20 + r * 28, 16, 16, 3) : x.rect(28 + k * 28, 20 + r * 28, 16, 16); x.fill(); }
      x.fillStyle = '#39404c'; x.textAlign = 'center'; x.font = '700 26px ui-monospace, Menlo, monospace';
      x.fillText(`${(+c.props.temp).toFixed(1)}°C`, 72, 162); x.fillText(`${Math.round(c.props.hum)}%`, 72, 196);
    };
    const tex = this.tex(144, 216, draw);
    const w = this.mat('#f4f6f8');
    this.box(g, 2, 1, 36, 54, 0, 3, w);
    const body = this.mesh(new T.BoxGeometry(36, 14, 54), [w, w, this.mat('#ffffff', { map: tex }), w, w, w], g, 20, 10, 28);
    body.material.forEach((m) => this.disp.includes(m) || this.disp.push(m));
    for (const x of [10, 20, 30]) this.leg(g, x, 55, x, 72);
    let last = `${c.props.temp}|${c.props.hum}`;
    this.live(c, () => {
      const k = `${c.props.temp}|${c.props.hum}`; if (k === last) return; last = k;
      const x = tex.image.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); draw(x); tex.needsUpdate = true;
    });
  }

  build_ldr(g, c) {
    this.box(g, 1, 1, 42, 46, 0, 3, this.mat('#1f4fa3'));
    const face = this.tex(88, 88, (x) => {
      x.fillStyle = '#e8a65a'; x.beginPath(); x.arc(44, 44, 44, 0, Math.PI * 2); x.fill();
      x.strokeStyle = '#7a3d12'; x.lineWidth = 5; x.beginPath(); x.moveTo(14, 30);
      for (let i = 0; i < 5; i++) { x.lineTo(74, 30 + i * 8); x.lineTo(14, 34 + i * 8); }
      x.stroke();
    });
    this.cyl(g, 22, 17, 11, 3, 6, this.mat('#e8a65a'));
    const top = this.mesh(new THREE.CircleGeometry(11, 32), this.mat('#ffffff', { map: face }), g, 22, 6.05, 17, false);
    top.rotation.x = -Math.PI / 2;
    const glow = this.glow(g, 22, 14, 17, 50, '#ffe680');
    for (const x of [10, 22, 34]) this.leg(g, x, 47, x, 62);
    this.live(c, () => { glow.material.opacity = (+c.props.light) * 0.55; });
  }

  build_pir(g, c) {
    this.box(g, 1, 4, 54, 48, 0, 3, this.mat('#2f7d3a'));
    const dome = this.mesh(new THREE.SphereGeometry(19, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), this.mat('#f3f4f0', { roughness: 0.85, transparent: true, opacity: 0.96 }), g, 28, 3, 26);
    dome.scale.y = 0.85;
    const led = this.cyl(g, 48, 9, 2.5, 3, 4.5, this.mat('#5a1a20', { emissive: '#ff3344', emissiveIntensity: 0 }), 12);
    const glow = this.glow(g, 48, 7, 9, 22, '#ff3344');
    for (const x of [14, 28, 42]) this.leg(g, x, 52, x, 66);
    this.live(c, () => { const m = !!c.props.motion; led.material.emissiveIntensity = m ? 2 : 0; glow.material.opacity = m ? 0.8 : 0; });
  }

  build_buzzer(g, c) {
    const T = THREE;
    this.cyl(g, 22, 22, 20, 0, 14, this.mat('#1c1e22', { roughness: 0.5 }), 36);
    const ring = this.mesh(new T.TorusGeometry(13, 1, 8, 36), this.mat('#33363d'), g, 22, 14, 22, false); ring.rotation.x = Math.PI / 2;
    this.cyl(g, 22, 22, 3.5, 13.6, 14.1, this.mat('#000'), 16);
    for (const x of [16, 28]) this.leg(g, x, 42, x, 62);
    const wm = new T.MeshBasicMaterial({ color: '#ffd60a', transparent: true, opacity: 0, depthWrite: false }); this.disp.push(wm);
    const waves = [0, 1, 2].map(() => { const w = this.mesh(new T.TorusGeometry(1, 0.06, 6, 40), wm.clone(), g, 22, 16, 22, false); this.disp.push(w.material); w.rotation.x = Math.PI / 2; return w; });
    this.live(c, (s) => {
      const on = s.f > 0; const t = performance.now() / 700;
      waves.forEach((w, i) => {
        const p = (t + i / 3) % 1;
        w.scale.setScalar(22 + p * 26); w.material.opacity = on ? 0.8 * (1 - p) : 0;
      });
    });
  }

  build_servo(g, c) {
    const blue = this.mat('#2163d6'), dark = this.mat('#1b4fb0');
    this.box(g, 20, 8, 76, 40, 0, 30, blue);
    this.box(g, 12, 8, 92, 40, 20, 23, dark);
    this.cyl(g, 44, 28, 8, 30, 33, blue);
    this.cyl(g, 44, 28, 3, 33, 37, this.M.metal, 12);
    const horn = new THREE.Group(); horn.position.set(44, 37, 28); g.add(horn);
    const white = this.mat('#ffffff', { roughness: 0.5 });
    this.cyl(horn, 0, 0, 5.5, 0, 3, white);
    const arm = this.mesh(new THREE.CylinderGeometry(3, 4.5, 26, 12), white, horn, 0, 1.5, -12);
    arm.rotation.x = Math.PI / 2; arm.scale.z = 0.5;
    // cable: brown/red/orange from the case to the pins
    [['#6b3e1f', 20], ['#d63b3b', 28], ['#f08a24', 36]].forEach(([col, z]) => this.rod(g, [0, PIN_TOP - 1, z], [20, 8, z], 1.4, this.mat(col)));
    this.live(c, (s) => { horn.rotation.y = -((s.angle ?? 90) - 90) * DEG; });
  }

  build_lcd(g, c) {
    const T = THREE;
    // underside: PCF8574 I2C "backpack" (texture rows are 86 - z because the -Y face is flipped)
    const back = this.tex(888, 344, (x) => {
      x.scale(4, 4); x.translate(-14, 0);
      x.fillStyle = '#1f6a35'; x.fillRect(14, 0, 222, 86);
      x.fillStyle = '#d8b24a';
      for (let i = 0; i < 16; i++) { x.beginPath(); x.arc(40 + i * 8, 86 - 6, 2, 0, Math.PI * 2); x.fill(); }
      x.fillStyle = '#1d3f8f'; x.fillRect(16, 86 - 72, 80, 56);
      x.fillStyle = '#111'; x.fillRect(40, 86 - 50, 28, 14);
      x.fillStyle = '#c4cbd8'; x.font = '600 4px ui-monospace, monospace'; x.textAlign = 'center'; x.fillText('PCF8574T', 54, 86 - 42);
      x.fillStyle = '#2f6fe0'; x.fillRect(74, 86 - 66, 16, 16); x.fillStyle = '#f2f2f2'; x.beginPath(); x.arc(82, 86 - 58, 5, 0, Math.PI * 2); x.fill();
      x.fillStyle = '#111'; x.fillRect(80.8, 86 - 63, 2.4, 10);
      x.fillStyle = '#c4cbd8'; x.font = '600 4.5px system-ui, sans-serif'; x.textAlign = 'left';
      ['GND', 'VCC', 'SDA', 'SCL'].forEach((l, i) => { x.fillText(l, 22, 86 - (22 + i * 12) + 1.5); });
      x.fillText('0x27', 42, 86 - 26); x.fillText('LED', 74, 86 - 24);
      x.fillStyle = '#111'; x.fillRect(70, 86 - 30, 8, 4);
      x.fillStyle = '#c4cbd8'; x.textAlign = 'center'; x.font = '700 7px system-ui, sans-serif'; x.fillText('LCD1602 · I2C', 165, 86 - 40);
    });
    const lg = this.mat('#1f6a35');
    this.mesh(new T.BoxGeometry(222, 3, 86), [lg, lg, lg, this.mat('#ffffff', { map: back }), lg, lg], g, 125, 1.5, 43);
    for (const [x, z] of [[24, 8], [226, 8], [24, 78], [226, 78]]) this.cyl(g, x, z, 3, 3, 3.3, this.mat('#0f3a1b'), 12);
    this.box(g, 30, 14, 196, 58, 3, 9, this.mat('#111111', { roughness: 0.5 }));
    for (const z of [22, 34, 46, 58]) this.rod(g, [0, PIN_TOP - 1, z], [16, 2.5, z], 0.9, this.M.lead);
    const W = 752, H = 200;
    const tex = this.tex(W, H, () => {});
    const screen = this.mesh(new T.PlaneGeometry(188, 50), (() => { const m = new T.MeshBasicMaterial({ map: tex }); this.disp.push(m); return m; })(), g, 128, 9.05, 43, false);
    screen.rotation.x = -Math.PI / 2;
    let last = null;
    this.live(c, (s) => {
      const L = s.lcd; const on = !!(L && L.backlight);
      const rows = L && L.display && s.wired ? L.buf.map((r) => r.join('')) : null;
      const key = `${on}|${!!L}|${rows ? rows.join('\n') : ''}`;
      if (key === last) return; last = key;
      const x = tex.image.getContext('2d'); const k = 4;
      x.setTransform(k, 0, 0, k, 0, 0);
      const bg = on ? '#9fd14a' : L ? '#4c6b22' : '#2f4416', fg = on ? '#14240a' : '#0d1806';
      x.fillStyle = bg; x.fillRect(0, 0, 188, 50);
      x.globalAlpha = on ? 0.07 : 0.14; x.fillStyle = fg;
      for (let r = 0; r < 2; r++) for (let i = 0; i < 16; i++) x.fillRect(6 + i * 11, 8 + r * 22, 9.5, 17);
      x.globalAlpha = 1;
      if (rows) {
        x.font = '15px ui-monospace, Menlo, Consolas, monospace'; x.textBaseline = 'middle'; x.textAlign = 'center';
        rows.forEach((row, r) => [...row].forEach((ch, i) => x.fillText(ch, 6 + i * 11 + 4.75, 8 + r * 22 + 9.5)));
      }
      tex.needsUpdate = true;
    });
  }

  /** Page coordinates of a 3D point (used by end-to-end tests). */
  screenPoint(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera); const r = this.el.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  }

  // ---------- interaction ----------
  hit(e) {
    const r = this.el.getBoundingClientRect();
    this.ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
    for (const h of this.ray.intersectObjects(this.picks, true)) {
      let o = h.object;
      while (o && !o.userData.compId && !o.userData.wireId) o = o.parent;
      if (o) return o.userData.compId ? { kind: 'comp', id: o.userData.compId } : { kind: 'wire', id: o.userData.wireId };
    }
    return null;
  }

  pressable(h) {
    if (!h || h.kind !== 'comp') return false;
    const c = this.app.project.components.find((x) => x.id === h.id);
    return !!(c && DEFS[c.type].interactive === 'press');
  }

  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') { this.down = null; return; }
    const h = this.hit(e);
    this.down = { x: e.clientX, y: e.clientY, h };
    if (this.app.sim.running && this.pressable(h)) {
      this.controls.enabled = false;
      this.pressing = h.id; this.app.sim.setPressed(h.id, true); this.app.canvas.renderDynamic();
      this.app.canvas.select(h);
    }
  }

  onUp(e) {
    const d = this.down; this.down = null;
    if (this.pressing) { this.release(); return; }
    if (!d || !this.active || e.target !== this.el) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) this.app.canvas.select(d.h);
  }

  release() {
    if (this.pressing) { this.app.sim.setPressed(this.pressing, false); this.pressing = null; this.app.canvas.renderDynamic(); }
    if (this.controls) this.controls.enabled = true;
  }

  onMove(e) {
    if (this.down || (this._mt && performance.now() - this._mt < 50)) return;
    this._mt = performance.now();
    const h = this.hit(e);
    this.el.style.cursor = this.app.sim.running && this.pressable(h) ? 'pointer' : h ? 'default' : '';
  }
}

export { View3D };
