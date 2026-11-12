// Swell: the surface of the water that is not solved.
//
// Water at rest is held or not stored at all (SparseSim), and a wave that is too small to keep
// its water solved ends where the solved bricks end. This is what carries it on: a map of the
// surface over x and z, h (cells above rest) and v = dh/dt per texel, stepped as linear waves
// on deep water (src/shaders/swell.js). It is one-way: where water is solved the map takes the
// solver's surface, and around it the map's waves run on from there; the solver knows nothing
// of the map. The renderer draws water that is not solved with the map's surface, and blends
// into it over the last solved brick.
//
// The map is a fixed window of n * cell cells per side. Waves that reach its edge are taken out.
import { swellShaders, SWELL_REACH } from '../shaders/swell.js';

export const SWELL_PARAMS = {
  n: 512,         // texels per side (a power of two)
  cell: 2,        // cells per texel (1 or 2)
  reach: 6,       // rows above and below the level in which the surface of solved water is looked for
  band: 32,       // texels along the edge of the window in which the waves are damped ...
  loss: 0.25,     // ... by this share per step at the very edge
  visc: 0.5,      // damping of short waves, cells^2 / s (rate = visc * wavenumber^2: a wave of 6 cells
                  // lasts two seconds, one of 30 cells a minute)
  depth: 1e6,     // depth of the water the waves run on, cells
  amp: 2,         // the renderer takes no displacement to be larger than this (cells)
  // With no solved water left and no wave higher than `quiet` (cells) or faster than `quietSpeed`
  // (cells per step) the map is switched off. Not lower: the longest waves the window holds are
  // millimetres high, take four seconds per swing and a minute to die, and nobody can see them.
  // (The speed is that of a wave `quiet` high and 20 cells long at 5 cm cells; shorter ones are
  // gone by then.)
  quiet: 0.02,
  quietSpeed: 2.5e-3,
};

export class Swell {
  /** @param center  [x, z] of the middle of the window, world cells */
  constructor(sim, { center = [0, 0], params = {} } = {}) {
    const glc = sim.glc;
    this.sim = sim;
    this.glc = glc;
    const p = this.params = { ...SWELL_PARAMS, ...params };
    this.m = Math.round(Math.log2(p.n));
    if (1 << this.m !== p.n) throw new Error('Swell: n has to be a power of two');
    if (p.reach > SWELL_REACH) throw new Error(`Swell: reach is at most ${SWELL_REACH}`);
    // (whole bricks: the columns of a texel then lie in one brick)
    this.origin = center.map((c) => Math.round((c - p.n * p.cell / 2) / sim.B) * sim.B);
    const S = swellShaders(p.cell);
    this.P = {};
    for (const k of ['fft', 'propagate', 'slave', 'show', 'max8']) this.P[k] = glc.program('swell.' + k, S[k]);
    const n = p.n;
    this.Z = glc.texture(n, n, 'rg32f');                       // h, v
    this.F = [glc.texture(n, n, 'rg32f'), glc.texture(n, n, 'rg32f')];   // work space of the transforms
    this.E = glc.texture(n, n, 'rgba32f');                     // what the solved water says (pass "slave")
    this.D = glc.texture(n, n, 'rgba16f', { linear: true });   // what the renderer reads (pass "show")
    this.M = [];
    for (let s = Math.ceil(n / 8); ; s = Math.ceil(s / 8)) { this.M.push(glc.texture(s, s, 'rg32f')); if (s === 1) break; }
    this.reset();
  }

  reset() {
    for (const t of [this.Z, this.E, this.D]) this.glc.clear(t);
    this.active = false;
    this.peak = [0, 0];       // largest |h| and |v| when last looked at
    this._calm = 0;
    this._run = (this._run || 0) + 1;
  }

  /** For the shaders that read the map (SWELL in src/shaders/common.js). */
  get uniforms() {
    const p = this.params;
    return { uSwell: this.D, uSwellMap: [this.origin[0], this.origin[1], 1 / (p.n * p.cell), this.active ? 1 : 0], uSwellAmp: p.amp };
  }

  /** The transform of `src` (sign -1) or its inverse without the factor 1 / n^2 (sign +1); returns the texture that holds it. */
  _fft(src, sign) {
    const { glc, P, F, m } = this;
    let from = src, k = src === F[0] ? 1 : 0;
    for (let axis = 0; axis < 2; axis++) {
      for (let s = 1; s <= m; s++) {
        glc.draw(P.fft, F[k], { uSrc: from, uAxis: axis, uSize: 1 << s, uBits: s === 1 ? m : 0, uSign: sign });
        from = F[k];
        k = 1 - k;
      }
    }
    return from;
  }

  /** One time step of the map, after that of the solver. */
  step() {
    const { glc, P, sim, params: p } = this;
    const L0 = sim.levels[0];
    const solved = L0.set.count - sim.nHeld;
    if (!this.active) {
      if (!solved) return;
      this.active = true;
      this._calm = 0;
    }
    const sp = sim.params;
    let f = this._fft(this.Z, -1);
    const g = f === this.F[0] ? this.F[1] : this.F[0];
    glc.draw(P.propagate, g, { uF: f, uG: -sp.gravity[1] / sp.h, uDt: sp.dt, uCell: p.cell, uDepth: p.depth, uVisc: p.visc });
    f = this._fft(g, 1);
    glc.draw(P.slave, [this.Z, this.E], {
      ...sim._U(L0), ...sim._solidUniforms(), uZ: f, uLiq: L0.liq, uVel: sim.T.vel[0], uOrigin: this.origin, uReach: p.reach, uBand: p.band, uLoss: p.loss,
    });
    glc.draw(P.show, this.D, { uZ: this.Z, uE: this.E, uInvCell: 1 / p.cell });
    if (sim.frame % 20 === 0) this._look(solved);
  }

  /** How large the waves still are (without blocking); with nothing left of them and no solved water the map is switched off. */
  _look(solved) {
    if (this._busy) return;
    const p = this.params;
    const src = this._reduce();
    this._busy = true;
    const run = this._run;
    this.glc.readAsync(src).then((d) => {
      if (run !== this._run) return;
      this.peak = [d[0], d[1]];
      const quiet = !solved && d[0] < p.quiet && d[1] * this.sim.params.dt < p.quietSpeed;
      this._calm = quiet ? this._calm + 1 : 0;
      if (this._calm >= 2 && this.sim.levels[0].set.count === this.sim.nHeld) this.reset();
    }, () => {}).finally(() => { this._busy = false; });
  }

  _reduce() {
    const { glc, P, M } = this;
    let src = this.Z;
    for (const t of M) { glc.draw(P.max8, t, { uSrc: src }); src = t; }
    return src;
  }

  /** [largest |h|, largest |v|] as they are now, read back at once (tests). */
  peakSync() {
    const d = this.glc.read(this._reduce());
    return [d[0], d[1]];
  }

  dispose() {
    for (const t of [this.Z, ...this.F, this.E, this.D, ...this.M]) this.glc.deleteTexture(t);
  }
}
