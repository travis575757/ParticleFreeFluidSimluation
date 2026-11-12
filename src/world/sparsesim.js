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
import { BRICK, NB_REACH, MAX_WATER, LEAF_LOG } from '../shaders/common.js';
import { farLevel } from './water.js';
import { sparseShaders } from '../shaders/sparse.js';
import { hfCoupleShaders } from '../shaders/hfcouple.js';
import { BrickSet } from './bricks.js';
import { Swell } from './swell.js';

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
  evict: 1,          // ... and liquid that falls into the water gets the bricks it lands in by sending the calmest
                     // solved bricks to sleep in exchange: it splashes, whatever else is going on
  rewake: 600,       // steps before moving water may wake the same brick again (pins and fast water always wake)
  pinHold: 120,      // steps a pinned brick stays solved after the pin has left it. A body that bobs moves the
                     // edge of its box across a brick boundary and back once per bob; without this the brick
                     // there went to sleep and was woken again every second.
  heldFloor: 1,      // on the coarse levels of the pressure solve held water above and below solved water is closed
                     // to it, as on the finest (0: coupled through the averaged face weights, as it was at first)
  swell: 1,          // 3D, with bodies of water: a map of the surface carries the waves on over the water that is
                     // not solved (src/world/swell.js)
  // over a height field (setHeightField)
  heldLive: -1,      // the faces between solved and held liquid keep their velocity (1) or let waves out (0: see
                     // "project" in shaders/sim.js); -1: the first over a height field, the second without one
  heldKeep: -1,      // the density passes move nothing between two held cells and let through a held face what
                     // the velocity says (1; "advGather" in shaders/sim.js), or treat held cells like any
                     // other (0); -1: the first over a height field, the second without one
  hfWake: 0,         // 1: moving water wakes the water next to it, as in a body of water at rest; 0: only fast
                     // water does (strongSpeed). The height field carries waves by itself.
  hfLook: 4,         // steps between looks at where the water of the height field is
  // A column of bricks goes back to the height field when it holds what a height field can: one
  // surface, a pressure close to hydrostatic, a gentle slope, no faster against the mean of the
  // column than such a slope makes it. (Not: at rest. A river is never at rest.)
  hfSleepSpeed: 0.05,  // against the mean velocity of the column, cells per step (a long wave of slope 0.1 on 12 cells of water: 0.06 at its surface)
  hfSleepP: 0.25,      // from the pressure of the column at rest, cells of head
  hfSleepRho: 0.6,     // from its density: more is liquid over air, a second surface
  hfSleepSlope: 0.1,   // of the surface, between texels of the height field
  hfMistMass: 8,       // mistMass over a height field
  hfSleepBed: 2,       // ... pressure and density not counting in this many cells over the bed (see "slotStats")
  hfSleepAfter: 120,   // steps a column has to be like that
  hfAwakeMin: 120,     // steps a column is solved at least
  hfRewake: 600,       // a column that is solved again within this many steps of being handed back stays solved twice as
  hfAwakeMax: 9600,    // long as the last time (this long at least, and no longer than hfAwakeMax): see _hfWoken
  hfWakeSpeed: 0.15,   // what counts as moving next to a brick that would go back (see wakeSpeed)
  // ... and is taken from it where it holds what a height field cannot (every hfLook steps, "cols" in shaders/hfcouple.js)
  hfPromote: 1,
  hfSteep: 0.3,        // a front: steeper than this between two texels ...
  hfBreak: 0.5,        // ... and higher than this share of the depth before it (a bore about to break; water coming over a dry bed)
  hfFall: 1,           // water leaves the bed: it runs over a drop steeper than this, down to a level below the lip ...
  hfFallMin: 0.2,      // ... and is at least this deep on the lip (cells)
  hfFallSpeed: 0.02,   // ... and runs over it at least this fast (cells per step)
  hfPromoteRadius: 0,  // only within this many cells of what the camera looks at (hfFocus); 0: wherever it is
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
    P.farVelFill = glc.program('farVelFill', S.farVelFill, VS_TILES);
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

  /**
   * The bodies of water: [{ box: [x0, z0, x1, z1] (cells, as the primitives), level }], at most MAX_WATER.
   * swell: { center: [x, z], params } for the map of the surface (Swell).
   */
  setWater(bodies, swell = {}) {
    if (bodies.length > MAX_WATER) throw new Error(`too many bodies of water (${bodies.length} > ${MAX_WATER})`);
    this.water = bodies;
    this._waterU = null;
    if (this.swell) { this.swell.dispose(); this.swell = null; }
    if (this.dim === 3 && bodies.length && this.params.swell && !this.hf) this.swell = new Swell(this, swell);
  }

  /** Is there water that is not solved: bodies of water at rest, or a height field? */
  get farOn() { return this.water.length > 0 || !!this.hf; }

  _farUniforms() {
    const p = this.params;
    const G = -p.gravity[1] * p.dt / p.h;
    let U = this._waterU;
    if (!U || U.G !== G || U.n !== this.water.length) {
      const box = new Float32Array(4 * MAX_WATER), lvl = new Float32Array(4 * MAX_WATER);
      this.water.forEach((w, i) => {
        const f = farLevel(w.level, G, p.thetaMin);
        box.set(w.box, 4 * i);
        lvl.set([w.level, f.top, f.pTop, G], 4 * i);
      });
      U = this._waterU = { G, n: this.water.length, box, lvl };
    }
    const out = { uWaterN: U.n, uWaterBox: U.box, uWaterLvl: U.lvl, uHeldLive: this.heldLive, uHeldKeep: p.heldKeep < 0 ? (this.hf ? 1 : 0) : p.heldKeep };
    const { hf, hfc } = this;
    if (hf) {
      const b0 = this._hfBrick0();
      out.uHf = hf.H[0];
      out.uHfBed = hf.Bd;
      out.uHfCols = hfc.cols;
      out.uHfMap = [hf.origin[0], hf.origin[1], 1 / hf.cell, 1];
      out.uHfG = [G, p.thetaMin, 0, 0];
      out.uHfColsMap = [b0[0], b0[1], hfc.nc[0], hfc.nc[1]];
    } else {
      out.uHf = out.uHfBed = out.uHfCols = this._noTerrain;
      out.uHfMap = [0, 0, 1, 0];
      out.uHfG = [G, p.thetaMin, 0, 0];
      out.uHfColsMap = [0, 0, 1, 1];
    }
    return out;
  }

  /** 1 if the faces between solved and held liquid keep their velocity (params.heldLive). */
  get heldLive() { return this.params.heldLive < 0 ? (this.hf ? 1 : 0) : this.params.heldLive; }

  // ------------------------------------------------------------------ height field
  // Over the map of a height field (src/world/heightfield.js) the water that is not solved is
  // not at rest: the height field moves it. What is said above of water at rest holds with
  // these differences:
  //   - The state a held brick is put back to is that of the height field: its level, the
  //     pressure under it, its velocity. What a step moved into the held bricks goes into the
  //     height field (_hfExchange; src/shaders/hfcouple.js has the bookkeeping).
  //   - A column of bricks is solved from the bed to the surface, or not at all: the height
  //     field has one depth per column and cannot stand for the lower half of one.
  //   - Waves do not wake the water they run into (params.hfWake): the height field takes them.
  //     Fast water does, and pins.

  /**
   * The height field that holds the water of its map wherever this solver does not solve it, or
   * null. Its origin has to be the corner of a brick, a brick a whole number of its texels.
   * Set it, and its state, before reset(): the liquid of the scene is added to it there.
   */
  setHeightField(hf) {
    const glc = this.glc;
    if (this.hfc) for (const t of [...this.hfc.C, this.hfc.C1, this.hfc.cols, this.hfc.look, this.hfc.W, ...(this.hfc.groups ? [this.hfc.groups.tex] : [])]) glc.deleteTexture(t);
    this.hf = hf || null;
    this.hfc = null;
    this.hfWater = null;
    this.hfFocus = null;              // [x, z] of what the camera looks at (cells), or null: see _hfPromote
    if (!hf) return;
    const { B, dim } = this;
    if (B % hf.cell) throw new Error(`a brick (${B} cells) is no whole number of texels of the height field (${hf.cell} cells)`);
    if ((dim === 3) !== (hf.n[1] > 1)) throw new Error('the height field of a 3D world is a map, that of a 2D world a row');
    const per = B / hf.cell;
    const nc = [Math.ceil(hf.n[0] / per), Math.ceil(hf.n[1] / per)];
    const key = dim + ':' + hf.cell;
    if (!this._hfProg) this._hfProg = new Map();
    if (!this._hfProg.has(key)) {
      const S = hfCoupleShaders(dim, hf.cell);
      this._hfProg.set(key, {
        column: glc.program('hf.column', S.column), fold: glc.program('hf.fold', S.fold), cols: glc.program('hf.cols', S.cols),
        water: glc.program('hf.water', S.water),
      });
    }
    const tex = (n) => glc.texture(n[0], n[1], 'rgba32f');
    const data = new Float32Array(4 * nc[0] * nc[1]);
    for (let k = 0; k < nc[0] * nc[1]; k++) { data[4 * k] = 1e30; data[4 * k + 1] = -1e30; }    // dry until looked at
    this.hfc = {
      P: this._hfProg.get(key),
      C: [tex(hf.n), tex(hf.n)],      // what "column" found: now, and when the height field last took account of it
      C1: tex(hf.n),                  // ... and the velocities it found at the faces of the texels
      W: tex(hf.n),                   // see hfWaterSync()
      per, nc,
      cols: tex(nc), look: tex(nc),   // per column of bricks: see _hfLook and _hfRows
      data,
      flags: new Uint8Array(nc[0] * nc[1]),   // per column: what "cols" found that a height field cannot hold
      locked: new Uint8Array(nc[0] * nc[1]),  // per column: 1 if it stays the height field's (hfLock)
      promoted: new Uint8Array(nc[0] * nc[1]), // per column: 1 if it is solved because of a flag (_hfPromote)
      up: new Uint8Array(nc[0] * nc[1]),      // per column: 1 while it is solved
      stay: new Int32Array(nc[0] * nc[1]),    // ... the steps it stays solved at least (_hfWoken)
      left: new Int32Array(nc[0] * nc[1]).fill(-1e9),  // ... the step at which it was last handed back
      promote: false,                 // some column has such a flag, and has not been looked at
      dirty: true,                    // `data` has changed since it was uploaded
      rebase: true,                   // the set of bricks has changed since "column" last ran
      busy: false,
      run: 0,
      version: 0,                     // of `cols`, as uploaded
      groups: null,                   // see hfGroups()
    };
    glc.clear(this.hfc.C[0]);
    glc.clear(this.hfc.C[1]);
    glc.clear(this.hfc.C1);
    if (this.swell) { this.swell.dispose(); this.swell = null; }
    this.hfLock();
  }

  _hfWaterTop() {
    const { glc, hf, hfc } = this;
    glc.draw(hfc.P.water, hfc.W, { uH: hf.H[0], uX: hf.X[0], uC0: hfc.C[0], uInvArea: 1 / hf.area, uDry: hf.params.dry });
    return hf._reduce('sum', hfc.W);
  }

  /**
   * All the water over the height field's map (cells^3; 2D: cells^2): its depths, what it has
   * been handed and has not taken in yet, and the liquid in solved bricks over columns that
   * are not the 3D solver's. Also sets hfTiers: texels that are the 3D solver's, texels that are wet.
   */
  hfWaterSync() {
    const d = this.glc.read(this._hfWaterTop());
    this.hfTiers = { solved: d[1], wet: d[2] };
    return (this.hfWater = d[0] * this.hf.area);
  }

  /** The same without blocking: hfWater and hfTiers follow a few frames later. Resolves with the water as of this call. */
  hfWaterAsync() {
    if (this._hfWaterBusy) return this._hfWaterRead;
    this._hfWaterBusy = true;
    const hfc = this.hfc, area = this.hf.area;
    return (this._hfWaterRead = this.glc.readAsync(this._hfWaterTop())
      .then((d) => {
        if (this.hfc === hfc) { this.hfWater = d[0] * area; this.hfTiers = { solved: d[1], wet: d[2] }; }
        return d[0] * area;
      }, () => null)
      .finally(() => { this._hfWaterBusy = false; }));
  }

  /**
   * Note where the height field has sources and links (HeightField.lockBoxes): the columns of
   * bricks that touch them stay the height field's, whatever happens there. A source acts on
   * the height field's own water; under solved bricks it would do nothing. Call again when
   * the sources or links change.
   */
  hfLock() {
    const { hf, hfc, B } = this;
    if (!hfc) return;
    hfc.locked.fill(0);
    const b0 = this._hfBrick0(), nc = hfc.nc;
    for (const box of hf.lockBoxes()) {
      const i0 = Math.max(Math.floor(box[0] / B) - b0[0], 0), i1 = Math.min(Math.ceil(box[2] / B) - b0[0], nc[0]);
      const j0 = Math.max(Math.floor(box[1] / B) - b0[1], 0), j1 = this.dim === 3 ? Math.min(Math.ceil(box[3] / B) - b0[1], nc[1]) : 1;
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) hfc.locked[j * nc[0] + i] = 1;
    }
  }

  /** Is the column of bricks (x, z) one the height field keeps (hfLock)? */
  _hfLocked(x, z) {
    const k = this._hfCol(x, z);
    return k >= 0 && this.hfc.locked[k] === 1;
  }

  /** Brick x and z of the corner of the height field's map. */
  _hfBrick0() {
    const { hf, B, anchor: a } = this;
    const x = (hf.origin[0] + a[0]) / B, z = this.dim === 3 ? (hf.origin[1] + a[2]) / B : 0;
    if (!Number.isInteger(x) || !Number.isInteger(z)) throw new Error('the corner of the height field is not the corner of a brick');
    return [x, z];
  }

  /** Index of the column of bricks (x, z) in the height field's table, or -1 if it is not over its map. */
  _hfCol(x, z) {
    if (!this.hf) return -1;
    const b0 = this._hfBrick0(), nc = this.hfc.nc;
    const i = x - b0[0], k = this.dim === 3 ? z - b0[1] : 0;
    return i >= 0 && k >= 0 && i < nc[0] && k < nc[1] ? k * nc[0] + i : -1;
  }

  /** The rows [first, last] of bricks that hold water of the height field in column (x, z); null if it is dry or not over the map. */
  _hfSpan(x, z) {
    const k = this._hfCol(x, z);
    if (k < 0) return null;
    const d = this.hfc.data, lo = d[4 * k], hi = d[4 * k + 1];
    if (!(hi > lo)) return null;
    const a1 = this.anchor[1], B = this.B;
    return [Math.floor((lo + a1) / B), Math.ceil((hi + a1) / B) - 1];
  }

  /** Is column (x, z) of a height field the solver's: is the lowest brick of its water (rows `span`) solved? */
  _hfOwned(x, z, span = this._hfSpan(x, z)) {
    if (!span) return false;
    const set = this.levels[0].set;
    let y0 = span[0];
    while (y0 < span[1] && set.marked(x, y0, z)) y0++;
    const t = set.get(x, y0, z);
    return t >= 0 && set.state(t) !== 2;
  }

  /**
   * Is brick (x, y, z) the one over the water of a column of the height field that is not the
   * solver's? Such a brick is held like the water under it, a copy of the air there, unless it
   * has liquid of the solver's in it: it is stored held, and held as soon as it is empty.
   * Solved and empty, it was filled from the side whenever a crest of the height field came by:
   * the copy of the crest in the column next to it stands higher than its floor, and runs into
   * it like water through a breach. Taken for liquid of the solver's, that had bricks stored
   * all round it, which the crest filled in turn as it went on: a patch of solved bricks that
   * ran out to sea with every wave, a thousand of them. Held, the brick takes what comes into
   * it from the solved bricks beside and above it, and the height field has it. (Liquid that
   * falls towards such a brick wakes the column under it first: _lifecycle.)
   */
  _hfHead(x, y, z) {
    if (!this.hfc) return false;
    const span = this._hfSpan(x, z);
    return !!span && y === span[1] + 1 && !this._hfOwned(x, z, span);
  }

  /**
   * Where the water of the height field is, per column of bricks: its lowest bed and highest
   * level (what _farWet and farWetBrick() of the shaders go by). Read back; `block`: at once.
   */
  _hfLook(block = false) {
    const { glc, hf, hfc } = this;
    if (hfc.busy && !block) return;
    const p = this.params;
    glc.draw(hfc.P.cols, hfc.look, {
      uH: hf.H[0], uBed: hf.Bd, uPer: hfc.per, uDry: hf.params.dry, uDx: hf.cell,
      uSteep: p.hfSteep, uBreak: p.hfBreak, uFall: p.hfFall, uFallMin: p.hfFallMin, uFallSpeed: p.hfFallSpeed / p.dt,
    });
    const take = (d) => {
      const out = hfc.data;
      let any = false;
      for (let k = 0; k < out.length; k += 4) {
        // (a cell lower: the bed of a texel is the mean of the ground under it)
        out[k] = d[k] - 1;
        out[k + 1] = d[k + 1];
        const f = Math.round(d[k + 2]);
        hfc.flags[k >> 2] = f;
        if (f) any = true;
      }
      hfc.dirty = true;
      hfc.tidy = true;
      hfc.promote = any;
    };
    if (block || !this.params.reportAsync) { take(glc.read(hfc.look)); return; }
    hfc.busy = true;
    const run = hfc.run;
    glc.readAsync(hfc.look).then((d) => { if (this.hfc === hfc && run === hfc.run) take(d); }, () => {}).finally(() => { hfc.busy = false; });
  }

  /** The table of the columns as the shaders read it: with the rows of bricks stored in each. */
  _hfRows() {
    const { hfc } = this;
    const set = this.levels[0].set, d = hfc.data;
    for (let k = 0; k < d.length; k += 4) { d[k + 2] = 0; d[k + 3] = 0; }
    for (let s = 0; s < set.high; s++) {
      if (!set.used[s]) continue;
      const k = this._hfCol(set.bx[s], set.bz[s]);
      if (k < 0) continue;
      const y = set.by[s];
      if (d[4 * k + 3] === d[4 * k + 2]) { d[4 * k + 2] = y; d[4 * k + 3] = y + 1; continue; }
      if (y < d[4 * k + 2]) d[4 * k + 2] = y;
      if (y >= d[4 * k + 3]) d[4 * k + 3] = y + 1;
    }
    hfc.dirty = true;
  }

  _hfUpload() {
    const hfc = this.hfc;
    if (!hfc.dirty) return;
    this.glc.upload(hfc.cols, hfc.data);
    hfc.dirty = false;
    hfc.version++;
  }

  /**
   * For the renderer, which skips 16 x 16 columns of bricks at a time where none is stored: the
   * lowest bed and the highest level of the height field's water per such group, as a texture
   * { tex, map: [group x, group z of texel (0, 0), size] }.
   */
  hfGroups() {
    const { hfc, glc } = this;
    this._hfUpload();
    const b0 = this._hfBrick0(), nc = hfc.nc, LS = LEAF_LOG;
    const g0 = [b0[0] >> LS, b0[1] >> LS];
    const n = [((b0[0] + nc[0] - 1) >> LS) - g0[0] + 1, ((b0[1] + nc[1] - 1) >> LS) - g0[1] + 1];
    let g = hfc.groups;
    if (!g) g = hfc.groups = { tex: glc.texture(n[0], n[1], 'rgba32f'), data: new Float32Array(4 * n[0] * n[1]), map: [g0[0], g0[1], n[0], n[1]], version: -1 };
    if (g.version !== hfc.version) {
      const d = hfc.data, o = g.data;
      for (let k = 0; k < o.length; k += 4) { o[k] = 1e30; o[k + 1] = -1e30; }
      for (let j = 0; j < nc[1]; j++) {
        for (let i = 0; i < nc[0]; i++) {
          const k = 4 * (j * nc[0] + i);
          if (!(d[k + 1] > d[k])) continue;
          const q = 4 * ((((b0[1] + j) >> LS) - g0[1]) * n[0] + ((b0[0] + i) >> LS) - g0[0]);
          if (d[k] < o[q]) o[q] = d[k];
          if (d[k + 1] > o[q + 1]) o[q + 1] = d[k + 1];
        }
      }
      glc.upload(g.tex, o);
      g.version = hfc.version;
    }
    return g;
  }

  /** Count the liquid of the stored bricks per texel of the height field ("column" in src/shaders/hfcouple.js). */
  _hfGather() {
    const { glc, hfc, T } = this;
    this._hfUpload();
    glc.draw(hfc.P.column, [hfc.C[1], hfc.C1], { ...this._U(this.levels[0]), uRho: T.rho[0], uFrac: T.frac, uVel: T.vel[0] });
    hfc.C.reverse();
  }

  /** Let the height field take account of what _hfGather found ("fold"). mode 1: the bricks have changed, the liquid has not; 2: a scene has been set up. */
  _hfFold(mode, prev = this.hfc.C[1]) {
    const { glc, hf, hfc } = this;
    glc.draw(hfc.P.fold, [hf.H[1], hf.X[1]], { uH: hf.H[0], uX: hf.X[0], uC0: hfc.C[0], uC1: hfc.C1, uPrev: prev, uInvArea: 1 / hf.area, uMode: mode, uOne: 1 });
    hf.H.reverse();
    hf.X.reverse();
  }

  /**
   * After the density passes of a step: the height field takes what the step moved into the
   * held bricks and what the solved ones gained, and makes its own step.
   */
  _hfExchange() {
    this._hfGather();
    this._hfFold(0);
    this.hf.step(this.params.dt);
  }

  /**
   * The bricks have changed (stored, dropped, held, woken): columns change hands, and the height
   * field's count of the solved liquid starts afresh. Bricks that have just been stored hold the
   * water at rest by now; those that have just been held still hold what they did.
   */
  _hfRebase() {
    const hfc = this.hfc;
    hfc.rebase = false;
    this._hfRows();
    this._hfGather();
    this._hfFold(1);
  }

  /** Hold brick (x, y, z) of level 0, or solve it again. */
  setHeld(x, y, z, held) {
    const set = this.levels[0].set;
    const s = set.get(x, y, z);
    if (s < 0 || (set.state(s) === 2) === held) return;
    set.setState(s, held ? 2 : 1);
    this.nHeld += held ? 1 : -1;
    this._heldDirty = true;
    if (this.hfc) {
      this.hfc.rebase = true;
      if (held) {
        this._newHeld.push(s);
        const k = this._hfCol(x, z);
        if (k >= 0 && this.hfc.up[k]) { this.hfc.up[k] = 0; this.hfc.left[k] = this.frame; }
      }
    }
    this.since[s] = this.frame;
    this.calm[s] = 0;
    this.drift[s] = 0;
    if (this.onState) this.onState(x, y, z, held ? 'sleep' : 'wake');
  }

  /** Does brick (x, y, z) hold water of some body at rest? (Cell centres and rows as farState() of the shaders.) */
  _farWet(x, y, z) {
    const B = this.B, a = this.anchor;
    const x0 = x * B - a[0], y0 = y * B - a[1], z0 = z * B - a[2];
    const k = this._hfCol(x, z);
    if (k >= 0) {
      const d = this.hfc.data;
      return d[4 * k + 1] > d[4 * k] && y0 < d[4 * k + 1] && y0 + B > d[4 * k];
    }
    for (const w of this.water) {
      if (y0 >= w.level) continue;
      if (x0 + B - 0.5 < w.box[0] || x0 + 0.5 > w.box[2]) continue;
      if (this.dim === 3 && (z0 + B - 0.5 < w.box[1] || z0 + 0.5 > w.box[3])) continue;
      return true;
    }
    return false;
  }

  /**
   * Is brick (x, y, z) the one over the surface of a body of water: wet at rest, but not even its
   * lowest row is full? (A level a quarter of a cell above a brick boundary: the brick below
   * holds the top liquid row, this one the quarter.) Such a brick is solved whenever the one
   * below it is. Held, it is no lid to the water below (the face under a cell that is not full
   * stays open), and it takes in every crest that rises into it: the surface of the solved water
   * under it could not rise above rest, in patches the shape of the bricks.
   */
  _overSurface(x, y, z) {
    const B = this.B, a = this.anchor;
    const x0 = x * B - a[0], y0 = y * B - a[1], z0 = z * B - a[2];
    const k = this._hfCol(x, z);
    if (k >= 0) {
      const d = this.hfc.data;
      return d[4 * k + 1] > d[4 * k] && y0 < d[4 * k + 1] && y0 > d[4 * k + 1] - 1;
    }
    for (const w of this.water) {
      if (y0 >= w.level || y0 <= w.level - 1) continue;
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
        if (set.get(X, y, Z) >= 0 || set.marked(X, y, Z)) continue;
        if (this._farWet(X, y, Z)) this.addBrick(X, y, Z, true);
        // (what is solid throughout is marked so now: the water woken here stands against it
        // before any report has looked that way, and is not at the edge of what is stored)
        else if (this.solidBrick && this.solidBrick(X * this.B, y * this.B, Z * this.B, this.B)) set.mark(X, y, Z);
      }
    }
  }

  /** Store brick (x, y, z) as a solved one, or wake it; returns its slot, or -1 (pool full, or inside a solid). */
  _solve(x, y, z) {
    const set = this.levels[0].set;
    let s = set.get(x, y, z);
    if (s < 0) {
      if (!this.addBrick(x, y, z)) return -1;
      s = set.get(x, y, z);
      if (s >= 0) { this.causes[this._cause] = (this.causes[this._cause] || 0) + 1; this._hfWoken(x, z); }
    } else if (set.state(s) === 2) {
      this.setHeld(x, y, z, false);
      this.causes[this._cause] = (this.causes[this._cause] || 0) + 1;
      this._hfWoken(x, z);
    }
    return s;
  }

  /**
   * Column (x, z) of a height field has become the solver's. How long it stays that at least
   * (hfAwakeMin) grows if it keeps coming back: a column that is solved again soon after it was
   * handed over (hfRewake) is one where the two descriptions do not agree, a standing jump at
   * the foot of a chute for one. The solver smooths it until a height field could hold it, the
   * height field steepens it until it cannot, and the column would change hands every few
   * seconds for good. Each time round it stays solved twice as long.
   */
  _hfWoken(x, z) {
    const k = this._hfCol(x, z);
    if (k < 0) return;
    const c = this.hfc, p = this.params;
    if (c.up[k]) return;
    c.up[k] = 1;
    c.stay[k] = this.frame - c.left[k] < p.hfRewake ? Math.min(Math.max(2 * c.stay[k], p.hfRewake), p.hfAwakeMax) : p.hfAwakeMin;
  }

  /** Hold brick (x, y, z) and what goes to sleep with it: the brick over the surface; over a height field, its column. */
  _hold(x, y, z) {
    const set = this.levels[0].set;
    const span = this._hfSpan(x, z);
    if (span && y >= span[0] && y <= span[1]) {
      for (let Y = span[0]; Y <= span[1]; Y++) this.setHeld(x, Y, z, true);
      return;
    }
    this.setHeld(x, y, z, true);
    if (set.get(x, y + 1, z) >= 0 && this._overSurface(x, y + 1, z)) this.setHeld(x, y + 1, z, true);
  }

  /**
   * Make brick (x, y, z) a solved one: stored if it was not (with the water at rest that belongs
   * there), woken if it was held, and with the water at rest around it stored. Returns its slot,
   * or -1 if it is not stored (pool full, or inside a solid).
   */
  _activate(x, y, z) {
    if (this.hfc && this._hfLocked(x, z) && this._farWet(x, y, z)) return -1;
    const s = this._solve(x, y, z);
    if (s < 0 || !this.farOn) return s;
    const span = this._hfSpan(x, z);
    if (span && y >= span[0] && y <= span[1]) {
      // over a height field: the column, from the bed to the surface
      for (let Y = span[0]; Y <= span[1]; Y++) {
        if (Y !== y) this._solve(x, Y, z);
        this._ring(x, Y, z);
      }
      return s;
    }
    this._ring(x, y, z);
    if (this._overSurface(x, y + 1, z)) this._activate(x, y + 1, z);
    return s;
  }

  /**
   * Over a height field a column of bricks is solved from the bed to the surface or not at all:
   * the height field has one depth per column. The surface moves and the lifecycle works brick
   * by brick; what they leave in between is put right here. The lowest brick of a column's
   * water decides. With it solved, so is the rest up to the surface (the level has risen into a
   * new row). Without, a solved brick that the water has risen into is held: what it holds
   * beyond the water at rest goes to the height field ("fold" in src/shaders/hfcouple.js). And
   * the water next to solved bricks is stored, held: the height field's water may have come
   * there since they were.
   */
  _hfTidy() {
    const set = this.levels[0].set, n = set.high;
    this._cause = 'column';
    for (let s = 0; s < n; s++) {
      if (!set.used[s] || set.state(s) === 2) continue;
      const x = set.bx[s], y = set.by[s], z = set.bz[s];
      if (this._hfCol(x, z) < 0) continue;
      const span = this._hfSpan(x, z);
      if (span && y >= span[0] && y <= span[1]) {
        let y0 = span[0];
        while (y0 < span[1] && set.marked(x, y0, z)) y0++;
        const t = set.get(x, y0, z);
        if (t < 0 || set.state(t) === 2) { this.setHeld(x, y, z, true); continue; }
        if (y === y0) {
          for (let Y = y0 + 1; Y <= span[1]; Y++) this._solve(x, Y, z);
          // (and what was held over the water while the column was not the solver's is air again)
          for (let Y = span[1] + 1; this.isHeld(x, Y, z); Y++) this.setHeld(x, Y, z, false);
        }
      }
      this._ring(x, y, z);
    }
    this._cause = 'other';
  }

  /**
   * Is the column of bricks (x, z) too far from what the camera looks at for its water to be
   * solved? With hfPromoteRadius, the height field's water is solved within one and a half
   * times that of hfFocus and nowhere else, whatever happens there (bodies, the brush and the
   * places a scene names apart: those are pinned).
   */
  _hfBeyond(x, z) {
    const f = this.hfFocus, R = this.params.hfPromoteRadius;
    if (!this.hfc || !f || !(R > 0) || this._hfCol(x, z) < 0) return false;
    const B = this.B;
    return Math.hypot((x + 0.5) * B - f[0], this.dim === 3 ? (z + 0.5) * B - f[1] : 0) > 1.5 * (R + B);
  }

  /**
   * Is the column of bricks (x, z) one in which nothing is solved: too far from the view
   * (_hfBeyond), and not kept solved by a body, the brush or a place the scene names (pins)?
   * What is stored there is held, at whatever height: a copy of the height field's water, or
   * of the air over it and over its dry ground. Liquid that comes into such a brick is the
   * height field's from then on. (Solved bricks there were filled by the height field itself:
   * one stored on a dry bank for the spray of the solved water next to it, and then reached by
   * a flood on the map, was the lowest brick of that column's water, the column therefore the
   * solver's, and its liquid had more bricks stored along the bank: solved water crept along
   * both shores of a flood to the end of the valley.)
   */
  _hfOut(x, z) {
    if (!this._hfBeyond(x, z)) return false;
    // Not under a pin, at any height: a body may be on its way through bricks above the water
    // (a gate being lifted out of it). A held brick is rewritten every step as the water at
    // rest in the cells as they are; cells that a body has just left come up full, and the
    // height field is charged for water it had all along. (13 cells of a reservoir, measured.)
    const B = this.B;
    for (const { lo, hi, soft, hold } of this.pins) {
      if (soft || hold) continue;
      if ((x + 1) * B <= lo[0] || x * B >= hi[0]) continue;
      if (this.dim === 3 && ((z + 1) * B <= lo[2] || z * B >= hi[2])) continue;
      return false;
    }
    const span = this._hfSpan(x, z);
    if (!span) return true;
    // (nor for a while after: pinHold)
    const set = this.levels[0].set;
    let y0 = span[0];
    while (y0 < span[1] && set.marked(x, y0, z)) y0++;
    const t = set.get(x, y0, z);
    return !(t >= 0 && this.pinOf[t] > this._pinStamp - this.params.pinHold);
  }

  /** Hand back what is solved where the focus has left it behind (_hfOut), as it is. */
  _hfConfine() {
    const hfc = this.hfc, p = this.params;
    if (!this.hfFocus || !(p.hfPromoteRadius > 0)) return;
    const set = this.levels[0].set;
    for (let s = 0; s < set.high; s++) {
      if (!set.used[s] || set.state(s) === 2) continue;
      const x = set.bx[s], y = set.by[s], z = set.bz[s];
      if (!this._hfOut(x, z)) continue;
      hfc.promoted[this._hfCol(x, z)] = 0;
      this.setHeld(x, y, z, true);
    }
  }

  /** Solved bricks the budget (maxSolved) still has room for. */
  get _room() {
    const set = this.levels[0].set;
    return (this.params.maxSolved || (this.dim === 3 ? 3000 : 600)) - (set.count - this.nHeld);
  }

  /**
   * Solve the columns of bricks in which the height field holds what it cannot ("cols" in
   * src/shaders/hfcouple.js): where water leaves the bed first, then the fronts, with the columns
   * around a front (it moves); of each kind the nearest to `hfFocus` first (what the camera
   * looks at), and with hfPromoteRadius none further from it than that. Within the budget. A
   * column that is solved already stays so for as long as it is flagged, like one under a pin.
   * (What the focus has left behind by half as much again is handed back: _hfConfine.)
   */
  _hfPromote() {
    const { hfc, dim, B } = this, p = this.params;
    hfc.promote = false;
    if (!p.hfPromote) return;
    const set = this.levels[0].set, b0 = this._hfBrick0(), nc = hfc.nc;
    const f = this.hfFocus, R = f && p.hfPromoteRadius > 0 ? p.hfPromoteRadius / B : Infinity;
    const far = (i, j) => (f ? Math.hypot(b0[0] + i + 0.5 - f[0] / B, dim === 3 ? b0[1] + j + 0.5 - f[1] / B : 0) : 0);
    const lowest = (x, z) => {
      const span = this._hfSpan(x, z);
      if (!span) return null;
      let y0 = span[0];
      while (y0 < span[1] && set.marked(x, y0, z)) y0++;
      return [span, y0, set.get(x, y0, z)];
    };
    let room = this._room;
    const stamp = this._pinStamp;
    const column = (i, j) => {
      if (i < 0 || j < 0 || i >= nc[0] || j >= nc[1]) return;
      const x = b0[0] + i, z = b0[1] + j;
      const c = lowest(x, z);
      if (!c) return;
      const [span, y0, t] = c;
      if (t < 0 || set.state(t) === 2) {
        if (room <= 0) { this.unpromoted++; return; }
        const before = set.count - this.nHeld;
        if (this._activate(x, y0, z) < 0) return;
        room -= Math.max(set.count - this.nHeld - before, 0);
      }
      hfc.promoted[j * nc[0] + i] = 1;
      for (let Y = span[0]; Y <= span[1]; Y++) { const u = set.get(x, Y, z); if (u >= 0) this.pinOf[u] = stamp; }
    };
    const Rz = dim === 3 ? 1 : 0;
    for (const want of [2, 1]) {
      this._cause = want === 2 ? 'fall' : 'front';
      const list = [];
      for (let k = 0; k < hfc.flags.length; k++) {
        if (!(hfc.flags[k] & want)) continue;
        const i = k % nc[0], j = Math.floor(k / nc[0]), d = far(i, j);
        if (d <= R) list.push([d, i, j]);
      }
      list.sort((u, v) => u[0] - v[0]);
      for (const [, i, j] of list) {
        if (want === 2) { column(i, j); continue; }
        for (let dj = -Rz; dj <= Rz; dj++) for (let di = -1; di <= 1; di++) column(i + di, j + dj);
      }
    }
    this._cause = 'other';
  }

  /**
   * Wake the water at rest in the bricks that touch the boxes of `pins` ({ lo, hi } in world
   * cells, hi exclusive). A pin with `soft` wakes within the budget of solved bricks only (the
   * surroundings of the camera); one with `hold` wakes nothing and keeps what is solved from
   * going back to sleep; the others always wake (bodies, the brush, what a scene says has to be
   * solved).
   */
  _applyPins() {
    const B = this.B;
    const stamp = ++this._pinStamp;
    if (!this.farOn) return;
    const set = this.levels[0].set;
    let room = null;
    for (const { lo, hi, soft, hold } of this.pins) {
      const b0 = lo.map((v) => Math.floor(v / B)), b1 = hi.map((v) => Math.floor((v - 1) / B));
      if (this.dim === 2) b0[2] = b1[2] = 0;
      for (let z = b0[2]; z <= b1[2]; z++) {
        for (let y = b0[1]; y <= b1[1]; y++) {
          for (let x = b0[0]; x <= b1[0]; x++) {
            if (!this._farWet(x, y, z)) continue;
            let s = set.get(x, y, z);
            if (hold) {
              if (s >= 0 && set.state(s) !== 2) this.pinOf[s] = stamp;
              continue;
            }
            if (soft && (s < 0 || set.state(s) === 2)) {
              if (room === null) room = this._room;
              if (room <= 0) continue;
              const before = set.count - this.nHeld;
              this._cause = 'view';
              s = this._activate(x, y, z);
              room -= Math.max(set.count - this.nHeld - before, 0);
            } else {
              this._cause = soft ? 'view' : 'pin';
              s = this._activate(x, y, z);
            }
            this._cause = 'other';
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
    // (over a height field "at rest" reads: as a height field would have it, see hfSleepSpeed)
    const hf = !!this.hf;
    return {
      uSleep: hf ? [p.hfSleepSpeed / p.dt, p.hfSleepP * G, p.hfSleepRho] : [p.sleepSpeed / p.dt, p.sleepP * G, p.sleepRho],
      uWake: [(hf ? p.hfWakeSpeed : p.wakeSpeed) / p.dt, p.wakeP * G, p.strongSpeed / p.dt],
      uSlope: hf ? p.hfSleepSlope : 0,
      uBedLayer: hf ? p.hfSleepBed : 0,
      // (mist that hovers has the speed gravity adds in one step, G, and loses it again in the next)
      // (over a height field more of it: what a splash leaves in the air there is the height field's
      // once its brick is dropped, and it would hang over the water for good otherwise)
      uMist: [hf ? p.hfMistMass : p.mistMass, Math.max(2 * G, 0.02 / p.dt)],
    };
  }

  // (a face that keeps its velocity is one like any other: weight 1)
  get _heldK() { return this.heldLive ? 1 : 1 / this.params.farZ; }
  _coefUniforms(l) { return { uHeldInv: l ? 1 / (0.5 + 2 ** -(l + 1)) : 0, uHeldK: this._heldK, uHeldFloor: this.params.heldFloor ? 1 : 0 }; }
  _projectUniforms() { return { uHeldK: this._heldK }; }

  _afterDensity() {
    const { glc, prog: P, T } = this;
    const L0 = this.levels[0];
    if (this.nHeld) {
      glc.draw(P.farDelta, this.R.d, { ...this._U(L0), uFrac: T.frac, uRho: T.rho[0] }, { blend: true });
      this._farPending = true;
    }
    if (this.hf) this._hfExchange();
    this._resetHeld();
  }

  /** Put the held bricks back to the state of the water at rest. */
  _resetHeld() {
    if (!this.nHeld) return;
    const { glc, prog: P, T } = this;
    const L0 = this.levels[0];
    glc.drawTiles(P.farReset, [T.rho[0], L0.p[0]], { ...this._U(L0), uFrac: T.frac, uRho: T.frac, uMerge: 0 }, this.heldList, L0.set.tile);
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
      ...this._farUniforms(),
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
    this.unpromoted = 0;              // columns of a height field that should have been solved with the budget used up (counted per look)
    // bricks of water at rest (or of a height field) that were made solved ones, by what did it: a pin
    // (a body, the brush, a place the scene names), the view (a soft pin), fast liquid, moving liquid,
    // a fall or a front of the height field, the column a solved brick belongs to
    this.causes = {};
    this._cause = 'other';
    this.evicted = 0;                 // solved bricks sent to sleep to make room for fast liquid (params.evict)
    // (x, y, z, size) -> true if the cube of `size` cells at world cell (x, y, z) lies inside a
    // solid that never moves, at least a cell and a half deep everywhere. Such bricks are not
    // stored (a missing brick is a wall already). Set by the owner; null = store everything.
    this.solidBrick = null;
    this.freedMass = 0;               // density (traces below wetMin, mist that hovered) in the bricks that were dropped
    this.water = [];
    this.swell = null;
    this.hf = null;                   // the height field (setHeightField) ...
    this.hfc = null;                  // ... and what ties it to the bricks
    this._newHeld = [];               // slots held since the last _syncBricks
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
    this.wakeOf = [];                 // ... the last report in which waking cells could reach it
    this.hardOf = [];                 // ... and in which those cells were fast (strongSpeed)
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
    this._fracGone = true;
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
    if (this.hfc) this.hfc.rebase = true;
    this._ref(1, x >> 1, y >> 1, this.dim === 3 ? z >> 1 : 0);
    if (this.onState) this.onState(x, y, z, 'store');
    return true;
  }

  removeBrick(x, y, z = 0) {
    const set = this.levels[0].set;
    const s = set.get(x, y, z);
    if (s < 0) return;
    if (set.state(s) === 2) this._heldDirty = true;
    if (this.hfc) this.hfc.rebase = true;
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
    if (this.farOn) for (let z = b0[2]; z <= b1[2]; z++) for (let y = b0[1]; y <= b1[1]; y++) for (let x = b0[0]; x <= b1[0]; x++) this._activate(x, y, z);
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
    if (this._version === L0.set.version && !L0.set.dirty) { if (this.hfc && this.hfc.rebase) this._hfRebase(); return; }
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

    // Bricks that have just been stored hold what the next pass may read from them before the
    // solver has written it; in a body of water: the water at rest. Over a height field so do
    // the bricks that have just been held: what was in them is the height field's already.
    let newHeld = [];
    if (this.hf) {
      this._hfRows();
      this._hfUpload();
      newHeld = this._newHeld.filter((s) => L0.set.used[s] && L0.set.state(s) === 2 && this._hfCol(L0.set.bx[s], L0.set.bz[s]) >= 0);
    }
    this._newHeld = [];
    const stored = [...new Set(this.fresh)].filter((s) => L0.set.used[s]);
    this.fresh = [];
    // the water at rest into the bricks of `tiles`
    const rest = (tiles) => {
      this.freshList.set(tiles);
      this._only = this.freshList;
      try {
        glc.drawTiles(P.farReset, [T.rho[0], L0.p[0]], { ...this._U(L0), uFrac: T.frac, uRho: T.frac, uMerge: 0 }, this.freshList, L0.set.tile);
        this._computeLiq();
      } finally {
        this._only = null;
      }
    };
    if (stored.length) {
      const fill = (t, v) => glc.drawTiles(P.fill, t, { uValue: v }, this.freshList, L0.set.tile);
      this.freshList.set(stored);
      if (this.hf) glc.drawTiles(P.farVelFill, T.vel[0], { ...this._U(L0), uVel: T.vel[1], uMerge: 0 }, this.freshList, L0.set.tile);
      else fill(T.vel[0], [0, 0, 0, 0]);
      fill(T.rho[0], [0, 1, 0, 0]);
      fill(L0.p[0], [0, 0, 0, 0]);
      this._only = this.freshList;
      try {
        this._updateSolids();
        if (!this.farOn) this._computeLiq();
      } finally {
        this._only = null;
      }
      if (this.farOn) rest(stored);
    }
    // The pool has grown: what every step makes afresh is gone until the next one does, the
    // solid fractions among it, and the water at rest of a cell goes by its fraction (farFill).
    // A brick held in this same step would be reset to no water at all, and the height field
    // would be told that it had lost it.
    if (this._fracGone) {
      this._fracGone = false;
      if (this.hf) this._updateSolids();
    }
    // (the height field first: what a brick that has just been held still holds is counted there)
    if (this.hfc && this.hfc.rebase) this._hfRebase();
    if (newHeld.length) rest(newHeld);
  }

  // ------------------------------------------------------------------ scene state
  /** As FluidSim.reset. The stored bricks become those around the liquid; `keep` leaves them as they are. */
  reset(solids, liquid, { keep = false } = {}) {
    if (this.hf) { this.hfc.run++; this._hfLook(true); }
    if (!keep) { this.clearBricks(); this.ensurePrims(liquid); }
    // (the height field counts afresh once the scene is in the bricks: below)
    if (this.hf) { this._hfTidy(); this.hfc.rebase = false; }
    this._syncBricks();
    super.reset(solids, liquid);
    if (this.farOn) {
      // the liquid of the scene on top of the water at rest
      const { glc, prog: P, T } = this;
      const L0 = this.levels[0];
      glc.drawTiles(P.farReset, [T.rho[1], L0.p[0]], { ...this._U(L0), uFrac: T.frac, uRho: T.rho[0], uMerge: 1 }, L0.set.list, L0.set.tile);
      this._swap(T.rho);
      if (this.hf) {
        // ... which moves as the height field does, and is the height field's from now on
        glc.drawTiles(P.farVelFill, T.vel[1], { ...this._U(L0), uVel: T.vel[0], uMerge: 1 }, L0.set.list, L0.set.tile);
        this._swap(T.vel);
        // (what it adds to columns that are solved from the bed up goes into their depth, what is
        // in held bricks is handed over; the rest of it is in the air)
        this._hfRows();
        this._hfGather();
        this._hfFold(2);
        this._resetHeld();
      }
      this._computeLiq();
    }
    if (this._farPending) { this.glc.clear(this.R.d); this._farPending = false; }
    this._lastRest = null;
    this.displaced = 0;
    if (this.swell) this.swell.reset();
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
    // (the height field counts what the solved bricks gain: at once, before the bricks change again)
    if (this.hf) { this._hfGather(); this._hfFold(0); this._resetHeld(); }
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
   * Resolves with those books.
   */
  readLedgerAsync() {
    if (this._ledgerBusy) return this._ledgerRead;
    this._ledgerBusy = true;
    const p = this.glc.readAsync(this.ledger);
    this.glc.clear(this.ledger);      // (the read above has its copy already)
    const st = this.stored || { mass: 0, excess: 0 };
    const now = { freed: this.freedMass, stored: st.mass, excess: st.excess, absorbed: this.absorbed, displaced: this.displaced };
    return (this._ledgerRead = p.then((d) => {
      this.added += d[0]; this.removed += d[1];
      return (this.books = { added: this.added, removed: this.removed, ...now });
    }, () => null).finally(() => { this._ledgerBusy = false; }));
  }

  step() {
    this._applyPins();
    if (this.params.lifecycle) this._lifecycle();
    // (when the bricks have changed, or the height field has been looked at since)
    if (this.hfc && this.hfc.promote) this._hfPromote();
    if (this.hfc && this.frame % 8 === 0) this._hfConfine();
    if (this.hfc && (this.hfc.rebase || this.hfc.tidy)) { this.hfc.tidy = false; this._hfTidy(); }
    this._syncBricks();
    super.step();
    if (this.swell) this.swell.step();
    if (this.hf && this.frame % this.params.hfLook === 0) this._hfLook();
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
    glc.draw(P.slotFlags, R.f, { ...U, uS0: R.s[0], uS1: R.s[1], uS2: R.s[2], uS3: R.s[3], uD: R.d, uDt: p.dt, uSteps: steps, uMargin: p.margin });
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
      ...this._U(L0), ...this._sleepUniforms(),
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
    const water = this.farOn;
    // a report that arrived later than assumed has to reach further
    const steps = Math.max(rep.steps, this.frame - rep.frame + p.reportEvery + 1);
    const far = NB_REACH * B;        // what the flags of the GPU cover
    const stamp = ++this._stamp;
    const want = [], wake = [], hard = [], falls = [], dry = [], held = [], sleep = [];
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
        // (not over a height field: what flows into its bricks is its flow)
        const own = this.since[s] >= rep.frame - p.reportEvery || this._hfCol(b[0], b[2]) >= 0;
        if (flags & 2 || (!own && D[4 * s + 3] > inflow)) wake.push(b[0], b[1], b[2]);
        else held.push(s);
        continue;
      }
      sum.excess += D[4 * s];
      const wet = A[4 * s + 3] > 0.5;
      const fw = water && this._farWet(b[0], b[1], b[2]);
      if (!wet && !fw) {
        // (over water of a height field that is not solved: a copy of the air there, see _hfHead)
        if (water && this._hfHead(b[0], b[1], b[2])) this.setHeld(b[0], b[1], b[2], true);
        else dry.push(s);
        continue;
      }
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
        // (fast liquid that is not of the sea, or in the brick over its surface: something is
        // falling in, or being thrown up)
        const falling = strong && !(fw && !this._overSurface(b[0], b[1], b[2]));
        each(b, Math.round(C[4 * s]), Math.round(C[4 * s + 1]), r, (x, y, z, t) => {
          if (t >= 0) { this.wakeOf[t] = stamp; if (strong) this.hardOf[t] = stamp; }
          if (t >= 0 ? set.state(t) === 2 : !set.marked(x, y, z)) {
            (strong ? hard : wake).push(x, y, z);
            if (strong) falls.push(falling);
          }
        });
      }
      if (fw) {
        // cells not at rest: those that only move + 1024 * those whose pressure or density is off
        const free = !(flags & 2) && !(this.pinOf[s] > this._pinStamp - p.pinHold);
        const calm = free && D[4 * s + 1] < 0.5;
        const drift = free && !strong && D[4 * s + 1] < 1023.5 && C[4 * s] < 0;
        this.calm[s] = calm ? (this.calm[s] || 0) + p.reportEvery : 0;
        this.drift[s] = drift ? (this.drift[s] || 0) + p.reportEvery : 0;
        const after = this.hf ? p.hfSleepAfter : p.sleepAfter;
        let least = p.awakeMin;
        if (this.hf) { const k = this._hfCol(b[0], b[2]); least = k >= 0 ? Math.max(this.hfc.stay[k], p.hfAwakeMin) : p.hfAwakeMin; }
        if ((this.calm[s] >= after || this.drift[s] >= p.sleepSlow) && this.frame - (this.since[s] || 0) >= least) sleep.push(s);
      }
    }
    for (let i = 0; i < want.length; i += 3) {
      const x = want[i], y = want[i + 1], z = want[i + 2];
      this.addBrick(x, y, z, water && (this._farWet(x, y, z) || this._hfHead(x, y, z) || this._hfOut(x, z)));
    }
    // Water at rest is woken within a budget of solved bricks (maxSolved), and the same brick
    // not again for a while (rewake): a brick at the edge of what the waves reach would
    // otherwise go to sleep and wake up with every group of waves. That is for waves that are
    // about as fast as waking. Liquid fast enough to wake a body (`hard`: something has fallen
    // in, a bow wave) wakes the water whenever it comes. Refused, a lump of water landing on
    // water that had just gone back to rest was taken in by the held bricks without a splash,
    // and the mist of its tail stayed in the air above them for good.
    // With the budget used up, liquid that falls into the water (`falls`) still gets the bricks
    // it lands in: for each, the calmest solved brick goes to sleep (what moved in it is taken
    // in like a wave at the edge, and counted). Not the fast water of the sea itself: its waves
    // would take the solved bricks along with them, further and further out, for as long as
    // they stay fast, which in 2D is a long time.
    let room = (p.maxSolved || (dim === 3 ? 3000 : 600)) - (set.count - this.nHeld);
    let calmest = null;
    const evict = () => {
      if (!calmest) {
        // (not: the bricks fast liquid is in or can reach, those around bodies and the brush, and
        // the bricks over the surface, which go with the ones below them)
        calmest = [];
        for (let s = 0; s < rep.high; s++) {
          if (!rep.used[s] || !set.used[s] || set.state(s) === 2 || set.bx[s] !== rep.bx[s] || set.by[s] !== rep.by[s] || set.bz[s] !== rep.bz[s]) continue;
          if (this.strongAt[s] === stamp || this.hardOf[s] === stamp || this.pinOf[s] > this._pinStamp - p.pinHold) continue;
          if (!this._farWet(set.bx[s], set.by[s], set.bz[s]) || this._overSurface(set.bx[s], set.by[s], set.bz[s])) continue;
          calmest.push(s);
        }
        // the calmest last (taken from the end): first those no moving liquid reaches, then by speed
        const reached = (s) => (this.wakeOf[s] === stamp ? 1 : 0);
        calmest.sort((u, v) => reached(v) - reached(u) || A[4 * v + 1] - A[4 * u + 1]);
      }
      while (calmest.length) {
        const s = calmest.pop();
        if (set.state(s) === 2) continue;
        const x = set.bx[s], y = set.by[s], z = set.bz[s];
        const before = this.nHeld;
        this._hold(x, y, z);
        this.evicted += this.nHeld - before;
        return this.nHeld - before;
      }
      return 0;
    };
    for (const list of [hard, wake]) {
      for (let i = 0; i < list.length; i += 3) {
        const x = list[i], y = list[i + 1], z = list[i + 2];
        let t = set.get(x, y, z);
        if (t < 0 || set.state(t) === 2) {
          // (the brick over water of a height field that is not solved: that water is what is reached)
          const head = water && this._hfHead(x, y, z);
          // (and only what falls towards it: the fast water of the solved columns next to it
          // wakes a column when it reaches its water, not the air over it)
          if (head && !(list === hard && falls[i / 3])) continue;
          if (head || (water && this._farWet(x, y, z))) {
            // (a height field carries the waves that reach it by itself)
            if (list === wake && !p.hfWake && this._hfCol(x, z) >= 0) continue;
            // (too far from the view: the height field takes it in as it takes a wave)
            if (this._hfBeyond(x, z)) continue;
            const k = `${x},${y},${z}`;
            if (list === wake && this.frame - (this.wokenAt.get(k) ?? -Infinity) < p.rewake) { sum.refused++; continue; }
            // (a brick under the surface brings the one over it along: room for two)
            while (room <= 0 && list === hard && falls[i / 3] && p.evict) { const n = evict(); if (!n) break; room += n; }
            if (room <= 0) { sum.refused++; continue; }
            this.wokenAt.set(k, this.frame);
          } else if (water && this._hfOut(x, z)) continue;      // (air that is held, or stored held when liquid reaches it)
          const before = set.count - this.nHeld;
          this._cause = list === hard ? 'fast' : 'moving';
          t = this._activate(x, head ? y - 1 : y, z);
          this._cause = 'other';
          room -= Math.max(set.count - this.nHeld - before, 0);
        }
        if (t >= 0) this.wakeOf[t] = stamp;
      }
    }
    if (this.wokenAt.size > 20000) for (const [k, f] of this.wokenAt) if (this.frame - f >= p.rewake) this.wokenAt.delete(k);
    const going = new Set();
    for (const s of sleep) {
      if (this.wakeOf[s] === stamp) { this.calm[s] = 0; this.drift[s] = 0; } else going.add(s);
    }
    for (const s of going) {
      const x = set.bx[s], y = set.by[s], z = set.bz[s];
      // (over a height field a column goes to sleep as a whole)
      const span = this._hfSpan(x, z);
      if (span && y >= span[0] && y <= span[1]) {
        let all = true;
        for (let Y = span[0]; Y <= span[1] && all; Y++) {
          const t = set.get(x, Y, z);
          if (t >= 0 && set.state(t) !== 2 && !going.has(t)) all = false;
        }
        if (all) this.setHeld(x, y, z, true);
        continue;
      }
      // (the brick over the surface goes to sleep with the one below it, not before: _overSurface)
      if (this._overSurface(x, y, z)) {
        const t = set.get(x, y - 1, z);
        if (t >= 0 && set.state(t) !== 2 && !going.has(t)) continue;
      }
      this.setHeld(x, y, z, true);
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
    if (this.swell) this.swell.dispose();
    this.setHeightField(null);
    for (const t of [...this.R.s, ...this.R.f, this.R.d, ...this._resolved.values(), this._noTerrain, this.ledger, ...this.M]) glc.deleteTexture(t);
    this.heldList.dispose();
    this.freshList.dispose();
    this.editList.dispose();
  }
}
