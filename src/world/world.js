// World: a SparseSim plus what a scene puts around it: the ground, fixed obstacles, bodies of
// water at rest, rigid bodies, sources that feed liquid in and drains that take it out (both
// metered), and the interaction verbs of the app. Lengths are cells, velocities cells per
// second, as everywhere in the solver.
import { SparseSim } from './sparsesim.js';
import { Terrain, staticSolidTest, primDistance } from './terrain.js';
import { Body, stepBodies, quatFromAxisAngle } from '../bodies.js';
import { MAX_PRIMS } from '../shaders/common.js';

export const WORLD_PARAMS = {
  pinMargin: 8,           // cells of water kept solved around a body that is awake
  // A body is at rest below this speed (cells per step; its surface speed from spinning counts too).
  // In a tank a floating body never comes quite to rest with this solver (see the README). Here the
  // waves it makes leave through the water at rest around it, and it settles to a few thousandths
  // of a cell per step within seconds.
  bodySleepSpeed: 0.02,
  // Slow is not enough: a buoy bobbing a quarter of a cell up and down is slow all the time, and
  // would be stopped wherever in its bob it happened to be (low, as it turned out, every time).
  // Its height must not have changed by more than this either (cells).
  bodySleepRange: 0.1,
  bodySleepAfter: 90,     // steps a body has to be at rest before it sleeps
  bodyArmAfter: 240,      // steps the water next to a sleeping body has to be at rest before moving water wakes the body
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
   *     bodies: [body specs]                         rigid bodies (src/bodies.js),
   *     kinematic: (t) => [body specs]               bodies that follow a script (3D: `yaw` turns them about y),
   *     emitters: [{ prim, from, until, every, for }], drains: [{ prim }] }
   */
  constructor(glc, dim, scene, { params = {}, bricks = {}, world = {} } = {}) {
    this.glc = glc;
    this.dim = dim;
    this.scene = scene;
    this.params = { ...WORLD_PARAMS, ...scene.world, ...world };
    this.sim = new SparseSim(glc, { dim, params: { h: scene.h, ...scene.params, ...params }, bricks: { ...scene.bricks, ...bricks } });
    this.terrain = scene.terrain ? new Terrain(glc, dim, scene.terrain) : null;
    this.sim.setTerrain(this.terrain);
    this.solids = scene.solids || [];
    // bricks inside the ground or a fixed obstacle are never stored
    this.sim.solidBrick = staticSolidTest(dim, this.terrain, this.solids);
    // what the bodies can touch that never moves
    this.statics = [...(this.terrain ? [this.terrain] : []), ...this.solids.map((p) => new Obstacle(dim, p))];
    this.sim.setWater(scene.water || []);
    this.reset();
  }

  reset() {
    const sc = this.scene, dim = this.dim;
    this.time = 0;
    this.emitters = (sc.emitters || []).map((e) => ({ from: 0, until: Infinity, ...e }));
    this.drains = sc.drains || [];
    this.kin = (sc.kinematic ? sc.kinematic(0) : []).map((spec) => {
      const b = new Body(dim, { ...spec, kinematic: true });
      b.scripted = true;
      b.still = 0;
      this._pose(b, spec, 0);
      return b;
    });
    this.bodies = [];
    for (const spec of sc.bodies || []) this.addBody(spec);
    this.sim.pins = [];
    this.sim.reset(this.solidPrims(), sc.liquid || []);
    this.mass0 = this.sim.measureSync().mass;     // the liquid the scene starts with ...
    this.excess0 = this.sim.water.length ? this.sim.excessSync() : 0;   // ... and how much of it is not water at rest
    this.forcesReady = Promise.resolve();
  }

  // ---------------------------------------------------------------- bodies
  /** The solver's solid primitives: fixed obstacles, scripted bodies, rigid bodies (in this order). */
  solidPrims() { return [...this.solids, ...this.kin.map((b) => b.prim()), ...this.bodies.map((b) => b.prim())]; }

  /** Kind per solid primitive for the renderer: 0 fixed obstacle, 1 scripted body, 2 + colour for a rigid body. */
  solidKinds() { return [...this.solids.map(() => 0), ...this.kin.map(() => 1), ...this.bodies.map((b) => 2 + (b.color % 4))]; }

  canAddBody() { return this.solids.length + this.kin.length + this.bodies.length < MAX_PRIMS; }
  addBody(spec) {
    if (!this.canAddBody()) return null;
    const b = new Body(this.dim, spec);
    b.asleep = false;
    b.still = 0;
    this.bodies.push(b);
    return b;
  }
  removeBodies() { this.bodies = []; }

  get gravityCells() {
    const g = this.sim.params.gravity, h = this.sim.params.h;
    return [g[0] / h, g[1] / h, this.dim === 2 ? 0 : g[2] / h];
  }

  /** Put a scripted body where its script says it is at the end of a step of dt (0: at once). */
  _pose(b, s, dt) {
    const dim = this.dim;
    const np = [s.pos[0], s.pos[1], dim === 2 ? 0.5 : s.pos[2]];
    const a = (dim === 2 ? s.angle : s.yaw) || 0;
    const axis = dim === 2 ? [0, 0, 1] : [0, 1, 0];
    if (dt > 0) {
      b.vel = [(np[0] - b.pos[0]) / dt, (np[1] - b.pos[1]) / dt, (np[2] - b.pos[2]) / dt];
      let da = a - b.angle1;
      da -= 2 * Math.PI * Math.round(da / (2 * Math.PI));     // (the script's angle may wrap)
      const w = da / dt;
      b.omega = [axis[0] * w, axis[1] * w, axis[2] * w];
    }
    b.pos = np;
    b.angle1 = a;
    b.quat = quatFromAxisAngle(axis, a);
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
  }

  _sleep(b) {
    b.asleep = true;
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
      if (b.grabbed || moves(b) || !(Math.abs(b.pos[1] - b.stillAt) <= P.bodySleepRange)) { b.still = 0; b.stillAt = b.pos[1]; }
      else b.still++;
      if (b.still >= P.bodySleepAfter) this._sleep(b);
    }
  }

  /** The water around the bodies that are awake (and under the brush) has to be solved. */
  _pins() {
    const P = this.params, sim = this.sim, dt = sim.params.dt;
    const pins = [];
    for (const b of [...this.kin, ...this.bodies]) {
      if (b.asleep || (b.scripted && b.still >= P.bodySleepAfter)) continue;
      pins.push(this.bodyBox(b, P.pinMargin + 4 * dt * len(b.vel)));
    }
    const m = sim.mouse;
    if (m.radius > 0 && m.strength > 0 && !len(m.dir || [0, 0, 0])) {
      const r = m.radius + 2;
      const lo = m.pos.map((v) => Math.floor(v - r)), hi = m.pos.map((v) => Math.ceil(v + r));
      if (this.dim === 2) { lo[2] = 0; hi[2] = 1; }
      pins.push({ lo, hi });
    }
    sim.pins = pins;
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

    if (this.kin.length) sc.kinematic(t1).forEach((s, i) => this._pose(this.kin[i], s, dt));
    if (this.bodies.length) {
      this._sleepBodies();
      if (this.bodies.some((b) => !b.asleep)) stepBodies(this.bodies, [...this.statics, ...this.kin], { dt, gravity: this.gravityCells });
    }
    if (this.kin.length || this.bodies.length) sim.setSolids(this.solidPrims());
    this._pins();

    const awake = this.bodies.filter((b) => !b.asleep);
    sim.twoWay = awake.some((b) => (b.wet ?? 1) > 0);
    sim.step();
    this.time = t1;
    // resolves once the liquid forces of this step have arrived (within a frame in the app)
    this.forcesReady = this._requestForces(awake, dt);
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
    if (!bk) return null;
    if (!this.sim.water.length) return this.mass0 + bk.added - bk.removed - bk.freed - bk.stored;
    return this.excess0 + bk.added - bk.removed - bk.freed - (bk.excess - bk.displaced + bk.absorbed);
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
    this.terrain?.dispose();
  }
}
