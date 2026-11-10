/* CatSim — 3D view of the circuit (Three.js, loaded on first use).
 * Read-only mirror of the 2D diagram: 2D (x, y) maps to 3D (x, z) with Y up, 1 unit = 1 px.
 * Live state (LEDs, servo, LCD, buzzer…) comes from the same def.state() the 2D canvas uses. */
import { DEFS, LED_COLORS } from './components.js';
import { breadboardContacts } from './contacts.js';
import { footprint } from './rotation.ts';
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
    this.drag = null; this.linksDirty = false; this.overlayKey = ''; this.selBox = null; this.pendRing = null;
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
    this.stage.insertBefore(this.el, this.stage.querySelector('.stage-tools'));

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

    this.ray = new T.Raycaster(); this.ptr = new T.Vector2(); this.ground = new T.Plane(new T.Vector3(0, 1, 0), 0);
    this.el.addEventListener('pointerdown', (e) => this.onDown(e), true); // capture: runs before the camera's own handler, so a dragged part doesn't also orbit
    window.addEventListener('pointerup', (e) => this.onUp(e));
    window.addEventListener('pointercancel', () => { this.drag = null; this.release(); });
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
      if (this.dirty && !this.drag) this.rebuild();
      if (this.linksDirty) { this.linksDirty = false; this.linkRefresh(); }
      this.syncOverlay();
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
      const f = footprint(d, c.rot);
      x0 = Math.min(x0, c.x); z0 = Math.min(z0, c.y); x1 = Math.max(x1, c.x + f.w); z1 = Math.max(z1, c.y + f.h);
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

  /** Top of a pin; `at` is the pin's place in the diagram (canvas.pinPos), which already includes any turn. */
  pinTop(at) {
    const c = at.comp, p = at.pin;
    if (c.type === 'esp32') return { x: c.x + (p.x === 0 ? 5 : 145), y: ESP_PIN_TOP, z: c.y + p.y };
    if (c.type === 'uno') return { x: c.x + p.x, y: 17, z: c.y + (p.y === 0 ? 4 : 176) }; // into the header sockets
    return { x: at.x, y: PIN_TOP + ((this.lift && this.lift.get(c.id)) || 0), z: at.y };
  }

  // ---------- scene ----------
  clear() {
    for (const o of this.disp) o.dispose();
    this.disp = []; this.updaters = []; this.picks = [];
    while (this.root.children.length) this.root.remove(this.root.children[0]);
  }

  rebuild() {
    this.dirty = false; this.overlayKey = '';
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

    // parts plugged into a breadboard stand on top of it
    this.lift = new Map(breadboardContacts(P, DEFS).map(([a]) => [a.split(':')[0], BREADBOARD_H]));
    for (const c of P.components) {
      const d = DEFS[c.type]; if (!d) continue;
      // the part turns about the middle of its footprint; its drawing is built in a pivot group that is offset to match
      // the group is centred on the unturned part: its pivot holds the drawing, which turns about that centre
      const g = new T.Group(); g.position.set(c.x + d.w / 2, this.lift.get(c.id) || 0, c.y + d.h / 2); g.rotation.y = -(c.rot || 0) * DEG; g.userData.compId = c.id;
      const pivot = new T.Group(); pivot.position.set(-d.w / 2, 0, -d.h / 2); g.add(pivot); g.userData.pivot = pivot;
      this.root.add(g); this.picks.push(g);
      const build = this['build_' + c.type] || (d.dip ? this.build_dip : null);
      if (build) build.call(this, pivot, c, d);
      if ((!d.board || c.type === 'esp32c3') && !d.noPinHeaders) for (const p of d.pins) {
        this.box(pivot, p.x - 2.5, p.y - 2.5, 5, 5, 0, 3.5, this.M.header);
        this.cyl(pivot, p.x, p.y, 0.9, 3.5, PIN_TOP, this.M.gold, 8);
      }
    }

    this.linkRefresh();
  }

  /** Pin targets and wires. Rebuilt on their own while a part is dragged, so the wires follow the pointer. */
  linkRefresh() {
    for (const o of this.root.children.slice()) if (o.userData.link) { this.root.remove(o); this.picks = this.picks.filter((x) => x !== o); }
    for (const o of this.linkDisp || []) o.dispose(); // what the previous links were made of
    const T = THREE, P = this.app.project, n0 = this.root.children.length, d0 = this.disp.length;
    // pins: an invisible target on each pin's top, so a click there starts or finishes a wire, as in 2D
    const hitMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const hitGeo = new T.SphereGeometry(4.5, 10, 8); this.disp.push(hitMat, hitGeo);
    for (const c of P.components) {
      const d = DEFS[c.type]; if (!d) continue;
      for (const p of d.pins) {
        const ref = `${c.id}:${p.id}`, at = this.app.canvas.pinPos(ref); if (!at) continue;
        const q = this.pinTop(at), m = new T.Mesh(hitGeo, hitMat);
        m.position.set(q.x, q.y, q.z); m.userData.pinRef = ref; this.root.add(m); this.picks.push(m);
      }
    }

    // wires: tubes arching up between pin tops
    P.wires.forEach((w, i) => {
      const pa = this.app.canvas.pinPos(w.from), pb = this.app.canvas.pinPos(w.to); if (!pa || !pb) return;
      const a = this.pinTop(pa), z = this.pinTop(pb);
      const A = new T.Vector3(a.x, a.y, a.z), B = new T.Vector3(z.x, z.y, z.z);
      const dist = A.distanceTo(B);
      const h = Math.min(90, Math.max(18, dist * 0.32)), d = Math.min(70, Math.max(10, dist * 0.25));
      const da = DIRS[pa.dir] || [0, 0], db = DIRS[pb.dir] || [0, 0];
      const curve = new T.CubicBezierCurve3(A,
        new T.Vector3(a.x + da[0] * d, a.y + h, a.z + da[1] * d),
        new T.Vector3(z.x + db[0] * d, z.y + h, z.z + db[1] * d), B);
      const m = this.mesh(new T.TubeGeometry(curve, Math.max(24, Math.round(dist / 6)), 1.6, 8, false),
        this.mat(this.app.canvas.wireColor(w, i), { roughness: 0.45 }), this.root);
      m.userData.wireId = w.id; this.picks.push(m);
      for (const e of [A, B]) this.mesh(new T.SphereGeometry(1.9, 10, 8), m.material, this.root, e.x, e.y, e.z, false);
    });
    for (const o of this.root.children.slice(n0)) o.userData.link = true;
    this.linkDisp = this.disp.splice(d0); // kept apart from the scene's own resources, so a drag doesn't pile them up
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
    this.cyl(g, 15, 16, 9.8, 14.5, 26, m); // a 5 mm LED: a 5.0 mm dome on a 2.54 mm lead pitch
    const dome = this.mesh(new THREE.SphereGeometry(9.8, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m, g, 15, 26, 16);
    dome.castShadow = true;
    for (const x of [10, 20]) { this.rod(g, [x, 1, 16], [x, 12, 16], 0.9, this.M.lead); this.leg(g, x, 16, x, 56); }
    const glow = this.glow(g, 15, 24, 16, 60, '#ff3b3b');
    let last = '';
    this.live(c, (s) => {
      const col = s.burnt ? '#3b2f2a' : (LED_COLORS[c.props.color] || LED_COLORS.red); const b = s.b || 0;
      if (col !== last) { m.color.set(col); m.emissive.set(col); glow.material.color.set(col); m.opacity = s.burnt ? 1 : m.opacity; last = col; }
      m.emissiveIntensity = b * 1.4; m.opacity = 0.72 + 0.28 * b;
      glow.material.opacity = b > 0.02 ? 0.25 + 0.6 * b : 0; glow.scale.setScalar(44 + 30 * b);
    });
  }

  build_resistor(g, c) {
    const T = THREE;
    this.rod(g, [15, 7, 8], [55, 7, 8], 0.9, this.M.lead);
    for (const x of [15, 55]) this.rod(g, [x, PIN_TOP - 1, 8], [x, 7, 8], 0.9, this.M.lead);
    const body = this.mesh(new T.CylinderGeometry(4.9, 4.9, 27, 20), this.mat('#d9c49a'), g, 35, 7, 8);
    body.rotation.z = Math.PI / 2;
    const bands = [];
    for (const x of [24, 28, 32, 43.5]) {
      const band = this.mesh(new T.CylinderGeometry(5.0, 5.0, 2.2, 20), this.mat('#000'), g, x, 7, 8);
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
    // a 6 mm × 6 mm switch body, 4.3 mm tall, with a 3.5 mm cap
    this.box(g, 1, 7, 24, 24, 0, 17, this.mat('#2a2e36'));
    this.cyl(g, 13, 19, 4, 17, 17.6, this.mat('#1a1c21'), 20);
    const capM = this.mat('#e5484d', { roughness: 0.4 });
    const cap = this.cyl(g, 13, 19, 7, 17.6, 20, capM, 24);
    let last = '';
    this.live(c, (s) => {
      const col = BTN_COLORS[c.props.color] || BTN_COLORS.red;
      if (col !== last) { capM.color.set(col); last = col; }
      cap.position.y = s.pressed ? -1.2 : 0;
    });
  }

  build_pot(g, c) {
    // a 9 mm × 9 mm body, 6 mm tall; the Ø6 mm shaft rises 13 mm above the board
    this.box(g, 10.5, 4, 35, 35, 0, 24, this.mat('#1e5bb8'));
    this.cyl(g, 28, 21.5, 11.8, 24, 75, this.mat('#d7dbe2', { metalness: 0.4, roughness: 0.4 }), 32);
    const knob = new THREE.Group(); knob.position.set(28, 75, 21.5); g.add(knob);
    this.box(knob, -1.2, -11.8, 2.4, 8, 0, 1.5, this.mat('#2a2e36'));
    this.live(c, () => { knob.rotation.y = -(-135 + 270 * (+c.props.value)) * DEG; });
  }

  build_breadboard(g, c, d) {
    // a half-size breadboard: an 8.5 mm block, holes on the top, a centre trench, red and blue rails
    const T = THREE, w = d.w, h = d.h;
    this.box(g, 0, 0, w, h, 0, 33.5, this.mat('#f4f1e8', { roughness: 0.8 }));
    this.box(g, 8, 84, w - 16, 12, 33.5, 33.9, this.mat('#d6cfb8'));
    const red = this.mat('#e5484d'), blue = this.mat('#3d8bff');
    for (const [y, m] of [[10, red], [20, blue], [160, red], [170, blue]]) this.box(g, 8, y - 2.5, w - 16, 5, 33.5, 33.9, m);
    const geo = new T.CylinderGeometry(1.9, 1.9, 0.8, 10); this.disp.push(geo);
    const holes = new T.InstancedMesh(geo, this.mat('#2b2f37'), d.pins.length), m4 = new T.Matrix4();
    d.pins.forEach((p, i) => { m4.makeTranslation(p.x, 33.4, p.y); holes.setMatrixAt(i, m4); });
    holes.instanceMatrix.needsUpdate = true; g.add(holes);
  }

  build_hcsr04(g, c, d) {
    // a blue 45 × 20 mm board, 1.6 mm thick, and two 16 mm × 12 mm metal transducers with mesh tops
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d5fb5', { roughness: 0.5 }));
    const mesh = this.mat('#2c2f35');
    for (const x of [48.5, 128.5]) { this.cyl(g, x, 39.5, 31.5, 6, 53, this.M.metal, 40); this.cyl(g, x, 39.5, 26, 53, 53.8, mesh, 40); }
  }

  build_ds18b20(g, c) {
    // a TO-92 package: 4.95 mm wide, the leads 1.27 mm apart, with the 18B20 mark on the flat face
    const T = THREE;
    this.mesh(new T.CylinderGeometry(9.75, 9.75, 20, 24, 1, false, Math.PI / 2, Math.PI), this.mat('#222', { roughness: 0.55 }), g, 15, 20, 22);
    const face = this.tex(112, 56, (x) => { x.fillStyle = '#222'; x.fillRect(0, 0, 112, 56); x.fillStyle = '#ddd'; x.textAlign = 'center'; x.font = '600 18px system-ui, sans-serif'; x.fillText('18B20', 56, 34); });
    this.mesh(new T.PlaneGeometry(14, 8), this.mat('#ffffff', { map: face }), g, 15, 20, 22.05, false);
    for (const x of [10, 15, 20]) { this.rod(g, [x, 10, 22], [x, 1, 22], 0.6, this.M.lead); this.leg(g, x, 22, x, 62); }
  }

  build_oled(g, c, d) {
    // a 27.3 × 27.8 mm blue board, a glass panel, and the lit pixels on a 21.74 × 10.86 mm active area
    const T = THREE, aw = 85.6, ah = 42.8, ax = 11.2, ay = 28.6;
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d3f8f', { roughness: 0.5 }));
    this.box(g, 4, 22, 100, 56, 6, 8, this.mat('#05070b', { roughness: 0.3 }));
    const tex = this.tex(128, 64, (x) => { x.fillStyle = '#05070b'; x.fillRect(0, 0, 128, 64); });
    const screen = this.mesh(new T.PlaneGeometry(aw, ah), this.mat('#ffffff', { map: tex, emissive: '#9fd8ff', emissiveIntensity: 0.25 }), g, ax + aw / 2, 8.1, ay + ah / 2, false);
    screen.rotation.x = -Math.PI / 2;
    let last = '';
    this.live(c, (s) => {
      const dd = s.d; if (!dd) return;
      const sig = dd.on ? dd.buf.join(',') + dd.invert : 'off'; if (sig === last) return; last = sig;
      const x = tex.image.getContext('2d');
      x.fillStyle = '#05070b'; x.fillRect(0, 0, 128, 64);
      if (!dd.on) return;
      const lit = (px, py) => !!(dd.buf[px + (py >> 3) * dd.w] & (1 << (py & 7))) !== dd.invert;
      x.fillStyle = '#e6f2ff';
      for (let py = 0; py < 64; py++) for (let px = 0; px < 128; px++) if (lit(px, py)) x.fillRect(px, py, 1, 1);
      tex.needsUpdate = true;
    });
  }

  // ---------- real-size modules (dimensions in diagram units: 1 unit = 0.254 mm) ----------
  build_lcd_parallel(g, c, d) {
    // HD44780 16×2: an 80 × 36 mm green board, a metal bezel and the glass window
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1f7a3a', { roughness: 0.5 }));
    this.box(g, 22, 22, 271, 98, 6, 11, this.M.metal);
    this.box(g, 30, 30, 255, 82, 11, 12.2, this.mat('#1f3f9a', { roughness: 0.3 }));
    const win = this.tex(256, 64, (x) => { x.fillStyle = '#2b5ad6'; x.fillRect(0, 0, 256, 64); x.fillStyle = '#9fc3ff'; x.font = '600 24px monospace'; x.fillText('CatSim 16x2', 14, 40); });
    this.mesh(new THREE.PlaneGeometry(255, 82), this.mat('#ffffff', { map: win, transparent: true, opacity: 0.85 }), g, 157.5, 12.4, 71).rotation.x = -Math.PI / 2;
  }

  build_mpu6050(g, c, d) {
    // GY-521: a 21 × 16 mm blue board with the 4 × 4 mm MPU-6050 chip
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#2a6fb8', { roughness: 0.5 }));
    this.box(g, 36, 25, 16, 16, 6, 8, this.mat('#15171c'));
    this.box(g, 22, 12, 6, 4, 6, 9, this.M.gold);
    this.box(g, 60, 46, 5, 5, 6, 8, this.mat('#222'));
  }

  build_bme280(g, c, d) {
    // a BME280 breakout: a 16 × 18 mm blue board with the 2.5 × 2.5 mm sensor under its metal lid
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#2a6fb8', { roughness: 0.5 }));
    this.box(g, 27, 30, 10, 10, 6, 8, this.mat('#c4c8cf', { metalness: 0.6, roughness: 0.35 }));
    this.box(g, 14, 50, 8, 3, 6, 7, this.mat('#222'));
  }

  build_ws2812_strip(g, c, d) {
    // 8 × 5050 WS2812B on a black strip: each LED is a 5 × 5 mm package whose lens shows its colour
    this.box(g, 0, 0, d.w, d.h, 0, 4, this.mat('#111319', { roughness: 0.6 }));
    const lens = [];
    for (let i = 0; i < 8; i++) {
      const x = 18.5 + i * 25;
      this.box(g, x - 10, 10, 20, 20, 4, 8, this.mat('#f7f7f2', { roughness: 0.4 }));
      const m = this.mat('#000', { emissive: '#000', emissiveIntensity: 0 }); lens.push(m);
      this.box(g, x - 6, 14, 12, 12, 8, 9, m);
    }
    this.live(c, (s) => (s.rgb || []).forEach((v, i) => { const m = lens[i]; if (!m) return; m.color.setHex(v || 0); m.emissive.setHex(v || 0); m.emissiveIntensity = ((v >> 16) | (v >> 8) | v) & 255 ? 1.2 : 0; }));
  }

  build_ws2812_ring(g, c, d) {
    // 16 × 5050 WS2812B on a 44.5 mm ring with a white diffuser in the middle
    this.mesh(new THREE.RingGeometry(62, 88, 64), this.mat('#1b1d22', { roughness: 0.5 }), g, 88, 4, 88, false).rotation.x = -Math.PI / 2;
    this.cyl(g, 88, 88, 62, 0, 3, this.mat('#f6f7f9', { roughness: 0.6 }), 64);
    const lens = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 - Math.PI / 2, x = 88 + Math.cos(a) * 75, z = 88 + Math.sin(a) * 75;
      this.box(g, x - 10, z - 10, 20, 20, 4, 8, this.mat('#f7f7f2', { roughness: 0.4 }));
      const m = this.mat('#000', { emissive: '#000', emissiveIntensity: 0 }); lens.push(m);
      this.box(g, x - 6, z - 6, 12, 12, 8, 9, m);
    }
    this.live(c, (s) => (s.rgb || []).forEach((v, i) => { const m = lens[i]; if (!m) return; m.color.setHex(v || 0); m.emissive.setHex(v || 0); m.emissiveIntensity = ((v >> 16) | (v >> 8) | v) & 255 ? 1.2 : 0; }));
  }

  build_tm1637(g, c, d) {
    // a red 42 × 24 mm module with four 0.36" digits behind a dark window
    this.box(g, 0, 0, d.w, d.h, 0, 4, this.mat('#b5271f', { roughness: 0.5 }));
    this.box(g, 12, 16, 141, 62, 4, 5, this.mat('#1b0d0e', { roughness: 0.4 }));
    for (let i = 0; i < 4; i++) this.box(g, 22 + i * 34, 26, 24, 36, 5, 6, this.mat('#2a0f11'));
  }

  build_ds3231(g, c, d) {
    // ZS-042 board: a 38 × 22 mm blue board, the DS3231 and AT24C32 chips, and the coin-cell holder (Ø20 mm)
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d4ea8', { roughness: 0.5 }));
    this.box(g, 40, 30, 30, 40, 6, 9, this.mat('#15171c'));
    this.box(g, 80, 30, 14, 20, 6, 8, this.mat('#15171c'));
    this.cyl(g, 116, 44, 20, 6, 8, this.mat('#9aa1ab', { metalness: 0.7, roughness: 0.3 }), 32);
    this.cyl(g, 116, 44, 18, 8, 11, this.mat('#c8ccd2', { metalness: 0.5, roughness: 0.3 }), 32);
  }

  build_keypad(g, c, d) {
    // a 4 × 4 membrane keypad, 69 × 76 mm, with its key labels printed on the membrane
    this.box(g, 0, 0, d.w, d.h, 0, 3, this.mat('#3a3f48', { roughness: 0.7 }));
    const face = this.tex(272, 300, (x) => {
      x.fillStyle = '#2f343d'; x.fillRect(0, 0, 272, 300);
      const L = [['1', '2', '3', 'A'], ['4', '5', '6', 'B'], ['7', '8', '9', 'C'], ['*', '0', '#', 'D']];
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) {
        const cx = 23.5 + 75 * k, cy = 37.5 + 75 * r;
        x.fillStyle = '#d9dde3'; x.beginPath(); x.roundRect(cx - 27, cy - 27, 54, 54, 6); x.fill();
        x.fillStyle = '#20242b'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.font = '600 34px system-ui, sans-serif'; x.fillText(L[r][k], cx, cy + 2);
      }
    });
    this.mesh(new THREE.PlaneGeometry(272, 300), this.mat('#ffffff', { map: face }), g, 136, 3.2, 150, false).rotation.x = -Math.PI / 2;
  }

  build_ir_receiver(g, c, d) {
    // a VS1838B on a small black board: a 6.4 × 7.6 mm receiver with its lens on top
    this.box(g, 4, 4, 32, 48, 0, 2, this.mat('#222'));
    this.box(g, 8, 8, 24, 30, 2, 12, this.mat('#2b2e36', { roughness: 0.3 }));
    this.cyl(g, 20, 20, 6, 12, 13.5, this.mat('#3a3f4a', { roughness: 0.2 }), 20);
  }

  build_ir_remote(g, c, d) {
    // a 21-key NEC remote: a 21 × 51 mm body with a row of keys and the IR emitter at the top
    this.box(g, 0, 0, d.w, d.h, 0, 8, this.mat('#1d1f24', { roughness: 0.5 }));
    const key = this.mat('#2c2f36');
    for (let r = 0; r < 7; r++) for (let k = 0; k < 3; k++) this.cyl(g, 18 + k * 24, 20 + r * 24, 7, 8, 9.5, key, 14);
    this.cyl(g, 42, 180, 4, 8, 9, this.mat('#050505', { roughness: 0.2 }), 12);
  }

  build_stepper(g, c, d) {
    // a 28BYJ-48 motor (Ø28 × 19 mm, Ø5 mm shaft) beside its ULN2003 driver board (35 × 25 mm)
    this.cyl(g, 55, 55, 55, 0, 75, this.mat('#d7d3c3', { roughness: 0.5 }), 48);
    this.cyl(g, 55, 55, 50, 75, 76, this.mat('#e8e4d6'), 40);
    this.cyl(g, 55, 55, 10, 76, 111, this.M.metal, 20);
    this.box(g, 118, 6, 138, 98, 0, 6, this.mat('#1d4ea8', { roughness: 0.5 }));
    this.box(g, 150, 30, 40, 20, 6, 10, this.mat('#15171c'));
  }

  build_rgb_led(g, c, d) {
    // a 5 mm RGB LED: a Ø9.8 mm dome on four 2.54 mm legs; its colour follows the three channels
    const m = this.mat('#f5f5f5', { transparent: true, opacity: 0.85, roughness: 0.25 });
    this.cyl(g, 22, 28, 9.8, 6, 24, m, 28);
    this.mesh(new THREE.SphereGeometry(9.8, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), m, g, 22, 24, 28);
    for (const x of [7, 17, 27, 37]) this.leg(g, x, 28, x, 70);
    this.live(c, (s) => { const r = (s.r || 0), gg = (s.g || 0), b = (s.b || 0); m.color.setRGB(0.25 + 0.75 * r, 0.25 + 0.75 * gg, 0.25 + 0.75 * b); m.emissive.setRGB(r, gg, b); m.emissiveIntensity = 1.2; });
  }

  build_seg7(g, c, d) {
    // a 0.56" digit: a black block with a window and seven lit segments (the segments show when they are on)
    this.box(g, 0, 0, d.w, d.h, 0, 10, this.mat('#111319', { roughness: 0.5 }));
    this.box(g, 6, 12, 48, 72, 10, 10.5, this.mat('#1a1d24'));
    const SEG = { a: [12, 12, 36, 6], b: [44, 16, 6, 30], c: [44, 50, 6, 30], d: [12, 78, 36, 6], e: [6, 50, 6, 30], f: [6, 16, 6, 30], g: [12, 45, 36, 6] };
    const mats = {};
    for (const [k, [x, z, w, dd]] of Object.entries(SEG)) { mats[k] = this.mat('#3a0d12', { emissive: '#ff3344', emissiveIntensity: 0 }); this.box(g, x, z, w, dd, 10.5, 11.5, mats[k]); }
    this.live(c, (s) => { const on = (s.on) || {}; for (const k of Object.keys(mats)) mats[k].emissiveIntensity = (on[k] || 0) * 2; });
  }

  build_slide_switch(g, c, d) {
    // an SPDT slide switch: a 12 × 8 mm black body with a slider that moves to the ON or OFF side
    this.box(g, 4, 8, 48, 30, 0, 7, this.mat('#1b1d22', { roughness: 0.5 }));
    const knob = this.box(g, 14, 14, 12, 14, 7, 9, this.mat('#e5e7eb', { roughness: 0.4 }));
    this.live(c, () => { knob.position.x = c.props.on ? 14 : 0; });
  }

  build_battery(g, c, d) {
    // a 9 V block, 48.5 × 26.5 × 17.5 mm, with two snap terminals on top
    this.box(g, 0, 0, d.w, d.h, 0, 69, this.mat('#2b2f37', { roughness: 0.6 }));
    const label = this.tex(192, 104, (x) => { x.fillStyle = '#2b2f37'; x.fillRect(0, 0, 192, 104); x.fillStyle = '#e5e7eb'; x.font = '700 40px system-ui, sans-serif'; x.textAlign = 'center'; x.fillText('9V', 96, 62); });
    this.mesh(new THREE.PlaneGeometry(192, 104), this.mat('#ffffff', { map: label }), g, 96, 69.1, 52, false).rotation.x = -Math.PI / 2;
    this.cyl(g, 30, 52, 10, 69, 72, this.M.metal, 20);
    this.cyl(g, 162, 52, 10, 69, 72, this.M.metal, 20);
  }

  build_fsr(g, c, d) {
    // an FSR 402: an 18.5 mm round sensing disc with a short tail and two pins
    this.cyl(g, 37, 40, 36, 0, 2, this.mat('#2a2d33', { roughness: 0.6 }), 48);
    this.cyl(g, 37, 40, 29, 2, 2.6, this.mat('#4a505a', { roughness: 0.5 }), 48);
    this.box(g, 31, 74, 12, 26, 0, 2, this.mat('#2a2d33'));
    for (const x of [32, 42]) this.box(g, x - 2, 96, 4, 4, 2, 2.6, this.M.metal);
  }

  build_vibmotor(g, c, d) {
    // a 10 mm coin vibration motor: a Ø10 × 3.4 mm metal can with its two leads
    this.cyl(g, 22, 26, 20, 0, 14, this.M.metal, 40);
    this.cyl(g, 22, 26, 14, 14, 14.6, this.mat('#222'), 32);
    for (const x of [17, 27]) this.leg(g, x, 26, x, 60);
  }

  build_tp4056(g, c, d) {
    // a TP4056 charger: a 26 × 17 mm board with the charge IC, the USB socket, two LEDs and the inductor
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#2d7f96', { roughness: 0.5 }));
    this.box(g, 40, 25, 19, 15, 6, 8, this.mat('#15171c'));
    this.box(g, 0, 26, 8, 14, 6, 9, this.M.metal);
    this.box(g, 70, 10, 4, 4, 6, 7, this.mat('#ff3b3b', { emissive: '#ff3b3b', emissiveIntensity: 0.3 }));
    this.box(g, 78, 10, 4, 4, 6, 7, this.mat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 0.3 }));
    this.cyl(g, 60, 52, 4, 6, 10, this.mat('#222'), 12);
  }

  build_buckboost(g, c, d) {
    // a 3.3 V buck-boost regulator: a 19 × 12 mm board with the inductor, the IC and two capacitors
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1a3d7c', { roughness: 0.5 }));
    this.cyl(g, 30, 23, 9, 6, 12, this.mat('#2d3139'), 24);
    this.box(g, 46, 14, 14, 18, 6, 8, this.mat('#15171c'));
    for (const x of [10, 20]) this.cyl(g, x, 23, 4, 6, 11, this.M.gold, 12);
  }

  build_joystick(g, c, d) {
    // a KY-023 joystick: a 26 × 34 mm blue board with the thumb stick under a red cap
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d4ea8', { roughness: 0.5 }));
    this.box(g, 30, 40, 42, 42, 6, 12, this.mat('#2a2e36'));
    this.cyl(g, 51, 61, 11, 12, 30, this.mat('#111', { roughness: 0.4 }), 24);
    this.cyl(g, 51, 61, 14, 28, 34, this.mat('#e5484d', { roughness: 0.4 }), 24);
  }

  build_encoder(g, c, d) {
    // a KY-040 rotary encoder: an 18 × 31 mm blue board, the encoder body, a Ø6 mm shaft and a Ø15 mm knob
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d4ea8', { roughness: 0.5 }));
    this.box(g, 20, 20, 32, 32, 6, 14, this.mat('#8a8f98', { roughness: 0.4 }));
    this.cyl(g, 36, 36, 11, 14, 20, this.M.metal, 24);
    this.cyl(g, 36, 36, 29, 20, 40, this.mat('#15171c', { roughness: 0.5 }), 40);
  }

  build_l298n(g, c, d) {
    // an L298N module: a 43 × 43 mm red board, the black heatsink with its fins, two blue screw terminals and the capacitors
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#c62828', { roughness: 0.5 }));
    this.box(g, 42, 40, 84, 60, 6, 22, this.mat('#1b1d22', { roughness: 0.4 }));
    for (let i = 0; i < 8; i++) this.box(g, 44 + i * 10, 42, 4, 56, 22, 36, this.mat('#222', { roughness: 0.4 }));
    this.box(g, 0, 40, 22, 26, 6, 18, this.mat('#1d4ea8'));
    this.box(g, 147, 40, 22, 26, 6, 18, this.mat('#1d4ea8'));
    this.cyl(g, 120, 20, 8, 6, 20, this.mat('#2a2d33'), 16);
  }

  build_sound(g, c, d) {
    // a KY-038 sound sensor: a 35 × 15 mm blue board with the electret microphone, a potentiometer and the LM393
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d4ea8', { roughness: 0.5 }));
    this.cyl(g, 20, 30, 10, 6, 22, this.mat('#c9ced6', { metalness: 0.5, roughness: 0.4 }), 20);
    this.box(g, 40, 20, 14, 18, 6, 12, this.mat('#1e5bb8'));
    this.cyl(g, 47, 29, 5, 12, 16, this.mat('#eee'), 16);
    this.box(g, 70, 22, 14, 14, 6, 9, this.mat('#15171c'));
  }

  build_soil(g, c, d) {
    // a YL-69 soil sensor: the 30 × 15 mm control board, and the 60 mm probe from its edge
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1f6f3a', { roughness: 0.5 }));
    this.box(g, 40, 20, 14, 18, 6, 9, this.mat('#15171c'));
    this.box(g, 70, 18, 14, 16, 6, 12, this.mat('#1e5bb8'));
    this.box(g, 40, 62, 8, 236, 0, 3, this.mat('#9a9ea6', { roughness: 0.4 }));
    this.box(g, 64, 62, 8, 236, 0, 3, this.mat('#9a9ea6', { roughness: 0.4 }));
  }

  build_mq2(g, c, d) {
    // an MQ-2 gas sensor: a 32 × 22 mm board with the sensor can (Ø14 mm) and its mesh cap
    this.box(g, 0, 0, d.w, d.h, 0, 6, this.mat('#1d4ea8', { roughness: 0.5 }));
    this.cyl(g, 63, 40, 30, 6, 8, this.mat('#222'), 32);
    this.cyl(g, 63, 40, 28, 8, 76, this.M.metal, 32);
    this.cyl(g, 63, 40, 27, 74, 76, this.mat('#2a2d33'), 24);
  }

  build_esp32c3(g, c, d) {
    // an ESP32-C3 Super Mini: an 18 × 22.5 mm black board, the module shield, the USB-C socket, two buttons and the LED
    this.box(g, 0, 0, d.w, d.h, 0, 4, this.mat('#1a1d24', { roughness: 0.6 }));
    this.box(g, 10, 18, 51, 52, 4, 10, this.mat('#c9ced6', { metalness: 0.6, roughness: 0.35 }));
    this.box(g, 20, 0, 31, 8, 4, 9, this.M.metal);
    this.box(g, 4, 78, 6, 6, 4, 6, this.mat('#8a8f98'));
    this.box(g, 60, 78, 6, 6, 4, 6, this.mat('#8a8f98'));
    const led = this.mat('#22c55e', { emissive: '#22c55e', emissiveIntensity: 0 });
    this.box(g, 30, 70, 5, 5, 4, 6, led);
    this.live(c, (s) => { led.emissiveIntensity = s.led ? 1.5 : 0; });
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

  // TO-92: half-cylinder standing on three legs, flat (marked) face toward the viewer.
  build_to92(g, c, mark) {
    const T = THREE;
    const body = this.mesh(new T.CylinderGeometry(9.25, 9.25, 20, 24, 1, false, Math.PI / 2, Math.PI), this.mat('#23262d', { roughness: 0.55 }), g, 15, 20, 22);
    body.castShadow = true;
    const face = this.tex(112, 88, (x) => {
      x.fillStyle = '#2b2f37'; x.fillRect(0, 0, 112, 88);
      x.fillStyle = '#c4cbd8'; x.textAlign = 'center'; x.font = '600 20px system-ui, sans-serif'; x.fillText(mark, 56, 40);
      x.font = '16px system-ui, sans-serif'; x.fillText(c.type.toUpperCase(), 56, 66);
    });
    const plate = this.mesh(new T.PlaneGeometry(14, 10), this.mat('#ffffff', { map: face }), g, 15, 20, 22.05, false);
    plate.rotation.y = 0; // faces +z (toward the default camera)
    for (const x of [10, 15, 20]) { this.rod(g, [x, 10, 22], [x, 1, 22], 0.6, this.M.lead); this.leg(g, x, 22, x, 62); }
    const dotM = this.mat('#0f3d1d', { emissive: '#22c55e', emissiveIntensity: 0 });
    this.cyl(g, 21, 26, 1.2, 30, 30.6, dotM, 10);
    const glow = this.glow(g, 21, 32, 26, 12, '#22c55e');
    this.live(c, (s) => { const on = s.on || 0; dotM.emissiveIntensity = on * 2; glow.material.opacity = on * 0.8; });
  }
  build_npn(g, c) { this.build_to92(g, c, '2N2222'); }
  build_pnp(g, c) { this.build_to92(g, c, '2N2907'); }
  build_nmos(g, c) { this.build_to92(g, c, '2N7000'); }

  build_diode(g, c) {
    const T = THREE;
    this.rod(g, [15, 7, 8], [55, 7, 8], 0.8, this.M.lead);
    for (const x of [15, 55]) this.rod(g, [x, PIN_TOP - 1, 8], [x, 7, 8], 0.8, this.M.lead);
    const bodyM = this.mat('#c98a3a', { transparent: true, opacity: 0.9, roughness: 0.2 });
    const body = this.mesh(new T.CylinderGeometry(3.75, 3.75, 16, 20), bodyM, g, 35, 7, 8); body.rotation.z = Math.PI / 2;
    const bandM = this.mat('#222');
    const band = this.mesh(new T.CylinderGeometry(3.8, 3.8, 2.5, 20), bandM, g, 39.5, 7, 8); band.rotation.z = Math.PI / 2;
    let last = '';
    this.live(c, () => {
      const m = String(c.props.model); if (m === last) return; last = m;
      const glass = m === '1N4148';
      bodyM.color.set(glass ? '#c98a3a' : '#1d1f24'); bodyM.opacity = glass ? 0.85 : 1; bandM.color.set(glass ? '#222' : '#cfd4dc');
      body.scale.set(glass ? 1 : 1.3, 1, glass ? 1 : 1.3); band.scale.set(glass ? 1 : 1.3, 1, glass ? 1 : 1.3);
    });
  }

  // DIP-8 chip: pins along the long edges, notch on the left.
  build_opamp(g, c) {
    const T = THREE;
    this.box(g, 0, 12, 64, 36, 4, 12, this.mat('#1d1f24', { roughness: 0.5 }));
    this.cyl(g, 0, 30, 5, 11.9, 12.05, this.mat('#33363d'), 16);
    this.cyl(g, 9, 41, 2, 11.95, 12.1, this.mat('#33363d'), 12);
    const top = this.tex(256, 144, (x) => {
      x.fillStyle = '#1d1f24'; x.fillRect(0, 0, 256, 144);
      x.fillStyle = '#c4cbd8'; x.textAlign = 'center'; x.font = '600 34px system-ui, sans-serif'; x.fillText('LM358', 128, 66);
      x.font = '20px system-ui, sans-serif'; x.fillStyle = '#8b93a1'; x.fillText('op-amp', 128, 100);
    });
    const label = this.mesh(new T.PlaneGeometry(40, 22), this.mat('#ffffff', { map: top, transparent: true }), g, 34, 12.1, 30, false);
    label.rotation.x = -Math.PI / 2;
    const leg = this.M.lead;
    for (let i = 0; i < 4; i++) {
      const x = 8 + i * 16;
      this.box(g, x - 2.5, 48, 5, 4, 5, 7, leg); this.box(g, x - 1.5, 51, 3, 9, 0, 7, leg);
      this.box(g, x - 2.5, 8, 5, 4, 5, 7, leg); this.box(g, x - 1.5, 0, 3, 9, 0, 7, leg);
    }
  }

  /** Any DIP logic chip: body, notch, label and a leg for every pin at its real position. */
  build_dip(g, c, d) {
    const T = THREE, w = d.w;
    this.box(g, 0, 12, w, 36, 4, 12, this.mat('#1d1f24', { roughness: 0.5 }));
    this.cyl(g, 0, 30, 5, 11.9, 12.05, this.mat('#33363d'), 16);
    const name = d.name.split(' ')[0];
    const top = this.tex(512, 144, (x) => {
      x.fillStyle = '#1d1f24'; x.fillRect(0, 0, 512, 144);
      x.fillStyle = '#c4cbd8'; x.textAlign = 'center'; x.font = '600 44px system-ui, sans-serif'; x.fillText(name, 256, 70);
      x.font = '24px system-ui, sans-serif'; x.fillStyle = '#8b93a1'; x.fillText(d.name.slice(name.length + 1), 256, 112);
    });
    const label = this.mesh(new T.PlaneGeometry(Math.min(w - 12, 100), 26), this.mat('#ffffff', { map: top, transparent: true }), g, w / 2 + 3, 12.1, 30, false);
    label.rotation.x = -Math.PI / 2;
    for (const p of d.pins) {
      const z0 = p.y === 0 ? 8 : 48;
      this.box(g, p.x - 2.5, z0, 5, 4, 5, 7, this.M.lead);
      this.box(g, p.x - 1.5, p.y === 0 ? 0 : 51, 3, 9, 0, 7, this.M.lead);
    }
  }

  build_capacitor(g, c) {
    const T = THREE;
    const elec = this.mat('#2457b8', { roughness: 0.4 }), stripe = this.mat('#9db7e6');
    const can = new T.Group(); g.add(can);
    this.cyl(can, 15, 18, 9.85, 8, 51, elec, 28); // Ø5 mm, 11 mm long
    const st = this.mesh(new T.CylinderGeometry(9.95, 9.95, 43, 28, 1, true, -0.35, 0.7), stripe, can, 15, 29.5, 18); st.rotation.y = Math.PI / 2;
    this.cyl(can, 15, 18, 9.5, 51, 51.6, this.M.metal, 28);
    const disc = new T.Group(); g.add(disc);
    // a 100 nF ceramic disc: Ø5 mm, 2.5 mm thick
    const dm = this.mesh(new T.SphereGeometry(10, 20, 12), this.mat('#e1a93b', { roughness: 0.6 }), disc, 15, 18, 18); dm.scale.set(1, 1, 0.5);
    for (const x of [10, 20]) { this.rod(g, [x, 1, 18], [x, 8, 18], 0.8, this.M.lead); this.leg(g, x, 18, x, 56); }
    let last = '';
    this.live(c, () => { const v = String(c.props.value); if (v === last) return; last = v; const ceramic = v === '100nF'; can.visible = !ceramic; disc.visible = ceramic; });
  }

  build_uno(g, c, d) {
    const T = THREE;
    const pcbTop = this.tex(1056, 720, (x) => {
      x.scale(4, 4);
      x.fillStyle = '#0b6d8c'; x.fillRect(0, 0, 264, 180);
      x.fillStyle = '#e6f3f7'; x.textAlign = 'center'; x.font = '800 22px system-ui, sans-serif'; x.fillText('UNO', 90, 74);
      x.font = '600 7px system-ui, sans-serif'; x.fillText('R3 · ATmega328P · 16 MHz', 90, 88);
      x.font = '600 5.5px ui-monospace, monospace';
      for (const p of d.pins) x.fillText(p.label.replace('GND', 'G'), p.x, p.y === 0 ? 16 : 166);
      for (const [lx, ly, l] of [[118, 30, 'L'], [118, 42, 'TX'], [118, 54, 'RX'], [222, 150, 'ON']]) { x.textAlign = 'left'; x.fillText(l, lx + 8, ly + 2); }
    });
    const side = this.mat('#0b6d8c');
    this.mesh(new T.BoxGeometry(264, 3, 168), [side, side, this.mat('#ffffff', { map: pcbTop }), side, side, side], g, 132, 5.5, 90);
    for (const [x, z, w, dd] of [[8, 14, 6, 6], [256, 14, 6, 6], [8, 166, 6, 6], [256, 166, 6, 6]]) this.box(g, x - 3, z - 3, w, dd, 0, 4, this.M.header); // standoffs
    // female headers: black sockets with a hole per pin
    const sock = this.mat('#1d1f24', { roughness: 0.7 });
    for (const [x0, x1, z] of [[34, 154, -2], [160, 256, -2], [70, 154, 172], [166, 238, 172]]) this.box(g, x0, z, x1 - x0, 10, 7, 17, sock);
    for (const p of d.pins) this.box(g, p.x - 1.4, (p.y === 0 ? 3 : 177) - 1.4, 2.8, 2.8, 16.95, 17.05, this.mat('#050506'));
    // ATmega328P (DIP-28), USB-B, barrel jack
    this.box(g, 120, 96, 132, 34, 7, 14, this.mat('#1d1f24', { roughness: 0.5 }));
    const chipTop = this.tex(528, 136, (x) => { x.fillStyle = '#1d1f24'; x.fillRect(0, 0, 528, 136); x.fillStyle = '#c4cbd8'; x.textAlign = 'center'; x.font = '600 38px system-ui, sans-serif'; x.fillText('ATmega328P', 264, 82); });
    const cl = this.mesh(new T.PlaneGeometry(120, 30), this.mat('#ffffff', { map: chipTop }), g, 186, 14.05, 113, false); cl.rotation.x = -Math.PI / 2;
    for (let i = 0; i < 14; i++) for (const z of [94, 130]) this.box(g, 124 + i * 9, z - 1, 3, 3, 4, 10, this.M.lead);
    this.box(g, -14, 32, 46, 36, 7, 28, this.M.metal);
    this.box(g, -10, 120, 40, 30, 7, 26, this.mat('#1d1f24'));
    // on-board LEDs
    const leds = [[118, 30, '#ffb020', 'L'], [118, 42, '#ffb020', 'tx'], [118, 54, '#ffb020', 'rx'], [222, 150, '#22c55e', 'on']].map(([x, z, col, k]) => {
      const m = this.mat('#2a3238', { emissive: col, emissiveIntensity: 0 });
      this.box(g, x - 4, z - 2, 8, 4, 7, 8.5, m);
      return { k, m, glow: this.glow(g, x, 11, z, 18, col) };
    });
    this.live(c, (s) => { for (const l of leds) { const on = l.k === 'L' ? s.L : l.k === 'tx' ? s.tx : l.k === 'on' ? s.on : 0; l.m.emissiveIntensity = on ? 1.8 : 0; l.glow.material.opacity = on ? 0.7 : 0; } });
  }

  build_motor(g, c) {
    const T = THREE;
    const can = this.mesh(new T.CylinderGeometry(15, 15, 40, 28), this.M.metal, g, 30, 18, 30); can.rotation.x = Math.PI / 2;
    this.box(g, 8, 44, 44, 6, 3, 33, this.mat('#2b2f37'));
    const shaft = new T.Group(); shaft.position.set(30, 18, 8); g.add(shaft);
    this.cyl(shaft, 0, 0, 1.2, 0, 10, this.M.lead, 10).rotation.x = Math.PI / 2;
    const blade = this.mesh(new T.BoxGeometry(34, 4, 1.5), this.mat('#e5484d'), shaft, 0, 0, -8);
    for (const x of [22, 38]) { this.rod(g, [x, 6, 50], [x, 1, 50], 0.8, this.M.lead); this.leg(g, x, 50, x, 72); }
    this.live(c, (s) => { blade.rotation.z = -(s.angle || 0); });
  }

  build_relay(g, c) {
    this.box(g, 1, 4, 64, 44, 0, 30, this.mat('#2163d6', { roughness: 0.45 }));
    const label = this.tex(256, 176, (x) => { x.fillStyle = '#2163d6'; x.fillRect(0, 0, 256, 176); x.fillStyle = '#e8eefc'; x.textAlign = 'center'; x.font = '600 34px system-ui, sans-serif'; x.fillText('RELAY', 128, 74); x.font = '24px system-ui, sans-serif'; x.fillText('5V DC · 10A 250VAC', 128, 116); });
    const top = this.mesh(new THREE.PlaneGeometry(60, 40), this.mat('#ffffff', { map: label }), g, 33, 30.05, 26, false); top.rotation.x = -Math.PI / 2;
    for (const x of [8, 20, 34, 46, 58]) this.leg(g, x, 48, x, 60);
    const dot = this.mat('#0f3d1d', { emissive: '#22c55e', emissiveIntensity: 0 });
    this.cyl(g, 58, 10, 2, 30, 30.6, dot, 10);
    this.live(c, (s) => { dot.emissiveIntensity = s.on ? 2 : 0; });
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
  setRay(e) {
    const r = this.el.getBoundingClientRect();
    this.ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ptr, this.camera);
  }

  /** Where the pointer is on the board (y = 0): diagram x is world x, diagram y is world z. */
  planePoint(e) {
    this.setRay(e);
    return this.ray.ray.intersectPlane(this.ground, new THREE.Vector3());
  }

  /** The diagram point the camera looks at: where a part added from the palette lands. */
  centerPoint() { const t = this.controls.target; return { x: t.x, y: t.z }; }

  partGroup(id) { return this.root.children.find((o) => o.userData.compId === id) || null; }

  hit(e) {
    this.setRay(e);
    for (const h of this.ray.intersectObjects(this.picks, true)) {
      let o = h.object;
      if (o.userData.pinRef) return { kind: 'pin', ref: o.userData.pinRef };
      while (o && !o.userData.compId && !o.userData.wireId) o = o.parent;
      if (o && o.userData.compId) { const p = o.userData.pivot.worldToLocal(h.point.clone()); return { kind: 'comp', id: o.userData.compId, lx: p.x, ly: p.z }; }
      if (o) return { kind: 'wire', id: o.userData.wireId };
    }
    return null;
  }

  pressable(h) {
    if (!h || h.kind !== 'comp') return false;
    const c = this.app.project.components.find((x) => x.id === h.id);
    if (!c) return false;
    const d = DEFS[c.type];
    if (d.interactive === 'keys') { h.key = d.keyAt(c, h.lx, h.ly); return !!h.key; }
    if (d.interactive === 'toggle') return true;
    return d.interactive === 'press';
  }

  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') { this.down = null; return; }
    const h = this.hit(e);
    this.down = { x: e.clientX, y: e.clientY, h };
    if (h && h.kind === 'pin') { this.down = null; this.app.canvas.clickPin(h.ref); this.syncOverlay(); return; }
    if (this.app.sim.running && this.pressable(h)) {
      this.controls.enabled = false;
      const tc = this.app.project.components.find((x) => x.id === h.id);
      if (tc && DEFS[tc.type].interactive === 'toggle') { tc.props.on = !tc.props.on; this.app.sim.syncProject(); this.app.save(); this.app.canvas.renderDynamic(); this.controls.enabled = true; return; }
      this.pressing = h.id; this.pressKey = h.key; this.app.sim.setPressed(h.id, true, h.key); this.app.canvas.renderDynamic();
      this.app.canvas.select({ kind: 'comp', id: h.id });
      return;
    }
    const c = h && h.kind === 'comp' ? this.app.project.components.find((x) => x.id === h.id) : null;
    const p = c && this.planePoint(e);
    if (p) { // drag a part along the board; the offset keeps the grab point under the pointer
      this.drag = { id: c.id, dx: p.x - c.x, dz: p.z - c.y, sx: e.clientX, sy: e.clientY, moved: false };
      this.controls.enabled = false;
      this.app.canvas.select({ kind: 'comp', id: c.id });
    }
  }

  onUp(e) {
    const d = this.down; this.down = null;
    if (this.pressing) { this.release(); return; }
    if (this.drag) {
      const dr = this.drag; this.drag = null; this.controls.enabled = true;
      const c = dr.moved && this.app.project.components.find((x) => x.id === dr.id);
      if (c) { this.app.canvas.endMove(c); return; }
    }
    if (!d || !this.active || e.target !== this.el) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) { this.app.canvas.cancelWire(); this.app.canvas.select(d.h); }
  }

  dragMove(e) {
    const dr = this.drag;
    if (!dr.moved && Math.hypot(e.clientX - dr.sx, e.clientY - dr.sy) < 4) return;
    const p = this.planePoint(e); if (!p) return;
    dr.moved = true;
    const c = this.app.project.components.find((x) => x.id === dr.id); if (!c) return;
    c.x = Math.round((p.x - dr.dx) / 5) * 5; c.y = Math.round((p.z - dr.dz) / 5) * 5;
    const g = this.partGroup(c.id), d = DEFS[c.type];
    if (g) { g.position.x = c.x + d.w / 2; g.position.z = c.y + d.h / 2; }
    this.linksDirty = true; // the wires and pin targets follow the part
    this.app.canvas.updateComp(c); this.app.canvas.scheduleWires();
  }

  /** Selection outline and the pin a wire starts from, drawn to match the 2D diagram. */
  syncOverlay() {
    const cv = this.app.canvas, sel = cv.sel;
    const key = `${sel ? sel.kind + ':' + sel.id : ''}|${cv.wireStart || ''}`;
    if (key === this.overlayKey) { if (this.selBox) this.selBox.update(); return; }
    this.overlayKey = key;
    if (this.selBox) { this.root.remove(this.selBox); this.selBox = null; }
    if (this.pendRing) { this.root.remove(this.pendRing); this.pendRing.geometry.dispose(); this.pendRing = null; }
    if (sel && sel.kind === 'comp') { const g = this.partGroup(sel.id); if (g) { this.selBox = new THREE.BoxHelper(g, 0xf5a524); this.root.add(this.selBox); } }
    const at = cv.wireStart && cv.pinPos(cv.wireStart);
    if (at) {
      const q = this.pinTop(at);
      this.pendRing = new THREE.Mesh(new THREE.SphereGeometry(3.4, 14, 10), new THREE.MeshBasicMaterial({ color: 0xf5a524 }));
      this.pendRing.position.set(q.x, q.y + 2, q.z); this.root.add(this.pendRing);
    }
  }

  release() {
    if (this.pressing) { this.app.sim.setPressed(this.pressing, false, this.pressKey); this.pressing = null; this.pressKey = undefined; this.app.canvas.renderDynamic(); }
    if (this.controls) this.controls.enabled = true;
  }

  onMove(e) {
    if (this.drag) { this.dragMove(e); return; }
    if (this.down || (this._mt && performance.now() - this._mt < 50)) return;
    this._mt = performance.now();
    const h = this.hit(e);
    this.el.style.cursor = this.app.sim.running && this.pressable(h) ? 'pointer' : h ? 'default' : '';
  }
}

// Library-driven parts (OLED, LED strips, keypad…): a slab whose top face shows the part's own 2D
// drawing, redrawn whenever its state changes (so the OLED, LEDs and digits update live in 3D too).
// the height of a breadboard: parts plugged into it stand on its top (8.5 mm)
const BREADBOARD_H = 33.5;
export { View3D };
