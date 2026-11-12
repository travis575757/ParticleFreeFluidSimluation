// World: a SparseSim plus what a scene puts around it: the ground, fixed obstacles, sources
// that feed liquid in and drains that take it out (both metered), and the interaction verbs of
// the app. Lengths are cells, velocities cells per second, as everywhere in the solver.
import { SparseSim } from './sparsesim.js';
import { Terrain, staticSolidTest } from './terrain.js';

export class World {
  /**
   * @param scene  see src/world/scenes.js:
   *   { h, params, terrain: { origin, spacing, n, height }, solids: [prims], liquid: [prims],
   *     emitters: [{ prim, from, until }], drains: [{ prim }] }
   */
  constructor(glc, dim, scene, { params = {}, bricks = {} } = {}) {
    this.glc = glc;
    this.dim = dim;
    this.scene = scene;
    this.sim = new SparseSim(glc, { dim, params: { h: scene.h, ...scene.params, ...params }, bricks: { ...scene.bricks, ...bricks } });
    this.terrain = scene.terrain ? new Terrain(glc, dim, scene.terrain) : null;
    this.sim.setTerrain(this.terrain);
    this.solids = scene.solids || [];
    // bricks inside the ground or a fixed obstacle are never stored
    this.sim.solidBrick = staticSolidTest(dim, this.terrain, this.solids);
    this.reset();
  }

  reset() {
    const sc = this.scene;
    this.time = 0;
    this.emitters = (sc.emitters || []).map((e) => ({ from: 0, until: Infinity, ...e }));
    this.drains = sc.drains || [];
    this.sim.reset(this.solids, sc.liquid || []);
    this.mass0 = this.sim.measureSync().mass;     // the liquid the scene starts with
  }

  step() {
    const sim = this.sim;
    for (const e of this.emitters) if (this.time >= e.from && this.time < e.until) sim.editLiquid([e.prim], 1, { meter: true });
    for (const d of this.drains) sim.editLiquid([d.prim], 2, { meter: true });
    sim.step();
    this.time += sim.params.dt;
  }

  // ---- interaction (positions in cells)
  setBrush(pos, vel, radius, strength = 1, dir = [0, 0, 0]) {
    const m = this.sim.mouse;
    m.pos = pos; m.vel = vel; m.radius = radius; m.strength = strength; m.dir = dir;
  }
  pour(pos, vel, radius) { this.sim.editLiquid([{ type: 'ball', center: pos, radius, vel }], 1, { meter: true }); }
  erase(pos, radius) { this.sim.editLiquid([{ type: 'ball', center: pos, radius }], 2, { meter: true }); }

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
