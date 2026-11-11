// 2D scenarios. Geometry is written in tank units (the tank interior is 1 unit high and
// `aspect` units wide, origin at its lower-left corner) and SI velocities; buildScene()
// converts everything to grid cells for a tank that is N cells high.
import { rotZ } from './sim.js';

const TAU = 2 * Math.PI;

export const SCENES2D = {
  damBreak: {
    title: 'Dam break',
    blurb: 'A column of liquid collapses, runs up the far wall and overturns.',
    liquid: [{ type: 'box', c: [0.2, 0.3], half: [0.2, 0.3] }],
  },
  ballDrop: {
    title: 'Splat (ball into empty tank)',
    blurb: 'The test of Fig. 2 / Fig. 7: a liquid ball splats on a dry floor and spreads into sheets thinner than a cell.',
    liquid: [{ type: 'ball', c: [0.5, 0.62], r: 0.18 }],
  },
  splash: {
    title: 'Ball into pool',
    blurb: 'A liquid ball hits a pool and throws up a crown (Fig. 5).',
    liquid: [{ type: 'box', c: [0.5, 0.11], half: [0.5, 0.11] }, { type: 'ball', c: [0.5, 0.62], r: 0.12, v: [0, -3] }],
  },
  doubleDam: {
    title: 'Double dam break',
    blurb: 'Two columns collapse towards each other and collide in the middle.',
    liquid: [{ type: 'box', c: [0.14, 0.3], half: [0.14, 0.3] }, { type: 'box', c: [0.86, 0.3], half: [0.14, 0.3] }],
  },
  jet: {
    title: 'Jet into tank',
    blurb: 'A fast jet fills a wide tank (Fig. 1). The liquid crosses many cells per step.',
    aspect: 2,
    liquid: [{ type: 'box', c: [1.0, 0.04], half: [1.0, 0.04] }],
    emitters: [{ shape: { type: 'box', c: [0.09, 0.62], half: [0.09, 0.05] }, v: [9, 0], until: 7 }],
  },
  rain: {
    title: 'Filling a dry tank',
    blurb: 'Liquid balls keep dropping into an initially dry tank, a hard case for level sets.',
    liquid: [],
    emitters: [
      { shape: { type: 'ball', c: [0.3, 0.86], r: 0.07 }, v: [1.5, -2], period: 0.9, duty: 0.03, until: 14 },
      { shape: { type: 'ball', c: [0.72, 0.8], r: 0.055 }, v: [-2, -1], period: 0.7, duty: 0.03, from: 0.35, until: 14 },
    ],
  },
  obstacle: {
    title: 'Dam break over a step',
    blurb: 'The wave hits a fixed block; with separating boundary conditions it peels off instead of sticking.',
    liquid: [{ type: 'box', c: [0.17, 0.32], half: [0.17, 0.32] }],
    kinematic: () => [{ shape: 'box', c: [0.62, 0.07], half: [0.06, 0.07] }],
  },
  paddle: {
    title: 'Fast moving obstacle',
    blurb: 'A solid sweeps through the pool at high speed (Fig. 11). Liquid it runs over is pushed out of the solid, not lost.',
    aspect: 1.5,
    liquid: [{ type: 'box', c: [0.75, 0.16], half: [0.75, 0.16] }],
    kinematic: (t) => [{ shape: 'ball', c: [0.75 + 0.5 * Math.sin(t * 2.2), 0.17 + 0.03 * Math.sin(t * 4.4)], r: 0.085 }],
  },
  mixer: {
    title: 'Rotating paddle',
    blurb: 'A bar rotates in the tank; cells are cut by the solid at every angle.',
    liquid: [{ type: 'box', c: [0.5, 0.2], half: [0.5, 0.2] }],
    kinematic: (t) => [{ shape: 'box', c: [0.5, 0.3], half: [0.26, 0.022], angle: 1.8 * t }],
  },
  roundTank: {
    title: 'Round container',
    blurb: 'Dam break in a circular tank (Fig. 8): none of the walls is aligned with the grid.',
    container: 'ball',
    liquid: [{ type: 'box', c: [0.2, 0.5], half: [0.2, 0.5] }],
  },
  shaker: {
    title: 'Shaken container',
    blurb: 'The whole tank oscillates sideways and the liquid sloshes against the moving walls.',
    container: 'ball',
    liquid: [{ type: 'box', c: [0.5, 0.17], half: [0.5, 0.17] }],
    shake: (t) => [0.055 * Math.sin(TAU * 0.55 * t) * Math.min(1, t), 0],
    margin: 0.08,
  },
  floaters: {
    title: 'Floating bodies',
    blurb: 'Rigid bodies of different densities fall into the pool; drag them or throw them with the mouse.',
    liquid: [{ type: 'box', c: [0.5, 0.17], half: [0.5, 0.17] }],
    bodies: [
      { shape: 'box', c: [0.25, 0.6], half: [0.075, 0.05], density: 0.45, angle: 0.3, color: 0 },
      { shape: 'ball', c: [0.5, 0.75], r: 0.06, density: 0.7, color: 1 },
      { shape: 'box', c: [0.74, 0.55], half: [0.05, 0.05], density: 1.9, angle: -0.5, color: 2 },
      { shape: 'ball', c: [0.62, 0.9], r: 0.04, density: 0.25, color: 3 },
    ],
  },
  still: {
    title: 'Still pool',
    blurb: 'Hydrostatic rest state. Push it around with the mouse or drop bodies in.',
    liquid: [{ type: 'box', c: [0.5, 0.2], half: [0.5, 0.2] }],
  },
};

/** Convert a scene description into grid-unit data for a tank that is N cells high. */
export function buildScene(desc, N) {
  const aspect = desc.aspect || 1;
  const ny = N;
  const nx = Math.round((N * aspect) / 16) * 16;
  const margin = Math.max(1, Math.round((desc.margin || 0) * N));   // wall thickness in cells (room for a moving container)
  const L = ny - 2 * margin;                                         // interior height in cells == 1 tank unit
  const h = (desc.height || 6.4) / ny;                               // metres per cell (128 cells -> dx = 0.05 m, as in the paper)
  const X = (p) => [margin + p[0] * L, margin + p[1] * L, 0.5];
  const prim = (s) => {
    const v = s.v || [0, 0];
    const out = { type: s.type, center: X(s.c), vel: [v[0] / h, v[1] / h, 0] };
    if (s.type === 'ball') out.radius = s.r * L;
    else { out.half = [s.half[0] * L, s.half[1] * L, 1]; out.round = (s.round || 0) * L; out.rot = rotZ(s.angle || 0); }
    return out;
  };
  const body = (s) => {
    const v = s.v || [0, 0];
    const out = { shape: s.shape, pos: X(s.c), vel: [v[0] / h, v[1] / h, 0], angle: s.angle || 0, density: s.density, color: s.color };
    if (s.shape === 'ball') out.radius = s.r * L;
    else { out.half = [s.half[0] * L, s.half[1] * L, 1]; out.round = (s.round || 0) * L; }
    return out;
  };
  const centre = [nx / 2, ny / 2, 0.5];
  const container = (t) => {
    const o = desc.shake ? desc.shake(t) : [0, 0];
    const c = [centre[0] + o[0] * L, centre[1] + o[1] * L, 0.5];
    return desc.container === 'ball'
      ? { type: 'ball', inverted: true, center: c, radius: Math.min(nx, ny) / 2 - margin }
      : { type: 'box', inverted: true, center: c, half: [nx / 2 - margin, ny / 2 - margin, 1] };
  };
  return {
    desc, nx, ny, nz: 1, h, L, margin, X,
    params: { h, ...(desc.params || {}) },
    liquid: (desc.liquid || []).map(prim),
    container,
    kinematic: desc.kinematic ? (t) => desc.kinematic(t).map(body) : null,
    bodies: (desc.bodies || []).map(body),
    emitters: (desc.emitters || []).map((e) => ({ from: e.from, until: e.until, period: e.period, duty: e.duty, prim: () => prim({ ...e.shape, v: e.v }) })),
  };
}
