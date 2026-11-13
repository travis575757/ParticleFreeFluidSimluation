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
import { MAX_PRIMS, MAX_HULLS } from './shaders/common.js';

export const DEFAULT_PARAMS = {
  dt: 1 / 60,            // time step [s]
  h: 0.05,               // cell size [m]
  gravity: [0, -10, 0],  // [m/s^2]

  // density advection (Sec. 3.4)
  advection: 1,          // 0 plain semi-Lagrangian (NOT conservative), 1 paper, 2 1/gamma row scale, 3 no gamma feedback
  traceSteps: 1,         // RK2 sub-steps per characteristic
  pushRel: 0,            // 1 = a characteristic may end as deep in a solid as it began (TRACE_REL in shaders/common.js): with
                         //     sliverSide, a pool stays at rest around a solid that crosses its surface. Both are fixed
                         //     when the solver is built, like manualFilter.
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
  sliverSide: 0,         // 1 = such a cell takes rho' from the cells beside it; from those above and below only if there are none (see pass "liq")

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

  // 1 = interpolate in the shader with exact weights instead of the GPU's texture filtering (which
  // rounds the weights to 8 bits). Slower; the reference the sparse solver is compared against.
  manualFilter: 0,

  // 1 = the density advection takes a source cell's capacity from before the solids moved in
  // this step (the capacity its density belongs to) instead of the new one. Off: as printed.
  oldCapacity: 0,
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
  // distance fields on a lattice (type 'sdf', src/world/hull.js; only programs built with them know these)
  const HN = new Int32Array(4 * MAX_HULLS);
  const out = {};
  let hulls = 0;
  list.forEach((p, i) => {
    const type = (p.type === 'ball' ? 1 : p.type === 'sdf' ? (p.shell ? 4 : 3) : 2) * (p.inverted ? -1 : 1);
    A.set([p.center[0], p.center[1], dim === 2 ? 0.5 : p.center[2], type], 4 * i);
    if (p.type === 'ball') B.set([p.radius, 0, 0, 0], 4 * i);
    else if (p.type === 'sdf') {
      if (hulls >= MAX_HULLS) throw new Error(`too many bodies with a distance field of their own (more than ${MAX_HULLS})`);
      B.set([p.half[0], p.half[1], dim === 2 ? 1e6 : p.half[2], hulls], 4 * i);
      HN.set(p.lattice.n, 4 * hulls);
      out[`u${P}H${hulls}`] = p.lattice.tex;
      hulls++;
    } else B.set([p.half[0], p.half[1], dim === 2 ? 1e6 : p.half[2], p.round || 0], 4 * i);
    R.set(p.rot || IDENTITY3, 9 * i);
    const v = p.vel || [0, 0, 0];
    const w = p.omega || [0, 0, 0];
    V.set([v[0], v[1], dim === 2 ? 0 : v[2] || 0], 3 * i);
    W.set(dim === 2 ? [0, 0, w[2] || 0] : [w[0] || 0, w[1] || 0, w[2] || 0], 3 * i);
  });
  return { [`u${P}N`]: list.length, [`u${P}A`]: A, [`u${P}B`]: B, [`u${P}R`]: R, [`u${P}V`]: V, [`u${P}W`]: W, [`u${P}HN`]: HN, ...out };
}

export class FluidSim {
  constructor(glc, options) {
    const { dim = 2, nx, ny, nz = 1, params = {}, backend = 'dense' } = options;
    this.glc = glc;
    this.dim = dim;
    this.backend = backend;
    this.options = options;
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.time = 0;
    this.frame = 0;
    this.solids = [];
    // Set by the owner while rigid bodies are driven by the measured liquid forces. The liquid's
    // answer to a body's motion has to be in the pressure of the same step: what an unconverged
    // solve leaves out arrives a step late, and bodies that touch each other or a wall (where
    // the multigrid converges slowest) turn that delay into a hopping motion that never dies.
    this.twoWay = false;
    // Set by the owner while rigid bodies and the liquid are solved together (src/couple.js):
    // the pressure solve then finds the bodies' velocities along with the pressure.
    this.coupler = null;
    this._scr = {};
    this.fields = new Set();        // textures like the pressure's that the coupler keeps (newField)
    this.fieldsVersion = 0;
    this.mouse = { pos: [0, 0, 0], vel: [0, 0, 0], dir: [0, 0, 0], radius: 0, strength: 0 };
    this._buildPrograms();
    this._buildGrid(nx, ny, dim === 2 ? 1 : nz);
  }

  // ------------------------------------------------------------------ setup
  _buildPrograms() {
    const glc = this.glc;
    const S = simShaders(this.dim, glc.floatLinear && !this.params.manualFilter, this.backend,
      { pushRel: this.params.pushRel, sliverSide: this.params.sliverSide });
    const vs = this._passVS();
    const P = {};
    const fragmentPasses = ['solid', 'liq', 'extrapInit', 'extrapPull', 'extrapPush', 'advTrace',
      'advGather', 'advPlain', 'diffuse', 'sharpen', 'velAdvect', 'downsample', 'coef', 'rhs', 'smooth', 'restrict',
      'prolong', 'residual', 'project', 'sourceRho', 'sourceVel', 'usBody', 'rhsBody', 'combine', 'keep'];
    for (const name of fragmentPasses) P[name] = glc.program(name, S[name], vs);
    P.stats = glc.program('stats', S.stats);
    P.scatterBeta = glc.program('scatterBeta', S.scatterFS, S.scatterBetaVS);
    P.scatterFwd = glc.program('scatterFwd', S.scatterFS, S.scatterFwdVS);
    P.scatterSharp = glc.program('scatterSharp', S.scatterFS, S.scatterSharpVS);
    P.bodyForce = glc.program('bodyForce', S.bodyForceFS, S.bodyForceVS);
    this.prog = P;
  }

  // How the passes reach the grid. The sparse solver (src/world/sparsesim.js) overrides these.
  /** Vertex shader of the per-cell fragment passes (null = one triangle over the whole target). */
  _passVS() { return null; }
  /** Grid uniforms of a pass on level L that also reads level L2 (the next finer or coarser one). */
  _U(L, L2 = L) { return { G: L.grid, GF: L2.grid, GC: L2.grid }; }
  /** Per-cell fragment pass over every cell of level L. */
  _draw(p, target, L, uniforms, L2 = L) { this.glc.draw(p, target, { ...this._U(L, L2), ...uniforms }); }
  /** Scatter pass with `perCell` points for every cell of level L. */
  _scatter(p, target, L, uniforms, perCell, opts) {
    this.glc.scatter(p, target, { ...this._U(L), ...uniforms }, L.grid.cells * perCell, opts);
  }

  /** Textures of multigrid level l (L.grid must be set). */
  _allocLevel(L, l) {
    const glc = this.glc;
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
  }

  /** Textures that only exist on the finest level. */
  _allocFields(g) {
    const glc = this.glc;
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
    this.nc = this.dim === 2 ? 4 : 8;
    this.baseline = null;
    this.stats = null;
    this._statsBusy = false;
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
    levels.forEach((L, l) => this._allocLevel(L, l));
    this.levels = levels;
    this.nlev = levels.length;       // levels in use
    this.grid = levels[0].grid;
    this._allocFields(this.grid);
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
    const { prog: P, T } = this;
    const L0 = this.levels[0];
    this._draw(P.solid, [T.sdf, T.us, T.frac, L0.W], L0,
      { uVthr: this.params.closeSlivers ? this.params.vthr : 0, ...this._prims(this.solids, 'S'), ...this._solidUniforms() });
  }

  /** The uniforms of a list of primitives for the programs that name them `P`. */
  _prims(list, P) { return packPrims(list, P, this.dim); }
  /** What the backend adds to the solids (the sparse one: a terrain). */
  _solidUniforms() { return {}; }
  /** What the backend adds to the matrix coefficients of level l ... */
  _coefUniforms(l) { return {}; }
  /** ... and to the right-hand side and the velocity update. */
  _projectUniforms() { return {}; }
  /** Called once the density of the step is final (the sparse backend resets its held bricks here). */
  _afterDensity() {}

  _computeLiq() {
    const { prog: P, T } = this;
    const L0 = this.levels[0];
    this._draw(P.liq, L0.liq, L0, { uRho: T.rho[0], uFrac: T.frac, uVthr: this.params.vthr });
  }

  /** Initialise the liquid from primitives (grid units, with velocities). */
  reset(solids, liquid) {
    const { glc, prog: P, T } = this;
    const L0 = this.levels[0];
    this.setSolids(solids);
    this._updateSolids();
    const L = this._prims(liquid, 'L');
    this._draw(P.sourceRho, T.rho[1], L0, { ...L, uRho: T.rho[0], uFrac: T.frac, uOp: 0 });
    this._swap(T.rho);
    this._draw(P.sourceVel, T.vel[1], L0, { ...L, uVel: T.vel[0], uOp: 0 });
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
    const { prog: P, T } = this;
    const L0 = this.levels[0];
    const L = this._prims(prims, 'L');
    this._draw(P.sourceRho, T.rho[1], L0, { ...L, uRho: T.rho[0], uFrac: T.frac, uOp: op });
    this._swap(T.rho);
    if (op === 1) {
      this._draw(P.sourceVel, T.vel[1], L0, { ...L, uVel: T.vel[0], uOp: 1 });
      this._swap(T.vel);
    }
    this._computeLiq();
    this.rebaseline = true;
  }

  // ------------------------------------------------------------------ time step
  step() {
    const p = this.params;
    this._extrapolate();
    this._keepCapacity();
    this._updateSolids();
    if (p.advection === 0) this._advectDensityPlain(p.dt);
    else this._advectDensity(p.dt);
    this._sharpen(p.dt);
    this._afterDensity();
    this._advectVelocity(p.dt);
    this._project(p.dt);
    this.time += p.dt;
    this.frame++;
  }

  // 1. velocity extrapolation -------------------------------------------------
  _extrapolate() {
    const { prog: P, T, levels: L } = this;
    this._draw(P.extrapInit, [L[0].exA, L[0].exB], L[0], { uVel: T.vel[0], uLiq: L[0].liq, uW: L[0].W });
    for (let l = 1; l < this.nlev; l++) {
      this._draw(P.extrapPull, [L[l].exA, L[l].exB], L[l], { uA: L[l - 1].exA, uB: L[l - 1].exB }, L[l - 1]);
    }
    const top = this.nlev - 1;
    if (top === 0) {
      this._draw(P.extrapPush, T.vel[1], L[0], { uA: L[0].exA, uB: L[0].exB, uFc: L[0].exA, uTop: 1 });
    } else {
      this._draw(P.extrapPush, L[top].exF, L[top], { uA: L[top].exA, uB: L[top].exB, uFc: L[top].exA, uTop: 1 });
      for (let l = top - 1; l >= 0; l--) {
        this._draw(P.extrapPush, l === 0 ? T.vel[1] : L[l].exF, L[l], { uA: L[l].exA, uB: L[l].exB, uFc: L[l + 1].exF, uTop: 0 }, L[l + 1]);
      }
    }
    this._swap(T.vel);
  }

  /** params.oldCapacity: the solid fractions as they are before the solid pass of this step. */
  _keepCapacity() {
    const T = this.T;
    this._fracOld = null;
    if (!this.params.oldCapacity) return;
    const old = this._scratch('fracOld', T.frac);
    // (fractions that no solid pass has written yet, after the grid was laid out anew: as printed, for this step)
    if (this._fracNew !== T.frac) { this._fracNew = T.frac; return; }
    this._draw(this.prog.keep, old, this.levels[0], { uSrc: T.frac });
    this._fracOld = old;
  }

  // 2a. conservative density advection -----------------------------------------
  _advectDensity(dt) {
    const { prog: P, T, params: p } = this;
    const L0 = this.levels[0];
    const tr = { uVel: T.vel[0], uSdf: T.sdf, uTraceSteps: p.traceSteps };
    const old = this._fracOld || T.frac;
    this._draw(P.advTrace, T.trace, L0, { ...tr, uRho: T.rho[0], uFrac: T.frac, uFracOld: old, uDt: dt, uMode: p.advection });
    this._scatter(P.scatterBeta, T.beta, L0, { uSrc: T.trace }, this.nc, { clear: true });
    this._draw(P.advGather, [T.rho[1], T.fwd], L0,
      { ...tr, uRho: T.rho[0], uTraceTex: T.trace, uBeta: T.beta, uFrac: T.frac, uFracOld: old, uDt: dt });
    this._scatter(P.scatterFwd, T.rho[1], L0, { uSrc: T.fwd, uRho: T.rho[0], uFrac: T.frac, uFracOld: old }, this.nc);
    this._swap(T.rho);
    const pairs = p.diffusionPairs ? [0, 1] : [-1];
    for (let it = 0; it < p.diffusionIters; it++) {
      for (let axis = 0; axis < this.dim; axis++) {
        for (const pair of pairs) {
          this._draw(P.diffuse, T.rho[1], L0,
            { uRho: T.rho[0], uFrac: T.frac, uAxis: axis, uPair: pair, uLimit: p.diffusionLimit, uKappa: p.kappa });
          this._swap(T.rho);
        }
      }
    }
  }

  _advectDensityPlain(dt) {
    const { prog: P, T, params: p } = this;
    this._draw(P.advPlain, T.rho[1], this.levels[0],
      { uVel: T.vel[0], uSdf: T.sdf, uTraceSteps: p.traceSteps, uRho: T.rho[0], uFrac: T.frac, uDt: dt });
    this._swap(T.rho);
  }

  // 2b. sharpening + solid excess ----------------------------------------------
  _sharpen(dt) {
    const { prog: P, T, params: p } = this;
    const L0 = this.levels[0];
    this._computeLiq();
    this._draw(P.sharpen, [T.rho[1], T.fwd], L0, {
      uVel: T.vel[0], uTraceSteps: p.traceSteps,
      uSdf: T.sdf, uRho: T.rho[0], uLiq: L0.liq, uFrac: T.frac,
      uCs: (p.sharpenK * dt) / p.h, uTau: p.tau, uD: p.D, uS: p.S, uEps: p.eps, uSharpen: p.sharpen,
    });
    this._scatter(P.scatterSharp, T.rho[1], L0, { uSrc: T.fwd, uFrac: T.frac }, this.nc);
    this._swap(T.rho);
    this._computeLiq();
  }

  // 3. velocity advection + forces ---------------------------------------------
  _advectVelocity(dt) {
    const { prog: P, T, params: p, mouse: m } = this;
    const g = p.gravity;
    this._draw(P.velAdvect, T.vel[1], this.levels[0], {
      uVel: T.vel[0], uTraceSteps: p.traceSteps, uDt: dt,
      uGravity: [g[0] / p.h, g[1] / p.h, this.dim === 2 ? 0 : g[2] / p.h],
      uMouse: [m.pos[0], m.pos[1], m.pos[2], m.radius],
      uMouseVel: [m.vel[0], m.vel[1], m.vel[2], m.strength],
      uMouseDir: m.dir,
    });
    this._swap(T.vel);
  }

  // 4. pressure projection ------------------------------------------------------
  _smooth(l, sweeps) {
    const { prog: P } = this;
    const L = this.levels[l];
    for (let i = 0; i < sweeps; i++) {
      for (let color = 0; color < 2; color++) {
        this._draw(P.smooth, L.p[1], L, { uP: L.p[0], uRhs: L.rhs, uCA: L.cA, uCB: L.cB, uColor: color });
        this._swap(L.p);
      }
    }
  }

  _vcycle(l) {
    const { glc, prog: P, params: p, levels } = this;
    const L = levels[l];
    if (l === this.nlev - 1) { this._smooth(l, p.coarseSweeps); return; }
    const C = levels[l + 1];
    this._smooth(l, p.preSweeps);
    this._draw(P.restrict, C.rhs, C,
      { uP: L.p[0], uRhs: L.rhs, uCA: L.cA, uCB: L.cB, uUsePmin: l < p.pminLevels ? 1 : 0 }, L);
    glc.clear(C.p[0]);
    this._vcycle(l + 1);
    this._draw(P.prolong, L.p[1], L, { uP: L.p[0], uPc: C.p[0], uLiqC: C.liq, uCA: L.cA }, C);
    this._swap(L.p);
    this._smooth(l, p.postSweeps);
  }

  /** Matrix coefficients on every level of the hierarchy, from the current liquid and solids. */
  _buildMatrix() {
    const { prog: P, levels, params: p } = this;
    const invThetaMax = 1 / p.thetaMin;
    const L0 = levels[0];
    // (the finer-level inputs are unused on level 0; any texture that is not a target of the pass will do)
    this._draw(P.coef, [L0.cA, L0.cB], L0, {
      uLiq: L0.liq, uW: L0.W, uInvThetaMax: invThetaMax,
      uCoarse: 0, uLiqF: L0.liq, uWF: L0.W, uCBF: L0.exB, ...this._coefUniforms(0),
    });
    for (let l = 1; l < this.nlev; l++) {
      const L = levels[l];
      const F = levels[l - 1];
      this._draw(P.downsample, [L.liq, L.W], L, { uLiqF: F.liq, uWF: F.W }, F);
      this._draw(P.coef, [L.cA, L.cB], L, {
        uLiq: L.liq, uW: L.W, uInvThetaMax: invThetaMax,
        uCoarse: p.airLeak, uLiqF: F.liq, uWF: F.W, uCBF: F.cB, ...this._coefUniforms(l),
      }, F);
    }
  }

  /** The right-hand side of the pressure equation, with the solids moving as `us` says. */
  _rhs(dt, us = this.T.us) {
    const { prog: P, T, levels, params: p } = this;
    const L0 = levels[0];
    this._draw(P.rhs, L0.rhs, L0, {
      uVel: T.vel[0], uUs: us, uW: L0.W, uLiq: L0.liq, uSdf: T.sdf,
      uSrcScale: p.lambda / dt, uSrcMax: p.eta / dt, uSinkScale: p.compress / dt, uSinkMax: p.compressMax / dt,
      uSeparate: p.separate,
    });
  }

  _project(dt) {
    const { T, params: p } = this;
    this._buildMatrix();
    let us = T.us;
    if (this.coupler && this.coupler.active.length) {
      // pressure and the velocities of the bodies together
      us = this.coupler.solve(this, dt);
    } else {
      this._rhs(dt);
      const cycles = this.twoWay ? Math.max(p.vcycles, p.vcyclesBodies) : p.vcycles;
      for (let i = 0; i < cycles; i++) this._vcycle(0);
    }
    this._drawProject(us);
    this._swap(T.vel);
  }

  /**
   * The velocity the pressure as it stands leaves, with the solids moving as `us` says: into
   * the spare of the velocity's two textures, which is returned (not swapped in).
   */
  _drawProject(us) {
    const { prog: P, T, levels, params: p } = this;
    const L0 = levels[0];
    this._draw(P.project, T.vel[1], L0,
      { uVel: T.vel[0], uUs: us, uW: L0.W, uLiq: L0.liq, uP: L0.p[0], uInvThetaMax: 1 / p.thetaMin, ...this._projectUniforms() });
    return T.vel[1];
  }

  // ---- what src/couple.js needs of the solver
  /** A work texture laid out and formatted like `like` (kept until the grid changes its size). */
  _scratch(name, like) {
    let t = this._scr[name];
    if (!t || t.w !== like.w || t.h !== like.h || t.fmt !== like.fmt) {
      if (t) this.glc.deleteTexture(t);
      t = this._scr[name] = this.glc.texture(like.w, like.h, like.fmt);
    }
    return t;
  }

  /**
   * The solid velocities with the primitives moving otherwise than the solid pass was told:
   * dV, dW per primitive (arrays of 3 * MAX_PRIMS) are added to its velocity and spin
   * (base 1), or are all that moves (base 0). Returns the texture.
   */
  _usBody(base, dV, dW, name = 'us') {
    const { prog: P, T } = this;
    const out = this._scratch(name, T.us);
    const C = new Float32Array(3 * MAX_PRIMS);
    this.solids.forEach((s, i) => C.set([s.center[0], s.center[1], this.dim === 2 ? 0.5 : s.center[2]], 3 * i));
    this._draw(P.usBody, out, this.levels[0], { uUs: T.us, uBase: base, uDV: dV, uDW: dW, uDC: C });
    return out;
  }

  /** A texture like the pressure's, zero. It lives until dropField(), or until the grid is laid out anew (fieldsVersion counts that). */
  newField() {
    const like = this.levels[0].p[0];
    const t = this.glc.texture(like.w, like.h, like.fmt);
    this.glc.clear(t);
    this.fields.add(t);
    return t;
  }

  dropField(t) { if (this.fields.delete(t)) this.glc.deleteTexture(t); }

  _dropFields() {
    for (const t of this.fields) this.glc.deleteTexture(t);
    this.fields.clear();
    this.fieldsVersion++;
  }

  /**
   * out = keep * p + the sum of coefs[k] * fields[k] (four at most) in the cells the pressure
   * is solved in; held * p in cells whose pressure is held, zero elsewhere.
   */
  _combine(out, p, keep, held, fields = [], coefs = []) {
    const L0 = this.levels[0];
    const q = (k) => fields[k] || p;
    this._draw(this.prog.combine, out, L0, {
      uP: p, uCA: L0.cA, uKeep: [keep, held], uQ0: q(0), uQ1: q(1), uQ2: q(2), uQ3: q(3),
      uC: [0, 1, 2, 3].map((k) => (fields[k] ? coefs[k] : 0)),
    });
  }

  /** pressure += the sum of coefs[k] * fields[k]. */
  addToPressure(fields, coefs) {
    const L0 = this.levels[0];
    for (let i = 0; i < fields.length; i += 4) {
      this._combine(L0.p[1], L0.p[0], 1, 1, fields.slice(i, i + 4), coefs.slice(i, i + 4));
      this._swap(L0.p);
    }
  }

  /**
   * How the liquid, at rest, answers solids that move as `us` says: `cycles` V-cycles on the
   * pressure of that, which stands in place of the pressure until `done()` is called (the
   * right-hand side is the caller's to rebuild). `pair`: two fields, the first with the guess
   * the solve starts from; afterwards the first of the pair is the answer.
   */
  _response(us, cycles, pair) {
    const { prog: P, levels } = this;
    const L0 = levels[0];
    const keep = L0.p;
    // (the guess: nothing where no pressure is solved for, the liquid may have moved since)
    this._combine(pair[1], pair[0], 1, 0);
    this._swap(pair);
    L0.p = pair;
    this._draw(P.rhsBody, L0.rhs, L0, { uUs: us, uW: L0.W, uLiq: L0.liq });
    for (let i = 0; i < cycles; i++) this._vcycle(0);
    return () => { L0.p = keep; };
  }

  /** The pass of measureBodyForces. `vel`: the velocity of the liquid to go by (the solver's, unless given). */
  _drawBodyForces(prims, vel = this.T.vel[0]) {
    const { prog: P, T } = this;
    const L0 = this.levels[0];
    this._scatter(P.bodyForce, T.force, L0,
      { uP: L0.p[0], uLiq: L0.liq, uVel: vel, uSlots: MAX_PRIMS, ...this._prims(prims, 'B') },
      1, { clear: true });
  }

  /**
   * As measureBodyForces, at once (the read-back blocks), of the pressure as it stands.
   * `all`: with the wet share of each body's surface and the velocity of the liquid around it.
   * `vel`: a velocity field to take the latter from, instead of the solver's as it stands.
   */
  bodyForcesSync(prims, all = true, vel = undefined) {
    const { glc, T } = this;
    this._drawBodyForces(prims, vel);
    const a = glc.read(T.force[0]), b = glc.read(T.force[1]), c = all ? glc.read(T.force[2]) : null;
    const NONE = 1e-6;
    return prims.map((_, i) => {
      const out = { force: [a[4 * i], a[4 * i + 1], a[4 * i + 2]], torque: [b[4 * i], b[4 * i + 1], b[4 * i + 2]] };
      if (all) {
        const w = c[4 * i + 3];
        out.wet = a[4 * i + 3] > NONE ? b[4 * i + 3] / a[4 * i + 3] : 0;
        out.fluidVel = w > NONE ? [c[4 * i] / w, c[4 * i + 1] / w, c[4 * i + 2] / w] : [0, 0, 0];
      }
      return out;
    });
  }

  // ------------------------------------------------------------------ diagnostics
  _drawStats() {
    const { glc, prog: P, T, levels } = this;
    const L0 = levels[0];
    this._draw(P.residual, T.res, L0, { uP: L0.p[0], uRhs: L0.rhs, uCA: L0.cA, uCB: L0.cB });
    glc.draw(P.stats, T.stats, { ...this._U(L0), uRho: T.rho[0], uLiq: L0.liq, uVel: T.vel[0], uRes: T.res, uB: this.statsBlock });
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
    const { glc, prog: P, T } = this;
    const L0 = this.levels[0];
    if (this._forceBusy || prims.length === 0) return null;
    this._forceBusy = true;
    try {
      this._drawBodyForces(prims);
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
    for (const t of Object.values(this._scr)) glc.deleteTexture(t);
    this._dropFields();
  }
}
