// Passes that only the sparse (brick) backend needs: bookkeeping per stored brick, and copies
// between the brick pools and ordinary dense textures. See src/world/sparsesim.js.
import { header, FAR } from './common.js';

export function sparseShaders(dim) {
  const H = header(dim, false, 'sparse');
  const S = {};

  // one value into every texel of the tiles drawn (vertex shader VS_TILES)
  S.fill = `#version 300 es
precision highp float;
uniform vec4 uValue;
out vec4 o;
void main() { o = uValue; }`;

  // texel-for-texel copy (a pool texture into a larger one)
  S.copy = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 o;
void main() { o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

  // The same for the tiles drawn only (vertex shader VS_TILES).
  S.copyTiles = S.copy;

  // What an edit of the density added (r) and removed (g), per cell of the box [uLo, uLo + uN):
  // cell number i of the box goes to texel i of the target, row by row. The sum8 passes below
  // add these up; one additive blend per cell would drop every amount that is small against
  // the running total.
  S.meterDiff = `${H}
uniform Grid G;
uniform sampler2D uA;     // density before the edit
uniform sampler2D uB;     // and after
uniform ivec3 uLo;
uniform ivec3 uN;
uniform int uWidth;       // texels per row of the target
uniform int uFirst;       // cell number of texel 0
out vec4 o;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int i = uFirst + f.x + f.y * uWidth;
  o = vec4(0.0);
  if (i >= uN.x * uN.y * uN.z) return;
  ivec3 c = uLo + ivec3(i % uN.x, (i / uN.x) % uN.y, i / (uN.x * uN.y));
  ivec2 t = pageTexel(G, c);
  float d = texelFetch(uB, t, 0).r - texelFetch(uA, t, 0).r;
  o = vec4(max(d, 0.0), max(-d, 0.0), 0.0, 0.0);
}`;

  // Each texel: the sum of an 8 x 8 block of uSrc (of its first uLimit texels per axis).
  S.sum8 = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform ivec2 uLimit;
out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      ivec2 t = base + ivec2(i, j);
      if (t.x < uLimit.x && t.y < uLimit.y) sum += texelFetch(uSrc, t, 0);
    }
  }
  o = sum;
}`;

  // Held bricks (water at rest that is not solved, see SparseSim) are put back to the state of
  // rest after the density passes of every step: vertex shader VS_TILES, over the held tiles.
  //   uMerge 1: keep the density uRho where it is higher (the liquid a scene starts with, on top
  //   of the water at rest)
  S.farReset = `${H}
uniform Grid G;
${FAR}
uniform sampler2D uFrac;
uniform sampler2D uRho;
uniform int uMerge;
layout(location = 0) out vec4 oRho;
layout(location = 1) out vec4 oP;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec2 f = farState(c);
  oRho = vec4(farFill(c, texelFetch(uFrac, t, 0).a), 1.0, 0.0, 0.0);
  if (uMerge == 1) {
    vec4 r = texelFetch(uRho, t, 0);
    if (r.r > oRho.r) oRho = r;
  }
  oP = vec4(f.y, 0.0, 0.0, 0.0);
}`;

  // The velocity of the water at rest, for bricks that have just been stored (over a height field
  // it is not zero: a brick that came into a river standing still would be a rock in it).
  // uMerge = 1: only where the liquid there has no velocity of its own (a scene's liquid, at reset).
  S.farVelFill = `${H}
uniform Grid G;
${FAR}
uniform sampler2D uVel;
uniform int uMerge;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec3 f = farVel(cellOf(G, t));
  vec3 v = texelFetch(uVel, t, 0).xyz;
  o = vec4(uMerge == 1 && dot(v, v) > 0.0 ? v : f, 0.0);
}`;

  // Per slot, before that reset: what the step moved into a held brick. r = sum over its cells of
  // (rho - rho at rest), g = the largest |rho - rho at rest|, b = the sum of the absolute values.
  // Drawn with additive blending: the target adds up the steps until it is read.
  S.farDelta = `${H}
uniform Grid G;
${FAR}
uniform sampler2D uRho;
uniform sampler2D uFrac;
out vec4 o;
void main() {
  ivec2 st = ivec2(gl_FragCoord.xy);
  int slot = st.x + st.y * G.tiles.x;
  enterSlot(G, slot);
  o = vec4(0.0);
  if (!g_live || !g_held) return;
  float sum = 0.0, big = 0.0, sumAbs = 0.0;
  for (int i = 0; i < CB; i++) {
    ivec3 l = ivec3(i & BM, (i >> LB) & BM, i >> (2 * LB));
    ivec2 t = slotTexel(G.tiles, slot, l);
    float d = texelFetch(uRho, t, 0).r - farFill(g_frame + l, texelFetch(uFrac, t, 0).a);
    sum += d;
    sumAbs += abs(d);
    big = max(big, abs(d));
  }
  o = vec4(sum, big, sumAbs, 0.0);
}`;

  // Per slot (one texel each): what the brick holds. A cell is "wet" if its density exceeds
  // uWet: advection leaves traces (1e-9 and less) far around every splash, and bricks are not
  // kept or added for those. The mass is that of all cells.
  // Mist that hovers does not count as wet either. The solver moves everything that is not
  // liquid (density below one half) with the velocity of the nearest liquid, so the crumbs a
  // splash leaves in the air over water that has come to rest stay where they are for good,
  // and each would keep its brick and those around it stored. A brick without a liquid cell
  // that holds at most uMist.x cells of liquid in all, none of it faster than uMist.y, reports
  // no wet cells; it is then dropped like any dry brick once nothing else needs it.
  // With bodies of water (FAR) the pass also compares the brick with the water at rest:
  //   not at rest  a cell that moves faster than uSleep.x (below the surface), whose pressure is more than uSleep.y
  //                from that of the water at rest, or whose density is more than uSleep.z from it.
  //                A brick without such cells can be held. Reported as two counts in one number:
  //                cells that only move + 1024 * cells whose pressure or density is off.
  //   waking       a cell faster than uWake.x (or, if uWake.y is set, further than that from the
  //                pressure at rest): the bricks its liquid can reach have to be solved.
  // Held bricks report neither (they are at rest by construction).
  S.slotStats = `${H}
uniform Grid G;
${FAR}
uniform sampler2D uRho;
uniform sampler2D uVel;
uniform sampler2D uP;
uniform sampler2D uLiq;
uniform sampler2D uFrac;
uniform float uWet;
uniform float uEdge;
uniform vec3 uSleep;      // speed (cells/s), pressure, density
uniform vec3 uWake;       // speed, pressure, speed that wakes a body that sleeps
uniform vec2 uMist;       // mass (cells), speed (cells/s)
uniform float uSlope;     // over a height field: a surface steeper than this is not at rest
uniform float uBedLayer;  // ... and in this many cells over the bed neither pressure nor density is looked at
layout(location = 0) out vec4 o0;   // mass, peak speed in wet cells, cells with density above uEdge on a face whose neighbour brick is not stored, peak rho
layout(location = 1) out vec4 o1;   // lowest wet cell (brick-local), number of wet cells
layout(location = 2) out vec4 o2;   // highest wet cell, excess: sum of rho - rho at rest
layout(location = 3) out vec4 o3;   // lowest and highest waking cell (x + 16 y + 256 z; -1: none), cells not at rest (moving + 1024 * off + 4194304 if one is fast enough to wake a body), sum of rho at rest
float pack(vec3 c) { return c.x + 16.0 * c.y + 256.0 * c.z; }
// the steepest slope of the height field's surface between the texel over cell c and those next to it
float hfSlope(ivec3 c) {
  ivec2 t;
  if (!hfTexel(c - uAnchor, t)) return 0.0;
  vec3 a = hfLevel(t);
  // (in water a cell deep at least: where the ground runs through a column of the 3D solver's,
  // the depth is the water it holds and says little about where its surface is)
  if (a.x < a.y + 1.0) return 0.0;
  ivec2 n = textureSize(uHf, 0);
  float s = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 u = t + ivec2(k == 0 ? 1 : k == 1 ? -1 : 0, k == 2 ? 1 : k == 3 ? -1 : 0);
    if (u.x < 0 || u.y < 0 || u.x >= n.x || u.y >= n.y) continue;
    if (texelFetch(uHfBed, u, 0).g > 0.5) continue;
    vec3 b = hfLevel(u);
    if (b.x >= b.y + 1.0) s = max(s, abs(a.x - b.x));
  }
  return s * uHfMap.z;
}
// Is cell c within uBedLayer cells of the bed of its texel of the height field? The bed of a
// texel is the mean of its ground, and its copy fills the cells from that bed up. On sloping
// ground the solver's water lies along the slope instead: cell by cell the two differ by up to
// a cell of water wherever the water is thin, with the same amount in the column, and thin
// water on a bank would stay solved for good on that account.
bool bedLayer(ivec3 c) {
  ivec2 t;
  if (uBedLayer <= 0.0 || !hfTexel(c - uAnchor, t)) return false;
  return float(c.y - uAnchor.y) < texelFetch(uHfBed, t, 0).r + uBedLayer;
}
// Is the brick at c over water of the height field that the solver has no part of? What hangs
// in the air there, not a liquid cell in it, is going nowhere: it goes along with whatever the
// nearest liquid does. Its brick is dropped and the height field takes it ("fold").
bool hfOnlyBelow(ivec3 c) {
  ivec2 t0;
  if (!hfTexel(c - uAnchor, t0)) return false;
  ivec2 n = textureSize(uHf, 0);
  int per = int(floor(float(BS) * uHfMap.z + 0.5));
  for (int j = 0; j < per; j++) {
    for (int i = 0; i < per; i++) {
      ivec2 t = t0 + ivec2(i, DIM == 3 ? j : 0);
      if (t.x >= n.x || t.y >= n.y) continue;
      if (texelFetch(uHf, t, 0).a > 0.5) return false;
    }
#if DIM == 2
    break;
#endif
  }
  return true;
}
void main() {
  ivec2 st = ivec2(gl_FragCoord.xy);
  int slot = st.x + st.y * G.tiles.x;
  ivec3 b = enterSlot(G, slot);
  o0 = vec4(0.0);
  o1 = vec4(BIG, BIG, BIG, 0.0);
  o2 = vec4(-BIG, -BIG, -BIG, 0.0);
  o3 = vec4(-1.0, -1.0, 0.0, 0.0);
  if (!g_live) return;
  bvec3 openLo = bvec3(false);
  bvec3 openHi = bvec3(false);
  for (int d = 0; d < DIM; d++) {
    openLo[d] = unknownCell(G, g_frame - AX[d]);
    openHi[d] = unknownCell(G, g_frame + BS * AX[d]);
  }
  bool water = FAR_ON;
  // (water at rest above and below solved water is a lid and a floor by design, stored or not)
  if (water && farWetBrick(g_frame)) {
    if (openLo[1] && farWetBrick(g_frame - BS * AX[1])) openLo[1] = false;
    if (openHi[1] && farWetBrick(g_frame + BS * AX[1])) openHi[1] = false;
  }
  float mass = 0.0, vmax = 0.0, vmist = 0.0, edge = 0.0, rmax = 0.0, n = 0.0, excess = 0.0, awake = 0.0, rest = 0.0;
  vec3 lo = vec3(BIG), hi = vec3(-BIG), wlo = vec3(BIG), whi = vec3(-BIG);
  bool anyLiquid = false, strong = false;
  for (int i = 0; i < CB; i++) {
    ivec3 l = ivec3(i & BM, (i >> LB) & BM, i >> (2 * LB));
    ivec2 t = slotTexel(G.tiles, slot, l);
    float rho = texelFetch(uRho, t, 0).r;
    mass += rho;
    float speed = 0.0;
    bool liquid = texelFetch(uLiq, t, 0).r < 0.0;
    if (rho > uWet) {
      n += 1.0;
      if (liquid) anyLiquid = true;
      rmax = max(rmax, rho);
      vec3 vel = texelFetch(uVel, t, 0).xyz;
      speed = length(vel);
      vmax = max(vmax, speed);
      // (at rest means: as the water at rest moves, which over a height field it does)
      if (uHfMap.w > 0.5) speed = length(vel - farVel(g_frame + l));
      // (mist hovers over a river that is not solved by going along with it: it has the
      // velocity of the nearest liquid, which is the river's)
      vmist = max(vmist, speed);
      lo = min(lo, vec3(l));
      hi = max(hi, vec3(l));
      bool e = false;
      for (int d = 0; d < DIM; d++) if ((l[d] == 0 && openLo[d]) || (l[d] == BM && openHi[d])) e = true;
      if (e && rho > uEdge && !g_held) edge += 1.0;
    }
    if (!water) continue;
    vec2 f = farState(g_frame + l);
    float V = texelFetch(uFrac, t, 0).a;
    float fr = farFill(g_frame + l, V);
    float dev = rho - fr;
    rest += fr;
    excess += dev;
    if (g_held) continue;
    // Speed counts below the surface only: in liquid cells with liquid above them. The top cell
    // of a surface that has moved is never quite at rest. The solver keeps such a surface
    // smeared over two or three cells, which holds up to a quarter of a cell less liquid per
    // column than the sharp surface of the water at rest at the same pressure; next to a held
    // brick that difference drains away in a thin tongue that moves fast (2 sqrt(g * step))
    // and would wake brick after brick. What moves the water below the surface is what counts.
    // (and not in a cell that a solid fills by more than half: it may have no open face at all,
    // and then no pressure and no velocity that mean anything)
    if (!liquid || V < 0.5 || fetchC(uLiq, G, g_frame + l + AX[1]).r >= 0.0) speed = 0.0;
    float dp = liquid && V >= 0.5 ? abs(texelFetch(uP, t, 0).r - f.y) : 0.0;
    // (the slope: once per column of cells)
    bool off = (dp > uSleep.y || abs(dev) > uSleep.z) && !bedLayer(g_frame + l);
    if (off || (l.y == 0 && uSlope > 0.0 && hfSlope(g_frame + l) > uSlope)) awake += 1024.0;
    else if (speed > uSleep.x) awake += 1.0;
    if (speed > uWake.x || (uWake.y > 0.0 && dp > uWake.y)) { wlo = min(wlo, vec3(l)); whi = max(whi, vec3(l)); }
    if (speed > uWake.z) strong = true;
  }
  if (!anyLiquid && mass <= uMist.x && (vmist <= uMist.y || hfOnlyBelow(g_frame)) && !(water && farWetBrick(g_frame))) { n = 0.0; edge = 0.0; }
  if (strong) awake += 4194304.0;
  o0 = vec4(mass, vmax, edge, rmax);
  o1 = vec4(lo, n);
  o2 = vec4(hi, excess);
  if (whi.x >= 0.0) o3 = vec4(pack(wlo), pack(whi), awake, rest);
  else o3 = vec4(-1.0, -1.0, awake, rest);
}`;

  // Per slot, from the statistics of the bricks around it (up to NR bricks away). "Reach" of a
  // brick's liquid: its cells, widened by ceil(speed * dt) * uSteps + uMargin. Held bricks reach
  // nothing: their water is at rest.
  //   miss      the wet cells of this brick can reach a brick that is not stored and should be
  //   keep      the wet cells of some solved brick can reach this one, which has to be stored for it
  //   wakeNeed  the waking cells of this brick can reach a brick that is held or not stored
  //   wakeBy    the waking cells of some solved brick can reach this one
  // Which bricks have to be stored for a solved brick: all its liquid can reach, except that
  // water at rest next to solved water at rest is stored on the same level only (the ring of
  // held bricks, SparseSim._ring): above and below it is a lid and a floor, stored or not.
  // With these flags the CPU only has to look at bricks that need something. The pass also
  // packs everything the CPU reads into four texels per slot.
  S.slotFlags = `${H}
uniform Grid G;
uniform sampler2D uS0;    // outputs of slotStats
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform sampler2D uS3;
uniform sampler2D uD;     // what went into the held bricks since the last report (pass farDelta)
uniform float uDt;
uniform float uSteps;
uniform float uMargin;
${FAR}
layout(location = 0) out vec4 oA;   // mass, peak speed, edge cells, wet cells
layout(location = 1) out vec4 oB;   // lowest and highest wet cell (x + 16 y + 256 z), miss, keep
layout(location = 2) out vec4 oC;   // lowest and highest waking cell (-1: none), wakeNeed + 2 wakeBy, sum of rho at rest
layout(location = 3) out vec4 oD;   // excess, cells not at rest, absorbed: sum and sum of absolute values
float reach(float speed) { return ceil(speed * uDt) * uSteps + uMargin; }
float pack(vec3 c) { return c.x + 16.0 * c.y + 256.0 * c.z; }
vec3 unpack(float v) { int i = int(v + 0.5); return vec3(float(i & 15), float((i >> 4) & 15), float((i >> 8) & 15)); }
// do the cells lo..hi of this brick, widened by r, touch the brick whose corner is at off?
bool touches(vec3 lo, vec3 hi, float r, vec3 off) {
  return all(lessThanEqual(off - r, hi)) && all(greaterThanEqual(off + float(BM) + r, lo));
}
void main() {
  ivec2 st = ivec2(gl_FragCoord.xy);
  enterSlot(G, st.x + st.y * G.tiles.x);
  float miss = 0.0, keep = 0.0, wakeNeed = 0.0, wakeBy = 0.0;
  vec4 a0 = texelFetch(uS0, st, 0);
  vec4 a1 = texelFetch(uS1, st, 0);
  vec4 a2 = texelFetch(uS2, st, 0);
  vec4 a3 = texelFetch(uS3, st, 0);
  bool wet = a1.w > 0.5;
  if (g_live) {
    float r = reach(a0.y);
    bool reaches = wet && !g_held;
    bool wakes = a3.x >= 0.0 && !g_held;
    bool rest = FAR_ON && farWetBrick(g_frame);     // this brick holds water of a body at rest
    vec3 wlo = unpack(max(a3.x, 0.0)), whi = unpack(max(a3.y, 0.0));
#if DIM == 2
    const int K = 0;
#else
    const int K = NR;
#endif
    for (int k = -K; k <= K; k++) {
      for (int j = -NR; j <= NR; j++) {
        for (int i = -NR; i <= NR; i++) {
          if (i == 0 && j == 0 && k == 0) continue;
          vec3 off = vec3(ivec3(i, j, k) * BS);       // corner of the other brick, in this brick's cells
          int s = slotOf(G, g_frame + ivec3(i, j, k) * BS);
          bool level = j == 0 && abs(i) <= 1 && abs(k) <= 1;
          if (s == G.tiles.x * G.tiles.y) {
            if (reaches && touches(a1.xyz, a2.xyz, r, off) && (level || !rest || !farWetBrick(g_frame + ivec3(i, j, k) * BS))) miss = 1.0;
            if (wakes && touches(wlo, whi, r, off)) wakeNeed = 1.0;
          } else if (s < G.tiles.x * G.tiles.y) {
            ivec2 t = ivec2(s % G.tiles.x, s / G.tiles.x);
            if (texelFetch(uSl0, t, 0).w > 1.5) {
              if (wakes && touches(wlo, whi, r, off)) wakeNeed = 1.0;
              continue;
            }
            vec4 n1 = texelFetch(uS1, t, 0);
            if (n1.w < 0.5) continue;
            float rn = reach(texelFetch(uS0, t, 0).y);
            // (the other brick's cells in this brick's frame against this brick)
            if (touches(n1.xyz + off, texelFetch(uS2, t, 0).xyz + off, rn, vec3(0.0)) &&
                (level || !rest || !farWetBrick(g_frame + ivec3(i, j, k) * BS))) keep = 1.0;
            vec4 n3 = texelFetch(uS3, t, 0);
            if (n3.x >= 0.0 && touches(unpack(n3.x) + off, unpack(n3.y) + off, rn, vec3(0.0))) wakeBy = 1.0;
          }
        }
      }
    }
  }
  vec4 d = texelFetch(uD, st, 0);
  oA = vec4(a0.xyz, a1.w);
  oB = wet ? vec4(pack(a1.xyz), pack(a2.xyz), miss, keep) : vec4(0.0, 0.0, miss, keep);
  oC = vec4(a3.xy, wakeNeed + 2.0 * wakeBy, g_live ? a3.w : 0.0);
  oD = vec4(g_live ? a2.w : 0.0, a3.z, d.r, d.b);
}`;

  // A window of the sparse grid into a dense texture (2D: n.x by n.y texels; 3D: an atlas of
  // z-slices, uTx per row), for the 2D view, test comparisons and dumps. Cells that are not
  // stored read as the field's default.
  //   uFrame 1: xyz holds a position in the frame of the cell's brick; make it relative to uLo
  S.resolve = `${H}
uniform Grid G;
uniform sampler2D uSrc;
uniform ivec3 uLo;
uniform ivec3 uN;
uniform int uTx;
uniform int uFrame;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
#if DIM == 2
  ivec3 l = ivec3(t, 0);
#else
  ivec2 tile = t / uN.xy;
  ivec3 l = ivec3(t - tile * uN.xy, tile.x + tile.y * uTx);
#endif
  ivec3 c = uLo + l;
  vec4 v = texelFetch(uSrc, pageTexel(G, c), 0);
  if (uFrame == 1 && pageLookup(G, c >> LB) >= 0) v.xyz += vec3(((c >> LB) << LB) - uLo);
  o = v;
}`;

  // The neighbour table uNb0 (see header() in common.js), from the page table: one texel per
  // (slot, brick offset).
  S.nbBuild = `${H}
uniform Grid G;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 tile = t / ivec2(NBW, NBS);
  ivec2 l = t - tile * ivec2(NBW, NBS);
#if DIM == 2
  ivec3 off = ivec3(l.x - NR, l.y - NR, 0);
#else
  ivec3 off = ivec3(l.x % NBS - NR, l.y - NR, l.x / NBS - NR);
#endif
  vec4 sl = texelFetch(uSl0, tile, 0);
  int s = -1;
  if (sl.w > 0.5) {
    ivec3 b = ivec3(sl.xyz) + off;
    s = pageLookup(G, b);
    // the top table wraps: a brick far outside the stored ones lands on the entry of another
    if (s >= 0 && ivec3(texelFetch(uSl0, ivec2(s % G.tiles.x, s / G.tiles.x), 0).xyz) != b) s = -1;
  }
  // not stored: the null slot; marked solid (-2): the one after it
  o = vec4(s < 0 ? float(G.tiles.x * G.tiles.y - 1 - s) : float(s), 0.0, 0.0, 0.0);
}`;

  return S;
}
