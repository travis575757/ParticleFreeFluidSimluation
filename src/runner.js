// Runner: owns a FluidSim plus everything a scene adds around it (scripted obstacles, a moving
// container, dynamic rigid bodies, emitters) and exposes the interaction verbs used by the apps.
import { FluidSim } from './sim.js';
import { MAX_PRIMS } from './shaders/common.js';
import { Body, Container, stepBodies, quatFromAxisAngle } from './bodies.js';

export class Runner {
  /**
   * @param scene  built scene (see scenes2d.js / scenes3d.js):
   *   { nx, ny, nz, params, liquid:[prims], container(t)->prim, kinematic?(t)->[body specs],
   *     bodies?:[body specs], emitters?:[{ from, until, period, duty, prim(t) }] }
   */
  constructor(glc, dim, scene, overrides = {}) {
    this.glc = glc;
    this.dim = dim;
    this.scene = scene;
    this.sim = new FluidSim(glc, { dim, nx: scene.nx, ny: scene.ny, nz: scene.nz, params: { ...scene.params, ...overrides } });
    this.reset();
  }

  reset() {
    const sc = this.scene;
    const dim = this.dim;
    this.time = 0;
    this.container = sc.container(0);
    this.kin = (sc.kinematic ? sc.kinematic(0) : []).map((spec) => {
      const b = new Body(dim, { ...spec, kinematic: true });
      b.scripted = true;
      b.angle2 = spec.angle || 0;
      return b;
    });
    this.bodies = (sc.bodies || []).map((spec) => new Body(dim, spec));
    this.grabbedBody = null;
    this.sim.reset(this._solidPrims(), sc.liquid);
  }

  _solidPrims() {
    return [this.container, ...this.kin.map((b) => b.prim()), ...this.bodies.map((b) => b.prim())];
  }

  /** Kinds per solid primitive for the renderers: 0 container, 1 scripted obstacle, 2+ dynamic body colour. */
  solidKinds() {
    return [0, ...this.kin.map(() => 1), ...this.bodies.map((b) => 2 + (b.color % 4))];
  }

  get gravityCells() {
    const g = this.sim.params.gravity;
    const h = this.sim.params.h;
    return [g[0] / h, g[1] / h, this.dim === 2 ? 0 : g[2] / h];
  }

  step() {
    const sim = this.sim;
    const sc = this.scene;
    const dim = this.dim;
    const dt = sim.params.dt;
    const t1 = this.time + dt;

    // scripted obstacles and the container: position at t1, velocity by finite differences
    if (sc.kinematic) {
      const specs = sc.kinematic(t1);
      this.kin.forEach((b, i) => {
        const s = specs[i];
        const np = [s.pos[0], s.pos[1], dim === 2 ? 0.5 : s.pos[2]];
        b.vel = [(np[0] - b.pos[0]) / dt, (np[1] - b.pos[1]) / dt, (np[2] - b.pos[2]) / dt];
        b.pos = np;
        if (dim === 2) {
          const a = s.angle || 0;
          b.omega = [0, 0, (a - b.angle2) / dt];
          b.angle2 = a;
          b.quat = quatFromAxisAngle([0, 0, 1], a);
        } else {
          b.omega = s.omega || [0, 0, 0];
          if (s.quat) b.quat = s.quat;
        }
      });
    }
    const c1 = sc.container(t1);
    const c0 = this.container;
    c1.vel = [(c1.center[0] - c0.center[0]) / dt, (c1.center[1] - c0.center[1]) / dt, dim === 2 ? 0 : (c1.center[2] - c0.center[2]) / dt];
    this.container = c1;

    if (this.bodies.length) {
      stepBodies(this.bodies, [new Container(dim, c1), ...this.kin], { dt, gravity: this.gravityCells });
    }
    sim.setSolids(this._solidPrims());

    for (const e of sc.emitters || []) {
      if (t1 < (e.from || 0) || t1 >= (e.until ?? Infinity)) continue;
      if (e.period && ((t1 - (e.from || 0)) % e.period) / e.period > (e.duty ?? 0.5)) continue;
      sim.editLiquid([e.prim(t1)], 1);
    }

    sim.twoWay = this.glc.readback !== 'scrambled' && this.bodies.some((b) => !b.kinematic && (b.wet ?? 1) > 0);
    sim.step();
    this.time = t1;
    if (!this._checked) { this._checked = true; this.glc.checkErrors(`the first step on a ${sim.grid.n.slice(0, dim).join('x')} grid`); }
    // resolves once the liquid forces of this step have arrived (within a frame in the apps;
    // tests await it so that their timing matches a real-time run)
    this.forcesReady = this._requestForces(dt);
  }

  _requestForces(dt) {
    const dyn = this.bodies.filter((b) => !b.kinematic);
    // without usable read-back the bodies only feel gravity and contacts
    if (!dyn.length || this.glc.readback === 'scrambled') return Promise.resolve();
    // the acceleration each body had in the step the liquid has just answered (forces, drag
    // and contacts): the measured force is the reaction to it
    const moved = dyn.map((b) => [0, 1].map((w) => {
      const now = w ? b.omega : b.vel, pre = (w ? b.omegaPre : b.velPre) || now;
      return [(now[0] - pre[0]) / dt, (now[1] - pre[1]) / dt, (now[2] - pre[2]) / dt];
    }));
    return this.sim.measureBodyForces(dyn.map((b) => b.prim())).then((res) => {
      if (!res) return;
      dyn.forEach((b, i) => {
        if (!this.bodies.includes(b)) return;
        const k = 1 / (b.density * dt * b.volume);
        const f = res[i].force.map((v) => v * k);
        const tq = res[i].torque.map((v) => v * k);
        // taken as measured: smoothing would delay the liquid's answer, and a delayed
        // restoring force feeds a bobbing body instead of slowing it
        b.force = f;
        b.torque = tq;
        [b.forceAcc, b.forceSpin] = moved[i];
        b.forceSeq++;
        b.wet = res[i].wet;
        b.fluidVel = res[i].fluidVel;
      });
    }).catch(() => {});
  }

  // ---------------------------------------------------------------- interaction
  /** Velocity brush: liquid near `pos` is dragged towards `vel` (cells/s). radius 0 switches it off. */
  setBrush(pos, vel, radius, strength = 1, dir = [0, 0, 0]) {
    const m = this.sim.mouse;
    m.pos = pos; m.vel = vel; m.radius = radius; m.strength = strength; m.dir = dir;
  }

  pour(pos, vel, radius) { this.sim.editLiquid([{ type: 'ball', center: pos, radius, vel }], 1); }
  erase(pos, radius) { this.sim.editLiquid([{ type: 'ball', center: pos, radius }], 2); }

  /** Dynamic body under `pos` (grid coordinates), or null. */
  pick(pos, tol = 0.75) {
    let best = null;
    let bd = tol;
    for (const b of this.bodies) {
      const d = b.sd(pos);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }

  grab(body, target) {
    this.grabbedBody = body;
    body.grabbed = true;
    body.target = target;
    body.grabOffset = [body.pos[0] - target[0], body.pos[1] - target[1], body.pos[2] - target[2]];
  }
  dragTo(target) {
    const b = this.grabbedBody;
    if (b) b.target = [target[0] + b.grabOffset[0], target[1] + b.grabOffset[1], this.dim === 2 ? 0.5 : target[2] + b.grabOffset[2]];
  }
  release() {
    if (this.grabbedBody) { this.grabbedBody.grabbed = false; this.grabbedBody = null; }
  }

  canAddBody() { return 1 + this.kin.length + this.bodies.length < MAX_PRIMS; }
  addBody(spec) {
    if (!this.canAddBody()) return null;
    const b = new Body(this.dim, spec);
    this.bodies.push(b);
    return b;
  }
  removeBodies() { this.release(); this.bodies = []; }

  dispose() { this.sim.dispose(); }
}
