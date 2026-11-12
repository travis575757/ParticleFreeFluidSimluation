// BrickSet: which bricks of an unbounded grid are stored, and where.
//
// A brick is a cube (2D: square) of BRICK[dim] cells per side. Stored bricks occupy "slots":
// tiles of the pool textures of one grid level, `perRow` tiles per row. The shaders find a
// brick's slot through a two-level page table that this class keeps and uploads:
//
//   top    one entry per group of 16 bricks per side ("leaf"), wrapped: the index of the group's
//          leaf, or -1. Two groups that wrap onto the same entry cannot both exist; add() throws.
//   leaf   the slot of each of its 16^dim bricks, -1 (not stored), or -2 (not stored and known
//          to lie inside a solid throughout: see mark())
//   slot   per slot: the brick's coordinate and its state (0 = slot not in use, 1 = solved, 2 = held)
//
// From these the owner renders `texNb` (SparseSim._buildNb): per slot, the slots of the bricks
// around it, which is what the solver passes actually read.
// See header() in src/shaders/common.js for the reading side (pageLookup, enterSlot, slotOf).
import { BRICK, LEAF_LOG, NB_REACH } from '../shaders/common.js';

const OFF = 32768;      // brick coordinates lie in [-OFF, OFF)
const M = 65536;
const LN = 1 << LEAF_LOG;
const key = (x, y, z) => ((x + OFF) * M + (y + OFF)) * M + (z + OFF);

export class BrickSet {
  /**
   * @param perRow  tiles per row of the pool textures (fixed)
   * @param rows    rows of tiles to start with (see resize)
   * @param top     size of the top table per axis (powers of two)
   */
  constructor(glc, dim, { perRow = 64, rows = 1, top = [256, 256, 1] } = {}) {
    this.glc = glc;
    this.dim = dim;
    this.B = BRICK[dim];
    this.TW = dim === 2 ? this.B : this.B * this.B;     // tile width in texels
    this.CB = this.B ** dim;                            // cells per brick
    this.perRow = perRow;
    this.top = dim === 2 ? [top[0], top[1], 1] : top.slice();
    this.spr = dim === 2 ? 1 : Math.min(this.top[2], 16);   // z-slices of the top table per atlas row
    this.topW = this.top[0] * this.spr;
    const topH = this.top[1] * Math.ceil(this.top[2] / this.spr);
    this.topData = new Float32Array(this.topW * topH).fill(-1);
    this.texTop = glc.texture(this.topW, topH, 'r32f', { data: this.topData });

    this.LW = dim === 2 ? LN : LN * LN;                 // leaf width in texels
    this.leafRow = dim === 2 ? 32 : 8;
    this.leafRows = 0;
    this.texLeaf = null;
    this.leafIndex = new Map();     // leaf key -> leaf number
    this.leafArr = [];              // leaf number -> { data, n, key, ti } | null
    this.leafFree = [];
    this.dirtyLeaves = new Set();
    this._growLeaves(1);

    this.map = new Map();           // brick key -> slot
    this.marks = new Set();         // keys of the bricks marked solid
    this.count = 0;
    this.high = 0;                  // highest slot in use + 1
    this._free = 0;                 // no free slot below this one
    this.rows = 0;
    this.capacity = 0;
    this.bx = new Int32Array(0);
    this.by = new Int32Array(0);
    this.bz = new Int32Array(0);
    this.used = new Uint8Array(0);
    this.refs = new Int32Array(0);  // for the owner: number of children on the finer level
    this.slotData = new Float32Array(0);
    this.texSlot = null;
    this.texNb = null;
    this.grid = {};                 // the `Grid` / `GridX` uniform of the shaders
    this.list = glc.tileList();     // the slots in use, for GLContext.drawTiles
    this.version = 0;               // changes whenever a brick is added or removed
    this.resize(rows);
    this.dirty = true;
  }

  /** Change the number of tile rows (never below what the slots in use need). */
  resize(rows) {
    rows = Math.max(rows, Math.ceil(this.high / this.perRow), 1);
    if (rows === this.rows) return;
    const cap = rows * this.perRow;
    const grow = (Old, per = 1) => { const a = new Old.constructor(cap * per); a.set(Old.subarray(0, Math.min(Old.length, cap * per))); return a; };
    this.bx = grow(this.bx); this.by = grow(this.by); this.bz = grow(this.bz);
    this.used = grow(this.used); this.refs = grow(this.refs);
    this.slotData = grow(this.slotData, 4);
    this.rows = rows;
    this.capacity = cap;
    if (this.texSlot) { this.glc.deleteTexture(this.texSlot); this.glc.deleteTexture(this.texNb); }
    this.texSlot = this.glc.texture(this.perRow, rows, 'rgba32f', { data: this.slotData });
    const nbs = 2 * NB_REACH + 1;
    this.texNb = this.glc.texture(this.perRow * (this.dim === 2 ? nbs : nbs * nbs), rows * nbs, 'r32f');
    const w = this.perRow * this.TW;
    const h = (rows + 1) * this.B;                      // one more row: the null tile is its first tile
    Object.assign(this.grid, {
      tiles: [this.perRow, rows], inv: [1 / w, 1 / h],
      top: [this.top[0] - 1, this.top[1] - 1, this.top[2] - 1], topTile: [this.top[0], this.spr],
      leafRow: this.leafRow, w, h, cells: w * h,
    });
    this.dirty = true;
  }

  /** Texel rectangle of the two null tiles (not stored; marked solid) in a pool texture: [x, y, w, h]. */
  get nullRect() { return [0, this.rows * this.B, 2 * this.TW, this.B]; }
  /** Tile geometry for GLContext.drawTiles. */
  get tile() { return { size: [this.TW, this.B], perRow: this.perRow }; }

  _growLeaves(rows) {
    const glc = this.glc;
    if (this.texLeaf) glc.deleteTexture(this.texLeaf);
    this.leafRows = rows;
    this.texLeaf = glc.texture(this.leafRow * this.LW, rows * LN, 'r32f');
    this.leafArr.forEach((leaf, i) => { if (leaf) this.dirtyLeaves.add(i); });
  }

  _topIndex(lx, ly, lz) {
    const tx = lx & (this.top[0] - 1), ty = ly & (this.top[1] - 1), tz = lz & (this.top[2] - 1);
    return (ty + Math.floor(tz / this.spr) * this.top[1]) * this.topW + tx + (tz % this.spr) * this.top[0];
  }

  _setLeaf(x, y, z, s) {
    const lx = x >> LEAF_LOG, ly = y >> LEAF_LOG, lz = z >> LEAF_LOG;
    const lk = key(lx, ly, lz);
    let li = this.leafIndex.get(lk);
    if (li === undefined) {
      if (s === -1) return;
      const ti = this._topIndex(lx, ly, lz);
      if (this.topData[ti] >= 0) throw new Error('bricks too far apart for the page table of this grid');
      li = this.leafFree.length ? this.leafFree.pop() : this.leafArr.length;
      this.leafArr[li] = { data: new Float32Array(LN ** this.dim).fill(-1), n: 0, key: lk, ti };
      this.leafIndex.set(lk, li);
      this.topData[ti] = li;
      this.dirtyTop = true;
      if (li >= this.leafRow * this.leafRows) this._growLeaves(this.leafRows * 2);
    }
    const leaf = this.leafArr[li];
    const ex = x & (LN - 1), ey = y & (LN - 1), ez = z & (LN - 1);
    const at = this.dim === 2 ? ey * LN + ex : (ey * LN + ez) * LN + ex;
    leaf.n += (s !== -1 ? 1 : 0) - (leaf.data[at] !== -1 ? 1 : 0);
    leaf.data[at] = s;
    this.dirtyLeaves.add(li);
    if (leaf.n === 0) {
      this.topData[leaf.ti] = -1;
      this.dirtyTop = true;
      this.leafIndex.delete(lk);
      this.leafArr[li] = null;
      this.leafFree.push(li);
      this.dirtyLeaves.delete(li);
    }
  }

  /** Slot of brick (x, y, z), or -1. */
  get(x, y, z) {
    const s = this.map.get(key(x, y, z));
    return s === undefined ? -1 : s;
  }

  /** Store brick (x, y, z); returns its slot (the lowest free one), or -1 if every slot is taken. */
  add(x, y, z) {
    const k = key(x, y, z);
    let s = this.map.get(k);
    if (s !== undefined) return s;
    if (this.count >= this.capacity) return -1;
    this.marks.delete(k);
    s = this._free;
    while (this.used[s]) s++;
    this._free = s + 1;
    this.used[s] = 1;
    this.bx[s] = x; this.by[s] = y; this.bz[s] = z;
    this.refs[s] = 0;
    this.slotData.set([x, y, z, 1], 4 * s);
    this.map.set(k, s);
    this.count++;
    if (s >= this.high) this.high = s + 1;
    this._setLeaf(x, y, z, s);
    this.dirty = this.dirtySlots = true;
    this.version++;
    return s;
  }

  /** State of the brick in slot s: 1 = solved, 2 = held (kept at the state of the water at rest; see SparseSim). */
  state(s) { return this.slotData[4 * s + 3]; }

  setState(s, v) {
    if (!this.used[s] || this.slotData[4 * s + 3] === v) return;
    this.slotData[4 * s + 3] = v;
    this.dirty = this.dirtySlots = true;
  }

  /** Drop brick (x, y, z); returns the slot it had, or -1. */
  remove(x, y, z) {
    const k = key(x, y, z);
    const s = this.map.get(k);
    if (s === undefined) return -1;
    this.map.delete(k);
    this.used[s] = 0;
    this.slotData[4 * s + 3] = 0;
    this.count--;
    if (s < this._free) this._free = s;
    while (this.high > 0 && !this.used[this.high - 1]) this.high--;
    this._setLeaf(x, y, z, -1);
    this.dirty = this.dirtySlots = true;
    this.version++;
    return s;
  }

  /**
   * Note that brick (x, y, z) is not stored because it lies inside a solid throughout. To the
   * solver it is a missing brick like any other (a wall); the difference is that nobody has to
   * ask for it again.
   */
  mark(x, y, z) {
    const k = key(x, y, z);
    if (this.map.has(k) || this.marks.has(k)) return;
    this.marks.add(k);
    this._setLeaf(x, y, z, -2);
    this.dirty = true;
  }

  marked(x, y, z) { return this.marks.has(key(x, y, z)); }

  clearMarks() {
    for (const k of this.marks) {
      const z = (k % M) - OFF, y = (Math.floor(k / M) % M) - OFF, x = Math.floor(k / (M * M)) - OFF;
      this._setLeaf(x, y, z, -1);
    }
    this.marks.clear();
    this.dirty = true;
  }

  /** Bricks covered: { lo, hi } per axis (hi exclusive), or null if there are none. */
  bounds() {
    if (!this.count) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const c = [this.bx, this.by, this.bz];
    for (let s = 0; s < this.high; s++) {
      if (!this.used[s]) continue;
      for (let d = 0; d < 3; d++) {
        const v = c[d][s];
        if (v < lo[d]) lo[d] = v;
        if (v >= hi[d]) hi[d] = v + 1;
      }
    }
    return { lo, hi };
  }

  /** Upload what changed to the lookup textures and the tile list. Returns true if anything had. */
  sync() {
    if (!this.dirty) return false;
    const glc = this.glc;
    if (this.dirtyTop) glc.upload(this.texTop, this.topData);
    for (const li of this.dirtyLeaves) {
      glc.upload(this.texLeaf, this.leafArr[li].data, (li % this.leafRow) * this.LW, Math.floor(li / this.leafRow) * LN, this.LW, LN);
    }
    glc.upload(this.texSlot, this.slotData);
    const slots = new Float32Array(this.count);
    for (let s = 0, n = 0; s < this.high; s++) if (this.used[s]) slots[n++] = s;
    this.list.set(slots);
    this.dirtyLeaves.clear();
    this.dirty = this.dirtyTop = this.dirtySlots = false;
    return true;
  }

  dispose() {
    const glc = this.glc;
    glc.deleteTexture(this.texTop);
    glc.deleteTexture(this.texLeaf);
    glc.deleteTexture(this.texSlot);
    glc.deleteTexture(this.texNb);
    this.list.dispose();
  }
}
