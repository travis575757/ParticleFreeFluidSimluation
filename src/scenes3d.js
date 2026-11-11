// 3D scenarios. Geometry is in tank units: the tank interior is 1 unit high (y), `size[0]`
// units long (x) and `size[1]` units deep (z), origin at the lower corner; velocities in m/s.
// buildScene3D() converts to grid cells for a tank that is N cells high.
import { quatFromAxisAngle, quatToWorldToLocal } from './bodies.js';

const TAU = 2 * Math.PI;

export const SCENES3D = {
  damBreak: {
    title: 'Dam break',
    blurb: 'A block of liquid collapses in a glass tank (Fig. 9).',
    size: [2, 1],
    liquid: [{ type: 'box', c: [0.3, 0.32, 0.5], half: [0.3, 0.32, 0.5] }],
  },
  splat: {
    title: 'Splat (ball into empty tank)',
    blurb: 'A liquid ball hits the dry floor and spreads into a thin sheet (Fig. 7).',
    size: [1, 1],
    liquid: [{ type: 'ball', c: [0.5, 0.62, 0.5], r: 0.2 }],
  },
  crown: {
    title: 'Crown splash',
    blurb: 'A liquid ball drops into a pool and raises a crown (Fig. 5, Fig. 6).',
    size: [1, 1],
    liquid: [{ type: 'box', c: [0.5, 0.1, 0.5], half: [0.5, 0.1, 0.5] }, { type: 'ball', c: [0.5, 0.6, 0.5], r: 0.13, v: [0, -4, 0] }],
  },
  damAndBall: {
    title: 'Dam break + falling ball',
    blurb: 'The scene of Fig. 9: a dam break with a liquid ball dropped on top.',
    size: [2, 1],
    liquid: [{ type: 'box', c: [0.25, 0.35, 0.5], half: [0.25, 0.35, 0.5] }, { type: 'ball', c: [1.3, 0.7, 0.5], r: 0.16 }],
  },
  jet: {
    title: 'Jet into tank',
    blurb: 'A fast jet fills a rectangular tank (Fig. 1); the liquid crosses many cells per step.',
    size: [2, 1],
    liquid: [{ type: 'box', c: [1.0, 0.03, 0.5], half: [1.0, 0.03, 0.5] }],
    emitters: [{ shape: { type: 'ball', c: [0.12, 0.66, 0.5], r: 0.085 }, v: [8, 0.5, 0], until: 8 }],
  },
  sphere: {
    title: 'Spherical container',
    blurb: 'Dam break inside a sphere (Fig. 8): no wall is aligned with the grid.',
    size: [1, 1],
    container: 'ball',
    liquid: [{ type: 'box', c: [0.2, 0.5, 0.5], half: [0.2, 0.5, 0.5] }],
  },
  obstacle: {
    title: 'Fast moving obstacle',
    blurb: 'A solid ball races back and forth through the tank (Fig. 11) and throws the liquid into the air.',
    size: [2, 1],
    liquid: [{ type: 'box', c: [1.0, 0.14, 0.5], half: [1.0, 0.14, 0.5] }],
    kinematic: (t) => [{ shape: 'ball', c: [1.0 + 0.72 * Math.sin(t * 2.0), 0.17 + 0.04 * Math.sin(t * 4.0), 0.5 + 0.15 * Math.sin(t * 1.3)], r: 0.11 }],
  },
  floaters: {
    title: 'Floating bodies',
    blurb: 'Rigid bodies of different densities drop into the pool. Drag them with the mouse.',
    size: [1.5, 1],
    liquid: [{ type: 'box', c: [0.75, 0.16, 0.5], half: [0.75, 0.16, 0.5] }],
    bodies: [
      { shape: 'box', c: [0.4, 0.6, 0.45], half: [0.1, 0.06, 0.08], density: 0.45, axis: [0.3, 1, 0.2], angle: 0.6, color: 0 },
      { shape: 'ball', c: [0.8, 0.75, 0.55], r: 0.075, density: 0.7, color: 1 },
      { shape: 'box', c: [1.1, 0.55, 0.5], half: [0.07, 0.07, 0.07], density: 1.9, axis: [1, 0.2, 0.4], angle: 0.5, color: 2 },
      { shape: 'ball', c: [0.6, 0.95, 0.35], r: 0.055, density: 0.25, color: 3 },
    ],
  },
  still: {
    title: 'Still pool',
    blurb: 'Hydrostatic rest state. Stir it with the mouse or pour liquid in.',
    size: [1.5, 1],
    liquid: [{ type: 'box', c: [0.75, 0.2, 0.5], half: [0.75, 0.2, 0.5] }],
  },
};

const round16 = (v) => Math.max(16, Math.round(v / 16) * 16);

/** Convert a scene description into grid-unit data for a tank that is N cells high. */
export function buildScene3D(desc, N) {
  const size = desc.size || [1, 1];
  const ny = round16(N);
  const nx = round16(N * size[0]);
  const nz = round16(N * size[1]);
  const margin = 1;
  const L = ny - 2 * margin;
  const h = (desc.height || 3.2) / ny;      // metres per cell (64 cells high -> dx = 0.05 m)
  // tank units -> cells; x and z are stretched slightly so the unit tank spans the interior exactly
  const sx = (nx - 2 * margin) / size[0];
  const sz = (nz - 2 * margin) / size[1];
  const X = (p) => [margin + p[0] * sx, margin + p[1] * L, margin + p[2] * sz];
  const prim = (s) => {
    const v = s.v || [0, 0, 0];
    const out = { type: s.type, center: X(s.c), vel: [v[0] / h, v[1] / h, v[2] / h] };
    if (s.type === 'ball') out.radius = s.r * L;
    else {
      out.half = [s.half[0] * sx, s.half[1] * L, s.half[2] * sz];
      out.round = (s.round || 0) * L;
      if (s.axis) out.rot = quatToWorldToLocal(quatFromAxisAngle(s.axis, s.angle || 0));
    }
    return out;
  };
  const body = (s) => {
    const v = s.v || [0, 0, 0];
    const out = { shape: s.shape, pos: X(s.c), vel: [v[0] / h, v[1] / h, v[2] / h], density: s.density, color: s.color,
      quat: quatFromAxisAngle(s.axis || [0, 1, 0], s.angle || 0), omega: s.omega };
    if (s.shape === 'ball') out.radius = s.r * L;
    else { out.half = [s.half[0] * L, s.half[1] * L, s.half[2] * L]; out.round = (s.round || 0) * L; }
    return out;
  };
  const centre = [nx / 2, ny / 2, nz / 2];
  const container = (t) => {
    const o = desc.shake ? desc.shake(t) : [0, 0, 0];
    const c = [centre[0] + o[0] * L, centre[1] + o[1] * L, centre[2] + o[2] * L];
    return desc.container === 'ball'
      ? { type: 'ball', inverted: true, center: c, radius: Math.min(nx, ny, nz) / 2 - margin }
      : { type: 'box', inverted: true, center: c, half: [nx / 2 - margin, ny / 2 - margin, nz / 2 - margin] };
  };
  return {
    desc, nx, ny, nz, h, L, margin, X, TAU,
    params: { h, ...(desc.params || {}) },
    liquid: (desc.liquid || []).map(prim),
    container,
    kinematic: desc.kinematic ? (t) => desc.kinematic(t).map(body) : null,
    bodies: (desc.bodies || []).map(body),
    emitters: (desc.emitters || []).map((e) => ({ from: e.from, until: e.until, period: e.period, duty: e.duty, prim: () => prim({ ...e.shape, v: e.v }) })),
  };
}
