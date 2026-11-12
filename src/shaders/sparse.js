// Passes that only the sparse (brick) backend needs: bookkeeping per stored brick, and copies
// between the brick pools and ordinary dense textures. See src/world/sparsesim.js.
import { header } from './common.js';

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

  // Per slot (one texel each): what the brick holds. A cell is "wet" if its density exceeds
  // uWet: advection leaves traces (1e-9 and less) far around every splash, and bricks are not
  // kept or added for those. The mass is that of all cells.
  S.slotStats = `${H}
uniform Grid G;
uniform sampler2D uRho;
uniform sampler2D uVel;
uniform float uWet;
uniform float uEdge;
layout(location = 0) out vec4 o0;   // mass, peak speed in wet cells, cells with density above uEdge on a face whose neighbour brick is not stored, peak rho
layout(location = 1) out vec4 o1;   // lowest wet cell (brick-local), number of wet cells
layout(location = 2) out vec4 o2;   // highest wet cell
void main() {
  ivec2 st = ivec2(gl_FragCoord.xy);
  int slot = st.x + st.y * G.tiles.x;
  ivec3 b = enterSlot(G, slot);
  o0 = vec4(0.0);
  o1 = vec4(BIG, BIG, BIG, 0.0);
  o2 = vec4(-BIG, -BIG, -BIG, 0.0);
  if (!g_live) return;
  bvec3 openLo = bvec3(false);
  bvec3 openHi = bvec3(false);
  for (int d = 0; d < DIM; d++) {
    openLo[d] = unknownCell(G, g_frame - AX[d]);
    openHi[d] = unknownCell(G, g_frame + BS * AX[d]);
  }
  float mass = 0.0, vmax = 0.0, edge = 0.0, rmax = 0.0, n = 0.0;
  vec3 lo = vec3(BIG);
  vec3 hi = vec3(-BIG);
  for (int i = 0; i < CB; i++) {
    ivec3 l = ivec3(i & BM, (i >> LB) & BM, i >> (2 * LB));
    ivec2 t = slotTexel(G.tiles, slot, l);
    float rho = texelFetch(uRho, t, 0).r;
    mass += rho;
    if (rho <= uWet) continue;
    n += 1.0;
    rmax = max(rmax, rho);
    vmax = max(vmax, length(texelFetch(uVel, t, 0).xyz));
    lo = min(lo, vec3(l));
    hi = max(hi, vec3(l));
    bool e = false;
    for (int d = 0; d < DIM; d++) if ((l[d] == 0 && openLo[d]) || (l[d] == BM && openHi[d])) e = true;
    if (e && rho > uEdge) edge += 1.0;
  }
  o0 = vec4(mass, vmax, edge, rmax);
  o1 = vec4(lo, n);
  o2 = vec4(hi, 0.0);
}`;

  // Per slot, from the statistics of the bricks around it (up to NR bricks away):
  //   r = 1: the liquid of this brick can reach a brick that is not stored
  //   g = 1: the liquid of some brick can reach this one
  // "Reach" of a brick's liquid: its wet cells, widened by ceil(speed * dt) * uSteps + uMargin.
  // With these two flags the CPU only has to look at bricks that need something. The pass also
  // packs everything the CPU reads into two texels per slot.
  S.slotFlags = `${H}
uniform Grid G;
uniform sampler2D uS0;    // outputs of slotStats
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform float uDt;
uniform float uSteps;
uniform float uMargin;
layout(location = 0) out vec4 oA;   // mass, peak speed, edge cells, wet cells
layout(location = 1) out vec4 oB;   // lowest and highest wet cell (x + 16 y + 256 z), r, g
float reach(float speed) { return ceil(speed * uDt) * uSteps + uMargin; }
float pack(vec3 c) { return c.x + 16.0 * c.y + 256.0 * c.z; }
void main() {
  ivec2 st = ivec2(gl_FragCoord.xy);
  enterSlot(G, st.x + st.y * G.tiles.x);
  float miss = 0.0, keep = 0.0;
  vec4 a0 = texelFetch(uS0, st, 0);
  vec4 a1 = texelFetch(uS1, st, 0);
  vec4 a2 = texelFetch(uS2, st, 0);
  bool wet = a1.w > 0.5;
  if (g_live) {
    float r = reach(a0.y);
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
          if (s == G.tiles.x * G.tiles.y) {
            if (wet && all(lessThanEqual(off - r, a2.xyz)) && all(greaterThanEqual(off + float(BM) + r, a1.xyz))) miss = 1.0;
          } else if (s < G.tiles.x * G.tiles.y) {
            ivec2 t = ivec2(s % G.tiles.x, s / G.tiles.x);
            vec4 n1 = texelFetch(uS1, t, 0);
            if (n1.w > 0.5) {
              float rn = reach(texelFetch(uS0, t, 0).y);
              vec3 hi = texelFetch(uS2, t, 0).xyz + off + rn;
              if (all(lessThanEqual(n1.xyz + off - rn, vec3(float(BM)))) && all(greaterThanEqual(hi, vec3(0.0)))) keep = 1.0;
            }
          }
        }
      }
    }
  }
  oA = vec4(a0.xyz, a1.w);
  oB = wet ? vec4(pack(a1.xyz), pack(a2.xyz), miss, keep) : vec4(0.0, 0.0, miss, keep);
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
