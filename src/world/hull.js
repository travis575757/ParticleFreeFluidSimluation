// Hull: a rigid body with a shape of its own, e.g. a ship's hull with its compartments.
//
// The shape is given as a distance function in the frame it was drawn in. It is sampled once on
// a lattice around the centre of mass, and that lattice is the body from then on: the solver
// reads it from a texture (prims() with `hulls` in src/shaders/common.js), contacts read the
// same samples here, and a breach is a change of the samples.
//
// Two fields are kept: the material (what is solid) and the shell (the body with its hollows
// filled in: what it displaces while it is whole). Mass, centre of mass and inertia come from
// the material by summing over a finer lattice, plus point masses for ballast. They stay as
// they are when the hull is holed (what a breach removes weighs little, and a body whose
// centre of mass moved under it would have to be re-centred on its lattice).
//
// For the rest of the code a hull is a Body: `volume` is the volume of the shell and `density`
// the mass over that volume, so that density * volume is the mass, as for a ball or a box.
import { Body, quatToWorldToLocal } from '../bodies.js';
import { HULL_MARGIN } from '../shaders/common.js';

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, (c * h - b * i) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, (c * d - a * f) / det,
    C / det, (b * g - a * h) / det, (a * e - b * d) / det];
}
const apply3 = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

/**
 * Volume, centre and second moments of what lies inside a distance function, summed over
 * samples `step` apart in the box [lo, hi]. A sample counts by how much of it is inside (to
 * first order: clamp(0.5 - d / step)), so flat faces are exact wherever they lie.
 * Returns { volume, center, inertia: 3x3 about the centre, per unit volume }.
 */
export function integrateShape(dim, sd, lo, hi, step = 0.5) {
  const n = [0, 1, 2].map((d) => (d < dim ? Math.ceil((hi[d] - lo[d]) / step) : 1));
  const dv = step ** dim;
  let V = 0;
  const m1 = [0, 0, 0];
  const m2 = [0, 0, 0, 0, 0, 0];        // xx, yy, zz, xy, xz, yz
  for (let k = 0; k < n[2]; k++) {
    const z = dim === 2 ? 0 : lo[2] + (k + 0.5) * step;
    for (let j = 0; j < n[1]; j++) {
      const y = lo[1] + (j + 0.5) * step;
      for (let i = 0; i < n[0]; i++) {
        const x = lo[0] + (i + 0.5) * step;
        const w = Math.min(Math.max(0.5 - sd(x, y, z) / step, 0), 1) * dv;
        if (w <= 0) continue;
        V += w;
        m1[0] += w * x; m1[1] += w * y; m1[2] += w * z;
        m2[0] += w * x * x; m2[1] += w * y * y; m2[2] += w * z * z;
        m2[3] += w * x * y; m2[4] += w * x * z; m2[5] += w * y * z;
      }
    }
  }
  if (V <= 0) return { volume: 0, center: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const c = m1.map((v) => v / V);
  // second moments about the centre, plus those of a sample about its own middle
  const self = (step * step) / 12;
  const xx = m2[0] / V - c[0] * c[0] + self, yy = m2[1] / V - c[1] * c[1] + self, zz = dim === 2 ? 0 : m2[2] / V - c[2] * c[2] + self;
  const xy = m2[3] / V - c[0] * c[1], xz = m2[4] / V - c[0] * c[2], yz = m2[5] / V - c[1] * c[2];
  return { volume: V, center: c, inertia: [yy + zz, -xy, -xz, -xy, xx + zz, -yz, -xz, -yz, xx + yy] };
}

export class Hull extends Body {
  /**
   * @param o  { sd: (x, y, z) => distance to the material (cells, negative inside), in the frame of the drawing,
   *             shell: the same for the body with its hollows filled (default: sd),
   *             box: [lo, hi] that contains the material, in that frame,
   *             density: of the material, relative to the liquid,
   *             ballast: [{ pos, mass }] point masses (mass in cells^dim of liquid),
   *             pos: where the origin of the drawing is, angle (2D) | quat (3D), vel, omega,
   *             spacing: of the lattice (cells, default 1), kinematic, color }
   */
  constructor(glc, dim, o) {
    super(dim, { ...o, shape: 'hull', pos: o.pos || [0, 0, 0], density: 1 });
    this.glc = glc;
    this.flooded = !!o.flooded;       // the scene's water where the hull is stays there (World.reset)
    const sd = o.sd, shell = o.shell || o.sd;
    const [lo, hi] = o.box;
    const s = (this.spacing = o.spacing || 1);

    // mass, centre of mass, inertia
    const step = o.massStep || 0.5;
    const mat = integrateShape(dim, sd, lo, hi, step);
    const outer = integrateShape(dim, shell, lo, hi, step);
    const rho = o.density ?? 1;
    let mass = rho * mat.volume;
    const com = mat.center.map((v) => v * mass);
    for (const b of o.ballast || []) { mass += b.mass; for (let d = 0; d < dim; d++) com[d] += b.mass * b.pos[d]; }
    for (let d = 0; d < 3; d++) com[d] /= mass;
    if (dim === 2) com[2] = 0;
    // about the centre of mass: each part's own inertia and that of its mass at its centre
    const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const part = (m, c, own) => {
      const r = [c[0] - com[0], c[1] - com[1], dim === 2 ? 0 : c[2] - com[2]], r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) I[3 * a + b] += m * ((own ? own[3 * a + b] : 0) + (a === b ? r2 : 0) - r[a] * r[b]);
    };
    part(rho * mat.volume, mat.center, mat.inertia);
    for (const b of o.ballast || []) part(b.mass, b.pos, null);
    this.mass = mass;
    this.com = com;                              // in the frame of the drawing
    this.materialVolume = mat.volume;
    this.volume = outer.volume;
    this.shellCenter = outer.center;             // centre of buoyancy of the whole body under water (frame of the drawing)
    this.density = mass / outer.volume;
    this.inertiaT = I.map((v) => v / mass);      // per unit mass, in the frame of the body
    this.inertia = [this.inertiaT[0], this.inertiaT[4], this.inertiaT[8]];
    this._invI = dim === 3 ? invert3(this.inertiaT) : null;

    // the lattice: around the centre of mass, HULL_MARGIN cells and one sample wider than the material
    const half = [0, 1, 2].map((d) => (d < dim ? Math.ceil((Math.max(com[d] - lo[d], hi[d] - com[d]) + HULL_MARGIN + s) / s) * s : 1));
    const n = [0, 1, 2].map((d) => (d < dim ? Math.round((2 * half[d]) / s) + 1 : 1));
    this.half = half;
    this.n = n;
    this.extent = Math.hypot(...[0, 1, 2].map((d) => (d < dim ? Math.max(com[d] - lo[d], hi[d] - com[d]) : 0)));
    const f = (this.field = new Float32Array(2 * n[0] * n[1] * n[2]));
    for (let k = 0; k < n[2]; k++) {
      for (let j = 0; j < n[1]; j++) {
        for (let i = 0; i < n[0]; i++) {
          const x = com[0] - half[0] + i * s, y = com[1] - half[1] + j * s, z = dim === 2 ? 0 : com[2] - half[2] + k * s;
          const q = 2 * ((k * n[1] + j) * n[0] + i);
          f[q] = sd(x, y, z);
          f[q + 1] = shell(x, y, z);
        }
      }
    }
    this.cols = dim === 2 ? 1 : Math.ceil(Math.sqrt(n[2]));
    const rows = Math.ceil(n[2] / this.cols);
    this.tex = glc.texture(this.cols * n[0], rows * n[1], 'rg32f');
    this.lattice = { tex: this.tex, n: [n[0], n[1], n[2], this.cols] };
    this.upload();

    // the centre of mass is what the body turns about: that is where it is
    this.pos = this.toWorld(com);
    if (dim === 2) this.pos[2] = 0.5;
    this._points = null;
  }

  /** The samples to the texture (3D: slice after slice in tiles). */
  upload() {
    const n = this.n, f = this.field, cols = this.cols, w = this.tex.w;
    const data = new Float32Array(2 * this.tex.w * this.tex.h);
    for (let k = 0; k < n[2]; k++) {
      const x0 = (k % cols) * n[0], y0 = Math.floor(k / cols) * n[1];
      for (let j = 0; j < n[1]; j++) {
        const from = 2 * (k * n[1] + j) * n[0];
        data.set(f.subarray(from, from + 2 * n[0]), 2 * ((y0 + j) * w + x0));
      }
    }
    this.glc.upload(this.tex, data);
  }

  /** The field (0 material, 1 shell) at l in the frame of the body: what sdHull() of the shaders returns. */
  sample(l, ch = 0) {
    const n = this.n, h = this.half, f = this.field, s = this.spacing, dim = this.dim;
    const q = [Math.min(Math.max(l[0], -h[0]), h[0]), Math.min(Math.max(l[1], -h[1]), h[1]), dim === 2 ? 0 : Math.min(Math.max(l[2], -h[2]), h[2])];
    const away = Math.hypot(l[0] - q[0], l[1] - q[1], dim === 2 ? 0 : l[2] - q[2]);
    if (away > 3) return away + HULL_MARGIN;
    const u = (q[0] + h[0]) / s, v = (q[1] + h[1]) / s;
    const i = Math.min(Math.max(Math.floor(u), 0), n[0] - 2), j = Math.min(Math.max(Math.floor(v), 0), n[1] - 2);
    const fx = u - i, fy = v - j;
    const row = n[0], at = (a) => f[2 * a + ch];
    let d;
    if (dim === 2) {
      const a = j * row + i;
      d = (at(a) * (1 - fx) + at(a + 1) * fx) * (1 - fy) + (at(a + row) * (1 - fx) + at(a + row + 1) * fx) * fy;
    } else {
      const w = (q[2] + h[2]) / s;
      const k = Math.min(Math.max(Math.floor(w), 0), n[2] - 2), fz = w - k;
      const sl = n[0] * n[1], a = k * sl + j * row + i;
      const lo = (at(a) * (1 - fx) + at(a + 1) * fx) * (1 - fy) + (at(a + row) * (1 - fx) + at(a + row + 1) * fx) * fy;
      const b = a + sl;
      const hi = (at(b) * (1 - fx) + at(b + 1) * fx) * (1 - fy) + (at(b + row) * (1 - fx) + at(b + row + 1) * fx) * fy;
      d = lo * (1 - fz) + hi * fz;
    }
    return away > 0 ? Math.max(away + HULL_MARGIN, d - away) : d;
  }

  sd(p) { return this.sample(this.toLocal(p), 0); }
  /** Distance to the body with its hollows filled. */
  shellSd(p) { return this.sample(this.toLocal(p), 1); }

  /** Where the origin of the drawing is now, and a point of the drawing in the world. */
  get origin() { return this.toWorld(this.com.map((v) => -v)); }
  fromDrawing(p) { return this.toWorld([p[0] - this.com[0], p[1] - this.com[1], this.dim === 2 ? 0 : p[2] - this.com[2]]); }

  /** Points on the outside of the body (where there is material), about two cells apart, for contacts. */
  samplePoints() {
    if (!this._points) {
      const n = this.n, h = this.half, s = this.spacing, dim = this.dim, pts = [];
      const st = Math.max(1, Math.round(2 / s));
      const node = (i, j, k) => this.field[2 * ((Math.min(k, n[2] - 1) * n[1] + Math.min(j, n[1] - 1)) * n[0] + Math.min(i, n[0] - 1)) + 1];
      const e = 0.25;
      for (let k = 0; k < (dim === 2 ? 1 : n[2] - 1); k += st) {
        for (let j = 0; j < n[1] - 1; j += st) {
          for (let i = 0; i < n[0] - 1; i += st) {
            let lo = Infinity, hi = -Infinity;
            for (let c = 0; c < (dim === 2 ? 4 : 8); c++) {
              const v = node(i + (c & 1) * st, j + ((c >> 1) & 1) * st, k + ((c >> 2) & 1) * st);
              lo = Math.min(lo, v); hi = Math.max(hi, v);
            }
            if (lo > 0 || hi < 0) continue;
            // from the middle of the block down the gradient onto the surface of the shell
            let p = [-h[0] + (i + 0.5 * st) * s, -h[1] + (j + 0.5 * st) * s, dim === 2 ? 0 : -h[2] + (k + 0.5 * st) * s];
            for (let it = 0; it < 4; it++) {
              const d = this.sample(p, 1);
              const g = [this.sample([p[0] + e, p[1], p[2]], 1) - this.sample([p[0] - e, p[1], p[2]], 1),
                this.sample([p[0], p[1] + e, p[2]], 1) - this.sample([p[0], p[1] - e, p[2]], 1),
                dim === 2 ? 0 : this.sample([p[0], p[1], p[2] + e], 1) - this.sample([p[0], p[1], p[2] - e], 1)];
              const g2 = (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) / (4 * e * e);
              if (g2 < 1e-6) break;
              const t = d / g2 / (2 * e);
              p = [p[0] - t * g[0], p[1] - t * g[1], p[2] - t * g[2]];
            }
            if (Math.abs(this.sample(p, 1)) < 0.25 && this.sample(p, 0) < 0.5) pts.push(p);
          }
        }
      }
      this._points = pts;
    }
    return this._points.map((l) => this.toWorld(l));
  }

  invInertia(v) {
    if (this.dim === 2) return [0, 0, v[2] / this.inertia[2]];
    return this.toWorldDir(apply3(this._invI, this.toLocalDir(v)));
  }
  toLocalDir(v) { const o = this.pos; return this.toLocal([v[0] + o[0], v[1] + o[1], v[2] + o[2]]); }
  toWorldDir(l) { const w = this.toWorld(l), o = this.pos; return [w[0] - o[0], w[1] - o[1], w[2] - o[2]]; }

  /** Cut a round hole of `radius` cells through the material around the world point p. */
  breach(p, radius) {
    const c = this.toLocal(p), n = this.n, h = this.half, s = this.spacing, f = this.field, dim = this.dim;
    for (let k = 0; k < n[2]; k++) {
      for (let j = 0; j < n[1]; j++) {
        for (let i = 0; i < n[0]; i++) {
          const d = Math.hypot(-h[0] + i * s - c[0], -h[1] + j * s - c[1], dim === 2 ? 0 : -h[2] + k * s - c[2]);
          const q = 2 * ((k * n[1] + j) * n[0] + i);
          f[q] = Math.max(f[q], radius - d);
        }
      }
    }
    this.holes = (this.holes || 0) + 1;
    this._points = null;
    this.upload();
  }

  prim() {
    return { type: 'sdf', half: this.half, lattice: this.lattice, center: this.pos, vel: this.vel, omega: this.omega, rot: quatToWorldToLocal(this.quat) };
  }
  /** The body with its hollows filled, as a primitive (to empty a hull that starts afloat, say). */
  shellPrim() { return { ...this.prim(), shell: true }; }

  dispose() { this.glc.deleteTexture(this.tex); }
}

// ---- shapes: distance functions to draw hulls with (cells, frame of the drawing) ----------------

/** Box with rounded corners: centre c, half extents h, corner radius r (2D: z ignored). */
export function sdBox(dim, c, h, r = 0) {
  return (x, y, z) => {
    const qx = Math.abs(x - c[0]) - h[0] + r, qy = Math.abs(y - c[1]) - h[1] + r, qz = dim === 2 ? -1e6 : Math.abs(z - c[2]) - h[2] + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
  };
}
export const sdUnion = (...f) => (x, y, z) => { let d = Infinity; for (const g of f) d = Math.min(d, g(x, y, z)); return d; };
export const sdIntersect = (...f) => (x, y, z) => { let d = -Infinity; for (const g of f) d = Math.max(d, g(x, y, z)); return d; };
/** a without b */
export const sdCut = (a, ...b) => (x, y, z) => { let d = a(x, y, z); for (const g of b) d = Math.max(d, -g(x, y, z)); return d; };
/** The half space behind the plane through p with the normal n (of length one). */
export const sdPlane = (p, n) => (x, y, z) => (x - p[0]) * n[0] + (y - p[1]) * n[1] + (z - p[2]) * n[2];

/**
 * How deep a shape floats upright: the height above its lowest point (box[0][1]) of the level
 * below which it displaces `mass` cells of liquid (the whole height if it cannot).
 */
export function floatDraught(dim, shell, box, mass, step = 1) {
  const [lo, hi] = box;
  let a = 0, b = hi[1] - lo[1];
  for (let i = 0; i < 14; i++) {
    const m = 0.5 * (a + b);
    const v = integrateShape(dim, (x, y, z) => Math.max(shell(x, y, z), y - lo[1] - m), lo, hi, step).volume;
    if (v < mass) a = m; else b = m;
  }
  return 0.5 * (a + b);
}
