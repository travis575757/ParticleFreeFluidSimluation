// Passes that tie the height field (src/world/heightfield.js) to the 3D solver (SparseSim).
//
// The height field holds the water of its map: its depth h is the volume of water in the column
// over a texel, whether the 3D solver has that water in cells of its own or not. Where no brick is
// solved the height field moves the water itself. Where bricks are solved the 3D solver does,
// and the height field only keeps count:
//   - Held bricks next to solved ones are copies of the height field (FAR in common.js): level,
//     pressure and velocity, made afresh after every step. The 3D solver moves liquid into them
//     and out of them like into any cell (nothing between two of them: "advGather" in sim.js).
//     What a step changed in them is the exchange between the two solvers: it is handed to the
//     height field, which takes it in during its own step.
//   - A column whose bricks are solved from the bed up is the 3D solver's: h follows the liquid
//     in its cells, all of it, and changes by what they gained. The height field itself leaves
//     such a texel alone and lets nothing through its faces; the faces carry the velocity of
//     the 3D liquid there, averaged over the depth, for the copies and for the height field's
//     own advection next to it.
//   - Liquid in solved bricks over a column that is not the 3D solver's (a jet through the air
//     above a lake that is not solved) is no part of h: the level under it must not rise before
//     it lands. It becomes part of h when it enters a held cell (the exchange above), when the
//     column becomes the 3D solver's, or when its brick is dropped with liquid still in it.
// So every face has one solver that moves water through it, and a column that goes from held to
// solved or back changes nothing: it is the same water, described differently. The water of a
// world is the depths, what the height field has been handed and not taken in yet, and the
// liquid in solved bricks over columns that are not the 3D solver's.
import { header, FAR } from './common.js';
import { LOST } from './heightfield.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export function hfCoupleShaders(dim, cell) {
  const H = header(dim, false, 'sparse');
  const S = {};

  // Per texel of the height field, over the stored bricks of its column:
  //   o0.r  S: the liquid in the cells of solved bricks
  //   o0.g  D: the liquid in the cells of held bricks, less what the water at rest puts there
  //   o0.b  1 if the 3D solver owns the column: the brick that holds its bed is solved. (Columns
  //         of bricks are solved from the bed to the surface or not at all, see SparseSim. The
  //         bed and the bricks say whose a column is, not the water: it changes hands only when
  //         the set of bricks changes.)
  //   o0.a  A: the liquid in the cells of solved bricks, less what the water at rest puts there
  //   o1.rg what goes through the texel's low-x face: the sum of rho * velocity over the cells
  //         at that face (solved or held: the solver moves the faces of both), and of rho
  //   o1.ba the same for the low-z face
  S.column = `${H}
uniform Grid G;
${FAR}
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform sampler2D uVel;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
const int CELL = ${cell};
// slot of brick b (-1 if it is not stored) and its state
int storedSlot(ivec3 b, out float state) {
  state = 0.0;
  int s = pageLookup(G, b);
  if (s < 0) return -1;
  vec4 sl = texelFetch(uSl0, ivec2(s % G.tiles.x, s / G.tiles.x), 0);
  if (sl.w < 0.5 || ivec3(sl.xyz) != b) return -1;
  state = sl.w;
  return s;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  o0 = vec4(0.0);
  o1 = vec4(0.0);
  // world cell of the texel's corner, and its column of bricks
#if DIM == 2
  ivec3 c0 = ivec3(int(floor(uHfMap.x + 0.5)) + uAnchor.x + t.x * CELL, 0, 0);
  ivec2 k = ivec2(c0.x >> LB, 0) - uHfColsMap.xy;
#else
  ivec3 c0 = ivec3(int(floor(uHfMap.x + 0.5)) + uAnchor.x + t.x * CELL, 0, int(floor(uHfMap.y + 0.5)) + uAnchor.z + t.y * CELL);
  ivec2 k = (c0.xz >> LB) - uHfColsMap.xy;
#endif
  vec4 q = texelFetch(uHfCols, k, 0);
  int y0 = int(q.b), y1 = int(q.a);
  // the row of bricks with the lowest water of the texel in it
  vec2 bed = texelFetch(uHfBed, t, 0).rg;
  int yb = (int(floor(bed.x)) + uAnchor.y) >> LB;
  float sum = 0.0, dev = 0.0, air = 0.0;
  vec4 mom = vec4(0.0);
  bool bedSolved = false;
  for (int by = y0; by < y1; by++) {
    ivec3 b = ivec3(c0.x >> LB, by, c0.z >> LB);
    float state;
    int s = storedSlot(b, state);
    if (s < 0) continue;
    bool h = state > 1.5;
    if (!h && by == yb) bedSolved = true;
#if DIM == 3
    for (int kk = 0; kk < CELL; kk++) {
#else
    for (int kk = 0; kk < 1; kk++) {
#endif
      for (int i = 0; i < CELL; i++) {
        for (int j = 0; j < BS; j++) {
          ivec3 l = ivec3((c0.x & BM) + i, j, (c0.z & BM) + kk);
          ivec2 tt = slotTexel(G.tiles, s, l);
          float rho = texelFetch(uRho, tt, 0).r;
          float over = rho - farFill(b * BS + l, texelFetch(uFrac, tt, 0).a);
          if (h) dev += over; else { sum += rho; air += over; }
          if (i == 0 || kk == 0) {
            vec3 v = texelFetch(uVel, tt, 0).xyz;
            if (i == 0) mom.rg += vec2(rho * v.x, rho);
            if (kk == 0) mom.ba += vec2(rho * v.z, rho);
          }
        }
      }
    }
  }
  o0 = vec4(sum, dev, bedSolved && bed.y < 0.5 ? 1.0 : 0.0, air);
  o1 = mom;
}`;

  // The height field after "column" has counted (uC0; uPrev: its count before). The water of a
  // texel is its depth, what it has been handed (uX.r, cells of depth) and, if the column is not
  // the 3D solver's, the liquid S in solved bricks over it. What a step or a change of the
  // bricks does to that sum is handed over:
  //   uMode 0  after the density passes of a step: what the step moved into the held cells of
  //            the column (D), and for a column of the 3D solver's what its solved cells gained.
  //   uMode 1  the set of bricks has changed and the liquid has not: for a column that is not
  //            the 3D solver's, what its solved cells hold less than before. (A brick dropped
  //            or held with liquid in it: the liquid has fallen into the height field. A brick
  //            stored with water at rest in it: the height field has given it that water.)
  //   uMode 2  a scene has been set up: the bricks hold the water at rest of the height field as
  //            it is, and the liquid of the scene on top of it. What that adds to the held cells
  //            (D) and to the solved cells of a column of the 3D solver's (A) is handed over.
  // and a column that changes hands takes S into its depth, or leaves it out again.
  // A texel of the 3D solver's takes what it is handed at once: its depth is that solver's
  // liquid. The others take it in during the height field's own step (pass "depth" in
  // src/shaders/heightfield.js). The texels of the 3D solver are marked, and their faces get the
  // velocity the 3D liquid has there (its mean over the depth), which is what the copies next to
  // it and the height field's own advection read.
  S.fold = `${HEAD}
uniform sampler2D uH;
uniform sampler2D uX;
uniform sampler2D uC0;
uniform sampler2D uC1;
uniform sampler2D uPrev;
uniform float uInvArea;
uniform int uMode;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oX;
${LOST}
bool owned(ivec2 t) {
  ivec2 n = textureSize(uH, 0);
  if (t.x < 0 || t.y < 0 || t.x >= n.x || t.y >= n.y) return false;
  return texelFetch(uC0, t, 0).b > 0.5;
}
float face(ivec2 t, int ax, float own) {
  if (!owned(t) && !owned(t - (ax == 0 ? ivec2(1, 0) : ivec2(0, 1)))) return own;
  vec4 c = texelFetch(uC1, t, 0);
  vec2 m = ax == 0 ? c.rg : c.ba;
  // (no liquid at the face, or no brick: nothing goes through)
  return m.y > 1.0e-6 ? m.x / m.y : 0.0;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH, t, 0);
  vec4 c = texelFetch(uC0, t, 0), p = texelFetch(uPrev, t, 0);
  // (g: what the sums have lost, see pass "depth" of the height field)
  vec2 xg = texelFetch(uX, t, 0).rg;
  float h = s.r, x = xg.r;
  bool own = c.b > 0.5, was = s.a > 0.5;
  float d;
  if (uMode == 0) d = c.g + (was && own ? c.r - p.r : was ? -p.r : own ? c.r : 0.0);
  else if (uMode == 1) d = (was ? 0.0 : p.r) - (own ? 0.0 : c.r);
  else d = c.g + (own ? c.a : 0.0);
  x += d * uInvArea;
  if (own) {
    // (a texel cannot hold less than nothing: what it is short of it goes on owing)
    float hn = h + x;
    xg.g += lost(h, x, hn);
    h = max(hn, 0.0);
    x = min(hn, 0.0);
  }
  o = vec4(h, face(t, 0, s.g), face(t, 1, s.b), c.b);
  oX = vec4(x, xg.g, 0.0, 0.0);
}`;

  // For the books: per texel r = its water in cells of depth (the depth, what it has been
  // handed, and for a column that is not the 3D solver's the liquid in solved bricks over it),
  // g = 1 if the column is the 3D solver's, b = 1 if it is wet.
  S.water = `${HEAD}
uniform sampler2D uH;
uniform sampler2D uX;
uniform sampler2D uC0;
uniform float uInvArea;
uniform float uDry;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH, t, 0);
  vec2 x = texelFetch(uX, t, 0).rg;
  vec4 c = texelFetch(uC0, t, 0);
  bool own = s.a > 0.5;
  o = vec4(s.r + x.r + x.g + (own ? 0.0 : c.r * uInvArea), own ? 1.0 : 0.0, s.r > uDry ? 1.0 : 0.0, 0.0);
}`;

  // What the CPU needs to know of the height field to decide which bricks hold its water: per
  // column of bricks (uPer texels on a side) r = the lowest bed under water, g = the highest
  // level of the water (r > g: the column is dry), a = the fastest water, and b = what in it a
  // height field cannot hold:
  //   1  a front: the surface is steeper than uSteep between two texels and the step higher
  //      than uBreak of the depth before it (a bore about to break; water coming over a dry bed)
  //   2  water leaves the bed: it runs over a drop of the bed steeper than uFall, down to a level
  //      below the lip. Both columns have it, the one with the lip and the one the water falls to.
  S.cols = `${HEAD}
uniform sampler2D uH;
uniform sampler2D uBed;
uniform int uPer;
uniform float uDry;
uniform float uDx;        // cells per texel
uniform float uSteep;
uniform float uBreak;
uniform float uFall;
uniform float uFallMin;   // ... of water at least this deep on the lip
uniform float uFallSpeed; // ... that runs over it at least this fast (cells per second)
out vec4 o;
void main() {
  ivec2 k = ivec2(gl_FragCoord.xy);
  ivec2 n = textureSize(uH, 0);
  float lo = 1.0e30, hi = -1.0e30, vmax = 0.0;
  bool front = false, fall = false;
  for (int j = 0; j < uPer; j++) {
    for (int i = 0; i < uPer; i++) {
      ivec2 t = k * uPer + ivec2(i, j);
      if (t.x >= n.x || t.y >= n.y) continue;
      vec2 b = texelFetch(uBed, t, 0).rg;
      if (b.y > 0.5) continue;
      vec4 s = texelFetch(uH, t, 0);
      bool wet = s.r > uDry;
      if (wet) { lo = min(lo, b.x); hi = max(hi, b.x + s.r); vmax = max(vmax, max(abs(s.g), abs(s.b))); }
      for (int q = 0; q < 4; q++) {
        ivec2 u = t + ivec2(q == 0 ? 1 : q == 1 ? -1 : 0, q == 2 ? 1 : q == 3 ? -1 : 0);
        if (u.x < 0 || u.y < 0 || u.x >= n.x || u.y >= n.y) continue;
        vec2 c = texelFetch(uBed, u, 0).rg;
        if (c.y > 0.5) continue;
        vec4 su = texelFetch(uH, u, 0);
        float hu = su.r;
        bool wetU = hu > uDry;
        if (!wet && !wetU) continue;

        // the surface on either side (of a dry texel: its bed)
        float a0 = b.x + (wet ? s.r : 0.0), a1 = c.x + (wetU ? hu : 0.0);
        float h0 = wet ? s.r : 0.0, h1 = wetU ? hu : 0.0;
        // A step in the surface that is one in the depth too. (Water that runs down a steep
        // bed has the first without the second, water at rest over one the second without the
        // first: neither is a front.)
        float step = min(abs(a0 - a1), abs(h0 - h1));
        // the water on the low side of the step
        float before = a0 > a1 ? h1 : h0;
        // (water that stands against higher dry ground is a shore)
        bool shore = a0 > a1 ? !wet : !wetU;
        // Only in water that is the height field's own. Under solved bricks a texel of a bank
        // holds the little liquid that stands over its lower part, on a bed that is the mean of
        // its ground and so above the level beside it: a step that is no front, and would keep
        // every bank solved. Solved water goes by what the solver finds in it (slotStats).
        bool mine = s.a < 0.5 && su.a < 0.5;
        if (mine && !shore && step > uSteep * uDx && step > uBreak * before) front = true;
        // The lip is the higher bed; its water runs down to a level below it. (Runs: the same
        // texel of a bank is no lip either, and its liquid goes nowhere.)
        float drop = abs(b.x - c.x);
        float lip = b.x > c.x ? h0 : h1;
        float below = b.x > c.x ? a1 : a0;
        float v = q == 0 ? su.g : q == 1 ? -s.g : q == 2 ? su.b : -s.b;     // from t to u
        float down = b.x > c.x ? v : -v;
        if (drop > uFall * uDx && lip > uFallMin && below < max(b.x, c.x) && down > uFallSpeed) fall = true;
      }
    }
  }
  o = vec4(lo, hi, (front ? 1.0 : 0.0) + (fall ? 2.0 : 0.0), vmax);
}`;

  return S;
}
