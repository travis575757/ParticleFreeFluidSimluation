// Rigid bodies ("physical objects") for the 2D and 3D simulators.
//
// Solid -> liquid coupling is the paper's: every body is a solid primitive with a velocity
// field, seen by the liquid through the solid fractions and solid velocities (Sec. 3.6/3.7).
// Liquid -> solid coupling (not part of the paper) integrates the liquid pressure over the
// body surface on the GPU and feeds force and torque back with a one/two frame delay,
// stabilised with an added-mass term so that bodies lighter than the liquid float calmly.
//
// All quantities are in grid units (cells, cells/s); positions are grid coordinates.

const DIRS3 = [];
for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) DIRS3.push([x, y, z]);
const DIRS2 = [];
for (let k = 0; k < 16; k++) DIRS2.push([Math.cos((k * Math.PI) / 8), Math.sin((k * Math.PI) / 8), 0]);
const BOX2 = [[-1, -1, 0], [0, -1, 0], [1, -1, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [-1, 1, 0], [-1, 0, 0],
  [-0.5, -1, 0], [0.5, -1, 0], [1, -0.5, 0], [1, 0.5, 0], [0.5, 1, 0], [-0.5, 1, 0], [-1, 0.5, 0], [-1, -0.5, 0]];

// ---- small vector / quaternion helpers -------------------------------------------------------
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Rotate v by unit quaternion q = [x, y, z, w]. */
function qrot(q, v) {
  const u = [q[0], q[1], q[2]];
  const t = mul(cross(u, v), 2);
  return add(add(v, mul(t, q[3])), cross(u, t));
}
const qconj = (q) => [-q[0], -q[1], -q[2], q[3]];
function qmul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qnorm(q) {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function quatFromAxisAngle(axis, angle) {
  const l = len(axis) || 1;
  const s = Math.sin(angle / 2) / l;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}
/** Column-major world->local rotation matrix (transpose of the body rotation). */
export function quatToWorldToLocal(q) {
  const ex = qrot(q, [1, 0, 0]);
  const ey = qrot(q, [0, 1, 0]);
  const ez = qrot(q, [0, 0, 1]);
  // rows of R^T are the body axes; column-major storage lists columns
  return [ex[0], ey[0], ez[0], ex[1], ey[1], ez[1], ex[2], ey[2], ez[2]];
}

export class Body {
  /**
   * @param {object} o  { shape:'ball'|'box', pos, radius | half, round, density (relative to the liquid),
   *                      vel, omega, angle (2D) | quat (3D), kinematic, color }
   */
  constructor(dim, o) {
    this.dim = dim;
    this.shape = o.shape;
    this.pos = [o.pos[0], o.pos[1], dim === 2 ? 0.5 : o.pos[2]];
    this.vel = o.vel ? [o.vel[0], o.vel[1], dim === 2 ? 0 : o.vel[2] || 0] : [0, 0, 0];
    this.omega = dim === 2 ? [0, 0, o.omega || 0] : (o.omega ? [...o.omega] : [0, 0, 0]);
    this.quat = dim === 2 ? quatFromAxisAngle([0, 0, 1], o.angle || 0) : (o.quat ? [...o.quat] : [0, 0, 0, 1]);
    this.radius = o.radius || 0;
    this.half = o.half ? [o.half[0], o.half[1], dim === 2 ? 1 : o.half[2]] : [0, 0, 0];
    this.round = o.round || 0;
    this.density = o.density ?? 0.5;
    this.kinematic = !!o.kinematic;
    this.color = o.color ?? 0;
    this.grabbed = false;
    this.scripted = false;        // position driven by a scene script (kinematic obstacle)
    this.target = null;
    this.restitution = o.restitution ?? 0.25;
    this.force = [0, 0, 0];        // filtered pressure acceleration from the liquid
    this.torque = [0, 0, 0];
    this.accPrev = [0, 0, 0];
    // volume (cells^dim) and inertia per unit mass
    if (this.shape === 'ball') {
      this.volume = dim === 2 ? Math.PI * this.radius ** 2 : (4 / 3) * Math.PI * this.radius ** 3;
      const k = (dim === 2 ? 0.5 : 0.4) * this.radius ** 2;
      this.inertia = [k, k, k];
      this.extent = this.radius;
    } else {
      const [a, b, c] = this.half;
      this.volume = dim === 2 ? 4 * a * b : 8 * a * b * c;
      this.inertia = dim === 2 ? [1, 1, (a * a + b * b) / 3] : [(b * b + c * c) / 3, (a * a + c * c) / 3, (a * a + b * b) / 3];
      this.extent = dim === 2 ? Math.hypot(a, b) : Math.hypot(a, b, c);
    }
  }

  toLocal(p) { const d = sub(p, this.pos); if (this.dim === 2) d[2] = 0; return qrot(qconj(this.quat), d); }
  toWorld(l) { return add(this.pos, qrot(this.quat, l)); }

  /** Signed distance (negative inside). */
  sd(p) {
    const l = this.toLocal(p);
    if (this.shape === 'ball') return len(l) - this.radius;
    const q = [Math.abs(l[0]) - this.half[0] + this.round, Math.abs(l[1]) - this.half[1] + this.round,
      this.dim === 2 ? -1e6 : Math.abs(l[2]) - this.half[2] + this.round];
    const out = Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0));
    return out + Math.min(Math.max(q[0], q[1], q[2]), 0) - this.round;
  }

  /** Outward unit normal of the distance field at p. */
  normal(p) {
    const e = 0.05;
    const g = [this.sd([p[0] + e, p[1], p[2]]) - this.sd([p[0] - e, p[1], p[2]]),
      this.sd([p[0], p[1] + e, p[2]]) - this.sd([p[0], p[1] - e, p[2]]),
      this.dim === 2 ? 0 : this.sd([p[0], p[1], p[2] + e]) - this.sd([p[0], p[1], p[2] - e])];
    const l = len(g) || 1;
    return mul(g, 1 / l);
  }

  velocityAt(p) {
    const r = sub(p, this.pos);
    if (this.dim === 2) r[2] = 0;
    return add(this.vel, cross(this.omega, r));
  }

  /** Surface sample points (world space) used for contact detection. */
  samplePoints() {
    const dirs = this.dim === 2 ? (this.shape === 'ball' ? DIRS2 : BOX2) : DIRS3;
    return dirs.map((d) => {
      let l;
      if (this.shape === 'ball') { const n = len(d); l = mul(d, this.radius / n); }
      else l = [d[0] * this.half[0], d[1] * this.half[1], this.dim === 2 ? 0 : d[2] * this.half[2]];
      return this.toWorld(l);
    });
  }

  /** World-space inverse inertia (per unit mass) applied to a vector. */
  invInertia(v) {
    if (this.dim === 2) return [0, 0, v[2] / this.inertia[2]];
    const l = qrot(qconj(this.quat), v);
    return qrot(this.quat, [l[0] / this.inertia[0], l[1] / this.inertia[1], l[2] / this.inertia[2]]);
  }

  /** Apply impulse J (per unit of this body's mass) at world point p. */
  applyImpulse(J, p) {
    if (this.kinematic) return;
    this.vel = add(this.vel, J);
    const r = sub(p, this.pos);
    if (this.dim === 2) r[2] = 0;
    this.omega = add(this.omega, this.invInertia(cross(r, J)));
  }

  integrate(dt) {
    this.pos = add(this.pos, mul(this.vel, dt));
    if (this.dim === 2) this.pos[2] = 0.5;
    const w = this.omega;
    const a = len(w) * dt;
    if (a > 1e-9) this.quat = qnorm(qmul(quatFromAxisAngle(w, a), this.quat));
  }

  /** Primitive for the solver (see packPrims in sim.js). */
  prim() {
    const base = { center: this.pos, vel: this.vel, omega: this.omega, rot: quatToWorldToLocal(this.quat) };
    return this.shape === 'ball'
      ? { type: 'ball', radius: this.radius, ...base }
      : { type: 'box', half: this.half, round: this.round, ...base };
  }
}

/** A static or moving container wall seen as an inside-out primitive. */
export class Container {
  constructor(dim, prim) { this.dim = dim; this.prim = prim; }
  sd(p) {
    const c = this.prim.center;
    const d = [p[0] - c[0], p[1] - c[1], this.dim === 2 ? 0 : p[2] - c[2]];
    if (this.prim.type === 'ball') return this.prim.radius - len(d);
    const h = this.prim.half;
    const q = [Math.abs(d[0]) - h[0], Math.abs(d[1]) - h[1], this.dim === 2 ? -1e6 : Math.abs(d[2]) - h[2]];
    return -(Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0));
  }
  normal(p) {
    const e = 0.05;
    const g = [this.sd([p[0] + e, p[1], p[2]]) - this.sd([p[0] - e, p[1], p[2]]),
      this.sd([p[0], p[1] + e, p[2]]) - this.sd([p[0], p[1] - e, p[2]]),
      this.dim === 2 ? 0 : this.sd([p[0], p[1], p[2] + e]) - this.sd([p[0], p[1], p[2] - e])];
    const l = len(g) || 1;
    return mul(g, 1 / l);
  }
  velocityAt() { return this.prim.vel || [0, 0, 0]; }
}

/**
 * Advance the dynamic bodies by dt.
 * @param {Body[]} bodies
 * @param {Array} statics  objects with sd/normal/velocityAt and infinite mass (container, kinematic obstacles)
 * @param {object} o       { dt, gravity:[..] (cells/s^2), addedMass, fluidDrag }
 */
export function stepBodies(bodies, statics, o) {
  const { dt, gravity } = o;
  const Ca = o.addedMass ?? 1.5;
  for (const b of bodies) {
    if (b.kinematic) continue;
    if (b.grabbed) {
      // follow the drag target; contacts still apply so the body cannot be pulled through walls
      let v = mul(sub(b.target, b.pos), 0.35 / dt);
      if (b.dim === 2) v[2] = 0;
      const lim = 0.45 / dt * Math.max(1, b.extent);
      if (len(v) > lim) v = mul(v, lim / len(v));
      b.vel = v;
      b.omega = mul(b.omega, 0.9);
      b.accPrev = [0, 0, 0];
      continue;
    }
    // a = (g + a_pressure + Ca r a_prev) / (1 + Ca r): implicit treatment of the added mass that
    // the (lagged) pressure force already contains
    const r = (Ca * Math.max(b.wet ?? 0, 0.3)) / b.density;
    // impact spikes arrive late (the force is read back asynchronously); cap them at a few
    // times the largest buoyancy the body can feel so light bodies do not get catapulted
    const glen = len(gravity);
    const cap = (3 * glen) / Math.min(b.density, 1);
    const fl = len(b.force);
    const fs = fl > cap ? cap / fl : 1;
    const acc = [0, 0, 0];
    for (let k = 0; k < 3; k++) acc[k] = (gravity[k] + fs * b.force[k] + r * b.accPrev[k]) / (1 + r);
    if (b.dim === 2) acc[2] = 0;
    b.accPrev = acc;
    b.vel = add(b.vel, mul(acc, dt));
    // The solver is inviscid, so nothing else resists a body moving through the liquid:
    // quadratic form drag plus a little linear damping, relative to the surrounding liquid
    // (implicit update, unconditionally stable).
    const vf = b.fluidVel || [0, 0, 0];
    const vr = sub(b.vel, vf);
    const kd = ((b.wet ?? 0) * (0.6 * len(vr) / Math.max(b.extent, 1) + 0.6)) / b.density;
    b.vel = add(vf, mul(vr, 1 / (1 + dt * kd)));
    if (b.dim === 2) b.vel[2] = 0;
    b.omega = add(b.omega, mul(b.invInertia(b.torque), dt / (1 + r)));
    // mild damping of the spin inside liquid (the inviscid solver exerts no shear)
    const damp = Math.exp(-dt * (0.2 + 2.0 * (b.wet ?? 0)));
    b.omega = mul(b.omega, damp);
    const vmax = 0.45 / dt * Math.max(1, b.extent);   // keep fast bodies from tunnelling
    const sp = len(b.vel);
    if (sp > vmax) b.vel = mul(b.vel, vmax / sp);
  }
  for (const b of bodies) if (!b.scripted) b.integrate(dt);

  // contacts: sample points of each body against statics and the other bodies
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      if (a.kinematic) continue;
      const others = [...statics, ...bodies.filter((_, j) => j !== i)];
      for (const o2 of others) {
        const isBody = o2 instanceof Body;
        if (isBody && len(sub(o2.pos, a.pos)) > a.extent + o2.extent + 1) continue;
        const fixedB = !isBody || o2.kinematic;
        const fixedA = false;
        const wA = fixedA ? 0 : 1 / (a.density * a.volume);
        const wB = fixedB ? 0 : 1 / (o2.density * o2.volume);
        let deepest = 0;
        let hit = null;
        for (const p of a.samplePoints()) {
          const d = o2.sd(p);
          if (d < deepest) { deepest = d; hit = p; }
        }
        if (!hit) continue;
        const n = o2.normal(hit);              // points out of o2, i.e. the way `a` must move
        const pen = -deepest;
        const corr = pen * 0.8;
        if (!fixedA) a.pos = add(a.pos, mul(n, (corr * wA) / (wA + wB)));
        if (!fixedB) o2.pos = sub(o2.pos, mul(n, (corr * wB) / (wA + wB)));
        const vrel = sub(a.velocityAt(hit), o2.velocityAt(hit));
        const vn = dot(vrel, n);
        if (vn < 0) {
          const rA = sub(hit, a.pos);
          let k = wA + wB;
          if (!fixedA) k += wA * dot(cross(a.invInertia(cross(rA, n)), rA), n);
          if (!fixedB) { const rB = sub(hit, o2.pos); k += wB * dot(cross(o2.invInertia(cross(rB, n)), rB), n); }
          const e = Math.min(a.restitution, isBody ? o2.restitution : a.restitution);
          const j = (-(1 + (Math.abs(vn) > 8 ? e : 0)) * vn) / k;
          // friction: remove part of the tangential slip
          const vt = sub(vrel, mul(n, vn));
          const jt = mul(vt, -0.25 / k);
          const J = add(mul(n, j), jt);
          if (!fixedA) a.applyImpulse(mul(J, wA), hit);
          if (!fixedB) o2.applyImpulse(mul(J, -wB), hit);
        }
      }
    }
  }
}
