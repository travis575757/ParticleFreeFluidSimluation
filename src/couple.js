// Coupler: rigid bodies and the liquid solved together.
//
// The liquid sees a body as a solid that moves (the paper's Sec. 3.6/3.7), and the body feels
// the liquid as the pressure on its surface. The pressure of a step depends on how the body
// moves in that step and the body's motion on that pressure: the two belong to one equation.
// stepBodies() in src/bodies.js takes them apart in time (the force measured after one step
// moves the body in the next) and repairs the delay with an estimate of the added mass. That
// works as long as the estimate is good and the added mass moderate. It is neither for a hull
// with water in it: the water inside weighs many times the hull, and every error of the
// estimate comes back multiplied by that ratio.
//
// Here the body's velocity at the end of the step is an unknown of the pressure solve:
//
//   M (v - v0) = dt M g + J(v)          J(v): the impulse of the pressure that belongs to v
//
// J is (piecewise) linear in v: J(v) = J(vi) - A (v - vi), with A the added mass matrix of the
// body. With an estimate of A this is Newton's method on a handful of unknowns per body:
//
//   v <- v + (M + A)^-1 (M (v0 + dt g) + J(v) - M v)
//
// A is measured rather than guessed: column k is the pressure force on the body when its
// degree of freedom k moves at unit speed through liquid at rest, one pressure solve per
// degree of freedom (FluidSim._response). Those pressure fields are kept, and for two reasons:
//
//   - The multigrid cycle converges slowly on water enclosed by thin walls (the coarse levels
//     cannot tell the two sides of a wall apart): two cycles from nothing find less than half
//     of the added mass of a hull with water in it, and Newton's method diverges on less than
//     half. Each field is the starting guess of its next solve instead, one degree of freedom
//     per step in turn, so the fields converge over the steps while the body moves little.
//   - The pressure is linear in the bodies' velocities, so the pressure that belongs to a
//     Newton step is known at once: p += sum of (change of degree of freedom k) * field k.
//     With that the last thing a step does is make the body's velocity and the pressure on
//     its surface agree exactly; what the fields lack shows up as a residual of the pressure
//     equation (a little divergence, which the density correction of the next step takes),
//     not as momentum that the body has and the liquid never gave.
//
// One iteration costs the solver the pass that sums the pressure over the bodies' surfaces
// (a few numbers, read back at once), the pass that adds the fields, and, if another
// iteration follows, a new right-hand side and a V-cycle.
//
// Contacts (with the ground, the walls, other bodies) are part of the iteration: every iterate
// is put through the contact solver before the liquid sees it.
//
// All quantities in cells and seconds, as in src/bodies.js. Masses are in units of the mass of
// a cell of liquid.
import { BODY_PARAMS, findContacts, solveContacts } from './bodies.js';
import { MAX_PRIMS } from './shaders/common.js';

export const COUPLE_PARAMS = {
  maxIter: 4,         // Newton iterations per step at most
  tol: 0.002,         // ... and until the velocities change by less than this (in units of g dt)
  cycles0: 2,         // V-cycles before the first iteration
  cycles: 1,          // V-cycles between iterations
  respCycles: 2,      // V-cycles of a response solve (added mass) that starts from the stored field
  respCycles0: 4,     // ... and of one that starts from nothing (a body that has just met the liquid)
  respPerStep: 1,     // response solves per step, in turn over the bodies in the liquid and their degrees of freedom (0: all of them, every step)
  relax: 1,           // share of each Newton step that is taken
  film: 600,          // [1/s] damping of the points of a body in the liquid that touch a solid nothing moves, in their motion towards and away from it
  filmGap: 0.3,       // [cells] ... which falls off with the distance d as (filmGap / (d + filmGap))^2, to nothing at BODY_PARAMS.near cells
};

const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Solve K x = r (K: n x n, row-major; both are overwritten). */
function solve(K, r, n) {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(K[i * n + c]) > Math.abs(K[piv * n + c])) piv = i;
    if (piv !== c) {
      for (let j = 0; j < n; j++) { const t = K[c * n + j]; K[c * n + j] = K[piv * n + j]; K[piv * n + j] = t; }
      const t = r[c]; r[c] = r[piv]; r[piv] = t;
    }
    const d = K[c * n + c] || 1e-30;
    for (let i = c + 1; i < n; i++) {
      const f = K[i * n + c] / d;
      if (!f) continue;
      for (let j = c; j < n; j++) K[i * n + j] -= f * K[c * n + j];
      r[i] -= f * r[c];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = r[i];
    for (let j = i + 1; j < n; j++) s -= K[i * n + j] * r[j];
    r[i] = s / (K[i * n + i] || 1e-30);
  }
  return r;
}

export class Coupler {
  constructor(dim, params = {}) {
    this.dim = dim;
    this.n = dim === 2 ? 3 : 6;         // degrees of freedom of a body: velocity, spin (2D: about z)
    this.params = { ...COUPLE_PARAMS, ...params };
    this.active = [];                   // the bodies of this step: { b, i: index of its primitive, vn, v, st }
    this.contacts = [];
    this.state = new Map();             // body -> { A: added mass matrix or null, P: the pressure fields it was measured with, next: degree of freedom to measure next, wet }
    this.turn = 0;
    this.spare = null;                  // a field to solve in
    this.trash = [];                    // fields of bodies that are gone
    this.version = -1;                  // the solver's fieldsVersion the fields belong to
    this.stats = { iterations: 0, change: 0, responses: 0, steps: 0, most: 0, unconverged: 0 };
  }

  // velocity and spin of a body as the vector of its degrees of freedom, and back
  _get(b) { return this.dim === 2 ? [b.vel[0], b.vel[1], b.omega[2]] : [...b.vel, ...b.omega]; }
  _set(b, v) {
    if (this.dim === 2) { b.vel = [v[0], v[1], 0]; b.omega = [0, 0, v[2]]; } else { b.vel = [v[0], v[1], v[2]]; b.omega = [v[3], v[4], v[5]]; }
  }
  // a measured force and torque (sums of -p grad W) as such a vector
  _wrench(f) { return this.dim === 2 ? [f.force[0], f.force[1], f.torque[2]] : [...f.force, ...f.torque]; }
  // M^-1 applied to such a vector (b.invInertia: per unit mass)
  _minv(b, w) {
    const m = b.density * b.volume;
    if (this.dim === 2) return [w[0] / m, w[1] / m, w[2] / (m * b.inertia[2])];
    const t = b.invInertia([w[3], w[4], w[5]]);
    return [w[0] / m, w[1] / m, w[2] / m, t[0] / m, t[1] / m, t[2] / m];
  }

  /**
   * The part of a step that comes before the liquid's: the bodies move with the velocities the
   * last step ended with, bodies that overlap are moved apart, and the velocities the liquid
   * step starts from are set (each body's as it would be if it accelerated as in the last step).
   * @param bodies   the rigid bodies (src/bodies.js); those that are kinematic or grabbed are moved, not solved for
   * @param statics  what they can touch that has no mass (as for stepBodies)
   * @param o        { dt, gravity, index: (body) => index of its primitive among the solver's solids }
   */
  begin(bodies, statics, o) {
    const { dt, gravity } = o;
    this.gravity = gravity;
    this.dt = dt;
    for (const b of bodies) {
      b.velPre = [...b.vel];
      b.omegaPre = [...b.omega];
      if (b.kinematic || !b.grabbed) continue;
      // (as in stepBodies: a grabbed body follows the pointer)
      let v = [0, 1, 2].map((k) => (b.target[k] - b.pos[k]) * 0.35 / dt);
      if (b.dim === 2) v[2] = 0;
      const lim = 0.45 / dt * Math.max(1, b.extent);
      if (len(v) > lim) v = v.map((x) => x * lim / len(v));
      b.vel = v;
      b.omega = b.omega.map((x) => x * 0.9);
    }
    for (const b of bodies) if (!b.scripted) b.integrate(dt);
    // (each body's `react` is that of the last step still: how it and the liquid answered an impulse then)
    this.contacts = findContacts(bodies, statics, true);
    this.active = [];
    for (const b of bodies) {
      if (b.kinematic || b.grabbed) { this._forget(b); b.react = null; if (b.grabbed) b.rested = false; continue; }
      let st = this.state.get(b);
      // (Body.rested: it was in balance when it was last solved, a body that slept. See World._sleep.)
      if (!st) this.state.set(b, (st = { A: null, next: 0, wet: 0, acc: b.rested ? new Array(this.n).fill(0) : null }));
      b.rested = false;
      const vn = this._get(b);
      // the first guess: the body accelerates as it did (at first: it falls, or stays at rest
      // if that is where it was. A hull that wakes with the guess that it falls is jolted:
      // the answers of the liquid, measured from nothing, are too small to take all of it back)
      const acc = st.acc || (this.dim === 2 ? [gravity[0], gravity[1], 0] : [gravity[0], gravity[1], gravity[2], 0, 0, 0]);
      const v = vn.map((x, k) => x + dt * acc[k]);
      this._set(b, v);
      this.active.push({ b, i: o.index(b), vn, v, st });
    }
    for (const b of [...this.state.keys()]) if (!bodies.includes(b)) this._forget(b);
    // (the first guess must not send a body into what it touches)
    if (this.contacts.length) {
      solveContacts(this.contacts);
      for (const e of this.active) e.v = this._get(e.b);
    }
    for (const e of this.active) e.v0 = [...e.v];
  }

  _forget(b) {
    const st = this.state.get(b);
    if (st && st.P) this.trash.push(...st.P);
    this.state.delete(b);
  }

  /** The fields of the solver as it is now: those of a grid that has been laid out anew are gone. */
  _fields(sim) {
    if (this.version !== sim.fieldsVersion || this.sim !== sim) {
      this.version = sim.fieldsVersion;
      this.sim = sim;
      this.spare = null;
      this.trash = [];
      for (const st of this.state.values()) { st.P = null; st.A = null; }
    }
    for (const t of this.trash) sim.dropField(t);
    this.trash = [];
    if (!this.spare) this.spare = sim.newField();
  }

  /**
   * The added mass of body e: the answers of the liquid to its degrees of freedom `dofs`, one
   * pressure solve of `cycles` V-cycles each, from the stored answer or (`zero`) from nothing.
   */
  _measure(sim, e, dofs, cycles, zero = false) {
    const n = this.n, st = e.st;
    if (!st.A) st.A = new Float64Array(n * n);
    if (!st.P) st.P = Array.from({ length: n }, () => sim.newField());
    const prims = sim.solids;
    for (const k of dofs) {
      const dV = new Float32Array(3 * MAX_PRIMS), dW = new Float32Array(3 * MAX_PRIMS);
      if (this.dim === 2) { if (k < 2) dV[3 * e.i + k] = 1; else dW[3 * e.i + 2] = 1; } else if (k < 3) dV[3 * e.i + k] = 1; else dW[3 * e.i + k - 3] = 1;
      if (zero) sim.glc.clear(st.P[k]);
      const pair = [st.P[k], this.spare];
      const done = sim._response(sim._usBody(0, dV, dW, 'usUnit'), cycles, pair);
      const f = this._wrench(sim.bodyForcesSync([prims[e.i]], false)[0]);
      done();
      st.P[k] = pair[0];
      this.spare = pair[1];
      for (let r = 0; r < n; r++) st.A[r * n + k] = -f[r];
      if (this.debug) console.log(`    response of body ${e.i} to ${k}: ${f.map((v) => v.toFixed(2)).join(' ')}  (wet ${e.wet}, step ${this.stats.steps})`);
      this.stats.responses++;
    }
  }

  /**
   * A as it is used: as measured (so that the forces after `p += fields` are the ones the
   * Newton step counted on), but with nothing negative on its diagonal.
   */
  _added(st) {
    const n = this.n, S = Float64Array.from(st.A);
    for (let r = 0; r < n; r++) S[r * n + r] = Math.max(S[r * n + r], 0);
    return S;
  }

  /**
   * The pressure solve of a step with the bodies' velocities as unknowns (called by
   * FluidSim._project once the matrix is built). Returns the texture of solid velocities the
   * pressure belongs to.
   */
  solve(sim, dt) {
    const P = this.params, n = this.n, dim = this.dim, g = this.gravity;
    const list = this.active;
    const prims = list.map((e) => sim.solids[e.i]);
    const glen = len(g) || 1;
    const tol = P.tol * glen * dt;
    const G = dim === 2 ? [g[0], g[1], 0] : [g[0], g[1], g[2], 0, 0, 0];
    const nl = dim === 2 ? 2 : 3;                  // how many of the degrees of freedom are velocities
    const BP = BODY_PARAMS;

    this._fields(sim);
    const every = [...Array(n).keys()];
    // added mass: one degree of freedom of one body per step, in turn
    const wetList = list.filter((e) => e.st.A && e.st.wet > 0);
    if (P.respPerStep === 0) for (const e of wetList) this._measure(sim, e, every, P.respCycles);
    else {
      for (let k = 0; k < P.respPerStep && wetList.length; k++) {
        const e = wetList[this.turn++ % wetList.length];
        this._measure(sim, e, [e.st.next], P.respCycles);
        e.st.next = (e.st.next + 1) % n;
      }
    }

    let us = sim.T.us;
    sim._rhs(dt, us);
    for (let i = 0; i < P.cycles0; i++) sim._vcycle(0);
    let iterations = 0, change = Infinity, before = Infinity, relax = P.relax;
    this.changes = [];                  // (per iteration, for diagnostics)
    for (let it = 0; it < P.maxIter; it++) {
      // (With the first: how much of each body is in the liquid and how the liquid around it
      // moves, for the drag. That velocity is the one this pressure leaves. As it stands before
      // the projection it carries the gravity of the step, which the pressure of water at rest
      // takes back: a body afloat would be dragged down by liquid that seems to fall.)
      const F = sim.bodyForcesSync(prims, it === 0, it === 0 ? sim._drawProject(us) : undefined);
      iterations++;
      list.forEach((e, j) => {
        if (it === 0) { e.wet = F[j].wet; e.fluidVel = F[j].fluidVel; }
        // a body that has just met the liquid: its added mass at once
        if (e.wet > 0 && (!e.st.A || !(e.st.wet > 0))) this._measure(sim, e, every, P.respCycles0, true);
        else if (e.wet > 0 && e.st.stale) this._measure(sim, e, every, P.respCycles);
        e.st.stale = false;
        if (!(e.wet > 0) && e.st.A) {
          e.st.A = null;
          if (e.st.P) this.trash.push(...e.st.P);
          e.st.P = null;
        }
        e.st.wet = e.wet;
      });
      for (const [j, e] of list.entries()) {
        const b = e.b, v = e.v;
        // drag (the solver is inviscid: see stepBodies), implicit: kd on the velocity relative to the liquid, cs on the spin
        const vf = e.fluidVel || [0, 0, 0];
        const vr = [v[0] - vf[0], v[1] - vf[1], dim === 2 ? 0 : v[2] - vf[2]];
        const kd = (e.wet * (BP.dragForm * len(vr) / Math.max(b.extent, 1) + BP.dragLinear)) / b.density;
        const cs = 0.2 + BP.dragSpin * e.wet;
        const J = this._minv(b, this._wrench(F[j]));
        const R = new Float64Array(n), K = new Float64Array(n * n);
        for (let k = 0; k < n; k++) {
          const lin = k < nl;
          R[k] = e.vn[k] + dt * G[k] + J[k] - v[k] - dt * (lin ? kd * (v[k] - vf[k]) : cs * v[k]);
          K[k * n + k] = 1 + dt * (lin ? kd : cs);
        }
        // The film of liquid between the body and a solid next to it is thinner than the grid
        // resolves. To close it the liquid in it has to leave sideways, many times faster than
        // the body comes down, and faster than the advection carries it: cells of it are
        // over-full in one step and empty in the next, with the pressure of the whole depth
        // above them or none, and what comes of that throws the body about. A wreck does not
        // lie still on the bed, it hops. A real film does the opposite: the narrower it is the
        // more it resists being squeezed out or drawn in, and that is where a body loses its
        // motion. So each point of the body's surface within BODY_PARAMS.near cells of a solid
        // that nothing moves (Body.film, from findContacts) is damped in its motion towards and
        // away from that solid, implicitly: forces -c_p (v_p . n) n at the points, the nearer
        // the stronger, which add up to m film for a body in the liquid that touches. (At the
        // points, not on the body as a whole: one that stands on a corner is free to turn
        // about it.)
        if (P.film > 0 && e.wet > 0 && (b.film || []).length) {
          const m = b.density * b.volume, far = (P.filmGap / (BP.near + P.filmGap)) ** 2;
          const share = (d) => Math.max(((P.filmGap / (d + P.filmGap)) ** 2 - far) / (1 - far), 0);   // 1 where they touch, 0 at BODY_PARAMS.near
          let sum = 1e-30, most = 0;
          for (const f of b.film) { f.s = share(f.d); sum += f.s; most = Math.max(most, f.s); }
          for (const f of b.film) {
            const c = dt * P.film * e.wet * most * f.s / sum;
            const r = [f.p[0] - b.pos[0], f.p[1] - b.pos[1], dim === 2 ? 0 : f.p[2] - b.pos[2]];
            const g = dim === 2 ? [f.n[0], f.n[1], r[0] * f.n[1] - r[1] * f.n[0]]
              : [f.n[0], f.n[1], f.n[2], r[1] * f.n[2] - r[2] * f.n[1], r[2] * f.n[0] - r[0] * f.n[2], r[0] * f.n[1] - r[1] * f.n[0]];
            const gi = this._minv(b, g).map((x) => x * m);
            let sp = 0;                       // how fast the point leaves the solid
            for (let k = 0; k < n; k++) sp += g[k] * v[k];
            for (let k = 0; k < nl; k++) sp -= f.vel[k] * f.n[k];
            for (let k = 0; k < n; k++) {
              R[k] -= c * sp * gi[k];
              for (let q = 0; q < n; q++) K[k * n + q] += c * gi[k] * g[q];
            }
          }
        }
        if (e.st.A) {
          const A = this._added(e.st);
          for (let c = 0; c < n; c++) {
            const col = this._minv(b, Array.from({ length: n }, (_, r) => A[r * n + c]));
            for (let r = 0; r < n; r++) K[r * n + c] += col[r];
          }
        }
        // K^-1: what is left of a change of the body's velocity once the liquid has answered it.
        // The contact solver needs it too (Body.react): an impulse from another body moves this
        // one as much as its own mass and the liquid's together allow.
        const Ki = new Float64Array(n * n);
        for (let c = 0; c < n; c++) {
          const col = new Float64Array(n);
          col[c] = 1;
          solve(Float64Array.from(K), col, n);
          for (let r = 0; r < n; r++) Ki[r * n + c] = col[r];
        }
        const mulK = (x) => Array.from({ length: n }, (_, r) => { let t = 0; for (let c = 0; c < n; c++) t += Ki[r * n + c] * x[c]; return t; });
        b.react = dim === 2
          ? (dv, dw) => { const o = mulK([dv[0], dv[1], dw[2]]); return [[o[0], o[1], 0], [0, 0, o[2]]]; }
          : (dv, dw) => { const o = mulK([...dv, ...dw]); return [o.slice(0, 3), o.slice(3)]; };
        const d = mulK(R);
        e.vNew = v.map((x, k) => x + relax * d[k]);
        this._set(b, e.vNew);
      }
      if (this.contacts.length) {
        solveContacts(this.contacts);
        for (const e of list) e.vNew = this._get(e.b);
      }
      // the pressure of the new velocities, as far as the stored answers know it
      const fields = [], coefs = [];
      change = 0;
      for (const e of list) {
        let c = 0;
        for (let k = 0; k < n; k++) {
          const d = e.vNew[k] - e.v[k];
          c = Math.max(c, Math.abs(d) * (k < nl ? 1 : Math.max(e.b.extent, 1)));
          if (e.st.P && d !== 0) { fields.push(e.st.P[k]); coefs.push(d); }
        }
        e.change = c;
        change = Math.max(change, c);
        e.v = e.vNew;
      }
      if (fields.length) sim.addToPressure(fields, coefs);
      const dV = new Float32Array(3 * MAX_PRIMS), dW = new Float32Array(3 * MAX_PRIMS);
      for (const e of list) {
        const d = e.v.map((x, k) => x - e.v0[k]);
        if (dim === 2) { dV.set([d[0], d[1], 0], 3 * e.i); dW.set([0, 0, d[2]], 3 * e.i); } else { dV.set(d.slice(0, 3), 3 * e.i); dW.set(d.slice(3), 3 * e.i); }
      }
      us = sim._usBody(1, dV, dW);
      this.changes.push(change);
      if (change < tol || it === P.maxIter - 1) break;
      // an iteration that moves the bodies more than the one before: the added mass is too
      // small somewhere. Shorter steps from here on, and the bodies that moved most are
      // measured afresh in the next step.
      if (change > before) {
        relax *= 0.5;
        for (const e of list) if (e.change > 0.5 * change) e.st.stale = true;
      }
      before = change;
      sim._rhs(dt, us);
      for (let i = 0; i < P.cycles; i++) sim._vcycle(0);
    }
    for (const e of list) {
      const b = e.b;
      this._set(b, e.v);
      e.st.acc = e.v.map((x, k) => (x - e.vn[k]) / dt);
      b.wet = e.wet;
      b.fluidVel = e.fluidVel;
      b.addedMatrix = e.st.A;       // for diagnostics
    }
    const S = this.stats;
    S.steps++;
    S.iterations += iterations;
    S.most = Math.max(S.most, iterations);
    S.change = change;
    if (change >= tol) S.unconverged++;
    return us;
  }
}
