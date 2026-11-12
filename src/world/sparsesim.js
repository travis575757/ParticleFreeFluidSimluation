// SparseSim: the solver of FluidSim (src/sim.js) on an unbounded grid of which only some bricks
// are stored. The numerics are the passes of src/shaders/sim.js, unchanged; this class supplies
// the storage (pooled bricks and their multigrid hierarchy) and decides which bricks exist.
//
//   level 0   the bricks that hold the fields. A cell whose brick is not stored is neither liquid
//             nor air: the faces towards it are closed, like a wall.
//   level l   the parents of the bricks of level l - 1 (brick b -> b >> 1), kept by reference
//             counts. Coarse levels hold nothing that outlives a step.
//
// Coordinates: cells are world integers; primitives (solids, liquid sources, the brush) are
// given relative to `anchor`.
import { FluidSim, makeGrid, packPrims } from '../sim.js';
import { VS_TILES } from '../gl.js';
import { BRICK, NB_REACH } from '../shaders/common.js';
import { sparseShaders } from '../shaders/sparse.js';
import { BrickSet } from './bricks.js';

export const SPARSE_PARAMS = {
  coarseSolids: 1,  // on coarse levels a cell that is solid throughout is a wall, not air (0: as the dense solver)
  mgDeep: 1,        // coarsen until the LONGEST side of the stored region is under 4 cells (0: the shortest, as the dense solver does)
  lifecycle: 1,     // store and drop bricks from the per-brick reports (0: only what the caller asks for)
  wetMin: 1e-6,     // a cell counts as wet above this density; bricks are kept and added for wet cells only
  edgeMin: 1e-3,    // density that counts as liquid at the edge of the stored bricks (the "edge" counter of the reports)
  margin: 5,        // cells kept stored around the liquid, on top of what its speed needs
  freeAfter: 40,    // a brick without wet cells, out of reach of all that are, is dropped after this many reports
  reportEvery: 1,   // steps between reports
  reportDelay: 0,   // act on reports that are at least this many steps old (tests)
  reportAsync: 0,   // read the reports back without blocking; they then arrive a few frames late
  reportLag: 3,     // steps a non-blocking report is assumed to take to arrive
};

const MAX_LEVELS = 24;

export class SparseSim extends FluidSim {
  /**
   * @param bricks  { initial, max: level-0 bricks to start with / at most, top: page table size }
   */
  constructor(glc, { dim = 2, params = {}, bricks = {} } = {}) {
    super(glc, { dim, params: { ...SPARSE_PARAMS, ...params }, backend: 'sparse', bricks });
  }

  // ------------------------------------------------------------------ setup
  _buildPrograms() {
    super._buildPrograms();
    const glc = this.glc;
    const S = sparseShaders(this.dim);
    const P = this.prog;
    P.fill = glc.program('fill', S.fill, VS_TILES);
    P.copy = glc.program('copy', S.copy);
    P.slotStats = glc.program('slotStats', S.slotStats);
    P.slotFlags = glc.program('slotFlags', S.slotFlags);
    P.resolve = glc.program('resolve', S.resolve);
    P.nbBuild = glc.program('nbBuild', S.nbBuild);
    P.copyTiles = glc.program('copyTiles', S.copyTiles, VS_TILES);
    P.meterDiff = glc.program('meterDiff', S.meterDiff);
    P.sum8 = glc.program('sum8', S.sum8);
  }

  /** The ground (src/world/terrain.js), or null. Takes effect at the next step. */
  setTerrain(terrain) { this.terrain = terrain; }

  _solidUniforms() { return this.terrain ? this.terrain.uniforms : { uTer: this._noTerrain, uTerMap: [0, 0, 1, 0] }; }

  _passVS() { return VS_TILES; }

  _U(L, L2 = L) {
    const a = L.set, b = L2.set;
    return {
      G: L.grid, GF: L2.grid, GC: L2.grid,
      uPg0: a.texTop, uLf0: a.texLeaf, uSl0: a.texSlot, uNb0: a.texNb,
      uPgX: b.texTop, uLfX: b.texLeaf,
      uAnchor: this.anchor, uCoarseSolids: this.params.coarseSolids,
    };
  }

  /** The neighbour table of a level, from its page table. */
  _buildNb(L) {
    this.glc.draw(this.prog.nbBuild, L.set.texNb, this._U(L));
  }

  _draw(p, target, L, uniforms, L2 = L) {
    this.glc.drawTiles(p, target, { ...this._U(L, L2), ...uniforms }, this._only || L.set.list, L.set.tile);
  }

  _scatter(p, target, L, uniforms, perCell, opts) {
    this.glc.scatter(p, target, { ...this._U(L), ...uniforms }, L.set.high * this.CB * perCell, opts);
  }

  _buildGrid() {
    const { glc, dim } = this;
    const o = this.options.bricks || {};
    this.B = BRICK[dim];
    this.TW = dim === 2 ? this.B : this.B * this.B;
    this.CB = this.B ** dim;
    this.anchor = [0, 0, 0];
    this.perRow0 = Math.min(dim === 2 ? 64 : 128, Math.floor(glc.maxTextureSize / this.TW));
    const maxRows = Math.floor(glc.maxTextureSize / this.B) - 1;
    this.maxBricks = Math.min(o.max || (dim === 2 ? 4096 : 16384), this.perRow0 * maxRows);
    this.top0 = o.top || (dim === 2 ? [256, 256, 1] : [128, 32, 128]);
    this.levels = [];
    this.nlev = 1;
    this.fresh = [];                  // level-0 slots stored since the last _syncBricks
    this.freshList = glc.tileList();
    this.editList = glc.tileList();
    this.terrain = null;
    this._noTerrain = glc.texture(2, 2, 'rgba32f');
    // what metered edits (editLiquid) added and removed: summed on the GPU into `ledger`, moved
    // into these totals by readLedger / readLedgerAsync
    this.ledger = glc.texture(1, 1, 'rgba32f');
    glc.clear(this.ledger);
    this.M = [512, 64, 8].map((n) => glc.texture(n, n, 'rg32f'));   // work space of _meter
    this.added = 0;
    this.removed = 0;
    this.quiet = [];                  // per level-0 slot: consecutive reports it was dry and out of reach
    this.stampOf = [];
    this._stamp = 0;
    this.reports = [];
    this.report = null;               // summary of the last report acted on
    this.refused = 0;                 // bricks that were wanted while the pool was full
    // (x, y, z, size) -> true if the cube of `size` cells at world cell (x, y, z) lies inside a
    // solid that never moves, at least a cell and a half deep everywhere. Such bricks are not
    // stored (a missing brick is a wall already). Set by the owner; null = store everything.
    this.solidBrick = null;
    this.freedMass = 0;               // density (traces below wetMin) in the bricks that were dropped
    this._resolved = new Map();
    const initial = Math.min(o.initial || (dim === 2 ? 256 : 1024), this.maxBricks);
    this._newLevel(Math.ceil(initial / this.perRow0));
    this.grid = this.levels[0].grid;
    this._allocFields(this.grid);
    this._initNull0();
    this._allocReports();
  }

  _newLevel(rows = 1) {
    const { glc, dim } = this;
    const l = this.levels.length;
    const perRow = l === 0 ? this.perRow0 : Math.max(8, Math.floor(this.perRow0 / 2 ** (dim === 2 ? l : 2 * l)));
    // coarse bricks span half the coordinates per level; one spare bit, because halving rounds
    const top = this.top0.map((v) => Math.max(2, Math.floor(v / 2 ** Math.max(0, l - 1))));
    const set = new BrickSet(glc, dim, { perRow, rows, top });
    const L = { l, set, grid: set.grid };
    this._allocLevel(L, l);
    this._initNull(L);
    this.levels.push(L);
    if (l > 0) {
      const F = this.levels[l - 1].set;
      for (let s = 0; s < F.high; s++) if (F.used[s]) this._ref(l, F.bx[s] >> 1, F.by[s] >> 1, dim === 3 ? F.bz[s] >> 1 : 0);
    }
    return L;
  }

  // What a cell that is not stored reads as, where that is not zero: no density but full row sum
  // (rho), air that is "not present" (liq), no separating constraint (rhs).
  _initNull(L) {
    const r = L.set.nullRect;
    this.glc.clearRect(L.liq, ...r, 0.5, -1, 0, 0);
    this.glc.clearRect(L.rhs, ...r, 0, -1e30, 0, 0);
  }

  _initNull0() {
    const r = this.levels[0].set.nullRect;
    for (const t of this.T.rho) this.glc.clearRect(t, ...r, 0, 1, 0, 0);
  }

  _allocReports() {
    const glc = this.glc;
    const set = this.levels[0].set;
    if (this.R) for (const t of [...this.R.s, ...this.R.f]) glc.deleteTexture(t);
    const tex = () => glc.texture(set.perRow, set.rows, 'rgba32f');
    // s: per-slot statistics (pass slotStats); f: what the CPU reads of them (pass slotFlags)
    this.R = { s: [tex(), tex(), tex()], f: [tex(), tex()] };
  }

  _levelTextures(L) { return [L.W, L.liq, L.cA, L.cB, ...L.p, L.rhs, L.exA, L.exB, L.exF]; }

  _growLevel(L) {
    for (const t of this._levelTextures(L)) this.glc.deleteTexture(t);
    L.set.resize(L.set.rows * 2);
    this._allocLevel(L, L.l);
    this._initNull(L);
  }

  /** Double the level-0 pool (up to maxBricks), keeping what the next step reads. */
  _grow0() {
    const glc = this.glc;
    const L = this.levels[0];
    const set = L.set;
    const maxRows = Math.ceil(this.maxBricks / set.perRow);
    if (set.rows >= maxRows) return false;
    const T = this.T;
    const keep = [T.vel[0], T.rho[0], L.p[0], L.liq, L.W];
    const drop = [T.vel[1], T.rho[1], T.sdf, T.us, T.frac, T.trace, T.beta, T.fwd, T.res, ...T.stats, ...T.force,
      L.cA, L.cB, L.p[1], L.rhs, L.exA, L.exB];
    for (const t of drop) glc.deleteTexture(t);
    const usedH = set.rows * this.B;
    const { baseline, stats } = this;
    set.resize(Math.min(maxRows, set.rows * 2));
    this._allocLevel(L, 0);
    this._allocFields(L.grid);
    this.baseline = baseline;
    this.stats = stats;
    const fresh = [this.T.vel[0], this.T.rho[0], L.p[0], L.liq, L.W];
    keep.forEach((old, i) => {
      glc.draw(this.prog.copy, fresh[i], { uSrc: old }, { viewport: [0, 0, old.w, usedH] });
      glc.deleteTexture(old);
    });
    this._initNull(L);
    this._initNull0();
    this._allocReports();
    return true;
  }

  // ------------------------------------------------------------------ bricks
  get bricks() { return this.levels[0].set.count; }
  /** Cells stored on level 0. */
  get storedCells() { return this.levels[0].set.count * this.CB; }

  /** Store brick (x, y, z) of level 0. Returns false if the pool is full. */
  addBrick(x, y, z = 0) {
    const set = this.levels[0].set;
    if (set.get(x, y, z) >= 0 || set.marked(x, y, z)) return true;
    if (this.solidBrick && this.solidBrick(x * this.B, y * this.B, z * this.B, this.B)) { set.mark(x, y, z); return true; }
    if (set.count >= set.capacity && !this._grow0()) { this.refused++; return false; }
    const s = set.add(x, y, z);
    this.fresh.push(s);
    this.quiet[s] = 0;
    this._ref(1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
    return true;
  }

  removeBrick(x, y, z = 0) {
    if (this.levels[0].set.remove(x, y, z) < 0) return;
    this._unref(1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
  }

  _ref(l, x, y, z) {
    if (l >= this.levels.length) return;
    const L = this.levels[l];
    let s = L.set.get(x, y, z);
    if (s < 0) {
      if (L.set.count >= L.set.capacity) this._growLevel(L);
      s = L.set.add(x, y, z);
      this._ref(l + 1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
    }
    L.set.refs[s]++;
  }

  _unref(l, x, y, z) {
    if (l >= this.levels.length) return;
    const L = this.levels[l];
    const s = L.set.get(x, y, z);
    if (--L.set.refs[s] > 0) return;
    L.set.remove(x, y, z);
    this._unref(l + 1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
  }

  /** Store every brick that touches the box of world cells [lo, hi). Returns false if some could not be. */
  ensureBox(lo, hi) {
    const B = this.B;
    const b0 = lo.map((v) => Math.floor(v / B));
    const b1 = hi.map((v) => Math.floor((v - 1) / B));
    if (this.dim === 2) b0[2] = b1[2] = 0;
    let ok = true;
    for (let z = b0[2]; z <= b1[2]; z++) for (let y = b0[1]; y <= b1[1]; y++) for (let x = b0[0]; x <= b1[0]; x++) ok = this.addBrick(x, y, z) && ok;
    return ok;
  }

  /** World cells [lo, hi) around a primitive, `margin` cells wider. */
  _primBox(p, margin) {
    const r = p.type === 'ball' ? [p.radius, p.radius, p.radius]
      : p.rot ? Array(3).fill(Math.hypot(p.half[0], p.half[1], this.dim === 3 ? p.half[2] : 0)) : p.half;
    const lo = [0, 1, 2].map((d) => Math.floor(p.center[d] - r[d] - margin) + this.anchor[d]);
    const hi = [0, 1, 2].map((d) => Math.ceil(p.center[d] + r[d] + margin) + this.anchor[d]);
    if (this.dim === 2) { lo[2] = 0; hi[2] = 1; }
    return { lo, hi };
  }

  /** Store the bricks around primitives (as given to reset / editLiquid), `margin` cells wider. */
  ensurePrims(prims, margin = this.params.margin) {
    let ok = true;
    for (const p of prims) {
      const { lo, hi } = this._primBox(p, margin);
      ok = this.ensureBox(lo, hi) && ok;
    }
    return ok;
  }

  clearBricks() {
    const set = this.levels[0].set;
    const all = [];
    for (let s = 0; s < set.high; s++) if (set.used[s]) all.push([set.bx[s], set.by[s], set.bz[s]]);
    for (const b of all) this.removeBrick(...b);
    set.clearMarks();
  }

  /** Bring the lookup textures, the level count and newly stored bricks up to date. */
  _syncBricks() {
    const { glc, prog: P, T, dim, B } = this;
    const L0 = this.levels[0];
    if (this._version === L0.set.version && !L0.set.dirty) return;
    this._version = L0.set.version;
    const bb = L0.set.bounds();
    let nlev = 1;
    if (bb) {
      const pick = this.params.mgDeep ? Math.max : Math.min;
      let l = 0;
      for (; l < MAX_LEVELS - 1; l++) {
        const ext = [];
        for (let d = 0; d < dim; d++) ext.push(((bb.hi[d] * B - 1) >> l) - ((bb.lo[d] * B) >> l) + 1);
        if (pick(...ext) < 4) break;
      }
      nlev = l + 1;
    }
    while (this.levels.length < nlev) this._newLevel();
    this.nlev = nlev;
    for (const L of this.levels) if (L.set.sync()) this._buildNb(L);

    const fresh = [...new Set(this.fresh)].filter((s) => L0.set.used[s]);
    this.fresh = [];
    if (!fresh.length) return;
    // what the next pass may read from a brick before the solver has written it
    this.freshList.set(fresh);
    const fill = (t, v) => glc.drawTiles(P.fill, t, { uValue: v }, this.freshList, L0.set.tile);
    fill(T.vel[0], [0, 0, 0, 0]);
    fill(T.rho[0], [0, 1, 0, 0]);
    fill(L0.p[0], [0, 0, 0, 0]);
    this._only = this.freshList;
    try {
      this._updateSolids();
      this._computeLiq();
    } finally {
      this._only = null;
    }
  }

  // ------------------------------------------------------------------ scene state
  /** As FluidSim.reset. The stored bricks become those around the liquid; `keep` leaves them as they are. */
  reset(solids, liquid, { keep = false } = {}) {
    if (!keep) { this.clearBricks(); this.ensurePrims(liquid); }
    this._syncBricks();
    super.reset(solids, liquid);
    this.reports = [];
    this.report = null;
    this.refused = 0;
    this.freedMass = 0;
    this.glc.clear(this.ledger);
    this.added = 0;
    this.removed = 0;
    this.books = null;
    this.stored = null;
  }

  /**
   * As FluidSim.editLiquid, on the bricks the primitives touch only. `meter`: what the edit adds
   * and removes goes into the ledger (see readLedger).
   */
  editLiquid(prims, op = 1, { meter = false } = {}) {
    const { glc, prog: P, B } = this;
    if (!prims.length) return;
    if (op === 1) this.ensurePrims(prims);
    this._syncBricks();
    const T = this.T;               // (storing bricks may have replaced the pool textures)
    const L0 = this.levels[0];
    const set = L0.set;
    // the cells an edit can change lie within half a cell of its primitives
    const boxes = prims.map((p) => this._primBox(p, 1));
    const slots = new Set();
    for (const { lo, hi } of boxes) {
      for (let z = Math.floor(lo[2] / B); z <= Math.floor((hi[2] - 1) / B); z++) {
        for (let y = Math.floor(lo[1] / B); y <= Math.floor((hi[1] - 1) / B); y++) {
          for (let x = Math.floor(lo[0] / B); x <= Math.floor((hi[0] - 1) / B); x++) {
            const s = set.get(x, y, z);
            if (s >= 0) slots.add(s);
          }
        }
      }
    }
    if (!slots.size) return;
    this.editList.set([...slots]);
    const U = packPrims(prims, 'L', this.dim);
    const copy = (from, to) => glc.drawTiles(P.copyTiles, to, { uSrc: from }, this.editList, set.tile);
    this._only = this.editList;
    try {
      this._draw(P.sourceRho, T.rho[1], L0, { ...U, uRho: T.rho[0], uFrac: T.frac, uOp: op });
      if (meter) {
        // one box around all primitives (boxes that overlap must not count twice)
        const lo = [0, 1, 2].map((d) => Math.min(...boxes.map((b) => b.lo[d])));
        const hi = [0, 1, 2].map((d) => Math.max(...boxes.map((b) => b.hi[d])));
        this._meter(lo, hi.map((v, d) => v - lo[d]), T.rho[0], T.rho[1]);
      }
      copy(T.rho[1], T.rho[0]);
      if (op === 1) {
        this._draw(P.sourceVel, T.vel[1], L0, { ...U, uVel: T.vel[0], uOp: 1 });
        copy(T.vel[1], T.vel[0]);
      }
      this._computeLiq();
    } finally {
      this._only = null;
    }
    this.rebaseline = true;
  }

  /** Add what turned density `before` into `after` within the box of n cells at lo to the ledger. */
  _meter(lo, n, before, after) {
    const { glc, prog: P } = this;
    const [M0, M1, M2] = this.M;
    const W = M0.w;
    const count = n[0] * n[1] * n[2];
    const U = { ...this._U(this.levels[0]), uA: before, uB: after, uLo: lo, uN: n, uWidth: W };
    for (let first = 0; first < count; first += W * W) {
      const rows = Math.min(W, Math.ceil((count - first) / W));
      const r1 = Math.ceil(rows / 8), r2 = Math.ceil(r1 / 8);
      glc.draw(P.meterDiff, M0, { ...U, uFirst: first }, { viewport: [0, 0, W, rows] });
      glc.draw(P.sum8, M1, { uSrc: M0, uLimit: [W, rows] }, { viewport: [0, 0, W / 8, r1] });
      glc.draw(P.sum8, M2, { uSrc: M1, uLimit: [W / 8, r1] }, { viewport: [0, 0, W / 64, r2] });
      glc.draw(P.sum8, this.ledger, { uSrc: M2, uLimit: [W / 64, r2] }, { blend: true });
    }
  }

  /** Move what the metered edits have summed up so far into `added` / `removed` (blocking). */
  readLedger() {
    const d = this.glc.read(this.ledger);
    this.glc.clear(this.ledger);
    this.added += d[0];
    this.removed += d[1];
  }

  /** readLedger once a non-blocking read that is under way has arrived: the totals are then complete. */
  async settleLedger() {
    while (this._ledgerBusy) await new Promise((r) => setTimeout(r, 1));
    this.readLedger();
  }

  /**
   * The same without blocking: the totals follow a few frames later. `books` then holds totals
   * that belong together: added, removed, the traces dropped with bricks (freed) and the liquid
   * stored, all as of this call (with blocking reports; non-blocking ones lag behind).
   */
  readLedgerAsync() {
    if (this._ledgerBusy) return;
    this._ledgerBusy = true;
    const p = this.glc.readAsync(this.ledger);
    this.glc.clear(this.ledger);      // (the read above has its copy already)
    const stored = this.stored ? this.stored.mass : 0, freed = this.freedMass;
    p.then((d) => {
      this.added += d[0]; this.removed += d[1];
      this.books = { added: this.added, removed: this.removed, freed, stored };
    }, () => {}).finally(() => { this._ledgerBusy = false; });
  }

  step() {
    if (this.params.lifecycle) this._lifecycle();
    this._syncBricks();
    super.step();
    if (this.params.lifecycle && this.frame % this.params.reportEvery === 0) this.makeReport();
  }

  // ------------------------------------------------------------------ brick lifecycle
  /** Per-brick statistics of the current state; read back at once or (reportAsync) when it arrives. */
  makeReport() {
    const { glc, prog: P, T, params: p } = this;
    this._syncBricks();
    const L0 = this.levels[0];
    const set = L0.set;
    const U = this._U(L0);
    // steps the liquid moves between this state and the last step that still runs on the bricks
    // chosen from it (one more than strictly needed)
    const steps = (p.reportAsync ? p.reportLag : p.reportDelay) + p.reportEvery + 1;
    this.refreshSlotStats();
    glc.draw(P.slotFlags, this.R.f, { ...U, uS0: this.R.s[0], uS1: this.R.s[1], uS2: this.R.s[2], uDt: p.dt, uSteps: steps, uMargin: p.margin });
    const n = set.high;
    const rep = {
      frame: this.frame, high: n, steps, data: null,
      bx: set.bx.slice(0, n), by: set.by.slice(0, n), bz: set.bz.slice(0, n), used: set.used.slice(0, n),
    };
    const texs = this.R.f;
    // (the liquid stored, for the books: see readLedgerAsync)
    const arrived = (d) => {
      rep.data = d;
      let mass = 0;
      for (let s = 0; s < n; s++) if (rep.used[s]) mass += d[0][4 * s];
      this.stored = { mass, frame: rep.frame };
    };
    if (p.reportAsync) Promise.all(texs.map((t) => glc.readAsync(t))).then(arrived, () => {});
    else arrived(texs.map((t) => glc.read(t, 0, 0, set.perRow, Math.max(1, Math.ceil(n / set.perRow)))));
    this.reports.push(rep);
    if (this.reports.length > 32) this.reports.shift();
    return rep;
  }

  /** The per-brick statistics (textures R.s) of the current state; the renderer reads them too. */
  refreshSlotStats() {
    const { glc, prog: P, T, params: p } = this;
    this._syncBricks();
    glc.draw(P.slotStats, this.R.s, { ...this._U(this.levels[0]), uRho: T.rho[0], uVel: T.vel[0], uWet: p.wetMin, uEdge: p.edgeMin });
    this.statsFrame = this.frame;
    this._statsVersion = this.levels[0].set.version;
  }

  /**
   * Act on the newest report that has arrived: store the bricks the liquid can reach before the
   * next report is acted on, and drop bricks that have been dry and out of reach for a while.
   * The GPU has already marked the bricks that need something (pass slotFlags).
   */
  _lifecycle() {
    const p = this.params;
    let rep = null;
    for (let i = this.reports.length - 1; i >= 0 && !rep; i--) {
      const r = this.reports[i];
      if (r.data && this.frame - r.frame >= p.reportDelay) rep = r;
    }
    if (!rep || rep.applied) return;
    rep.applied = true;
    this.reports = this.reports.filter((r) => r.frame >= rep.frame);
    const { dim, B } = this;
    const set = this.levels[0].set;
    const [A, F] = rep.data;
    // a report that arrived later than assumed has to reach further
    const steps = Math.max(rep.steps, this.frame - rep.frame + p.reportEvery + 1);
    const far = NB_REACH * B;        // what the flags of the GPU cover
    const stamp = ++this._stamp;
    const want = [];
    const dry = [];
    const sum = { frame: rep.frame, wet: 0, dry: 0, edge: 0, mass: 0, maxSpeed: 0, looked: 0 };
    const lo = [0, 0, 0], hi = [0, 0, 0];
    for (let s = 0; s < rep.high; s++) {
      if (!rep.used[s]) continue;
      // the slot may have changed hands since
      if (!set.used[s] || set.bx[s] !== rep.bx[s] || set.by[s] !== rep.by[s] || set.bz[s] !== rep.bz[s]) continue;
      sum.mass += A[4 * s];
      sum.edge += Math.round(A[4 * s + 2]);
      if (A[4 * s + 3] < 0.5) { dry.push(s); continue; }
      sum.wet++;
      this.quiet[s] = 0;
      const speed = A[4 * s + 1];
      if (speed > sum.maxSpeed) sum.maxSpeed = speed;
      const r = Math.ceil(speed * p.dt) * steps + p.margin;
      if (F[4 * s + 2] < 0.5 && r <= far && steps === rep.steps) continue;
      sum.looked++;
      const b = [rep.bx[s], rep.by[s], rep.bz[s]];
      // the wet cells of the brick: lowest and highest, packed as x + 16 y + 256 z
      const wl = Math.round(F[4 * s]), wh = Math.round(F[4 * s + 1]);
      for (let d = 0; d < dim; d++) {
        lo[d] = b[d] + Math.floor((((wl >> (4 * d)) & 15) - r) / B);
        hi[d] = b[d] + Math.floor((((wh >> (4 * d)) & 15) + r) / B);
      }
      for (let z = lo[2]; z <= hi[2]; z++) {
        for (let y = lo[1]; y <= hi[1]; y++) {
          for (let x = lo[0]; x <= hi[0]; x++) {
            const t = set.get(x, y, z);
            if (t >= 0) this.stampOf[t] = stamp;
            else if (!set.marked(x, y, z)) want.push(x, y, z);
          }
        }
      }
    }
    for (let i = 0; i < want.length; i += 3) this.addBrick(want[i], want[i + 1], want[i + 2]);
    for (const s of dry) {
      if (F[4 * s + 3] > 0.5 || this.stampOf[s] === stamp) { this.quiet[s] = 0; continue; }
      this.quiet[s] = (this.quiet[s] || 0) + 1;
      if (this.quiet[s] < p.freeAfter) continue;
      this.freedMass += A[4 * s];
      this.removeBrick(rep.bx[s], rep.by[s], rep.bz[s]);
    }
    sum.dry = dry.length;
    this.report = sum;
  }

  // ------------------------------------------------------------------ dense views
  /**
   * Copy a window of a field of level `level` into a dense texture laid out as FluidSim lays out
   * a grid of n cells (makeGrid). The texture is reused by the next call with the same size.
   * frame: the field's xyz are positions in the frame of each cell's brick; return them relative
   * to `lo`.
   */
  resolve(src, lo, n, { frame = false, level = 0, into = null } = {}) {
    const { glc, dim } = this;
    this._syncBricks();
    const g = makeGrid(n[0], n[1], dim === 2 ? 1 : n[2]);
    let dst = into;
    if (!dst) {
      const key = g.w + 'x' + g.h;
      dst = this._resolved.get(key);
      if (!dst) { dst = glc.texture(g.w, g.h, 'rgba32f'); this._resolved.set(key, dst); }
    }
    glc.draw(this.prog.resolve, dst, {
      ...this._U(this.levels[level]), uSrc: src,
      uLo: [lo[0], lo[1], dim === 2 ? 0 : lo[2]], uN: g.n, uTx: g.tx, uFrame: frame ? 1 : 0,
    });
    return dst;
  }

  _drawStats() {
    this._syncBricks();
    super._drawStats();
  }

  async measureBodyForces(prims) {
    this._syncBricks();
    return super.measureBodyForces(prims);
  }

  dispose() {
    super.dispose();
    const glc = this.glc;
    for (const L of this.levels) L.set.dispose();
    for (const t of [...this.R.s, ...this.R.f, ...this._resolved.values(), this._noTerrain, this.ledger, ...this.M]) glc.deleteTexture(t);
    this.freshList.dispose();
    this.editList.dispose();
  }
}
