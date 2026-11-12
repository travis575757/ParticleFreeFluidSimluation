// Shared GLSL chunks. All simulation shaders are written once for a 3D grid stored as a
// 2D "atlas" of z-slices; the 2D simulator is the nz = 1 special case (DIM == 2 strips the
// z-work at compile time).
//
// Conventions (grid units, one cell = 1):
//   cell (i,j,k) spans [i,i+1]x[j,j+1]x[k,k+1], centre at (i+.5, j+.5, k+.5)
//   velocity texel (i,j,k) stores the staggered components on the cell's LOW faces:
//       u at (i, j+.5, k+.5), v at (i+.5, j, k+.5), w at (i+.5, j+.5, k)

export const MAX_PRIMS = 12;
export const EPSV = '1.0e-3'; // floor on the capacity weight so scatter weights can always be normalised

// Bricks of the sparse backend: BRICK[dim] cells per side, stored as one tile of a pool texture
// (2D: B x B texels; 3D: the B z-slices side by side, B*B x B texels). LEAF_LOG: a leaf of the
// page table covers 2^LEAF_LOG bricks per side.
export const BRICK = { 2: 16, 3: 8 };
export const LEAF_LOG = 4;
// Each stored brick knows the slots of the bricks up to NB_REACH away on every axis.
export const NB_REACH = 2;

// The simulation passes address the grid only through the helpers below, so the same pass
// sources run on two storage layouts ("backends"):
//
//   dense   one box of n cells; in 3D the z-slices are tiled into a 2D atlas. Cells outside the
//           box do not exist; fetchC replicates the edge cell.
//   sparse  an unbounded grid of which only some bricks are stored (see src/world/bricks.js).
//           A cell whose brick is not stored reads as the field's default (the "null tile").
//
// A pass addresses its own level as `Grid` and the next finer or coarser one as `GridX` (the
// same type in the dense backend).
//
//   cellOf(g, t)            cell of texel t (and, sparse, makes its brick the current frame)
//   texelOf(g, c)           texel of cell c; sparse: always valid (the null tile if c is not stored)
//   hasCell(g, c)           c is stored
//   present(liq, g, c)      c is stored AND stands for real cells: on coarse multigrid levels a
//                           stored cell none of whose children exists is marked V < 0 in `liq`
//   fetchC(s, g, c)         value at c (dense: edge-replicated; sparse: default if not stored)
//   cellPos(c, off)         position of a point of cell c, in the current frame
//   cellAt(f)               cell containing the frame position f (already floored)
//   shapePos(x)             frame position -> coordinates of the analytic shapes and the brush
//   sampleLin / sampleFast  multilinear interpolation of cell-centred data at a frame position
//   sampleCoarseIn(s, liq, gc, c)   interpolation on the next coarser grid gc at the centre of
//                           cell c, over the coarse cells that are present (liq = gc's liq)
//   sampleCoarseKnown(s, gc, c)     the same for data that carries its own "present" flag in .w
//   capW(frac, g, c)        capacity weight of c as the target of a deposit
//   pointTexel(g, i)        source texel of the i-th cell of a scatter pass (sets g_live)
//   texelClip(g, t)         clip-space position of texel t
//   liveTexel(g, t)         texel t holds a cell
//
// Frame: positions are floats. Dense uses grid coordinates. Sparse measures them from the corner
// of the brick the fragment (or scatter point) belongs to, so their precision does not depend
// on where in the world the brick lies; cells are world integers.
export function header(dim, floatLinear = true, backend = 'dense') {
  const sparse = backend === 'sparse';
  const B = BRICK[dim];
  const LB = Math.log2(B);
  const S = 1 << LEAF_LOG;
  const common = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define DIM ${dim}
#define NC ${dim === 2 ? 4 : 8}
${floatLinear && !sparse ? '' : '#define NO_LINEAR'}
const float BIG = 1.0e30;
const ivec3 AX[3] = ivec3[3](ivec3(1, 0, 0), ivec3(0, 1, 0), ivec3(0, 0, 1));
ivec3 cornerOffset(int k) { return ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1); }
float cornerWeight(int k, vec3 a) {
  vec3 w = mix(1.0 - a, a, vec3(cornerOffset(k)));
#if DIM == 2
  return w.x * w.y;
#else
  return w.x * w.y * w.z;
#endif
}
`;
  if (!sparse) return common + `
struct Grid { ivec3 n; int tx; vec2 inv; };
#define GridX Grid
const bool g_live = true;
ivec2 texelOf(Grid g, ivec3 c) {
#if DIM == 2
  return c.xy;
#else
  return ivec2(c.x + (c.z % g.tx) * g.n.x, c.y + (c.z / g.tx) * g.n.y);
#endif
}
ivec3 cellOf(Grid g, ivec2 t) {
#if DIM == 2
  return ivec3(t, 0);
#else
  ivec2 tile = t / g.n.xy;
  return ivec3(t - tile * g.n.xy, tile.x + tile.y * g.tx);
#endif
}
bool inGrid(Grid g, ivec3 c) { return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, g.n)); }
bool hasCell(Grid g, ivec3 c) { return inGrid(g, c); }
bool present(sampler2D liq, Grid g, ivec3 c) { return inGrid(g, c); }
ivec3 clampCell(Grid g, ivec3 c) { return clamp(c, ivec3(0), g.n - 1); }
vec4 fetchC(sampler2D s, Grid g, ivec3 c) { return texelFetch(s, texelOf(g, clampCell(g, c)), 0); }
ivec3 cellAt(vec3 f) { return ivec3(f); }
// position of the cell-relative offset; in 2D the z coordinate is pinned to the slab centre
vec3 cellPos(ivec3 c, vec3 off) {
#if DIM == 2
  return vec3(vec2(c.xy) + off.xy, 0.5);
#else
  return vec3(c) + off;
#endif
}
vec3 shapePos(vec3 x) { return x; }
vec3 clampFrame(Grid g, vec3 x) {
#if DIM == 2
  return vec3(clamp(x.xy, vec2(0.5), vec2(g.n.xy) - 0.5), 0.5);
#else
  return clamp(x, vec3(0.5), vec3(g.n) - 0.5);
#endif
}
// exact (manual) multilinear interpolation of cell-centred data
vec4 sampleLin(sampler2D s, Grid g, vec3 x) {
  vec3 q = x - 0.5;
  vec3 f = floor(q);
  vec3 a = q - f;
  ivec3 c = ivec3(f);
  vec4 r = vec4(0.0);
  for (int k = 0; k < NC; k++) r += cornerWeight(k, a) * fetchC(s, g, c + cornerOffset(k));
  return r;
}
// hardware-filtered multilinear interpolation (texture must be LINEAR); clamps to the grid
vec4 sampleFast(sampler2D s, Grid g, vec3 x) {
#ifdef NO_LINEAR
  return sampleLin(s, g, x);
#else
  vec2 xy = clamp(x.xy, vec2(0.5), vec2(g.n.xy) - 0.5);
#if DIM == 2
  return textureLod(s, xy * g.inv, 0.0);
#else
  float qz = clamp(x.z - 0.5, 0.0, float(g.n.z - 1));
  float fz = floor(qz);
  int k0 = int(fz);
  int k1 = min(k0 + 1, g.n.z - 1);
  vec2 o0 = vec2(ivec2(k0 % g.tx, k0 / g.tx) * g.n.xy);
  vec2 o1 = vec2(ivec2(k1 % g.tx, k1 / g.tx) * g.n.xy);
  return mix(textureLod(s, (xy + o0) * g.inv, 0.0), textureLod(s, (xy + o1) * g.inv, 0.0), qz - fz);
#endif
#endif
}
vec4 sampleCoarse(sampler2D s, Grid gc, ivec3 c) {
  vec3 x = (vec3(c) + 0.5) * 0.5;
#if DIM == 2
  x.z = 0.5;
#endif
  return sampleLin(s, gc, x);
}
vec4 sampleCoarseIn(sampler2D s, sampler2D liq, Grid gc, ivec3 c) { return sampleCoarse(s, gc, c); }
vec4 sampleCoarseKnown(sampler2D s, Grid gc, ivec3 c) { return sampleCoarse(s, gc, c); }
float capW(sampler2D frac, Grid g, ivec3 c) { return fetchC(frac, g, c).a + ${EPSV}; }
ivec2 pointTexel(Grid g, int i) {
  int aw = g.n.x * g.tx;
  return ivec2(i % aw, i / aw);
}
vec4 texelClip(Grid g, ivec2 t) { return vec4((vec2(t) + 0.5) * g.inv * 2.0 - 1.0, 0.0, 1.0); }
bool liveTexel(Grid g, ivec2 t) { return t.x < g.n.x * g.tx && t.y < int(floor(1.0 / g.inv.y + 0.5)); }
`;

  // ---- sparse ----------------------------------------------------------------------------
  // Lookup textures of a grid level (kept by BrickSet, src/world/bricks.js):
  //   uSl0  per slot: xyz = brick coordinate, w = 1 if in use
  //   uNb0  per slot: the slots of the bricks up to NR bricks away on every axis. Where there is
  //         none: the null slot (first tile of the extra row of every pool), or the one after
  //         it if the brick is known to lie inside a solid (BrickSet.mark); both tiles hold
  //         the same defaults. Every access of a pass to its own level goes through this
  //         table: one fetch, no search. Positions are therefore kept within its reach
  //         (clampFrame): the liquid moves at most NR bricks per step.
  //   uPg0, uLf0   the page table of the level (top level, leaves): brick coordinate -> slot.
  //         Used to build uNb0 and by passes that do not sit in a brick (resolve).
  //   uPgX, uLfX   the page table of the other level a pass reads (GridX: the next finer or
  //         coarser one)
  return common + `
#define SPARSE
#define LB ${LB}
#define BS ${B}
#define BM ${B - 1}
#define TW ${dim === 2 ? B : B * B}
#define CB ${dim === 2 ? B * B : B * B * B}
#define LS ${LEAF_LOG}
#define LW ${dim === 2 ? S : S * S}
#define NR ${NB_REACH}
#define NBS ${2 * NB_REACH + 1}
#define NBW ${dim === 2 ? 2 * NB_REACH + 1 : (2 * NB_REACH + 1) ** 2}
struct Grid { ivec2 tiles; vec2 inv; ivec3 top; ivec2 topTile; int leafRow; };
struct GridX { ivec2 tiles; ivec3 top; ivec2 topTile; int leafRow; };
uniform sampler2D uPg0;
uniform sampler2D uLf0;
uniform sampler2D uSl0;
uniform sampler2D uNb0;
uniform sampler2D uPgX;
uniform sampler2D uLfX;
uniform ivec3 uAnchor;     // world cell the analytic shapes are measured from
uniform int uCoarseSolids; // 1: coarse cells that are solid throughout are walls (see "coef" in sim.js)
ivec3 g_frame = ivec3(0);  // corner cell of the brick the fragment (or scatter point) lies in
ivec2 g_nb = ivec2(0);     // corner texel of that brick's block in uNb0
bool g_live = true;
ivec2 slotTexel(ivec2 tiles, int s, ivec3 l) {
#if DIM == 2
  return ivec2((s % tiles.x) * TW + l.x, (s / tiles.x) * BS + l.y);
#else
  return ivec2((s % tiles.x) * TW + l.z * BS + l.x, (s / tiles.x) * BS + l.y);
#endif
}
ivec2 topTexel(ivec3 b, ivec3 top, ivec2 topTile) {
  ivec3 tb = (b >> LS) & top;
#if DIM == 2
  return tb.xy;
#else
  return ivec2(tb.x + (tb.z % topTile.y) * topTile.x, tb.y + (tb.z / topTile.y) * (top.y + 1));
#endif
}
ivec2 leafTexel(ivec3 b, int leaf, int leafRow) {
  ivec3 e = b & ((1 << LS) - 1);
#if DIM == 2
  ivec2 off = e.xy;
#else
  ivec2 off = ivec2(e.z * (1 << LS) + e.x, e.y);
#endif
  return ivec2((leaf % leafRow) * LW, (leaf / leafRow) * (1 << LS)) + off;
}
// slot of brick b through the page table, -1 if it is not stored
int pageLookup(Grid g, ivec3 b) {
  float lf = texelFetch(uPg0, topTexel(b, g.top, g.topTile), 0).r;
  if (lf < 0.0) return -1;
  return int(texelFetch(uLf0, leafTexel(b, int(lf), g.leafRow), 0).r);
}
// the other level: the children of a coarse cell share a brick, so the last answer is kept
ivec3 g_xb = ivec3(0);
int g_xs = -2;
int pageLookup(GridX g, ivec3 b) {
  if (g_xs != -2 && b == g_xb) return g_xs;
  float lf = texelFetch(uPgX, topTexel(b, g.top, g.topTile), 0).r;
  int s = -1;
  if (lf >= 0.0) s = int(texelFetch(uLfX, leafTexel(b, int(lf), g.leafRow), 0).r);
  g_xb = b;
  g_xs = s;
  return s;
}
// make the brick of slot s the current frame; returns its brick coordinate
ivec3 enterSlot(Grid g, int s) {
  ivec2 st = ivec2(s % g.tiles.x, s / g.tiles.x);
  vec4 sl = texelFetch(uSl0, st, 0);
  ivec3 b = ivec3(sl.xyz);
  g_live = sl.w > 0.5;
  g_frame = b * BS;
  g_nb = st * ivec2(NBW, NBS);
  return b;
}
// slot of the brick that holds cell c (the null slot if it is not stored)
int slotOf(Grid g, ivec3 c) {
  ivec3 o = clamp((c - g_frame) >> LB, ivec3(-NR), ivec3(NR)) + NR;
#if DIM == 2
  return int(texelFetch(uNb0, g_nb + o.xy, 0).r);
#else
  return int(texelFetch(uNb0, g_nb + ivec2(o.x + NBS * o.z, o.y), 0).r);
#endif
}
bool hasCell(Grid g, ivec3 c) { return slotOf(g, c) < g.tiles.x * g.tiles.y; }
// c is not stored and nothing is known about it (hasCell is false for bricks marked solid too)
bool unknownCell(Grid g, ivec3 c) { return slotOf(g, c) == g.tiles.x * g.tiles.y; }
ivec2 texelOf(Grid g, ivec3 c) { return slotTexel(g.tiles, slotOf(g, c), c & BM); }
ivec2 texelOf(GridX g, ivec3 c) {
  int s = pageLookup(g, c >> LB);
  if (s < 0) s = g.tiles.x * g.tiles.y;
  return slotTexel(g.tiles, s, c & BM);
}
// texel of cell c for a pass that does not sit in a brick
ivec2 pageTexel(Grid g, ivec3 c) {
  int s = pageLookup(g, c >> LB);
  if (s < 0) s = g.tiles.x * g.tiles.y;
  return slotTexel(g.tiles, s, c & BM);
}
ivec3 cellOf(Grid g, ivec2 t) {
  ivec2 tile = ivec2(t.x / TW, t.y / BS);
  int lx = t.x - tile.x * TW;
  enterSlot(g, tile.x + tile.y * g.tiles.x);
  return g_frame + ivec3(lx & BM, t.y & BM, lx >> LB);
}
ivec3 clampCell(Grid g, ivec3 c) { return c; }
ivec3 clampCell(GridX g, ivec3 c) { return c; }
vec4 fetchC(sampler2D s, Grid g, ivec3 c) { return texelFetch(s, texelOf(g, c), 0); }
vec4 fetchC(sampler2D s, GridX g, ivec3 c) { return texelFetch(s, texelOf(g, c), 0); }
bool present(sampler2D liq, Grid g, ivec3 c) { return texelFetch(liq, texelOf(g, c), 0).g >= 0.0; }
bool present(sampler2D liq, GridX g, ivec3 c) { return texelFetch(liq, texelOf(g, c), 0).g >= 0.0; }
ivec3 cellAt(vec3 f) { return g_frame + ivec3(f); }
vec3 cellPos(ivec3 c, vec3 off) {
#if DIM == 2
  return vec3(vec2((c - g_frame).xy) + off.xy, 0.5);
#else
  return vec3(c - g_frame) + off;
#endif
}
vec3 shapePos(vec3 x) { return x + vec3(g_frame - uAnchor); }
// there is no box to stay in, but the interpolation stencil has to stay inside the bricks
// that uNb0 knows about
vec3 clampFrame(Grid g, vec3 x) {
  const float lo = float(-NR * BS) + 1.5;
  const float hi = float((NR + 1) * BS) - 1.5;
#if DIM == 2
  return vec3(clamp(x.xy, vec2(lo), vec2(hi)), 0.5);
#else
  return clamp(x, vec3(lo), vec3(hi));
#endif
}
vec4 sampleLin(sampler2D s, Grid g, vec3 x) {
  vec3 q = x - 0.5;
  vec3 f = floor(q);
  vec3 a = q - f;
  ivec3 c = cellAt(f);
  vec4 r = vec4(0.0);
  for (int k = 0; k < NC; k++) r += cornerWeight(k, a) * fetchC(s, g, c + cornerOffset(k));
  return r;
}
vec4 sampleFast(sampler2D s, Grid g, vec3 x) { return sampleLin(s, g, x); }
// The centre of fine cell c lies a quarter of a coarse cell from the centre of its parent. Coarse
// cells that are not present (not stored, or standing for no real cell) are left out and the
// weights renormalised: at the edge of a box that is the edge replication of the dense backend.
vec4 sampleCoarseIn(sampler2D s, sampler2D liq, GridX gc, ivec3 c) {
  ivec3 b = (c - 1) >> 1;
  vec3 a = mix(vec3(0.75), vec3(0.25), vec3(c & 1));
#if DIM == 2
  b.z = 0;
#endif
  vec4 r = vec4(0.0);
  float ws = 0.0;
  for (int k = 0; k < NC; k++) {
    ivec2 t = texelOf(gc, b + cornerOffset(k));
    vec2 l = texelFetch(liq, t, 0).rg;
    // (a coarse cell that is solid throughout has no pressure of its own either: see "coef")
    if (l.g < 0.0 || (uCoarseSolids == 1 && l.g <= 1.0e-4 && l.r >= 0.0)) continue;
    float w = cornerWeight(k, a);
    r += w * texelFetch(s, t, 0);
    ws += w;
  }
  return ws > 0.0 ? r / ws : r;
}
vec4 sampleCoarseKnown(sampler2D s, GridX gc, ivec3 c) {
  ivec3 b = (c - 1) >> 1;
  vec3 a = mix(vec3(0.75), vec3(0.25), vec3(c & 1));
#if DIM == 2
  b.z = 0;
#endif
  vec4 r = vec4(0.0);
  float ws = 0.0;
  for (int k = 0; k < NC; k++) {
    vec4 v = fetchC(s, gc, b + cornerOffset(k));
    if (v.w <= 0.0) continue;
    float w = cornerWeight(k, a);
    r += w * v;
    ws += w;
  }
  return ws > 0.0 ? r / ws : r;
}
float capW(sampler2D frac, Grid g, ivec3 c) {
  int s = slotOf(g, c);
  return s < g.tiles.x * g.tiles.y ? texelFetch(frac, slotTexel(g.tiles, s, c & BM), 0).a + ${EPSV} : 0.0;
}
ivec2 pointTexel(Grid g, int i) {
  int li = i % CB;
  enterSlot(g, i / CB);
  return slotTexel(g.tiles, i / CB, ivec3(li & BM, (li >> LB) & BM, li >> (2 * LB)));
}
vec4 texelClip(Grid g, ivec2 t) { return vec4((vec2(t) + 0.5) * g.inv * 2.0 - 1.0, 0.0, 1.0); }
bool liveTexel(Grid g, ivec2 t) {
  ivec2 st = ivec2(t.x / TW, t.y / BS);
  if (st.y >= g.tiles.y) return false;
  return texelFetch(uSl0, st, 0).w > 0.5;
}
`;
}

// Velocity sampling + characteristic tracing. Requires: uniform Grid G; sampler2D uVel, uSdf.
export const TRACE = `
uniform sampler2D uVel;
uniform sampler2D uSdf;
uniform int uTraceSteps;
vec3 clampDomain(vec3 x) { return clampFrame(G, x); }
vec3 velAt(vec3 x) {
  vec3 v;
  v.x = sampleFast(uVel, G, x + vec3(0.5, 0.0, 0.0)).x;
  v.y = sampleFast(uVel, G, x + vec3(0.0, 0.5, 0.0)).y;
#if DIM == 3
  v.z = sampleFast(uVel, G, x + vec3(0.0, 0.0, 0.5)).z;
#else
  v.z = 0.0;
#endif
  return v;
}
// cell-centred solid signed distance: rgb = gradient, a = distance (negative inside solid)
vec4 sdfAt(vec3 x) { return sampleFast(uSdf, G, x); }
vec3 pushOut(vec3 x) {
  vec4 s = sdfAt(x);
  if (s.w < 0.0) {
    float l = length(s.xyz);
    if (l > 1.0e-6) x = clampDomain(x + s.xyz / l * (-s.w));
  }
  return x;
}
// midpoint (RK2) characteristic trace over time dt (negative dt = backwards), optionally sub-stepped
vec3 trace(vec3 x, float dt) {
  float h = dt / float(uTraceSteps);
  for (int i = 0; i < 4; i++) {
    if (i >= uTraceSteps) break;
    vec3 k1 = velAt(x);
    vec3 k2 = velAt(clampDomain(x + 0.5 * h * k1));
    x = clampDomain(x + h * k2);
  }
  return pushOut(x);
}
`;

// Terrain: ground given by its height over x and z (2D: over x), as a texture of samples that
// the shader interpolates linearly. Mirrored in JS by src/world/terrain.js.
// The distance is the vertical clearance scaled by the slope: exact for a plane, and right to a
// fraction of a cell where the slope changes over several samples.
export const TERRAIN = `
uniform sampler2D uTer;    // per sample: height, d height / dx, d height / dz   (cells)
uniform vec4 uTerMap;      // x and z of sample (0, 0), cells per sample, 1 if there is a terrain
// height and its gradient at the horizontal position of x
vec3 terrainAt(vec3 x) {
  ivec2 sz = textureSize(uTer, 0);
#if DIM == 2
  float u = clamp((x.x - uTerMap.x) / uTerMap.z, 0.0, float(sz.x - 1));
  int i = min(int(u), sz.x - 2);
  return mix(texelFetch(uTer, ivec2(i, 0), 0).xyz, texelFetch(uTer, ivec2(i + 1, 0), 0).xyz, u - float(i));
#else
  vec2 u = clamp((x.xz - uTerMap.xy) / uTerMap.z, vec2(0.0), vec2(sz - 1));
  ivec2 i = min(ivec2(u), sz - 2);
  vec2 f = u - vec2(i);
  return mix(mix(texelFetch(uTer, i, 0).xyz, texelFetch(uTer, i + ivec2(1, 0), 0).xyz, f.x),
             mix(texelFetch(uTer, i + ivec2(0, 1), 0).xyz, texelFetch(uTer, i + ivec2(1, 1), 0).xyz, f.x), f.y);
#endif
}
float sdTerrain(vec3 x) {
  if (uTerMap.w < 0.5) return BIG;
  vec3 h = terrainAt(x);
  return (x.y - h.x) / sqrt(1.0 + dot(h.yz, h.yz));
}
`;

// Signed-distance primitives shared by solids and liquid sources.
//   A = (centre.xyz, type)   type: 1 ball, 2 box; negative = inverted (container)
//   B = (half.xyz | radius, corner rounding)
//   R = world->local rotation, V = linear velocity, W = angular velocity
export function prims(P) {
  return `
uniform int u${P}N;
uniform vec4 u${P}A[${MAX_PRIMS}];
uniform vec4 u${P}B[${MAX_PRIMS}];
uniform mat3 u${P}R[${MAX_PRIMS}];
uniform vec3 u${P}V[${MAX_PRIMS}];
uniform vec3 u${P}W[${MAX_PRIMS}];
float sd${P}Prim(int i, vec3 x) {
  vec4 A = u${P}A[i];
  vec4 B = u${P}B[i];
  vec3 p = u${P}R[i] * (x - A.xyz);
#if DIM == 2
  p.z = 0.0;
#endif
  float d;
  if (abs(A.w) < 1.5) {
    d = length(p) - B.x;
  } else {
    vec3 q = abs(p) - B.xyz + B.w;
#if DIM == 2
    q.z = -1.0e6;
#endif
    d = length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - B.w;
  }
  return A.w < 0.0 ? -d : d;
}
// x = distance to the union, y = index of the closest primitive (-1 if none)
vec2 sd${P}(vec3 x) {
  float d = BIG;
  float idx = -1.0;
  for (int i = 0; i < ${MAX_PRIMS}; i++) {
    if (i >= u${P}N) break;
    float di = sd${P}Prim(i, x);
    if (di < d) { d = di; idx = float(i); }
  }
  return vec2(d, idx);
}
vec3 vel${P}(int i, vec3 x) {
  vec3 r = x - u${P}A[i].xyz;
#if DIM == 2
  r.z = 0.0;
#endif
  return u${P}V[i] + cross(u${P}W[i], r);
}
`;
}
