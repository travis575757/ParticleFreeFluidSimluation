// World: a SparseSim plus what a scene puts around it: the ground, fixed obstacles, bodies of
// water at rest, rigid bodies, sources that feed liquid in and drains that take it out (both
// metered), and the interaction verbs of the app. Lengths are cells, velocities cells per
// second, as everywhere in the solver.
import { SparseSim } from './sparsesim.js';
import { HeightField } from './heightfield.js';
import { Terrain, staticSolidTest, primDistance } from './terrain.js';
import { Body, stepBodies, quatFromAxisAngle } from '../bodies.js';
import { MAX_PRIMS, MAX_HULLS } from '../shaders/common.js';
import { Hull } from './hull.js';
import { Coupler } from '../couple.js';

export const WORLD_PARAMS = {
  pinMargin: 8,           // cells of water kept solved around a body that is awake
  // A body is at rest below this speed (cells per step; its surface speed from spinning counts too).
  // In a tank a floating body never comes quite to rest with this solver (see the README). Here the
  // waves it makes leave through the water at rest around it, and it settles to a few thousandths
  // of a cell per step within seconds.
  bodySleepSpeed: 0.02,
  // Slow is not enough: a buoy bobbing a quarter of a cell up and down is slow all the time, and
  // would be stopped wherever in its bob it happened to be. Over the same steps its height must
  // have stayed within a band of twice this (cells), and it is stopped as it passes the middle
  // of that band: where it would come to rest by itself.
  bodySleepRange: 0.1,
  bodySleepAfter: 90,     // steps a body has to be at rest before it sleeps
  bodySleepDrift: 0.01,   // [cells] ... and how far the middle of the swing of one that stands on the ground may have moved in that time
  bodyArmAfter: 240,      // steps the water next to a sleeping body has to be at rest before moving water wakes the body
  // with a height field: the water around what the camera looks at is solved, as far as the budget of solved bricks allows
  // rigid bodies and the liquid are solved together (src/couple.js; 0: they take turns, stepBodies in src/bodies.js)
  couple: 1,
  focusRadius: 0,         // cells around the focus (setFocus) within which the height field's water is solved (0: nowhere on that account)
  focusHold: 1.5,         // ... and stays solved within this many times the radius
};

const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** A fixed primitive as an obstacle for the bodies (the interface of resolveContacts in src/bodies.js). */
class Obstacle {
  constructor(dim, prim) { this.dim = dim; this.prim = prim; }
  sd(p) { return primDistance(this.prim, p, this.dim); }
  normal(p) {
    const e = 0.05;
    const g = [this.sd([p[0] + e, p[1], p[2]]) - this.sd([p[0] - e, p[1], p[2]]),
      this.sd([p[0], p[1] + e, p[2]]) - this.sd([p[0], p[1] - e, p[2]]),
      this.dim === 2 ? 0 : this.sd([p[0], p[1], p[2] + e]) - this.sd([p[0], p[1], p[2] - e])];
    const l = len(g) || 1;
    return [g[0] / l, g[1] / l, g[2] / l];
  }
  velocityAt() { return [0, 0, 0]; }
}

export class World {
  /**
   * @param scene  see src/world/scenes.js:
   *   { h, params, terrain: { origin, spacing, n, height }, solids: [prims], liquid: [prims],
   *     water: [{ box: [x0, z0, x1, z1], level }]   bodies of water at rest (SparseSim.setWater),
   *     swell: { center: [x, z], params }            the map of their surface (src/world/swell.js),
   *     bodies: [body specs]                         rigid bodies (src/bodies.js),
   *     kinematic: (t) => [body specs]               bodies that follow a script (3D: `yaw` turns them about y),
   *     emitters: [{ prim, from, until, every, for }], drains: [{ prim }],
   *     heightfield: { origin: [x, z], n: [nx, nz], cell, params,        a height field for the water that is not solved
   *       fill: [{ level, box }] or depth: (x, z, bed) => depth, velocity: (x, z) => [u, w],
   *       blocked: (x, z) => bool, sources: [...], links: [...],          (src/world/heightfield.js)
   *       sea: { level, wave: { amp, period, depth, dir: [x, z], origin: [x, z], ramp } } }
   *                                                  the sea beyond the map, for the eye only, with the swell that comes
   *                                                  in from it; a source with `swell: true` holds its strip of the map
   *                                                  at that sea's level (seaLevel), which is what sends the swell in
   *     solve: [{ lo, hi }]                          boxes of cells whose water is always solved (a cave: no height field),
   *     events: [{ at: seconds, run: (world) => {} }] }
   */
  constructor(glc, dim, scene, { params = {}, bricks = {}, world = {}, swell = {} } = {}) {
    this.glc = glc;
    this.dim = dim;
    this.scene = scene;
    this.params = { ...WORLD_PARAMS, ...scene.world, ...world };
    this.sim = new SparseSim(glc, { dim, params: { h: scene.h, ...scene.params, ...params }, bricks: { ...scene.bricks, ...bricks } });
    this.terrain = scene.terrain ? new Terrain(glc, dim, scene.terrain) : null;
    this.sim.setTerrain(this.terrain);
    this.solids = scene.solids || [];
    // bricks inside the ground or a fixed obstacle are never stored
    const solid = staticSolidTest(dim, this.terrain, this.solids);
    this.sim.solidBrick = solid;
    // what the bodies can touch that never moves
    this.statics = [...(this.terrain ? [this.terrain] : []), ...this.solids.map((p) => new Obstacle(dim, p))];
    // (the map of the surface is laid out around what the scene's camera looks at)
    const sw = scene.swell || {};
    this.sim.setWater(scene.water || [], {
      center: sw.center || (scene.camera ? [scene.camera.target[0], scene.camera.target[2]] : [0, 0]),
      params: { ...sw.params, ...swell },
    });
    this.hf = null;
    if (scene.heightfield) {
      const f = scene.heightfield, sp = this.sim.params;
      this.hf = new HeightField(glc, { origin: f.origin, n: dim === 2 ? [f.n[0], 1] : f.n, cell: f.cell || 2, gravity: -sp.gravity[1] / sp.h, params: f.params });
      this.setBed();
      this.sim.setHeightField(this.hf);
      // The edge of the map is the edge of the world to its water: a wall to the height field,
      // and to the solver, which stores no brick beyond it. (Without it solved water at the edge
      // would run on over ground where nobody keeps count of it.)
      const c = this.hf.cell, x0 = f.origin[0], x1 = x0 + this.hf.n[0] * c, z0 = f.origin[1], z1 = z0 + this.hf.n[1] * c;
      this.sim.solidBrick = (x, y, z, size) => x + size <= x0 || x >= x1 || (dim === 3 && (z + size <= z0 || z >= z1)) || solid(x, y, z, size);
    }
    this.focus = null;
    this.coupler = this.params.couple ? new Coupler(dim, scene.couple) : null;
    this.reset();
  }

  /**
   * The bed of the height field: the ground, and a wall wherever a fixed obstacle stands in the
   * water (or the scene says so: `blocked`, which may change, e.g. a gate that opens; call again then).
   */
  setBed() {
    const f = this.scene.heightfield, dim = this.dim;
    const ground = (x, z) => (this.terrain ? this.terrain.height(x, z) : f.bed ?? 0);
    const mid = dim === 2 ? 0.5 : 0;
    this.hf.setBed(ground, (x, z) => {
      if (f.blocked && f.blocked(x, z, this)) return true;
      const p = [x, ground(x, z) + 0.5, dim === 2 ? mid : z];
      return this.solids.some((s) => primDistance(s, p, dim) < 0);
    });
  }

  reset() {
    const sc = this.scene, dim = this.dim;
    this.time = 0;
    this.emitters = (sc.emitters || []).map((e) => ({ from: 0, until: Infinity, ...e }));
    this.drains = sc.drains || [];
    for (const b of this.kin || []) if (b.dispose) b.dispose();
    this.kin = (sc.kinematic ? sc.kinematic(0) : []).map((spec) => {
      const b = spec.shape === 'hull' ? new Hull(this.glc, dim, { ...spec, kinematic: true }) : new Body(dim, { ...spec, kinematic: true });
      b.scripted = true;
      b.still = 0;
      this._pose(b, spec, 0);
      return b;
    });
    if (this.bodies) this.removeBodies();
    this.bodies = [];
    for (const spec of sc.bodies || []) this.addBody(spec);
    this.sim.pins = [];
    this.events = (sc.events || []).map((e) => ({ ...e, done: false }));
    if (this.hf) {
      const f = sc.heightfield, hf = this.hf;
      if (f.blocked) this.setBed();
      hf.sources = (f.sources || []).map((s) => ({ ...s }));
      this._swellSources(0);
      hf.links = (f.links || []).map((l) => ({ ...l }));
      const inBox = (x, z, b) => !b || (x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
      hf.setState(f.depth || ((x, z, bed) => {
        let d = 0;
        for (const w of f.fill || []) if (inBox(x, z, w.box)) d = Math.max(d, w.level - bed);
        return d;
      }), f.velocity || null);
      this.sim.hfLock();
    }
    this.sim.reset(this.solidPrims(), sc.liquid || []);
    // a hull starts with nothing in it, unless the scene says otherwise (`flooded`): the water
    // the scene laid out where it floats is the water it displaces
    // (on water at rest nothing is stored there yet: the bricks would arrive full of it)
    const dry = [...this.kin, ...this.bodies].filter((b) => b instanceof Hull && !b.flooded);
    if (dry.length) {
      const shells = dry.map((b) => b.shellPrim());
      if (this.sim.water.length) this.sim.ensurePrims(shells, 2);
      this.sim.editLiquid(shells, 2);
    }
    this.mass0 = this.sim.measureSync().mass;     // the liquid the scene starts with ...
    this.excess0 = this.sim.water.length ? this.sim.excessSync() : 0;   // ... and how much of it is not water at rest
    this.water0 = this.hf ? this.sim.hfWaterSync() : 0;                 // with a height field: all the water there is
    this.unaccounted = null;                      // see readBooksAsync()
    this.forcesReady = Promise.resolve();
  }

  /**
   * The sea beyond the height field's map at time t, as the renderer draws it and as the sources
   * with `swell` hold their strips: { level, amp, k, phase, dir, origin } with the surface at
   * level + amp sin(phase - k ((x, z) - origin) . dir). A long wave on water `depth` deep (the
   * depth at the edge of the map, where the height field takes it over), grown from nothing
   * over `ramp` seconds. Null if the scene has no such sea.
   */
  sea(t = this.time) {
    const s = this.scene.heightfield && this.scene.heightfield.sea;
    if (!s) return null;
    const w = s.wave;
    if (!w) return { level: s.level, amp: 0, k: 0, phase: 0, dir: [1, 0], origin: [0, 0] };
    const sp = this.sim.params, g = -sp.gravity[1] / sp.h;
    const omega = 2 * Math.PI / w.period, k = omega / Math.sqrt(g * w.depth);
    const u = Math.min(t / (w.ramp ?? w.period), 1);
    return { level: s.level, amp: w.amp * u * u * (3 - 2 * u), k, phase: (omega * t) % (2 * Math.PI), dir: w.dir || [1, 0], origin: w.origin || [0, 0] };
  }

  /** The height of that sea's surface at (x, z). */
  seaLevel(x, z, t = this.time) {
    const s = this.sea(t);
    return s.level + s.amp * Math.sin(s.phase - s.k * ((x - s.origin[0]) * s.dir[0] + (z - s.origin[1]) * s.dir[1]));
  }

  _swellSources(t) {
    if (!this.hf) return;
    for (const s of this.hf.sources) {
      if (s.swell) s.level = this.seaLevel(0.5 * (s.box[0] + s.box[2]), 0.5 * (s.box[1] + s.box[3]), t);
    }
  }

  /**
   * What the camera looks at (cells), or null. With a height field: what it cannot hold is solved
   * nearest to this first (SparseSim._hfPromote), and with `solve` so is all its water within
   * params.focusRadius of it.
   */
  setFocus(pos, solve = true) { this.focus = pos; this.focusSolve = solve; }

  // ---------------------------------------------------------------- bodies
  /** The solver's solid primitives: fixed obstacles, scripted bodies, rigid bodies (in this order). */
  solidPrims() { return [...this.solids, ...this.kin.map((b) => b.prim()), ...this.bodies.map((b) => b.prim())]; }

  /** Kind per solid primitive for the renderer: 0 fixed obstacle, 1 scripted body, 2 + colour for a rigid body. */
  /** Per primitive, what the renderers draw it as: 0 obstacle, 1 scripted body, 2..5 rigid bodies, 6 rock, 7 hull. */
  solidKinds() {
    return [...this.solids.map((s) => (s.rock ? 6 : 0)), ...this.kin.map((b) => (b instanceof Hull ? 7 : 1)),
      ...this.bodies.map((b) => (b instanceof Hull ? 7 : 2 + (b.color % 4)))];
  }

  /**
   * A hole of `radius` cells through the hull at the world point p, if there is a hull within
   * `reach` cells of it. Returns that hull, or null. (The hull wakes: what floats now may not
   * float with a hole in it.)
   */
  breachAt(p, radius, reach = 1) {
    for (const b of [...this.bodies, ...this.kin]) {
      if (!(b instanceof Hull) || b.sd(p) > reach) continue;
      b.breach(p, radius);
      if (b.asleep) this.wake(b);
      return b;
    }
    return null;
  }

  canAddBody() { return this.solids.length + this.kin.length + this.bodies.length < MAX_PRIMS; }
  /** A rigid body (src/bodies.js), or with shape 'hull' one with a shape of its own (src/world/hull.js). */
  addBody(spec) {
    if (!this.canAddBody()) return null;
    const hull = spec.shape === 'hull';
    if (hull && this.hulls.length >= MAX_HULLS) return null;
    const b = hull ? new Hull(this.glc, this.dim, spec) : new Body(this.dim, spec);
    b.asleep = false;
    b.still = 0;
    this.bodies.push(b);
    return b;
  }
  removeBodies() { for (const b of this.bodies) if (b.dispose) b.dispose(); this.bodies = []; }
  get hulls() { return this.bodies.filter((b) => b instanceof Hull); }

  get gravityCells() {
    const g = this.sim.params.gravity, h = this.sim.params.h;
    return [g[0] / h, g[1] / h, this.dim === 2 ? 0 : g[2] / h];
  }

  /** Put a scripted body where its script says it is at the end of a step of dt (0: at once). */
  _pose(b, s, dt) {
    const dim = this.dim;
    let np = [s.pos[0], s.pos[1], dim === 2 ? 0.5 : s.pos[2]];
    const was = b.pos;
    const a = (dim === 2 ? s.angle : s.yaw) || 0;
    const axis = dim === 2 ? [0, 0, 1] : [0, 1, 0];
    if (dt > 0) {
      let da = a - b.angle1;
      da -= 2 * Math.PI * Math.round(da / (2 * Math.PI));     // (the script's angle may wrap)
      const w = da / dt;
      b.omega = [axis[0] * w, axis[1] * w, axis[2] * w];
    }
    b.angle1 = a;
    b.quat = quatFromAxisAngle(axis, a);
    if (s.quat && dim === 3) {
      // (a script may give the attitude whole; it is then the script's business to turn slowly)
      const q0 = b.quat0 || s.quat, q1 = s.quat;
      if (dt > 0) {
        // the turn from q0 to q1 as a vector: 2 * (q1 * conj(q0)).xyz for a small turn
        const w = [q1[3] * -q0[0] + q1[0] * q0[3] - q1[1] * q0[2] + q1[2] * q0[1],
          q1[3] * -q0[1] + q1[1] * q0[3] - q1[2] * q0[0] + q1[0] * q0[2],
          q1[3] * -q0[2] + q1[2] * q0[3] - q1[0] * q0[1] + q1[1] * q0[0]];
        b.omega = w.map((v) => (2 * v) / dt);
      }
      b.quat = [...q1];
      b.quat0 = [...q1];
    }
    // (a hull's script says where the origin of its drawing is: the body is where its centre of mass is)
    if (b.com) { b.pos = np; np = b.toWorld(b.com); if (dim === 2) np[2] = 0.5; }
    if (dt > 0) b.vel = [(np[0] - was[0]) / dt, (np[1] - was[1]) / dt, (np[2] - was[2]) / dt];
    b.pos = np;
  }

  /** Box of cells [lo, hi) around a body, `margin` cells wider. */
  bodyBox(b, margin = 0) {
    let e;
    if (b.shape === 'ball') e = [b.radius, b.radius, b.radius];
    else {
      // the box that contains the turned box
      e = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const u = [0, 0, 0];
        u[k] = b.half[k];
        const w = b.toWorld(u);
        for (let d = 0; d < 3; d++) e[d] += Math.abs(w[d] - b.pos[d]);
      }
    }
    const lo = [0, 1, 2].map((d) => Math.floor(b.pos[d] - e[d] - margin));
    const hi = [0, 1, 2].map((d) => Math.ceil(b.pos[d] + e[d] + margin));
    if (this.dim === 2) { lo[2] = 0; hi[2] = 1; }
    return { lo, hi };
  }

  wake(b) {
    if (!b.asleep) return;
    b.asleep = false;
    b.kinematic = false;
    b.still = 0;
    b.heights = [];
    b.middles = [];
  }

  _sleep(b) {
    b.asleep = true;
    b.rested = true;          // for the Coupler: when it wakes, the first guess is that it stays where it is
    b.armed = 0;              // what wakes it: see _sleepBodies
    b.calmFor = 0;
    b.kinematic = true;       // to the other bodies and to the liquid: a solid that stays where it is
    b.vel = [0, 0, 0];
    b.omega = [0, 0, 0];
    b.am = null;
  }

  /**
   * Bodies sleep and wake like the water around them. A body that has been slow for a while
   * stops being stepped (and stops keeping its water solved); it wakes when the water next to
   * it moves (the bricks it touches report liquid above the waking speed), or when something
   * that moves comes close. The water it stirred up itself has to calm down first: it wakes
   * to fast water once the water next to it is no longer fast, and to water that merely moves
   * (above the waking speed of the bricks) once that water has been at rest for bodyArmAfter steps.
   */
  _sleepBodies() {
    const P = this.params, sim = this.sim, dt = sim.params.dt;
    const moves = (b) => len(b.vel) * dt > P.bodySleepSpeed || len(b.omega) * b.extent * dt > P.bodySleepSpeed;
    const movers = [...this.kin, ...this.bodies].filter((b) => !b.asleep && moves(b));
    for (const b of this.kin) b.still = moves(b) ? 0 : b.still + 1;
    for (const b of this.bodies) {
      if (b.asleep) {
        const box = this.bodyBox(b, 1);
        const fast = sim.wakingIn(box.lo, box.hi, true), moving = fast || sim.wakingIn(box.lo, box.hi);
        b.calmFor = moving ? 0 : b.calmFor + 1;
        if (!fast) b.armed = Math.max(b.armed, 1);
        if (b.calmFor >= P.bodyArmAfter) b.armed = 2;
        if (b.grabbed || (fast && b.armed >= 1) || (moving && b.armed >= 2) ||
            movers.some((o) => len([o.pos[0] - b.pos[0], o.pos[1] - b.pos[1], o.pos[2] - b.pos[2]]) < o.extent + b.extent + 2)) this.wake(b);
        continue;
      }
      const ys = b.heights || (b.heights = []);
      const before = ys.length ? ys[ys.length - 1] : b.pos[1];
      ys.push(b.pos[1]);
      if (ys.length > P.bodySleepAfter) ys.shift();
      let lo = Infinity, hi = -Infinity;
      for (const y of ys) { lo = Math.min(lo, y); hi = Math.max(hi, y); }
      const mid = 0.5 * (lo + hi);
      const mids = b.middles || (b.middles = []);
      mids.push(mid);
      if (mids.length > P.bodySleepAfter) mids.shift();
      b.still = b.grabbed || moves(b) ? 0 : b.still + 1;
      if (b.still < P.bodySleepAfter) continue;
      // One that stands on the ground and goes over slowly (a hull on her bow, the last of her
      // compartments filling) is slow, and what the film under it leaves of its motion takes it
      // through the middle of its swing: but that middle moves. (Body.film: the points of it
      // next to a solid that nothing moves, see the Coupler.)
      if ((b.film || []).length && Math.abs(mid - mids[0]) > P.bodySleepDrift) continue;
      // (in the middle of its swing, not at the top of it; or not swinging at all: one that lies
      // on the ground and creeps one way never passes the middle)
      if (hi - lo <= 2 * P.bodySleepRange && ((before - mid) * (b.pos[1] - mid) <= 0 || hi - lo <= 0.02 * P.bodySleepRange)) this._sleep(b);
    }
  }

  /** The water around the bodies that are awake (and under the brush) has to be solved. */
  _pins() {
    const P = this.params, sim = this.sim, dt = sim.params.dt;
    const pins = [];
    for (const b of [...this.kin, ...this.bodies]) {
      const rests = b.asleep || (b.scripted && b.still >= P.bodySleepAfter);
      // (a hull at rest keeps its own water solved: what is in it is not water at rest, and
      // held bricks hold nothing else)
      if (rests && b instanceof Hull) pins.push(this.bodyBox(b, 2));
      if (rests) continue;
      pins.push(this.bodyBox(b, P.pinMargin + 4 * dt * len(b.vel)));
    }
    const m = sim.mouse;
    if (m.radius > 0 && m.strength > 0 && !len(m.dir || [0, 0, 0])) {
      const r = m.radius + 2;
      const lo = m.pos.map((v) => Math.floor(v - r)), hi = m.pos.map((v) => Math.ceil(v + r));
      if (this.dim === 2) { lo[2] = 0; hi[2] = 1; }
      pins.push({ lo, hi });
    }
    for (const b of this.scene.solve || []) pins.push({ lo: b.lo, hi: b.hi });
    if (this.hf) sim.hfFocus = this.focus ? [this.focus[0], this.focus[2]] : null;
    if (this.hf && this.focus && this.focusSolve && P.focusRadius > 0) {
      const f = this.focus, box = (r) => ({ lo: f.map((v) => Math.floor(v - r)), hi: f.map((v) => Math.ceil(v + r)) });
      // (in height: whatever water there is in the columns around)
      const tall = (b) => { b.lo[1] = -1e6; b.hi[1] = 1e6; if (this.dim === 2) { b.lo[2] = 0; b.hi[2] = 1; } return b; };
      pins.push({ ...this._span(tall(box(P.focusRadius))), soft: true });
      pins.push({ ...this._span(tall(box(P.focusRadius * P.focusHold))), hold: true });
    }
    sim.pins = pins;
  }

  /** A box of cells cut down in height to the rows of bricks in which the height field has water below it. */
  _span(b) {
    const sim = this.sim, B = sim.B;
    let lo = Infinity, hi = -Infinity;
    for (let z = Math.floor(b.lo[2] / B); z <= Math.floor((b.hi[2] - 1) / B); z++) {
      for (let x = Math.floor(b.lo[0] / B); x <= Math.floor((b.hi[0] - 1) / B); x++) {
        const s = sim._hfSpan(x, z);
        if (s) { lo = Math.min(lo, s[0]); hi = Math.max(hi, s[1]); }
      }
    }
    if (hi < lo) return { lo: [0, 0, 0], hi: [0, 0, 0] };
    return { lo: [b.lo[0], lo * B, b.lo[2]], hi: [b.hi[0], (hi + 1) * B, b.hi[2]] };
  }

  step() {
    const sim = this.sim, sc = this.scene;
    const dt = sim.params.dt;
    const t1 = this.time + dt;
    for (const e of this.emitters) {
      if (this.time < e.from || this.time >= e.until) continue;
      // (every, for: on for `for` seconds every `every` seconds)
      if (e.every && (this.time - e.from) % e.every >= (e.for ?? dt)) continue;
      sim.editLiquid([e.prim], 1, { meter: true });
    }
    for (const d of this.drains) sim.editLiquid([d.prim], 2, { meter: true });
    for (const e of this.events) if (!e.done && this.time >= e.at) { e.done = true; e.run(this); }
    this._swellSources(t1);

    if (this.kin.length) sc.kinematic(t1).forEach((s, i) => this._pose(this.kin[i], s, dt));
    const cp = this.coupler;
    if (this.bodies.length) {
      this._sleepBodies();
      const statics = [...this.statics, ...this.kin];
      if (cp) {
        const first = this.solids.length + this.kin.length;
        cp.begin(this.bodies, statics, { dt, gravity: this.gravityCells, index: (b) => first + this.bodies.indexOf(b) });
      } else if (this.bodies.some((b) => !b.asleep)) stepBodies(this.bodies, statics, { dt, gravity: this.gravityCells });
    } else if (cp) cp.active = [];
    if (this.kin.length || this.bodies.length) sim.setSolids(this.solidPrims());
    this._pins();

    const awake = this.bodies.filter((b) => !b.asleep);
    sim.coupler = cp;
    sim.twoWay = !cp && awake.some((b) => (b.wet ?? 1) > 0);
    sim.step();
    this.time = t1;
    // resolves once the liquid forces of this step have arrived (within a frame in the app;
    // solved together with the liquid, they are part of the step)
    this.forcesReady = cp ? Promise.resolve() : this._requestForces(awake, dt);
  }

  /** The liquid's force on the bodies that are awake (as Runner._requestForces of the tank simulators). */
  _requestForces(dyn, dt) {
    if (!dyn.length) return Promise.resolve();
    // the acceleration each body had in the step the liquid has just answered (forces, drag
    // and contacts): the measured force is the reaction to it
    const moved = dyn.map((b) => [0, 1].map((w) => {
      const now = w ? b.omega : b.vel, pre = (w ? b.omegaPre : b.velPre) || now;
      return [(now[0] - pre[0]) / dt, (now[1] - pre[1]) / dt, (now[2] - pre[2]) / dt];
    }));
    return this.sim.measureBodyForces(dyn.map((b) => b.prim())).then((res) => {
      if (!res) return;
      dyn.forEach((b, i) => {
        if (!this.bodies.includes(b) || b.asleep) return;
        const k = 1 / (b.density * dt * b.volume);
        b.force = res[i].force.map((v) => v * k);
        b.torque = res[i].torque.map((v) => v * k);
        [b.forceAcc, b.forceSpin] = moved[i];
        b.forceSeq++;
        b.wet = res[i].wet;
        b.fluidVel = res[i].fluidVel;
      });
    }).catch(() => {});
  }

  // ---- interaction (positions in cells)
  setBrush(pos, vel, radius, strength = 1, dir = [0, 0, 0]) {
    const m = this.sim.mouse;
    m.pos = pos; m.vel = vel; m.radius = radius; m.strength = strength; m.dir = dir;
  }
  pour(pos, vel, radius) { this.sim.editLiquid([{ type: 'ball', center: pos, radius, vel }], 1, { meter: true }); }
  erase(pos, radius) { this.sim.editLiquid([{ type: 'ball', center: pos, radius }], 2, { meter: true }); }

  /**
   * The liquid that is unaccounted for, from the totals of SparseSim.books (cells of liquid;
   * zero if nothing is lost), or null before the first totals have arrived. With bodies of
   * water the books are kept on the liquid that is more than the water at rest.
   */
  balance() {
    const bk = this.sim.books;
    if (this.hf) {
      // (all the water there is: the height field's, with what the 3D solver holds above it)
      const w = this.sim.hfWater;
      if (w === null || !bk) return null;
      return this.water0 + (bk.added - bk.removed) + (this.hf.added - this.hf.removed) - w;
    }
    if (!bk) return null;
    if (!this.sim.water.length) return this.mass0 + bk.added - bk.removed - bk.freed - bk.stored;
    return this.excess0 + bk.added - bk.removed - bk.freed - (bk.excess - bk.displaced + bk.absorbed);
  }

  /**
   * balance() with every total complete and of this moment: waits for the non-blocking reads that
   * are under way, then reads what is left (blocking). For tests of a running app, whose frames
   * keep starting such reads.
   */
  async balanceSettled() {
    const sim = this.sim, hf = this.hf;
    for (;;) {
      const a = sim._ledgerRead, b = hf && hf._ledgerRead;
      await a;
      await b;
      // (nothing was started while waiting: from here to the reads below no frame can come between)
      if (sim._ledgerRead === a && !sim._ledgerBusy && (!hf || hf._ledgerRead === b)) break;
    }
    sim.readLedger();
    if (!hf) { sim.readLedgerAsync(); await sim._ledgerRead; return this.balance(); }
    hf.readLedger();
    return this.water0 + (sim.added - sim.removed) + (hf.added - hf.removed) - sim.hfWaterSync();
  }

  /**
   * Start reading the totals balance() rests on, without blocking (for an app). With a height
   * field `unaccounted` is then balance() of totals read at one moment, a few frames later: its
   * sources and the waves at its edge move thousands of cells a step, so totals of different
   * steps would show as water lost or gained.
   */
  readBooksAsync() {
    const sim = this.sim, hf = this.hf;
    if (!hf) { sim.readLedgerAsync(); return; }
    if (this._booksBusy) return;
    this._booksBusy = true;
    Promise.all([sim.readLedgerAsync(), hf.readLedgerAsync(), sim.hfWaterAsync()])
      .then(([a, b, w]) => {
        if (a && w !== null) this.unaccounted = this.water0 + (a.added - a.removed) + (b.added - b.removed) - w;
      }, () => {})
      .finally(() => { this._booksBusy = false; });
  }

  /**
   * Who has the water, per column of bricks of the height field's map: { n: [columns in x, in z],
   * tier: Uint8Array } with 0 dry, 1 the height field alone, 2 a copy of it stored next to
   * solved water, 3 solved in 3D; + 4 where the height field holds something it cannot (a front,
   * water leaving the bed), near enough to the focus to be solved, and the column is not: the
   * budget of solved bricks is used up; + 8 where it has a source or a link
   * (and stays the height field's). Null without a height field.
   */
  tiers() {
    const sim = this.sim, hfc = sim.hfc;
    if (!hfc) return null;
    const nc = hfc.nc, d = hfc.data, n = nc[0] * nc[1];
    const tier = this._tier && this._tier.length === n ? this._tier : (this._tier = new Uint8Array(n));
    for (let k = 0; k < n; k++) tier[k] = d[4 * k + 1] > d[4 * k] ? 1 : 0;
    const set = sim.levels[0].set;
    for (let s = 0; s < set.high; s++) {
      if (!set.used[s]) continue;
      const x = set.bx[s], y = set.by[s], z = set.bz[s];
      const k = sim._hfCol(x, z);
      if (k < 0 || !tier[k]) continue;
      const span = sim._hfSpan(x, z);
      if (!span || y < span[0] || y > span[1]) continue;
      tier[k] = Math.max(tier[k], set.state(s) === 2 ? 2 : 3);
    }
    const f = sim.hfFocus, R = sim.params.hfPromoteRadius, b0 = sim._hfBrick0(), B = sim.B;
    for (let k = 0; k < n; k++) {
      // (flagged and not solved: only where it would be, within the radius around the focus)
      if (hfc.flags[k] && tier[k] && tier[k] < 3 && !hfc.locked[k]) {
        const i = k % nc[0], j = (k - i) / nc[0];
        const near = !f || !(R > 0) || Math.hypot((b0[0] + i + 0.5) * B - f[0], this.dim === 3 ? (b0[1] + j + 0.5) * B - f[1] : 0) <= R;
        if (near) tier[k] += 4;
      }
      if (hfc.locked[k]) tier[k] += 8;
    }
    return { n: nc, tier, origin: sim._hfBrick0() };
  }

  /** Cells of the box around the stored bricks: what a dense grid of the same region would hold. */
  boundsCells() {
    const set = this.sim.levels[0].set;
    if (this._boundsVersion !== set.version) {
      this._boundsVersion = set.version;
      const b = set.bounds();
      this._bounds = b;
      this._boundsCells = b ? [0, 1, 2].reduce((n, d) => n * (d < this.dim ? (b.hi[d] - b.lo[d]) * this.sim.B : 1), 1) : 0;
    }
    return this._boundsCells;
  }

  /** Cells [lo, hi) of the box around the stored bricks, or null. */
  bounds() {
    this.boundsCells();
    const b = this._bounds, B = this.sim.B;
    return b ? { lo: b.lo.map((v) => v * B), hi: b.hi.map((v) => v * B) } : null;
  }

  dispose() {
    this.sim.dispose();
    this.hf?.dispose();
    this.terrain?.dispose();
  }
}
