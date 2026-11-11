// FluidSim: GPU (WebGL2) implementation of
//   N. Chentanez, M. Mueller, "Mass-Conserving Eulerian Liquid Simulation", SCA 2012.
// One code path serves 2D (nz = 1) and 3D (z-slices tiled into a 2D atlas).
//
// Time step (Algorithm 1):
//   1. velocity extrapolation            (Sec. 3.3)
//   2. density advection + sharpening    (Sec. 3.4, 3.5, 3.6)
//   3. velocity advection + forces
//   4. incompressibility                 (Sec. 3.7, multigrid of [CM11a])
import { simShaders } from './shaders/sim.js';
import { MAX_PRIMS } from './shaders/common.js';

export const DEFAULT_PARAMS = {
  dt: 1 / 60,            // time step [s]
  h: 0.05,               // cell size [m]
  gravity: [0, -10, 0],  // [m/s^2]

  // density advection (Sec. 3.4)
  advection: 1,          // 0 plain semi-Lagrangian (NOT conservative), 1 paper, 2 1/gamma row scale, 3 no gamma feedback
  traceSteps: 1,         // RK2 sub-steps per characteristic
  diffusionIters: 1,     // gamma diffusion sweeps per step ([LAF11] uses 1..7)
  diffusionPairs: 1,     // 1 = pairwise exchange as in [LAF11] (two passes per axis), 0 = both neighbours at once (Jacobi)
  diffusionLimit: 1,     // 1 = the exchange never moves liquid from an emptier cell into a fuller one
  kappa: 0.5,            // exchange factor (0.5 = the pair meets at its mean; Jacobi needs <= 0.25)

  // sharpening (Sec. 3.5)
  sharpen: 1,
  sharpenK: 3,           // fictitious time step Delta T = sharpenK * dt
  tau: 0.4,
  D: 2.1,                // max redistribution distance [cells]
  eps: 1e-5,

  // solids (Sec. 3.6)
  S: 1,                  // excess density is moved S cells out of the solid
  vthr: 0.1,             // cells with less non-solid volume take rho' from their neighbours
  closeSlivers: 1,       // faces between two such cells are closed (a sliver between two solids is not an air pocket)

  // pressure (Sec. 3.7)
  lambda: 0.5,
  eta: 1,
  compress: 0.1,         // extension: lambda_c, contraction rate of under-full interior liquid cells (0 = off, as in the paper)
  compressMax: 0.25,     // extension: eta_c
  separate: 1,           // separating solid boundary condition [CM11a]
  vcycles: 2,
  vcyclesBodies: 4,      // at least this many while rigid bodies feel the liquid (see FluidSim.twoWay)
  preSweeps: 2,
  postSweeps: 2,
  coarseSweeps: 12,
  thetaMin: 0.01,        // ghost-fluid clamp
  airLeak: 1,            // coarse levels keep the p = 0 condition of air pockets that averaging phi erases
  pminLevels: 3,         // "S" of [CM11a]
};

/** Atlas layout for an nx*ny*nz grid: z-slices tiled tx across. */
export function makeGrid(nx, ny, nz = 1) {
  let tx = 1;
  if (nz > 1) {
    let best = Infinity;
    for (let t = 1; t <= nz; t++) {
      if (nz % t) continue;
      const cost = Math.abs(Math.log((nx * t) / (ny * (nz / t))));
      if (cost < best) { best = cost; tx = t; }
    }
  }
  const ty = nz / tx;
  const w = nx * tx;
  const h = ny * ty;
  return { n: [nx, ny, nz], tx, ty, w, h, inv: [1 / w, 1 / h], cells: nx * ny * nz };
}

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** Rotation about z by `angle` as a column-major world->local matrix (transpose of local->world). */
export function rotZ(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/**
 * Pack primitives into uniform arrays.
 * prim = { type: 'ball'|'box', inverted, center:[x,y,z], radius | half:[x,y,z], round,
 *          rot: world->local mat3 (column-major), vel:[..], omega:[..] }   (grid units)
 */
export function packPrims(list, P, dim) {
  if (list.length > MAX_PRIMS) throw new Error(`too many primitives (${list.length} > ${MAX_PRIMS})`);
  const A = new Float32Array(4 * MAX_PRIMS);
  const B = new Float32Array(4 * MAX_PRIMS);
  const R = new Float32Array(9 * MAX_PRIMS);
  const V = new Float32Array(3 * MAX_PRIMS);
  const W = new Float32Array(3 * MAX_PRIMS);
  for (let i = 0; i < MAX_PRIMS; i++) R.set(IDENTITY3, 9 * i);
  list.forEach((p, i) => {
    const type = (p.type === 'ball' ? 1 : 2) * (p.inverted ? -1 : 1);
    A.set([p.center[0], p.center[1], dim === 2 ? 0.5 : p.center[2], type], 4 * i);
    if (p.type === 'ball') B.set([p.radius, 0, 0, 0], 4 * i);
    else B.set([p.half[0], p.half[1], dim === 2 ? 1e6 : p.half[2], p.round || 0], 4 * i);
    R.set(p.rot || IDENTITY3, 9 * i);
    const v = p.vel || [0, 0, 0];
    const w = p.omega || [0, 0, 0];
    V.set([v[0], v[1], dim === 2 ? 0 : v[2] || 0], 3 * i);
    W.set(dim === 2 ? [0, 0, w[2] || 0] : [w[0] || 0, w[1] || 0, w[2] || 0], 3 * i);
  });
  return { [`u${P}N`]: list.length, [`u${P}A`]: A, [`u${P}B`]: B, [`u${P}R`]: R, [`u${P}V`]: V, [`u${P}W`]: W };
}

export class FluidSim {
  constructor(glc, { dim = 2, nx, ny, nz = 1, params = {} }) {
    this.glc = glc;
    this.dim = dim;
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.time = 0;
    this.frame = 0;
    this.solids = [];
    // Set by the owner while rigid bodies are driven by the measured liquid forces. The liquid's
    // answer to a body's motion has to be in the pressure of the same step: what an unconverged
    // solve leaves out arrives a step late, and bodies that touch each other or a wall (where
    // the multigrid converges slowest) turn that delay into a hopping motion that never dies.
    this.twoWay = false;
    this.mouse = { pos: [0, 0, 0], vel: [0, 0, 0], dir: [0, 0, 0], radius: 0, strength: 0 };
    this._buildPrograms();
    this._buildGrid(nx, ny, dim === 2 ? 1 : nz);
  }

  // ------------------------------------------------------------------ setup
  _buildPrograms() {
    const glc = this.glc;
    const S = simShaders(this.dim, glc.floatLinear);
    const P = {};
    const fragmentPasses = ['solid', 'liq', 'extrapInit', 'extrapPull', 'extrapPush', 'advTrace',
      'advGather', 'advPlain', 'diffuse', 'sharpen', 'velAdvect', 'downsample', 'coef', 'rhs', 'smooth', 'restrict',
      'prolong', 'residual', 'project', 'stats', 'sourceRho', 'sourceVel'];
    for (const name of fragmentPasses) P[name] = glc.program(name, S[name]);
    P.scatterBeta = glc.program('scatterBeta', S.scatterFS, S.scatterBetaVS);
    P.scatterFwd = glc.program('scatterFwd', S.scatterFS, S.scatterFwdVS);
    P.scatterSharp = glc.program('scatterSharp', S.scatterFS, S.scatterSharpVS);
    P.bodyForce = glc.program('bodyForce', S.bodyForceFS, S.bodyForceVS);
    this.prog = P;
  }

  _buildGrid(nx, ny, nz) {
    const glc = this.glc;
    const dim = this.dim;
    // multigrid / extrapolation hierarchy
    const levels = [];
    let n = [nx, ny, nz];
    for (;;) {
      const grid = makeGrid(n[0], n[1], n[2]);
      if (grid.w > glc.maxTextureSize || grid.h > glc.maxTextureSize) throw new Error('grid too large for this GPU');
      levels.push({ grid });
      const active = dim === 2 ? [n[0], n[1]] : n;
      if (active.some((v) => v % 2 !== 0 || v / 2 < (this.params.coarsest || 2))) break;
      n = [n[0] / 2, n[1] / 2, dim === 2 ? 1 : n[2] / 2];
    }
    levels.forEach((L, l) => {
      const { w, h } = L.grid;
      L.W = glc.texture(w, h, 'rgba32f');
      L.liq = glc.texture(w, h, 'rg32f', { linear: l === 0 });
      L.cA = glc.texture(w, h, 'rgba32f');
      L.cB = glc.texture(w, h, 'rgba32f');
      L.p = [glc.texture(w, h, 'r32f'), glc.texture(w, h, 'r32f')];
      L.rhs = glc.texture(w, h, 'rg32f');
      L.exA = glc.texture(w, h, 'rgba32f');
      L.exB = glc.texture(w, h, 'rgba32f');
      if (l > 0) L.exF = glc.texture(w, h, 'rgba32f');
      glc.clear(L.p[0]);
      glc.clear(L.p[1]);
    });
    this.levels = levels;
    const g = (this.grid = levels[0].grid);
    const T = (this.T = {});
    T.vel = [glc.texture(g.w, g.h, 'rgba32f', { linear: true }), glc.texture(g.w, g.h, 'rgba32f', { linear: true })];
    T.rho = [glc.texture(g.w, g.h, 'rg32f', { linear: true }), glc.texture(g.w, g.h, 'rg32f', { linear: true })];
    T.sdf = glc.texture(g.w, g.h, 'rgba32f', { linear: true });
    T.us = glc.texture(g.w, g.h, 'rgba32f');
    T.frac = glc.texture(g.w, g.h, 'rgba32f');
    T.trace = glc.texture(g.w, g.h, 'rgba32f');
    T.beta = glc.texture(g.w, g.h, 'r32f');
    T.fwd = glc.texture(g.w, g.h, 'rgba32f');
    T.res = glc.texture(g.w, g.h, 'rg32f');
    this.statsBlock = g.cells > 70000 ? 8 : 4;
    const sw = Math.ceil(g.w / this.statsBlock);
    const sh = Math.ceil(g.h / this.statsBlock);
    T.stats = [glc.texture(sw, sh, 'rgba32f'), glc.texture(sw, sh, 'rgba32f')];
    T.force = [0, 1, 2].map(() => glc.texture(MAX_PRIMS, 1, 'rgba32f'));
    for (const t of [...T.vel, ...T.rho, T.res]) glc.clear(t);
    this.nc = dim === 2 ? 4 : 8;
    this.baseline = null;
    this.stats = null;
    this._statsBusy = false;
  }

  get vel() { return this.T.vel[0]; }
  get rho() { return this.T.rho[0]; }
  get liq() { return this.levels[0].liq; }
  get pressure() { return this.levels[0].p[0]; }
  _swap(pair) { const t = pair[0]; pair[0] = pair[1]; pair[1] = t; }

  // ------------------------------------------------------------------ scene state
  /** Replace the solid primitives (grid units); they take effect at the next step(). */
  setSolids(list) {
    this.solids = list;
  }

  _updateSolids() {
    const { glc, prog: P, T, grid: G } = this;
    glc.draw(P.solid, [T.sdf, T.us, T.frac, this.levels[0].W], { G, uVthr: this.params.closeSlivers ? this.params.vthr : 0, ...packPrims(this.solids, 'S', this.dim) });
  }

  _computeLiq() {
    const { glc, prog: P, T, grid: G } = this;
    glc.draw(P.liq, this.levels[0].liq, { G, uRho: T.rho[0], uFrac: T.frac, uVthr: this.params.vthr });
  }

  /** Initialise the liquid from primitives (grid units, with velocities). */
  reset(solids, liquid) {
    const { glc, prog: P, T, grid: G } = this;
    this.setSolids(solids);
    this._updateSolids();
    const L = packPrims(liquid, 'L', this.dim);
    glc.draw(P.sourceRho, T.rho[1], { G, ...L, uRho: T.rho[0], uFrac: T.frac, uOp: 0 });
    this._swap(T.rho);
    glc.draw(P.sourceVel, T.vel[1], { G, ...L, uVel: T.vel[0], uOp: 0 });
    this._swap(T.vel);
    for (const lv of this.levels) { glc.clear(lv.p[0]); glc.clear(lv.p[1]); }
    glc.clear(T.res);
    this._computeLiq();
    this.time = 0;
    this.frame = 0;
    this.baseline = null;
    this.stats = null;
    this.rebaseline = true;
  }

  /** Add (op = 1) or remove (op = 2) liquid inside primitives; added liquid gets their velocity. */
  editLiquid(prims, op = 1) {
    const { glc, prog: P, T, grid: G } = this;
    const L = packPrims(prims, 'L', this.dim);
    glc.draw(P.sourceRho, T.rho[1], { G, ...L, uRho: T.rho[0], uFrac: T.frac, uOp: op });
    this._swap(T.rho);
    if (op === 1) {
      glc.draw(P.sourceVel, T.vel[1], { G, ...L, uVel: T.vel[0], uOp: 1 });
      this._swap(T.vel);
    }
    this._computeLiq();
    this.rebaseline = true;
  }

  // ------------------------------------------------------------------ time step
  step() {
    const p = this.params;
    this._extrapolate();
    this._updateSolids();
    if (p.advection === 0) this._advectDensityPlain(p.dt);
    else this._advectDensity(p.dt);
    this._sharpen(p.dt);
    this._advectVelocity(p.dt);
    this._project(p.dt);
    this.time += p.dt;
    this.frame++;
  }

  // 1. velocity extrapolation -------------------------------------------------
  _extrapolate() {
    const { glc, prog: P, T, levels: L } = this;
    glc.draw(P.extrapInit, [L[0].exA, L[0].exB], { G: L[0].grid, uVel: T.vel[0], uLiq: L[0].liq, uW: L[0].W });
    for (let l = 1; l < L.length; l++) {
      glc.draw(P.extrapPull, [L[l].exA, L[l].exB], { G: L[l].grid, GF: L[l - 1].grid, uA: L[l - 1].exA, uB: L[l - 1].exB });
    }
    const top = L.length - 1;
    if (top === 0) {
      glc.draw(P.extrapPush, T.vel[1], { G: L[0].grid, GC: L[0].grid, uA: L[0].exA, uB: L[0].exB, uFc: L[0].exA, uTop: 1 });
    } else {
      glc.draw(P.extrapPush, L[top].exF, { G: L[top].grid, GC: L[top].grid, uA: L[top].exA, uB: L[top].exB, uFc: L[top].exA, uTop: 1 });
      for (let l = top - 1; l >= 0; l--) {
        glc.draw(P.extrapPush, l === 0 ? T.vel[1] : L[l].exF,
          { G: L[l].grid, GC: L[l + 1].grid, uA: L[l].exA, uB: L[l].exB, uFc: L[l + 1].exF, uTop: 0 });
      }
    }
    this._swap(T.vel);
  }

  // 2a. conservative density advection -----------------------------------------
  _advectDensity(dt) {
    const { glc, prog: P, T, grid: G, params: p } = this;
    const count = G.cells * this.nc;
    const tr = { uVel: T.vel[0], uSdf: T.sdf, uTraceSteps: p.traceSteps };
    glc.draw(P.advTrace, T.trace, { G, ...tr, uRho: T.rho[0], uFrac: T.frac, uDt: dt, uMode: p.advection });
    glc.scatter(P.scatterBeta, T.beta, { G, uSrc: T.trace }, count, { clear: true });
    glc.draw(P.advGather, [T.rho[1], T.fwd],
      { G, ...tr, uRho: T.rho[0], uTraceTex: T.trace, uBeta: T.beta, uFrac: T.frac, uDt: dt });
    glc.scatter(P.scatterFwd, T.rho[1], { G, uSrc: T.fwd, uRho: T.rho[0], uFrac: T.frac }, count);
    this._swap(T.rho);
    const pairs = p.diffusionPairs ? [0, 1] : [-1];
    for (let it = 0; it < p.diffusionIters; it++) {
      for (let axis = 0; axis < this.dim; axis++) {
        for (const pair of pairs) {
          glc.draw(P.diffuse, T.rho[1],
            { G, uRho: T.rho[0], uFrac: T.frac, uAxis: axis, uPair: pair, uLimit: p.diffusionLimit, uKappa: p.kappa });
          this._swap(T.rho);
        }
      }
    }
  }

  _advectDensityPlain(dt) {
    const { glc, prog: P, T, grid: G, params: p } = this;
    glc.draw(P.advPlain, T.rho[1],
      { G, uVel: T.vel[0], uSdf: T.sdf, uTraceSteps: p.traceSteps, uRho: T.rho[0], uFrac: T.frac, uDt: dt });
    this._swap(T.rho);
  }

  // 2b. sharpening + solid excess ----------------------------------------------
  _sharpen(dt) {
    const { glc, prog: P, T, grid: G, params: p } = this;
    this._computeLiq();
    glc.draw(P.sharpen, [T.rho[1], T.fwd], {
      G, uSdf: T.sdf, uRho: T.rho[0], uLiq: this.levels[0].liq, uFrac: T.frac,
      uCs: (p.sharpenK * dt) / p.h, uTau: p.tau, uD: p.D, uS: p.S, uEps: p.eps, uSharpen: p.sharpen,
    });
    glc.scatter(P.scatterSharp, T.rho[1], { G, uSrc: T.fwd, uFrac: T.frac }, G.cells * this.nc);
    this._swap(T.rho);
    this._computeLiq();
  }

  // 3. velocity advection + forces ---------------------------------------------
  _advectVelocity(dt) {
    const { glc, prog: P, T, grid: G, params: p, mouse: m } = this;
    const g = p.gravity;
    glc.draw(P.velAdvect, T.vel[1], {
      G, uVel: T.vel[0], uTraceSteps: p.traceSteps, uDt: dt,
      uGravity: [g[0] / p.h, g[1] / p.h, this.dim === 2 ? 0 : g[2] / p.h],
      uMouse: [m.pos[0], m.pos[1], m.pos[2], m.radius],
      uMouseVel: [m.vel[0], m.vel[1], m.vel[2], m.strength],
      uMouseDir: m.dir,
    });
    this._swap(T.vel);
  }

  // 4. pressure projection ------------------------------------------------------
  _smooth(l, sweeps) {
    const { glc, prog: P } = this;
    const L = this.levels[l];
    for (let i = 0; i < sweeps; i++) {
      for (let color = 0; color < 2; color++) {
        glc.draw(P.smooth, L.p[1], { G: L.grid, uP: L.p[0], uRhs: L.rhs, uCA: L.cA, uCB: L.cB, uColor: color });
        this._swap(L.p);
      }
    }
  }

  _vcycle(l) {
    const { glc, prog: P, params: p, levels } = this;
    const L = levels[l];
    if (l === levels.length - 1) { this._smooth(l, p.coarseSweeps); return; }
    const C = levels[l + 1];
    this._smooth(l, p.preSweeps);
    glc.draw(P.restrict, C.rhs,
      { G: C.grid, GF: L.grid, uP: L.p[0], uRhs: L.rhs, uCA: L.cA, uCB: L.cB, uUsePmin: l < p.pminLevels ? 1 : 0 });
    glc.clear(C.p[0]);
    this._vcycle(l + 1);
    glc.draw(P.prolong, L.p[1], { G: L.grid, GC: C.grid, uP: L.p[0], uPc: C.p[0], uCA: L.cA });
    this._swap(L.p);
    this._smooth(l, p.postSweeps);
  }

  /** Matrix coefficients on every level of the hierarchy, from the current liquid and solids. */
  _buildMatrix() {
    const { glc, prog: P, levels, params: p } = this;
    const invThetaMax = 1 / p.thetaMin;
    const L0 = levels[0];
    // (the finer-level inputs are unused on level 0; any texture that is not a target of the pass will do)
    glc.draw(P.coef, [L0.cA, L0.cB], {
      G: L0.grid, uLiq: L0.liq, uW: L0.W, uInvThetaMax: invThetaMax,
      uCoarse: 0, GF: L0.grid, uLiqF: L0.liq, uWF: L0.W, uCBF: L0.exB,
    });
    for (let l = 1; l < levels.length; l++) {
      const L = levels[l];
      const F = levels[l - 1];
      glc.draw(P.downsample, [L.liq, L.W], { G: L.grid, GF: F.grid, uLiqF: F.liq, uWF: F.W });
      glc.draw(P.coef, [L.cA, L.cB], {
        G: L.grid, uLiq: L.liq, uW: L.W, uInvThetaMax: invThetaMax,
        uCoarse: p.airLeak, GF: F.grid, uLiqF: F.liq, uWF: F.W, uCBF: F.cB,
      });
    }
  }

  _project(dt) {
    const { glc, prog: P, T, levels, params: p } = this;
    const invThetaMax = 1 / p.thetaMin;
    const L0 = levels[0];
    this._buildMatrix();
    glc.draw(P.rhs, L0.rhs, {
      G: L0.grid, uVel: T.vel[0], uUs: T.us, uW: L0.W, uLiq: L0.liq, uSdf: T.sdf,
      uSrcScale: p.lambda / dt, uSrcMax: p.eta / dt, uSinkScale: p.compress / dt, uSinkMax: p.compressMax / dt,
      uSeparate: p.separate,
    });
    const cycles = this.twoWay ? Math.max(p.vcycles, p.vcyclesBodies) : p.vcycles;
    for (let i = 0; i < cycles; i++) this._vcycle(0);
    glc.draw(P.project, T.vel[1],
      { G: L0.grid, uVel: T.vel[0], uUs: T.us, uW: L0.W, uLiq: L0.liq, uP: L0.p[0], uInvThetaMax: invThetaMax });
    this._swap(T.vel);
  }

  // ------------------------------------------------------------------ diagnostics
  _drawStats() {
    const { glc, prog: P, T, levels } = this;
    const L0 = levels[0];
    glc.draw(P.residual, T.res, { G: L0.grid, uP: L0.p[0], uRhs: L0.rhs, uCA: L0.cA, uCB: L0.cB });
    glc.draw(P.stats, T.stats, { G: L0.grid, uRho: T.rho[0], uLiq: L0.liq, uVel: T.vel[0], uRes: T.res, uB: this.statsBlock });
  }

  _reduceStats(a, b) {
    let mass = 0, vol = 0, res = 0, rhs = 0, gmin = Infinity, gmax = -Infinity, vmax = 0, rmax = 0;
    for (let i = 0; i < a.length; i += 4) {
      mass += a[i]; vol += a[i + 1]; res += a[i + 2]; rhs += a[i + 3];
      if (b[i] < gmin) gmin = b[i];
      if (b[i + 1] > gmax) gmax = b[i + 1];
      if (b[i + 2] > vmax) vmax = b[i + 2];
      if (b[i + 3] > rmax) rmax = b[i + 3];
    }
    const s = { mass, volume: vol, residual: rhs > 0 ? res / rhs : 0, gammaMin: gmin, gammaMax: gmax, maxSpeed: vmax, maxRhoP: rmax,
      time: this.time, frame: this.frame };
    if (this.rebaseline || !this.baseline) { this.baseline = { mass, volume: vol }; this.rebaseline = false; }
    s.massRatio = this.baseline.mass > 0 ? mass / this.baseline.mass : 1;
    s.volumeRatio = this.baseline.volume > 0 ? vol / this.baseline.volume : 1;
    s.cfl = vmax * this.params.dt;
    this.stats = s;
    return s;
  }

  /** Blocking statistics readback (tests / tooling). */
  measureSync() {
    this._drawStats();
    return this._reduceStats(this.glc.read(this.T.stats[0]), this.glc.read(this.T.stats[1]));
  }

  /** Non-blocking statistics; resolves with the stats object (also stored in this.stats). */
  async measure() {
    if (this._statsBusy) return this.stats;
    this._statsBusy = true;
    try {
      this._drawStats();
      const [a, b] = await Promise.all([this.glc.readAsync(this.T.stats[0]), this.glc.readAsync(this.T.stats[1])]);
      return this._reduceStats(a, b);
    } finally {
      this._statsBusy = false;
    }
  }

  /**
   * Pressure force/torque on rigid bodies. `prims` are the bodies' solver primitives.
   * Resolves to [{ force:[3], torque:[3], wet, fluidVel:[3] }] in solver units: sum of -p * grad(W)
   * (force), r x force (torque), the fraction of the body's surface band that lies in liquid and
   * the mean liquid velocity over that wet band.
   */
  async measureBodyForces(prims) {
    const { glc, prog: P, T, grid: G } = this;
    if (this._forceBusy || prims.length === 0) return null;
    this._forceBusy = true;
    try {
      glc.scatter(P.bodyForce, T.force,
        { G, uP: this.levels[0].p[0], uLiq: this.levels[0].liq, uVel: T.vel[0], uSlots: MAX_PRIMS, ...packPrims(prims, 'B', this.dim) },
        G.cells, { clear: true });
      const [a, b, c] = await Promise.all(T.force.map((tex) => glc.readAsync(tex)));
      // the weights are sums of O(1) terms: "none" is tested against a threshold because some
      // browsers return zeros with their last bits flipped (see GLContext._testReadback)
      const NONE = 1e-6;
      return prims.map((_, i) => {
        const w = c[4 * i + 3];
        return {
          force: [a[4 * i], a[4 * i + 1], a[4 * i + 2]],
          torque: [b[4 * i], b[4 * i + 1], b[4 * i + 2]],
          wet: a[4 * i + 3] > NONE ? b[4 * i + 3] / a[4 * i + 3] : 0,
          fluidVel: w > NONE ? [c[4 * i] / w, c[4 * i + 1] / w, c[4 * i + 2] / w] : [0, 0, 0],
        };
      });
    } finally {
      this._forceBusy = false;
    }
  }

  dispose() {
    const glc = this.glc;
    const all = [...this.T.vel, ...this.T.rho, this.T.sdf, this.T.us, this.T.frac, this.T.trace, this.T.beta, this.T.fwd,
      this.T.res, ...this.T.stats, ...this.T.force];
    for (const L of this.levels) all.push(L.W, L.liq, L.cA, L.cB, ...L.p, L.rhs, L.exA, L.exB, L.exF);
    for (const t of all) glc.deleteTexture(t);
  }
}
