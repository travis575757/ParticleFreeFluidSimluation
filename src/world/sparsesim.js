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
import { BRICK, NB_REACH, MAX_WATER } from '../shaders/common.js';
import { farLevel } from './water.js';
import { sparseShaders } from '../shaders/sparse.js';
import { BrickSet } from './bricks.js';

export const SPARSE_PARAMS = {
  // Two options of FluidSim that are off there (the dense solver is the reference) and on here: with
  // them water at rest stays at rest next to a solid that crosses its surface. Without, a current of
  // 0.1 to 0.15 cells per step runs down the side of every such solid for good, and no water near a
  // shore, a quay or a floating body would ever be found at rest.
  pushRel: 1,       // see TRACE in shaders/common.js
  sliverSide: 1,    // see pass "liq" in shaders/sim.js
  coarseSolids: 1,  // on coarse levels a cell that is solid throughout is a wall, not air (0: as the dense solver)
  mgDeep: 1,        // coarsen until the LONGEST side of the stored region is under 4 cells (0: the shortest, as the dense solver does)
  lifecycle: 1,     // store and drop bricks from the per-brick reports (0: only what the caller asks for)
  wetMin: 1e-6,     // a cell counts as wet above this density; bricks are kept and added for wet cells only
  edgeMin: 1e-3,    // density that counts as liquid at the edge of the stored bricks (the "edge" counter of the reports)
  margin: 5,        // cells kept stored around the liquid, on top of what its speed needs
  freeAfter: 40,    // a brick without wet cells, out of reach of all that are, is dropped after this many reports
  mistMass: 1,      // a brick without a liquid cell that holds no more than this (cells) and does not move counts
                    // as one without wet cells: the solver moves mist with the velocity of the nearest liquid, so
                    // over water at rest it never falls, and would keep its brick and those around it for good
  reportEvery: 1,   // steps between reports
  reportDelay: 0,   // act on reports that are at least this many steps old (tests)
  reportAsync: 0,   // read the reports back without blocking; they then arrive a few frames late
  reportLag: 3,     // steps a non-blocking report is assumed to take to arrive, at least
  sponge: 0.1,      // share of its velocity the liquid loses per step at a face between a solved and a held brick
  farZ: 1,          // what the faces between solved and held liquid let through: a wave that travels this many cells per step
  // bricks in a body of water (setWater) are held while their water is at rest, and solved again when something moves
  sleepSpeed: 0.02,  // a cell is at rest below this speed (cells per step; liquid below the surface only) ...
  sleepP: 0.15,      // ... within this of the pressure of the water at rest (cells of head) ...
  sleepRho: 0.6,     // ... and within this of its density (a surface that has moved stays smeared over two or three cells)
  sleepAfter: 60,    // steps a brick has to be at rest before it is held
  sleepSlow: 300,    // ... or steps it has only drifted: surface and pressure at rest, nothing as fast as wakeSpeed.
                     // (A splash leaves slow eddies behind that nothing damps; held, the water just stops.)
  wakeSpeed: 0.06,   // a cell above this speed wakes the bricks its liquid can reach
  wakeP: 0,          // ... or (if not 0) a cell this far from the pressure at rest. Off: an impact changes the
                     // pressure far around at once (in 2D it falls off with 1 / distance), the motion stays local
  strongSpeed: 0.15, // a cell above this speed wakes a body that sleeps next to it (World): well above what the water a
                     // body stirred up before it went to sleep still does, or the two would keep each other awake
  awakeMin: 30,      // steps a brick is solved at least
  inflow: 0.03,      // a held brick wakes when this much liquid per face cell and step goes in or out
  maxSolved: 0,      // moving water wakes water at rest only while fewer bricks than this are solved (0: no limit;
                     // the default is 3000 in 3D, 600 in 2D). Beyond it the held bricks at the edge of the solved
                     // region take the waves in. Pins always wake.
  rewake: 600,       // steps before moving water may wake the same brick again (pins and fast water always wake)
  pinHold: 120,      // steps a pinned brick stays solved after the pin has left it. A body that bobs moves the
                     // edge of its box across a brick boundary and back once per bob; without this the brick
                     // there went to sleep and was woken again every second.
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
    P.farReset = glc.program('farReset', S.farReset, VS_TILES);
    P.farDelta = glc.program('farDelta', S.farDelta);
  }

  /** The ground (src/world/terrain.js), or null. Takes effect at the next step. */
  setTerrain(terrain) { this.terrain = terrain; }

  _solidUniforms() {
    return { ...(this.terrain ? this.terrain.uniforms : { uTer: this._noTerrain, uTerMap: [0, 0, 1, 0] }), ...this._farUniforms() };
  }

  _passVS() { return VS_TILES; }

  // ------------------------------------------------------------------ water at rest, held bricks
  // A held brick is stored but not solved: after the density passes of every step its cells are
  // put back to the state of the water at rest (src/world/water.js), and the pressure solve
  // treats them as cells whose pressure is known. Liquid crosses the faces between held and
  // solved cells freely; what that moves into the held cells is summed up before they are reset
  // (`absorbed`), so nothing is lost from the books.
  //
  // With bodies of water a brick is in one of three states:
  //   solved    as without them
  //   held      stored, at rest. Every solved brick has the water at rest around it stored like
  //             this (_ring): to the solver a brick that is not stored is a wall.
  //   implicit  not stored: the body of water says what is there. Nothing is solved, stored or
  //             drawn from textures for it.
  // The reports decide (see _lifecycle): a held brick wakes when moving liquid comes within
  // reach, when liquid flows into it, or when the owner pins it (`pins`: around bodies, the
  // brush); a solved brick is held once it has been at rest for a while; a held brick that no
  // solved brick reaches is dropped.

  /** The bodies of water: [{ box: [x0, z0, x1, z1] (cells, as the primitives), level }], at most MAX_WATER. */
  setWater(bodies) {
    if (bodies.length > MAX_WATER) throw new Error(`too many bodies of water (${bodies.length} > ${MAX_WATER})`);
    this.water = bodies;
  }

  _farUniforms() {
    const p = this.params;
    const G = -p.gravity[1] * p.dt / p.h;
    const box = new Float32Array(4 * MAX_WATER), lvl = new Float32Array(4 * MAX_WATER);
    this.water.forEach((w, i) => {
      const f = farLevel(w.level, G, p.thetaMin);
      box.set(w.box, 4 * i);
      lvl.set([w.level, f.top, f.pTop, G], 4 * i);
    });
    return { uWaterN: this.water.length, uWaterBox: box, uWaterLvl: lvl };
  }

  /** Hold brick (x, y, z) of level 0, or solve it again. */
  setHeld(x, y, z, held) {
    const set = this.levels[0].set;
    const s = set.get(x, y, z);
    if (s < 0 || (set.state(s) === 2) === held) return;
    set.setState(s, held ? 2 : 1);
    this.nHeld += held ? 1 : -1;
    this._heldDirty = true;
    this.since[s] = this.frame;
    this.calm[s] = 0;
    this.drift[s] = 0;
    if (this.onState) this.onState(x, y, z, held ? 'sleep' : 'wake');
  }

  /** Does brick (x, y, z) hold water of some body at rest? (Cell centres and rows as farState() of the shaders.) */
  _farWet(x, y, z) {
    const B = this.B, a = this.anchor;
    const x0 = x * B - a[0], y0 = y * B - a[1], z0 = z * B - a[2];
    for (const w of this.water) {
      if (y0 >= w.level) continue;
      if (x0 + B - 0.5 < w.box[0] || x0 + 0.5 > w.box[2]) continue;
      if (this.dim === 3 && (z0 + B - 0.5 < w.box[1] || z0 + 0.5 > w.box[3])) continue;
      return true;
    }
    return false;
  }

  /**
   * Store, held, the water at rest around brick (x, y, z), on its level: the solver exchanges
   * liquid with water at rest sideways only (pass "solid" closes the faces above and below).
   */
  _ring(x, y, z) {
    const set = this.levels[0].set;
    const K = this.dim === 3 ? 1 : 0;
    for (let k = -K; k <= K; k++) {
      for (let i = -1; i <= 1; i++) {
        const X = x + i, Z = z + k;
        if (set.get(X, y, Z) < 0 && !set.marked(X, y, Z) && this._farWet(X, y, Z)) this.addBrick(X, y, Z, true);
      }
    }
  }

  /**
   * Make brick (x, y, z) a solved one: stored if it was not (with the water at rest that belongs
   * there), woken if it was held, and with the water at rest around it stored. Returns its slot,
   * or -1 if it is not stored (pool full, or inside a solid).
   */
  _activate(x, y, z) {
    const set = this.levels[0].set;
    let s = set.get(x, y, z);
    if (s < 0) {
      if (!this.addBrick(x, y, z)) return -1;
      s = set.get(x, y, z);
      if (s < 0) return -1;
    } else if (set.state(s) === 2) {
      this.setHeld(x, y, z, false);
    }
    if (this.water.length) this._ring(x, y, z);
    return s;
  }

  /** Wake the water at rest in the bricks that touch the boxes of `pins` ({ lo, hi } in world cells, hi exclusive). */
  _applyPins() {
    const B = this.B;
    const stamp = ++this._pinStamp;
    if (!this.water.length) return;
    for (const { lo, hi } of this.pins) {
      const b0 = lo.map((v) => Math.floor(v / B)), b1 = hi.map((v) => Math.floor((v - 1) / B));
      if (this.dim === 2) b0[2] = b1[2] = 0;
      for (let z = b0[2]; z <= b1[2]; z++) {
        for (let y = b0[1]; y <= b1[1]; y++) {
          for (let x = b0[0]; x <= b1[0]; x++) {
            if (!this._farWet(x, y, z)) continue;
            const s = this._activate(x, y, z);
            if (s >= 0) this.pinOf[s] = stamp;
          }
        }
      }
    }
  }

  isHeld(x, y, z) {
    const set = this.levels[0].set;
    const s = set.get(x, y, z);
    return s >= 0 && set.state(s) === 2;
  }

  /** The list of held tiles, and for every solved brick which of its face neighbours are held (see spongeKeep). */
  _syncHeld() {
    const set = this.levels[0].set, held = [];
    const isHeld = (x, y, z) => { const t = set.get(x, y, z); return t >= 0 && set.state(t) === 2; };
    for (let s = 0; s < set.high; s++) {
      if (!set.used[s]) continue;
      if (set.state(s) === 2) { held.push(s); continue; }
      const x = set.bx[s], y = set.by[s], z = set.bz[s];
      let m = 0;
      if (held.length || this.nHeld) {
        // (sideways only: the faces towards water at rest above and below are closed)
        if (isHeld(x - 1, y, z)) m |= 1;
        if (isHeld(x + 1, y, z)) m |= 2;
        if (this.dim === 3) {
          if (isHeld(x, y, z - 1)) m |= 16;
          if (isHeld(x, y, z + 1)) m |= 32;
        }
      }
      set.setState(s, 1 + m / 128);
    }
    this.nHeld = held.length;
    this.heldList.set(held);
    this._heldDirty = false;
    if (set.sync()) this._buildNb(this.levels[0]);
  }

  _sleepUniforms() {
    const p = this.params;
    const G = -p.gravity[1] * p.dt / p.h;
    return {
      uSleep: [p.sleepSpeed / p.dt, p.sleepP * G, p.sleepRho], uWake: [p.wakeSpeed / p.dt, p.wakeP * G, p.strongSpeed / p.dt],
      // (mist that hovers has the speed gravity adds in one step, G, and loses it again in the next)
      uMist: [p.mistMass, Math.max(2 * G, 0.02 / p.dt)],
    };
  }

  _coefUniforms(l) { return { uHeldInv: l ? 1 / (0.5 + 2 ** -(l + 1)) : 0, uHeldK: 1 / this.params.farZ }; }
  _projectUniforms() { return { uHeldK: 1 / this.params.farZ }; }

  _afterDensity() {
    if (!this.nHeld) return;
    const { glc, prog: P, T } = this;
    const L0 = this.levels[0];
    const U = { ...this._U(L0), ...this._farUniforms(), uFrac: T.frac, uRho: T.rho[0], uMerge: 0 };
    glc.draw(P.farDelta, this.R.d, U, { blend: true });
    this._farPending = true;
    glc.drawTiles(P.farReset, [T.rho[0], L0.p[0]], { ...U, uRho: T.frac }, this.heldList, L0.set.tile);
    this._only = this.heldList;
    try { this._computeLiq(); } finally { this._only = null; }
  }

  /**
   * What the steps since the last report (or the last call) moved into the held bricks, with a
   * blocking read-back: added to `absorbed`. The reports do the same without blocking; this is
   * for runs without them. Returns the largest |rho - rho at rest| found in a held brick before
   * its reset, summed over those steps.
   */
  readFar() {
    if (!this._farPending) return 0;
    const d = this.glc.read(this.R.d);
    this.glc.clear(this.R.d);
    this._farPending = false;
    let sum = 0, big = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += d[i];
      big = Math.max(big, d[i + 1]);
    }
    this.absorbed += sum;
    return big;
  }

  _U(L, L2 = L) {
    const a = L.set, b = L2.set;
    return {
      G: L.grid, GF: L2.grid, GC: L2.grid,
      uPg0: a.texTop, uLf0: a.texLeaf, uSl0: a.texSlot, uNb0: a.texNb,
      uPgX: b.texTop, uLfX: b.texLeaf,
      uAnchor: this.anchor, uCoarseSolids: this.params.coarseSolids, uSponge: this.params.sponge,
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
    // (_scatterSlots: the points of these slots only, see measureBodyForces)
    const ranges = this._scatterSlots ? { ranges: this._scatterSlots.map(([s, n]) => [s * this.CB * perCell, n * this.CB * perCell]) } : null;
    this.glc.scatter(p, target, { ...this._U(L), ...uniforms }, L.set.high * this.CB * perCell, { ...opts, ...ranges });
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
    this._unbooked = [];              // reports made but not yet entered into the books (_book), oldest first
    this._run = 0;                    // counts the resets: a report read back after one belongs to nothing
    this._lag = 0;                    // steps the reports took to arrive lately (reportAsync)
    this.report = null;               // summary of the last report acted on
    this.refused = 0;                 // bricks that were wanted while the pool was full
    // (x, y, z, size) -> true if the cube of `size` cells at world cell (x, y, z) lies inside a
    // solid that never moves, at least a cell and a half deep everywhere. Such bricks are not
    // stored (a missing brick is a wall already). Set by the owner; null = store everything.
    this.solidBrick = null;
    this.freedMass = 0;               // density (traces below wetMin, mist that hovered) in the bricks that were dropped
    this.water = [];
    this.nHeld = 0;
    this.heldList = glc.tileList();
    this.absorbed = 0;                // liquid that went into held bricks (net)
    this.displaced = 0;               // water at rest that solids have pushed out of the stored bricks since the reset
    this._farPending = false;
    this.pins = [];                   // boxes of world cells ({ lo, hi }) in which water at rest is solved; set by the owner
    this._pinStamp = 0;
    this.pinOf = [];
    this.calm = [];                   // per level-0 slot: steps it has been at rest
    this.drift = [];                  // ... and steps it has only drifted (see sleepSlow)
    this.wakingAt = [];               // per level-0 slot: the last report (its stamp) in which the brick had waking cells
    this.strongAt = [];               // ... and cells fast enough to wake a body
    this.since = [];                  // ... and the frame of its last change of state
    this.wakeOf = [];
    this.wokenAt = new Map();         // brick -> frame at which moving water last woke it
    this.onState = null;              // (x, y, z, 'wake' | 'sleep' | 'store' | 'drop') => for tests
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
    if (this.R) {
      if (this._farPending) this.readFar();
      for (const t of [...this.R.s, ...this.R.f, this.R.d]) glc.deleteTexture(t);
    }
    const tex = () => glc.texture(set.perRow, set.rows, 'rgba32f');
    // s: per-slot statistics (pass slotStats); f: what the CPU reads of them (pass slotFlags);
    // d: what the steps moved into each held brick (pass farDelta)
    this.R = { s: [tex(), tex(), tex(), tex()], f: [tex(), tex(), tex(), tex()], d: tex() };
    glc.clear(this.R.d);
    // (the last report stays the reference for what solids displace: slots keep their numbers when the pool grows)
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

  /**
   * Store brick (x, y, z) of level 0, with the water at rest that belongs there; `held`: as a
   * held brick. Returns false if the pool is full.
   */
  addBrick(x, y, z = 0, held = false) {
    const set = this.levels[0].set;
    if (set.get(x, y, z) >= 0 || set.marked(x, y, z)) return true;
    if (this.solidBrick && this.solidBrick(x * this.B, y * this.B, z * this.B, this.B)) { set.mark(x, y, z); return true; }
    if (set.count >= set.capacity && !this._grow0()) { this.refused++; return false; }
    const s = set.add(x, y, z);
    this.fresh.push(s);
    this.quiet[s] = 0;
    this.calm[s] = 0;
    this.drift[s] = 0;
    this.wakingAt[s] = 0;
    this.strongAt[s] = 0;
    this.pinOf[s] = 0;
    this.since[s] = this.frame;
    if (held) { set.setState(s, 2); this.nHeld++; this._heldDirty = true; }
    this._ref(1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
    if (this.onState) this.onState(x, y, z, 'store');
    return true;
  }

  removeBrick(x, y, z = 0) {
    const set = this.levels[0].set;
    const s = set.get(x, y, z);
    if (s < 0) return;
    if (set.state(s) === 2) this._heldDirty = true;
    set.remove(x, y, z);
    this._unref(1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
    if (this.onState) this.onState(x, y, z, 'drop');
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
    // (in a body of water these bricks are solved ones: with the water at rest around them)
    if (this.water.length) for (let z = b0[2]; z <= b1[2]; z++) for (let y = b0[1]; y <= b1[1]; y++) for (let x = b0[0]; x <= b1[0]; x++) this._activate(x, y, z);
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
    if (this._heldDirty || this.nHeld) this._syncHeld();

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
      // in a body of water: the water at rest
      if (this.water.length) {
        glc.drawTiles(P.farReset, [T.rho[0], L0.p[0]],
          { ...this._U(L0), ...this._farUniforms(), uFrac: T.frac, uRho: T.frac, uMerge: 0 }, this.freshList, L0.set.tile);
      }
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
    if (this.water.length) {
      // the liquid of the scene on top of the water at rest
      const { glc, prog: P, T } = this;
      const L0 = this.levels[0];
      glc.drawTiles(P.farReset, [T.rho[1], L0.p[0]],
        { ...this._U(L0), ...this._farUniforms(), uFrac: T.frac, uRho: T.rho[0], uMerge: 1 }, L0.set.list, L0.set.tile);
      this._swap(T.rho);
      this._computeLiq();
    }
    if (this._farPending) { this.glc.clear(this.R.d); this._farPending = false; }
    this._lastRest = null;
    this.displaced = 0;
    this.wokenAt.clear();
    this.reports = [];
    this._unbooked = [];
    this._run++;
    this._lag = 0;
    this.report = null;
    this.refused = 0;
    this.freedMass = 0;
    this.absorbed = 0;
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
    // the cells an edit can change lie within half a cell of its primitives
    const boxes = prims.map((p) => this._primBox(p, 1));
    if (this.nHeld) {
      // an edit of water at rest wakes it (a held brick would take the edit back at the next step)
      const held = this.levels[0].set;
      for (const { lo, hi } of boxes) {
        for (let z = Math.floor(lo[2] / B); z <= Math.floor((hi[2] - 1) / B); z++) {
          for (let y = Math.floor(lo[1] / B); y <= Math.floor((hi[1] - 1) / B); y++) {
            for (let x = Math.floor(lo[0] / B); x <= Math.floor((hi[0] - 1) / B); x++) {
              const t = held.get(x, y, z);
              if (t >= 0 && held.state(t) === 2) this._activate(x, y, z);
            }
          }
        }
      }
    }
    this._syncBricks();
    const T = this.T;               // (storing bricks may have replaced the pool textures)
    const L0 = this.levels[0];
    const set = L0.set;
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
   * that belong together, all as of this call (with blocking reports; non-blocking ones lag
   * behind): added, removed, the traces dropped with bricks (freed), the liquid stored, and for
   * scenes with bodies of water: how much of the stored liquid is more than the water at rest
   * (excess), what the held bricks have taken in (absorbed) and the water at rest that solids
   * have pushed out of the stored bricks (displaced). What must not change is
   *   excess - displaced + absorbed - added + removed + freed.
   */
  readLedgerAsync() {
    if (this._ledgerBusy) return;
    this._ledgerBusy = true;
    const p = this.glc.readAsync(this.ledger);
    this.glc.clear(this.ledger);      // (the read above has its copy already)
    const st = this.stored || { mass: 0, excess: 0 };
    const now = { freed: this.freedMass, stored: st.mass, excess: st.excess, absorbed: this.absorbed, displaced: this.displaced };
    p.then((d) => {
      this.added += d[0]; this.removed += d[1];
      this.books = { added: this.added, removed: this.removed, ...now };
    }, () => {}).finally(() => { this._ledgerBusy = false; });
  }

  step() {
    this._applyPins();
    if (this.params.lifecycle) this._lifecycle();
    this._syncBricks();
    super.step();
    if (this.params.lifecycle && this.frame % this.params.reportEvery === 0) this.makeReport();
  }

  // ------------------------------------------------------------------ brick lifecycle
  /** Per-brick statistics of the current state; read back at once or (reportAsync) when it arrives. */
  makeReport() {
    const { glc, prog: P, params: p } = this;
    this._syncBricks();
    const L0 = this.levels[0];
    const set = L0.set;
    const U = this._U(L0);
    const R = this.R;
    // steps the liquid moves between this state and the last step that still runs on the bricks
    // chosen from it (one more than strictly needed)
    // (read back without blocking, a report takes as long as the GPU is busy: the longest it took lately counts)
    const steps = (p.reportAsync ? Math.max(p.reportLag, Math.ceil(this._lag)) : p.reportDelay) + p.reportEvery + 1;
    this.refreshSlotStats();
    glc.draw(P.slotFlags, R.f, { ...U, ...this._farUniforms(), uS0: R.s[0], uS1: R.s[1], uS2: R.s[2], uS3: R.s[3], uD: R.d, uDt: p.dt, uSteps: steps, uMargin: p.margin });
    if (this._farPending) { glc.clear(R.d); this._farPending = false; }
    const n = set.high;
    const rep = {
      frame: this.frame, high: n, steps, data: null, lost: false, run: this._run,
      bx: set.bx.slice(0, n), by: set.by.slice(0, n), bz: set.bz.slice(0, n), used: set.used.slice(0, n),
    };
    this._unbooked.push(rep);
    const arrived = (d) => {
      rep.data = d;
      if (rep.run === this._run) this._lag = Math.max(this.frame - rep.frame, 0.98 * this._lag);
      this._book();
    };
    if (p.reportAsync) Promise.all(R.f.map((t) => glc.readAsync(t))).then(arrived, () => { rep.lost = true; this._book(); });
    else arrived(R.f.map((t) => glc.read(t, 0, 0, set.perRow, Math.max(1, Math.ceil(n / set.perRow)))));
    this.reports.push(rep);
    if (this.reports.length > 32) this.reports.shift();
    return rep;
  }

  /**
   * Enter the reports that have arrived into the books: the liquid stored, how much of it is
   * more than the water at rest, what the held bricks took in, and what solids have displaced
   * (see `books`). Oldest first: read back without blocking, reports can arrive out of order,
   * and each carries what the held bricks took in during its own steps only.
   */
  _book() {
    const q = this._unbooked;
    while (q.length && (q[0].data || q[0].lost || q[0].run !== this._run)) {
      const rep = q.shift();
      if (!rep.data || rep.run !== this._run) continue;
      const [A, , C, D] = rep.data;
      let mass = 0, excess = 0, absorbed = 0, displaced = 0;
      const last = this._lastRest;
      for (let s = 0; s < rep.high; s++) {
        absorbed += D[4 * s + 2];
        if (!rep.used[s]) continue;
        mass += A[4 * s];
        excess += D[4 * s];
        // (a brick has its water at rest when it is stored and when it is dropped: only what
        // changes in between counts)
        if (last && s < last.high && last.used[s] && last.bx[s] === rep.bx[s] && last.by[s] === rep.by[s] && last.bz[s] === rep.bz[s]) {
          displaced += last.data[2][4 * s + 3] - C[4 * s + 3];
        }
      }
      this.absorbed += absorbed;
      this.displaced += displaced;
      this._lastRest = rep;
      this.stored = { mass, excess, frame: rep.frame };
    }
  }

  /** The per-brick statistics (textures R.s) of the current state; the renderer reads them too. */
  refreshSlotStats() {
    const { glc, prog: P, T, params: p } = this;
    this._syncBricks();
    const L0 = this.levels[0];
    glc.draw(P.slotStats, this.R.s, {
      ...this._U(L0), ...this._farUniforms(), ...this._sleepUniforms(),
      uRho: T.rho[0], uVel: T.vel[0], uP: L0.p[0], uLiq: L0.liq, uFrac: T.frac, uWet: p.wetMin, uEdge: p.edgeMin,
    });
    this.statsFrame = this.frame;
    this._statsVersion = L0.set.version;
  }

  /** Sum of (density - density of the water at rest) over the stored bricks, with a blocking read-back. */
  excessSync() {
    this.refreshSlotStats();
    const set = this.levels[0].set;
    const d = this.glc.read(this.R.s[2], 0, 0, set.perRow, Math.max(1, Math.ceil(set.high / set.perRow)));
    let sum = 0;
    for (let s = 0; s < set.high; s++) if (set.used[s]) sum += d[4 * s + 3];
    return sum;
  }

  /**
   * Act on the newest report that has arrived:
   *   - store the bricks the liquid can reach before the next report is acted on (water at
   *     rest: held; anything else: solved)
   *   - wake the held bricks that moving liquid can reach, or that liquid flows into
   *   - hold solved bricks whose water has been at rest for a while
   *   - drop bricks that have been dry (or held) and out of reach of every solved brick for a while
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
    const [A, F, C, D] = rep.data;
    const water = this.water.length > 0;
    // a report that arrived later than assumed has to reach further
    const steps = Math.max(rep.steps, this.frame - rep.frame + p.reportEvery + 1);
    const far = NB_REACH * B;        // what the flags of the GPU cover
    const stamp = ++this._stamp;
    const want = [], wake = [], hard = [], dry = [], held = [], sleep = [];
    const sum = { frame: rep.frame, wet: 0, dry: 0, held: 0, edge: 0, mass: 0, excess: 0, maxSpeed: 0, looked: 0, refused: 0 };
    const inflow = p.inflow * B ** (dim - 1) * p.reportEvery;
    const lo = [0, 0, 0], hi = [0, 0, 0];
    // the bricks that cells lo..hi (packed as x + 16 y + 256 z) of brick b, widened by r cells, touch
    const each = (b, cl, ch, r, f) => {
      for (let d = 0; d < dim; d++) {
        lo[d] = b[d] + Math.floor((((cl >> (4 * d)) & 15) - r) / B);
        hi[d] = b[d] + Math.floor((((ch >> (4 * d)) & 15) + r) / B);
      }
      for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) f(x, y, z, set.get(x, y, z));
    };
    for (let s = 0; s < rep.high; s++) {
      if (!rep.used[s]) continue;
      // the slot may have changed hands since
      if (!set.used[s] || set.bx[s] !== rep.bx[s] || set.by[s] !== rep.by[s] || set.bz[s] !== rep.bz[s]) continue;
      const b = [rep.bx[s], rep.by[s], rep.bz[s]];
      sum.mass += A[4 * s];
      sum.edge += Math.round(A[4 * s + 2]);
      const flags = Math.round(C[4 * s + 2]);      // 1: its waking cells reach a held or missing brick, 2: those of another reach this one
      if (set.state(s) === 2) {
        sum.held++;
        // (what a brick took in in the step it was first put back to rest is how far it was from
        // rest itself, not something that flowed in: counted, it woke every brick the moment it
        // had gone to sleep, for one more second)
        const own = this.since[s] >= rep.frame - p.reportEvery;
        if (flags & 2 || (!own && D[4 * s + 3] > inflow)) wake.push(b[0], b[1], b[2]);
        else held.push(s);
        continue;
      }
      sum.excess += D[4 * s];
      const wet = A[4 * s + 3] > 0.5;
      const fw = water && this._farWet(b[0], b[1], b[2]);
      if (!wet && !fw) { dry.push(s); continue; }
      const speed = A[4 * s + 1];
      const r = Math.ceil(speed * p.dt) * steps + p.margin;
      const late = r > far || steps !== rep.steps;
      if (wet) {
        sum.wet++;
        this.quiet[s] = 0;
        if (speed > sum.maxSpeed) sum.maxSpeed = speed;
        if (F[4 * s + 2] > 0.5 || late) {
          sum.looked++;
          each(b, Math.round(F[4 * s]), Math.round(F[4 * s + 1]), r, (x, y, z, t) => {
            // (water at rest next to solved water at rest is stored on the same level only: _ring)
            const need = !fw || (y === b[1] && Math.abs(x - b[0]) <= 1 && Math.abs(z - b[2]) <= 1) || !this._farWet(x, y, z);
            if (t >= 0) { if (need) this.stampOf[t] = stamp; } else if (need && !set.marked(x, y, z)) want.push(x, y, z);
          });
        }
      }
      if (C[4 * s] >= 0) this.wakingAt[s] = stamp;
      const strong = D[4 * s + 1] >= 4194304;
      if (strong) this.strongAt[s] = stamp;
      if (water && C[4 * s] >= 0 && (flags & 1 || late)) {
        each(b, Math.round(C[4 * s]), Math.round(C[4 * s + 1]), r, (x, y, z, t) => {
          if (t >= 0) this.wakeOf[t] = stamp;
          if (t >= 0 ? set.state(t) === 2 : !set.marked(x, y, z)) (strong ? hard : wake).push(x, y, z);
        });
      }
      if (fw) {
        // cells not at rest: those that only move + 1024 * those whose pressure or density is off
        const free = !(flags & 2) && !(this.pinOf[s] > this._pinStamp - p.pinHold);
        const calm = free && D[4 * s + 1] < 0.5;
        const drift = free && !strong && D[4 * s + 1] < 1023.5 && C[4 * s] < 0;
        this.calm[s] = calm ? (this.calm[s] || 0) + p.reportEvery : 0;
        this.drift[s] = drift ? (this.drift[s] || 0) + p.reportEvery : 0;
        if ((this.calm[s] >= p.sleepAfter || this.drift[s] >= p.sleepSlow) && this.frame - (this.since[s] || 0) >= p.awakeMin) sleep.push(s);
      }
    }
    for (let i = 0; i < want.length; i += 3) {
      const x = want[i], y = want[i + 1], z = want[i + 2];
      this.addBrick(x, y, z, water && this._farWet(x, y, z));
    }
    // Water at rest is woken within a budget of solved bricks (maxSolved), and the same brick
    // not again for a while (rewake): a brick at the edge of what the waves reach would
    // otherwise go to sleep and wake up with every group of waves. That is for waves that are
    // about as fast as waking. Liquid fast enough to wake a body (`hard`: something has fallen
    // in, a bow wave) wakes the water whenever it comes. Refused, a lump of water landing on
    // water that had just gone back to rest was taken in by the held bricks without a splash,
    // and the mist of its tail stayed in the air above them for good.
    let room = (p.maxSolved || (dim === 3 ? 3000 : 600)) - (set.count - this.nHeld);
    for (const list of [hard, wake]) {
      for (let i = 0; i < list.length; i += 3) {
        const x = list[i], y = list[i + 1], z = list[i + 2];
        let t = set.get(x, y, z);
        if (t < 0 || set.state(t) === 2) {
          if (water && this._farWet(x, y, z)) {
            const k = `${x},${y},${z}`;
            if (room <= 0 || (list === wake && this.frame - (this.wokenAt.get(k) ?? -Infinity) < p.rewake)) { sum.refused++; continue; }
            this.wokenAt.set(k, this.frame);
          }
          t = this._activate(x, y, z);
          room--;
        }
        if (t >= 0) this.wakeOf[t] = stamp;
      }
    }
    if (this.wokenAt.size > 20000) for (const [k, f] of this.wokenAt) if (this.frame - f >= p.rewake) this.wokenAt.delete(k);
    for (const s of sleep) {
      if (this.wakeOf[s] === stamp) { this.calm[s] = 0; this.drift[s] = 0; continue; }
      this.setHeld(set.bx[s], set.by[s], set.bz[s], true);
    }
    // held bricks are there for the solved ones next to them
    const K = dim === 3 ? 1 : 0;
    const besideSolved = (x, y, z) => {
      for (let k = -K; k <= K; k++) {
        for (let i = -1; i <= 1; i++) {
          const t = i || k ? set.get(x + i, y, z + k) : -1;
          if (t >= 0 && set.state(t) !== 2) return true;
        }
      }
      return false;
    };
    for (const s of held) {
      if (F[4 * s + 3] > 0.5 || this.stampOf[s] === stamp || this.pinOf[s] === this._pinStamp) { this.quiet[s] = 0; continue; }
      this.quiet[s] = (this.quiet[s] || 0) + 1;
      if (this.quiet[s] < p.freeAfter) continue;
      // (the report is of a state some steps back: a brick beside it may have been woken since)
      if (besideSolved(rep.bx[s], rep.by[s], rep.bz[s])) { this.quiet[s] = 0; continue; }
      this.removeBrick(rep.bx[s], rep.by[s], rep.bz[s]);
    }
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

  /** As FluidSim.measureBodyForces, over the bricks around the bodies only. */
  measureBodyForces(prims) {
    this._syncBricks();
    // the force comes from the cells within a cell and a half of a body's surface
    const set = this.levels[0].set, B = this.B;
    const slots = new Set();
    for (const p of prims) {
      const { lo, hi } = this._primBox(p, 2);
      for (let z = Math.floor(lo[2] / B); z <= Math.floor((hi[2] - 1) / B); z++) {
        for (let y = Math.floor(lo[1] / B); y <= Math.floor((hi[1] - 1) / B); y++) {
          for (let x = Math.floor(lo[0] / B); x <= Math.floor((hi[0] - 1) / B); x++) {
            const s = set.get(x, y, z);
            if (s >= 0) slots.add(s);
          }
        }
      }
    }
    // runs of consecutive slots: [first, count]
    const runs = [];
    for (const s of [...slots].sort((a, b) => a - b)) {
      const last = runs[runs.length - 1];
      if (last && last[0] + last[1] === s) last[1]++; else runs.push([s, 1]);
    }
    this._scatterSlots = runs;
    try {
      return super.measureBodyForces(prims);      // (the pass is drawn before this returns; the result follows)
    } finally {
      this._scatterSlots = null;
    }
  }

  /**
   * Has liquid been moving (faster than wakeSpeed, below the surface; `strong`: than strongSpeed)
   * in a brick that touches the box of world cells [lo, hi)? By the last report acted on.
   */
  wakingIn(lo, hi, strong = false) {
    const at = strong ? this.strongAt : this.wakingAt;
    const B = this.B, set = this.levels[0].set;
    for (let z = Math.floor(lo[2] / B); z <= Math.floor((hi[2] - 1) / B); z++) {
      for (let y = Math.floor(lo[1] / B); y <= Math.floor((hi[1] - 1) / B); y++) {
        for (let x = Math.floor(lo[0] / B); x <= Math.floor((hi[0] - 1) / B); x++) {
          const s = set.get(x, y, z);
          if (s >= 0 && at[s] === this._stamp) return true;
        }
      }
    }
    return false;
  }

  dispose() {
    super.dispose();
    const glc = this.glc;
    for (const L of this.levels) L.set.dispose();
    for (const t of [...this.R.s, ...this.R.f, this.R.d, ...this._resolved.values(), this._noTerrain, this.ledger, ...this.M]) glc.deleteTexture(t);
    this.heldList.dispose();
    this.freshList.dispose();
    this.editList.dispose();
  }
}
