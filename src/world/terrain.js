// Terrain: ground given by its height over x and z (2D: a profile over x), sampled on a regular
// grid. The solver and the renderer read the samples from a texture (TERRAIN in
// src/shaders/common.js); this class evaluates the same interpolation in JS for everything the
// CPU decides: which bricks lie inside the ground, where scenes put things, contacts of bodies.
//
// Coordinates are cells in the solver's shape space (relative to SparseSim.anchor).

export class Terrain {
  /**
   * @param o.origin   [x, z] of sample (0, 0)
   * @param o.spacing  cells per sample
   * @param o.n        [nx, nz] samples (2D: nz is ignored)
   * @param o.height   (x, z) => height; the terrain continues level beyond its samples
   */
  constructor(glc, dim, { origin = [0, 0], spacing = 2, n, height }) {
    this.glc = glc;
    this.dim = dim;
    this.origin = origin;
    this.spacing = spacing;
    const nx = n[0], nz = dim === 2 ? 1 : n[1];
    this.n = [nx, nz];
    const h = new Float64Array(nx * nz);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) h[j * nx + i] = height(origin[0] + i * spacing, origin[1] + j * spacing);
    const data = (this.data = new Float32Array(nx * nz * 4));
    const at = (i, j) => h[Math.min(Math.max(j, 0), nz - 1) * nx + Math.min(Math.max(i, 0), nx - 1)];
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = 4 * (j * nx + i);
        data[k] = at(i, j);
        // slope from the samples on either side (one-sided at the border)
        data[k + 1] = (at(i + 1, j) - at(i - 1, j)) / ((Math.min(i + 1, nx - 1) - Math.max(i - 1, 0) || 1) * spacing);
        data[k + 2] = (at(i, j + 1) - at(i, j - 1)) / ((Math.min(j + 1, nz - 1) - Math.max(j - 1, 0) || 1) * spacing);
        lo = Math.min(lo, data[k]); hi = Math.max(hi, data[k]);
      }
    }
    this.min = lo;
    this.max = hi;
    this.tex = glc.texture(nx, nz, 'rgba32f', { data });
  }

  /** Uniforms of the TERRAIN shader code. */
  get uniforms() { return { uTer: this.tex, uTerMap: [this.origin[0], this.origin[1], this.spacing, 1] }; }

  /** [height, d/dx, d/dz] at (x, z): the interpolation of terrainAt() in the shader. */
  sample(x, z = 0) {
    const [nx, nz] = this.n;
    const d = this.data;
    const u = Math.min(Math.max((x - this.origin[0]) / this.spacing, 0), nx - 1);
    const i = Math.max(Math.min(Math.floor(u), nx - 2), 0);
    const f = u - i;
    const i1 = Math.min(i + 1, nx - 1);
    let j = 0, j1 = 0, g = 0;
    if (nz > 1) {
      const v = Math.min(Math.max((z - this.origin[1]) / this.spacing, 0), nz - 1);
      j = Math.max(Math.min(Math.floor(v), nz - 2), 0);
      g = v - j;
      j1 = j + 1;
    }
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = d[4 * (j * nx + i) + c] * (1 - f) + d[4 * (j * nx + i1) + c] * f;
      const b = d[4 * (j1 * nx + i) + c] * (1 - f) + d[4 * (j1 * nx + i1) + c] * f;
      out[c] = a * (1 - g) + b * g;
    }
    return out;
  }

  height(x, z = 0) { return this.sample(x, z)[0]; }

  /** Signed distance estimate at p (negative in the ground), as sdTerrain() in the shader. */
  sd(p) {
    const [h, gx, gz] = this.sample(p[0], p[2]);
    return (p[1] - h) / Math.sqrt(1 + gx * gx + gz * gz);
  }

  normal(p) {
    const [, gx, gz] = this.sample(p[0], p[2]);
    const l = Math.sqrt(1 + gx * gx + gz * gz);
    return [-gx / l, 1 / l, -gz / l];
  }

  velocityAt() { return [0, 0, 0]; }

  /**
   * True if the cube of `size` cells with its low corner at (x, y, z) lies in the ground, at
   * least `depth` cells deep by the shader's distance at every point (SparseSim.solidBrick).
   */
  solidCube(x, y, z, size, depth = 1.5) {
    const [nx, nz] = this.n;
    const d = this.data;
    const s = this.spacing;
    const i0 = Math.max(Math.floor((x - this.origin[0]) / s) - 1, 0), i1 = Math.min(Math.ceil((x + size - this.origin[0]) / s) + 1, nx - 1);
    const j0 = nz > 1 ? Math.max(Math.floor((z - this.origin[1]) / s) - 1, 0) : 0;
    const j1 = nz > 1 ? Math.min(Math.ceil((z + size - this.origin[1]) / s) + 1, nz - 1) : 0;
    let hmin = Infinity, g2 = 0;
    for (let j = Math.min(j0, nz - 1); j <= Math.max(j1, 0); j++) {
      for (let i = Math.min(i0, nx - 1); i <= Math.max(i1, 0); i++) {
        const k = 4 * (j * nx + i);
        if (d[k] < hmin) hmin = d[k];
        const g = d[k + 1] * d[k + 1] + d[k + 2] * d[k + 2];
        if (g > g2) g2 = g;
      }
    }
    return y + size + depth * Math.sqrt(1 + g2) <= hmin;
  }

  dispose() { this.glc.deleteTexture(this.tex); }
}

/** Signed distance of a solver primitive (see prims() in src/shaders/common.js) at p, in JS. */
export function primDistance(prim, p, dim = 3) {
  let x = p[0] - prim.center[0], y = p[1] - prim.center[1], z = dim === 2 ? 0 : p[2] - prim.center[2];
  if (prim.rot) {
    const R = prim.rot;   // column-major world -> local
    [x, y, z] = [R[0] * x + R[3] * y + R[6] * z, R[1] * x + R[4] * y + R[7] * z, R[2] * x + R[5] * y + R[8] * z];
    if (dim === 2) z = 0;
  }
  let d;
  if (prim.type === 'ball') d = Math.hypot(x, y, z) - prim.radius;
  else {
    const r = prim.round || 0;
    const qx = Math.abs(x) - prim.half[0] + r, qy = Math.abs(y) - prim.half[1] + r, qz = dim === 2 ? -1e6 : Math.abs(z) - prim.half[2] + r;
    d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
  }
  return prim.inverted ? -d : d;
}

/**
 * A SparseSim.solidBrick test for solids that never move: a terrain (or null) and primitives.
 * A cube lies inside a primitive if the centre of every one of its cells is `depth` deep in it.
 */
export function staticSolidTest(dim, terrain, prims = [], depth = 1.5) {
  return (x, y, z, size) => {
    if (terrain && terrain.solidCube(x, y, z, size, depth)) return true;
    const c = [x + size / 2, y + size / 2, dim === 2 ? 0.5 : z + size / 2];
    const r = (size / 2) * Math.sqrt(dim);
    const nz = dim === 2 ? 1 : size;
    for (const p of prims) {
      const d0 = primDistance(p, c, dim);
      if (d0 <= -(r + depth)) return true;      // the distance changes by at most 1 per cell
      if (d0 > -depth) continue;
      let inside = true;
      for (let k = 0; k < nz && inside; k++) {
        for (let j = 0; j < size && inside; j++) {
          for (let i = 0; i < size; i++) {
            if (primDistance(p, [x + i + 0.5, y + j + 0.5, z + k + 0.5], dim) > -depth) { inside = false; break; }
          }
        }
      }
      if (inside) return true;
    }
    return false;
  };
}
