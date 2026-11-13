// Simulation passes for "Mass-Conserving Eulerian Liquid Simulation" (Chentanez & Mueller, SCA 2012).
// Section/equation numbers in comments refer to that paper unless another reference is named.
import { header, TRACE as TRACE_ABS, TRACE_REL, prims, EPSV, TERRAIN, FAR, MAX_PRIMS } from './common.js';

const VMIN = '0.05';   // floor on V when normalising row sums of nearly solid cells

/** Pass sources for the `dense` or `sparse` grid backend (see header() in common.js). */
/**
 * @param opts  { pushRel, sliverSide }: see PARAMS in sim.js. Off, the sources are those of the reference solver, to the letter.
 */
export function simShaders(dim, floatLinear, backend = 'dense', opts = {}) {
  const H = header(dim, floatLinear, backend);
  const sparse = backend === 'sparse';             // ... which also knows bodies with a distance field of their own
  const FARS = backend === 'sparse' ? FAR : '';      // the state of water at rest, for the passes that meet held bricks
  const TRACE = opts.pushRel ? TRACE_REL : TRACE_ABS;
  const S = {};

  // ---------------------------------------------------------------- solids
  // Everything the solver needs to know about solids, evaluated from the analytic primitives:
  //   sdf  = (gradient, distance) at the cell centre (negative inside solid)
  //   us   = solid velocity on the cell's low faces
  //   frac = (A_x, A_y, A_z, V): non-solid AREA fraction of the low faces (Sec. 3.6) and non-solid
  //          volume fraction of the cell
  //   W    = (W_x, W_y, W_z): non-solid VOLUME fraction of the staggered cell around each low
  //          face, the weights of the variational pressure solve [BBB07, CM11a]
  // Volume fractions use clamp(0.5 + d): exact for axis-aligned walls and never positive for an
  // element lying half a cell or more inside the solid (a wider ramp leaks through wall corners).
  // Area fractions use the planar-cut estimate clamp(0.5 + d / |tangential variation of d|).
  // The sparse backend adds a terrain to the primitives (index -1: it does not move).
  const terrain = backend !== 'sparse' ? '' : `${TERRAIN}
vec2 sdSolids(vec3 x) {
  vec2 s = sdS(x);
  float t = sdTerrain(x);
  return t < s.x ? vec2(t, -1.0) : s;
}
#define sdS sdSolids
`;
  S.solid = `${H}
uniform Grid G;
${prims('S', sparse)}${terrain}${backend === 'sparse' ? FAR : ''}
layout(location = 0) out vec4 oSdf;
layout(location = 1) out vec4 oUs;
layout(location = 2) out vec4 oFrac;
layout(location = 3) out vec4 oW;
uniform float uVthr;
ivec3 gc;
vec3 X(float x, float y, float z) { return shapePos(cellPos(gc, vec3(x, y, z))); }
float D(float x, float y, float z) { return sdS(X(x, y, z)).x; }
float ramp(float d, float l1) { return clamp(0.5 + d / max(l1, 1.0e-6), 0.0, 1.0); }
float vol(float d) { float w = clamp(0.5 + d, 0.0, 1.0); return w < 0.01 ? 0.0 : w; }
// A cell with V < uVthr has no density of its own to speak of: it is liquid or air according to
// its neighbours (pass "liq"). A sliver of such cells between two solids (under a body lying
// on the floor) has no neighbour to ask and would count as air, i.e. as a p = 0 pocket at the
// bottom of the pool that the liquid next to it rushes into. Faces between two such cells are
// therefore closed; a sliver cell only ever exchanges with a neighbour that has real volume.
bool sliver(float x, float y, float z) { return clamp(0.5 + D(x, y, z), 0.0, 1.0) < uVthr; }
void main() {
  gc = cellOf(G, ivec2(gl_FragCoord.xy));
  // A wall lying exactly on a face must count as closed, hence the small bias on the area fraction.
  const float bias = 1.0e-3;
  float dc = D(0.5, 0.5, 0.5);
  vec3 xf;
  vec3 us = vec3(0.0);
  // (who: the primitive each face takes its velocity from, counted from 1; 0 = none. For "usBody".)
  ivec3 who = ivec3(0);
  xf = X(0.0, 0.5, 0.5); vec2 sx = sdS(xf); if (sx.y >= 0.0) { us.x = velS(int(sx.y), xf).x; who.x = int(sx.y) + 1; }
  xf = X(0.5, 0.0, 0.5); vec2 sy = sdS(xf); if (sy.y >= 0.0) { us.y = velS(int(sy.y), xf).y; who.y = int(sy.y) + 1; }
  vec3 g = vec3(D(1.0, 0.5, 0.5) - sx.x, D(0.5, 1.0, 0.5) - sy.x, 0.0);
  vec3 A = vec3(0.0);
  vec3 W = vec3(vol(sx.x), vol(sy.x), 0.0);
#if DIM == 2
  float n00 = D(0.0, 0.0, 0.5), n01 = D(0.0, 1.0, 0.5), n10 = D(1.0, 0.0, 0.5);
  A.x = ramp(sx.x - bias, abs(n01 - n00));
  A.y = ramp(sy.x - bias, abs(n10 - n00));
#else
  xf = X(0.5, 0.5, 0.0); vec2 sz = sdS(xf); if (sz.y >= 0.0) { us.z = velS(int(sz.y), xf).z; who.z = int(sz.y) + 1; }
  g.z = D(0.5, 0.5, 1.0) - sz.x;
  W.z = vol(sz.x);
  // edge mid-points: e_ab = edge through corner (a, b) of the two named axes
  float xy00 = D(0.0, 0.0, 0.5), xy01 = D(0.0, 1.0, 0.5), xy10 = D(1.0, 0.0, 0.5);
  float xz00 = D(0.0, 0.5, 0.0), xz01 = D(0.0, 0.5, 1.0), xz10 = D(1.0, 0.5, 0.0);
  float yz00 = D(0.5, 0.0, 0.0), yz01 = D(0.5, 0.0, 1.0), yz10 = D(0.5, 1.0, 0.0);
  A.x = ramp(sx.x - bias, abs(xy01 - xy00) + abs(xz01 - xz00));
  A.y = ramp(sy.x - bias, abs(xy10 - xy00) + abs(yz01 - yz00));
  A.z = ramp(sz.x - bias, abs(xz10 - xz00) + abs(yz10 - yz00));
#endif
  if (clamp(0.5 + dc, 0.0, 1.0) < uVthr) {
    if (sliver(-0.5, 0.5, 0.5)) W.x = 0.0;
    if (sliver(0.5, -0.5, 0.5)) W.y = 0.0;
#if DIM == 3
    if (sliver(0.5, 0.5, -0.5)) W.z = 0.0;
#endif
  }
#ifdef SPARSE
  // a face towards a cell that is not stored is closed (the far side of the cell would hold its
  // other half): liquid cannot leave the stored set, and the pressure solve knows it.
  // Such a face stands still, as does the floor and the lid below: us is the velocity of the
  // nearest obstacle however far away it is, and belongs to a face only if that obstacle is
  // what closes it. (Left in, every face at the edge of the stored cells moved with the nearest
  // body: a crate falling through the air pushed the water under it before it arrived.)
  for (int d = 0; d < DIM; d++) if (!hasCell(G, gc - AX[d])) { if (W[d] > 0.0) { us[d] = 0.0; who[d] = 0; } W[d] = 0.0; A[d] = 0.0; }
  // Water at rest (a held brick, see SparseSim) under solved cells is a floor to them, and a lid
  // above them: held and solved cells exchange liquid sideways only. Through an open floor the
  // whole solved column would move up and down as one (nothing but its own inertia resists),
  // which is not what deep water does. Where the held cell is not full (the surface, air) the
  // face stays open: spray falls into water at rest.
  if (FAR_ON && (gc.y & BM) == 0) {
    int sb = slotOf(G, gc - AX[1]);
    if (sb < G.tiles.x * G.tiles.y) {
      bool heldBelow = texelFetch(uSl0, ivec2(sb % G.tiles.x, sb / G.tiles.x), 0).w > 1.5;
      if (heldBelow != g_held && farState(g_held ? gc : gc - AX[1]).x >= 1.0) { if (W[1] > 0.0) { us[1] = 0.0; who[1] = 0; } W[1] = 0.0; A[1] = 0.0; }
    }
  }
#endif
  oSdf = vec4(g, dc);
  oUs = vec4(us, float(who.x + 16 * who.y + 256 * who.z));
  oFrac = vec4(A, clamp(0.5 + dc, 0.0, 1.0));
  oW = vec4(W, 0.0);
#ifdef SPARSE
  oW.a = g_held ? 1.0 : 0.0;    // held cells: see "coef"
#endif
}`;

  // The solid velocities with the rigid bodies moving otherwise than the solid pass was told
  // (src/couple.js): to the velocity of every face that belongs to a primitive, the change of
  // that primitive's velocity is added (uBase 1), or the faces carry that change alone (uBase 0:
  // one body moving at unit speed in an otherwise resting world).
  S.usBody = `${H}
uniform Grid G;
uniform sampler2D uUs;
uniform float uBase;
uniform vec3 uDV[${MAX_PRIMS}];      // per primitive: change of its velocity ...
uniform vec3 uDW[${MAX_PRIMS}];      // ... and of its spin
uniform vec3 uDC[${MAX_PRIMS}];      // its centre
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 us = texelFetch(uUs, t, 0);
  int code = int(us.a + 0.5);
  vec3 v = us.xyz * uBase;
  for (int d = 0; d < DIM; d++) {
    int i = (code >> (4 * d)) & 15;
    if (i == 0) continue;
    vec3 off = vec3(0.5);
    off[d] = 0.0;
    vec3 r = shapePos(cellPos(c, off)) - uDC[i - 1];
#if DIM == 2
    r.z = 0.0;
#endif
    v[d] += (uDV[i - 1] + cross(uDW[i - 1], r))[d];
  }
  o = vec4(v, us.a);
}`;

  // The right-hand side of the pressure equation for liquid at rest between solids that move
  // as uUs says: the part of "rhs" that is linear in the solid velocity, without the sources
  // and without the separating condition (the pressure may pull). Its solution is how the
  // liquid answers a body's motion, i.e. the body's added mass (src/couple.js).
  S.rhsBody = `${H}
uniform Grid G;
uniform sampler2D uUs;
uniform sampler2D uW;
uniform sampler2D uLiq;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec2 l = texelFetch(uLiq, t, 0).rg;
  vec4 Wc = texelFetch(uW, t, 0);
  float b = 0.0;
#ifdef SPARSE
  if (Wc.a > 0.5) { o = vec4(0.0, -BIG, 0.0, 0.0); return; }
#endif
  if (l.r < 0.0) {
    vec4 sc = texelFetch(uUs, t, 0);
    for (int d = 0; d < DIM; d++) {
      b -= (Wc[d] - l.g) * sc[d];
      ivec3 hi = c + AX[d];
      if (hasCell(G, hi)) {
        ivec2 th = texelOf(G, hi);
        b += (texelFetch(uW, th, 0)[d] - l.g) * texelFetch(uUs, th, 0)[d];
      }
    }
  }
  o = vec4(b, -BIG, 0.0, 0.0);
}`;

  // A pressure plus multiples of up to four others, in the cells the pressure is solved in
  // (uCA's diagonal positive); cells whose pressure is held keep uKeep.y of theirs, all other
  // cells are zero. src/couple.js: the pressure follows a change of the bodies' velocities by
  // the stored answers of the liquid to each of them.
  S.combine = `${H}
uniform sampler2D uP;
uniform sampler2D uCA;
uniform sampler2D uQ0;
uniform sampler2D uQ1;
uniform sampler2D uQ2;
uniform sampler2D uQ3;
uniform vec4 uC;
uniform vec2 uKeep;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  float w = texelFetch(uCA, t, 0).w;
  float p = texelFetch(uP, t, 0).r;
  float r = 0.0;
  if (w > 0.0) {
    r = uKeep.x * p + uC.x * texelFetch(uQ0, t, 0).r + uC.y * texelFetch(uQ1, t, 0).r
      + uC.z * texelFetch(uQ2, t, 0).r + uC.w * texelFetch(uQ3, t, 0).r;
  } else if (w < 0.0) r = uKeep.y * p;
  o = vec4(r, 0.0, 0.0, 0.0);
}`;

  // A texture as it is (params.oldCapacity: the solid fractions before the solid pass).
  S.keep = `${H}
uniform sampler2D uSrc;
out vec4 o;
void main() { o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

  // ---------------------------------------------------------------- liquid classification
  // rho' = rho / V (Eq. 20), extrapolated into (nearly) solid cells from their neighbours.
  // Output: r = phi = 0.5 - rho'  (liquid where phi < 0, Sec. 3.7), g = V.
  S.liq = `${H}
uniform Grid G;
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform float uVthr;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float rho = texelFetch(uRho, t, 0).r;
  float V = texelFetch(uFrac, t, 0).a;
  float rp = 0.0;
  if (V >= uVthr) {
    rp = rho / V;
  } else {
${opts.sliverSide ? `
    // Option "sliverSide". The fullest neighbour deciding makes the cell at the waterline of a
    // solid liquid because the cell below it is: the liquid stands a cell too high along the
    // solid with no pressure to speak of at its top, and what is below it sinks, a steady current
    // down the side of the solid. Here the cells beside it decide, those above and below only
    // where there are none beside it: the cell is what the liquid next to it is, as in a pool at rest.
    float along = 0.0;
    bool beside = false;
    for (int d = 0; d < DIM; d++) {
      for (int s = -1; s <= 1; s += 2) {
        ivec3 nb = c + s * AX[d];
        if (!hasCell(G, nb)) continue;
        ivec2 tn = texelOf(G, nb);
        float Vn = texelFetch(uFrac, tn, 0).a;
        if (Vn < uVthr) continue;
        float r = texelFetch(uRho, tn, 0).r / Vn;
        if (d == 1) along = max(along, r);
        else { rp = max(rp, r); beside = true; }
      }
    }
    if (!beside) rp = along;` : `
    for (int d = 0; d < DIM; d++) {
      for (int s = -1; s <= 1; s += 2) {
        ivec3 nb = c + s * AX[d];
        if (!hasCell(G, nb)) continue;
        ivec2 tn = texelOf(G, nb);
        float Vn = texelFetch(uFrac, tn, 0).a;
        if (Vn >= uVthr) rp = max(rp, texelFetch(uRho, tn, 0).r / Vn);
      }
    }`}
  }
  o = vec4(0.5 - rp, V, 0.0, 0.0);
}`;

  // ---------------------------------------------------------------- velocity extrapolation (Sec. 3.3)
  // Pull-push over the grid hierarchy [CM11b Sec. 3.3.1]: known face velocities (faces touching
  // a liquid cell) are averaged down the hierarchy, unknown ones are filled on the way back up.
  S.extrapInit = `${H}
uniform Grid G;
uniform sampler2D uVel;
uniform sampler2D uLiq;
uniform sampler2D uW;
layout(location = 0) out vec4 oA;   // velocity * known
layout(location = 1) out vec4 oB;   // known mask per component
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 v = texelFetch(uVel, t, 0);
  vec4 W = texelFetch(uW, t, 0);
  float pc = texelFetch(uLiq, t, 0).r;
  vec3 known = vec3(0.0);
  for (int d = 0; d < DIM; d++) {
    ivec3 a = c - AX[d];
    if (!hasCell(G, a) || W[d] <= 0.0) continue;
    if (pc < 0.0 || fetchC(uLiq, G, a).r < 0.0) known[d] = 1.0;
  }
  oA = vec4(v.xyz * known, 0.0);
  oB = vec4(known, 1.0);       // w: the cell stands for real cells (averaged down by the pull)
}`;

  S.extrapPull = `${H}
uniform Grid G;    // coarse (target)
uniform GridX GF;   // fine (source)
uniform sampler2D uA;
uniform sampler2D uB;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec3 c = cellOf(G, ivec2(gl_FragCoord.xy));
  ivec3 f = c * 2;
#if DIM == 2
  f.z = 0;
#endif
  vec4 a = vec4(0.0);
  vec4 b = vec4(0.0);
  for (int k = 0; k < NC; k++) {
    ivec2 t = texelOf(GF, clampCell(GF, f + cornerOffset(k)));
    a += texelFetch(uA, t, 0);
    b += texelFetch(uB, t, 0);
  }
  oA = a / float(NC);
  oB = b / float(NC);
}`;

  S.extrapPush = `${H}
uniform Grid G;    // this level
uniform GridX GC;   // coarser level
uniform sampler2D uA;
uniform sampler2D uB;
uniform sampler2D uFc;   // filled velocities of the coarser level
uniform int uTop;        // 1 on the coarsest level (nothing coarser to pull from)
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 a = texelFetch(uA, t, 0);
  vec4 b = texelFetch(uB, t, 0);
  vec3 coarse = vec3(0.0);
  if (uTop == 0) coarse = sampleCoarseKnown(uFc, GC, c).xyz;
  vec3 r;
  for (int d = 0; d < 3; d++) r[d] = b[d] > 0.0 ? a[d] / b[d] : coarse[d];
  o = vec4(r, b.w > 0.0 ? 1.0 : 0.0);
}`;

  // ---------------------------------------------------------------- density advection (Sec. 3.4)
  // The discrete advection operator is rho_new = A rho with A_il = s_i w-_li / max(1, beta_l)
  // (backward part) + (1 - beta_j) w+_jk (forward part for sources that were not fully handed out).
  //   beta_l  = column sum of A: how much of source l is handed out. All beta = 1 <=> exact
  //             mass conservation.
  //   gamma_i = row sum of A ("An indicator ... are the gamma_i = sum_j A_ij"): what a completely
  //             full field would deliver to cell i, relative to what the cell can hold. All
  //             gamma = 1 <=> incompressible.
  // Solids generalise both: capacities are the non-solid volume fractions V, i.e. the scheme
  // transports rho' = rho / V and gamma_i = (sum_l A_il V_l) / V_i.
  // A solid that moves changes the capacities before the densities follow (the solid pass comes
  // first). As printed, V_l of a source is the new one; with params.oldCapacity it is the one
  // the source's density was full or not full of (uFracOld), and a cell next to a moving wall
  // that was full is asked for, and delivers, a full cell's worth.
  //
  // Step 1: backward characteristic x- of every cell and its row scale s_i.
  //   uMode 1: s = gamma~   semi-Lagrangian advected previous row sum, as printed in steps 3-4.
  //            For a steady flow this pre-scaling already makes the columns sum to one, so
  //            neither the clamp nor the (more diffusive) forward pass has anything to do.
  //   uMode 2: s = 1 / gamma~   (the "clamp gamma" reading of [LAF11])
  //   uMode 3: s = 1            (no feedback from the previous step, i.e. reordered [LGF11])
  S.advTrace = `${H}
uniform Grid G;
${TRACE}
uniform sampler2D uRho;   // r = rho, g = gamma
uniform sampler2D uFrac;
uniform sampler2D uFracOld;   // the capacities the densities belong to (params.oldCapacity; else uFrac again)
uniform float uDt;
uniform int uMode;
out vec4 o;               // xyz = x-, w = row scale s_i
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec3 xb = trace(cellPos(c, vec3(0.5)), -uDt);
  float V = texelFetch(uFrac, t, 0).a;
  float s = 0.0;
  if (V > 0.0) {             // fully solid cells request nothing
    vec3 q = xb - 0.5;
    vec3 f = floor(q);
    vec3 a = q - f;
    float gt = 0.0;
    float Vsrc = 0.0;
    for (int k = 0; k < NC; k++) {
      ivec2 ts = texelOf(G, clampCell(G, cellAt(f) + cornerOffset(k)));
      float w = cornerWeight(k, a);
      gt += w * texelFetch(uRho, ts, 0).g;
      Vsrc += w * texelFetch(uFracOld, ts, 0).a;
    }
    s = V / max(Vsrc, 1.0e-2);
    if (uMode == 1) s *= gt;
    else if (uMode == 2) s /= max(gt, 1.0e-3);
  }
  o = vec4(xb, s);
}`;

  // Shared vertex shader for all scatter passes. One point per (source cell, stencil corner);
  // the fragment stage just adds vVal into the destination texel.
  const scatterVS = (decl, body) => `${H}
uniform Grid G;
uniform sampler2D uSrc;    // xyz = deposit position, w = amount (meaning depends on the pass)
uniform int uBase;         // index of the first point of this draw call (see GLContext.scatter)
${decl}
out vec4 vVal;
void main() {
  int id = gl_VertexID + uBase;
  int corner = id % NC;
  ivec2 st = pointTexel(G, id / NC);
  vec4 src = texelFetch(uSrc, st, 0);
  vec3 q = src.xyz - 0.5;
  vec3 f = floor(q);
  float w = cornerWeight(corner, q - f);
  ivec3 tc = cellAt(f) + cornerOffset(corner);
  ivec2 tt = texelOf(G, clampCell(G, tc));
  vec4 val = vec4(0.0);
  ${body}
#ifdef SPARSE
  // nothing is deposited into a cell that is not stored; the passes that compute the amounts
  // leave such corners out of their normalisation, so no mass is lost here
  if (!g_live || !hasCell(G, tc)) val = vec4(0.0);
#endif
  vVal = val * w;
  gl_PointSize = 1.0;
  gl_Position = (w > 0.0 && val != vec4(0.0)) ? texelClip(G, tt) : vec4(2.0, 2.0, 2.0, 1.0);
}`;

  S.scatterFS = `${H}
in vec4 vVal;
out vec4 o;
void main() { o = vVal; }`;

  // Step 3: beta_l += w-_li s_i
  // (uHeldKeep: a held cell that asks another held cell, or itself, counts for nothing: see "advGather")
  S.scatterBetaVS = scatterVS('', `val = vec4(src.w);
#ifdef SPARSE
  if (uHeldKeep == 1 && g_held && heldCell(G, tc)) val = vec4(0.0);
#endif`);

  // Steps 4-5 (gather) and the forward characteristics needed by steps 6-7.
  //
  // Sparse backend with uHeldKeep (held cells that are copies of a height field, see
  // src/shaders/hfcouple.js): the water in held cells is the height field's to move, and what the
  // step changes in them is handed over to it. So nothing moves between two held cells, and the
  // liquid that crosses a face between a held and a solved cell has to be what a uniform flow
  // would carry through it. The scheme as it stands does neither: next to cells that stand still
  // a held cell is asked for more than it has (its own share and the solved cell's), every
  // request is scaled down, and the face lets through a quarter less than the velocity says, a
  // river dips behind it and piles up before the next one. Here instead
  //   - a held cell takes from solved cells what the scheme gives it, nothing from held ones,
  //     and keeps of its own liquid what the solved cells have not asked for (1 - beta, with
  //     beta counting their requests only: pass "scatterBeta")
  //   - so a solved cell gets from a held one all it asks for, unless together they ask for
  //     more than the cell holds
  //   - nothing is carried forward out of a held cell.
  // Every cell still hands out exactly what it has.
  S.advGather = `${H}
uniform Grid G;
${TRACE}
uniform sampler2D uRho;
uniform sampler2D uTraceTex;
uniform sampler2D uBeta;
uniform sampler2D uFrac;
uniform sampler2D uFracOld;
uniform float uDt;
layout(location = 0) out vec4 oRho;   // (rho, gamma) before the forward scatter
layout(location = 1) out vec4 oFwd;   // xyz = x+, w = (1 - beta_j) / capacity normalisation
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 tr = texelFetch(uTraceTex, t, 0);
  float V = texelFetch(uFrac, t, 0).a;
  vec2 acc = vec2(0.0);
#ifdef SPARSE
  bool keep = uHeldKeep == 1 && g_held;
#else
  const bool keep = false;
#endif
  if (tr.w > 0.0) {
    vec3 q = tr.xyz - 0.5;
    vec3 f = floor(q);
    vec3 a = q - f;
    for (int k = 0; k < NC; k++) {
#ifdef SPARSE
      if (keep && heldCell(G, cellAt(f) + cornerOffset(k))) continue;
#endif
      ivec2 ts = texelOf(G, clampCell(G, cellAt(f) + cornerOffset(k)));
      acc += cornerWeight(k, a) * vec2(texelFetch(uRho, ts, 0).r, texelFetch(uFracOld, ts, 0).a) / max(1.0, texelFetch(uBeta, ts, 0).r);
    }
    acc *= tr.w;
    acc.y /= max(V, ${VMIN});
  }
  // Steps 6-7: whatever this cell was not asked for (beta_j < 1) is carried forward.
  float rem = max(0.0, 1.0 - texelFetch(uBeta, t, 0).r);
  if (keep) {
    acc.x += rem * texelFetch(uRho, t, 0).r;
    acc.y = 1.0;
    rem = 0.0;
  }
  oRho = vec4(acc, 0.0, 0.0);
  vec3 x = cellPos(c, vec3(0.5));
  vec3 xf = x;
  float amt = 0.0;
  if (rem > 0.0 && (V > 0.0 || texelFetch(uRho, t, 0).r > 0.0)) {
    xf = trace(x, uDt);
    vec3 q = xf - 0.5;
    vec3 f = floor(q);
    vec3 a = q - f;
    float norm = 0.0;
    for (int k = 0; k < NC; k++) norm += cornerWeight(k, a) * capW(uFrac, G, cellAt(f) + cornerOffset(k));
#ifdef SPARSE
    if (norm <= 0.0) { xf = x; norm = capW(uFrac, G, c); }   // nowhere to go: it stays in its cell
#endif
    amt = rem / norm;
  }
  oFwd = vec4(xf, amt);
}`;

  // Steps 6-7: rho_k += rho_j (1 - beta_j) w+_jk, and the same entries added to the row sums.
  S.scatterFwdVS = scatterVS(
    `uniform sampler2D uRho; uniform sampler2D uFrac; uniform sampler2D uFracOld;`,
    `if (src.w > 0.0) {
    float Vt = texelFetch(uFrac, tt, 0).a;
    val = vec4(texelFetch(uRho, st, 0).r, texelFetch(uFracOld, st, 0).a / max(Vt, ${VMIN}), 0.0, 0.0) * (src.w * (Vt + ${EPSV}));
  }`,
  );

  // Non-conservative reference: plain semi-Lagrangian advection of rho (for comparison only).
  S.advPlain = `${H}
uniform Grid G;
${TRACE}
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform float uDt;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float V = texelFetch(uFrac, t, 0).a;
  vec3 xb = trace(cellPos(c, vec3(0.5)), -uDt);
  o = vec4(V > 0.0 ? sampleLin(uRho, G, xb).r : 0.0, 1.0, 0.0, 0.0);
}`;

  // Step 8: diffusion of the row sums [LAF11 Sec. 2.1]. For two neighbouring cells the one with
  // the larger gamma hands rho (gamma_j - gamma_i) / (2 gamma_j) to the other and both take the
  // mean gamma. The reference sweeps the cells sequentially; here each sweep along an axis is
  // split into the two disjoint pairings (2k, 2k+1) and (2k+1, 2k+2) (uPair = 0 / 1), so every
  // cell has exactly one partner per pass and the pair exchange is exactly the sequential one.
  // uPair = -1 exchanges with both neighbours at once (Jacobi); that needs uKappa <= 0.25,
  // because with 0.5 the grid-frequency mode just changes sign every sweep and is never damped.
  // Only pairs of liquid cells (rho' > 0.5) exchange: outside the liquid the velocity is an
  // extrapolation that is not divergence free, so row sums there say nothing about compression
  // and exchanging with them would just smear the free surface.
  // uLimit = 1: the exchange may level the fill rho' of the two cells but not move liquid from
  // the emptier to the fuller one (see README, "Where the paper leaves a choice open").
  S.diffuse = `${H}
uniform Grid G;
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform int uAxis;
uniform int uPair;
uniform int uLimit;
uniform float uKappa;
out vec4 o;
// change of (rho, gamma) of cell "me" from the exchange with "nb"
vec2 exchange(vec2 me, float Vme, vec2 nb, float Vnb) {
  float dg = (nb.g - me.g) * uKappa;            // > 0: the neighbour is the donor
  bool take = dg > 0.0;
  vec2 src = take ? nb : me;
  float amount = src.r * abs(dg) / max(src.g, 1.0e-6);
  if (uLimit == 1 && amount > 0.0) {
    float fs = take ? nb.r / Vnb : me.r / Vme;
    float fd = take ? me.r / Vme : nb.r / Vnb;
    float cap = max(0.0, fs - fd) * Vme * Vnb / (Vme + Vnb) * (uPair < 0 ? 0.5 : 1.0);
    if (amount > cap) { dg *= cap / amount; amount = cap; }
  }
  return vec2(take ? amount : -amount, dg);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 fr = texelFetch(uFrac, t, 0);
  vec2 me = texelFetch(uRho, t, 0).rg;
  vec2 r = me;
  if (fr.a > 0.0 && me.r > 0.5 * fr.a) {
    bool useLo = true, useHi = true;
    if (uPair >= 0) { useHi = ((c[uAxis] + uPair) & 1) == 0; useLo = !useHi; }
    ivec3 lo = c - AX[uAxis];
    ivec3 hi = c + AX[uAxis];
#ifdef SPARSE
    // (uHeldKeep: a held cell is short of what it has handed over, or holds more than it can, and
    // that is the exchange with the height field: not something to level out with a neighbour)
    if (uHeldKeep == 1) {
      if (g_held) useLo = useHi = false;
      if (useLo && heldCell(G, lo)) useLo = false;
      if (useHi && heldCell(G, hi)) useHi = false;
    }
#endif
    if (useLo && hasCell(G, lo) && fr[uAxis] > 0.0) {
      ivec2 tl = texelOf(G, lo);
      float Vl = texelFetch(uFrac, tl, 0).a;
      vec2 nb = texelFetch(uRho, tl, 0).rg;
      if (Vl > 0.0 && nb.r > 0.5 * Vl) r += exchange(me, fr.a, nb, Vl);
    }
    if (useHi && hasCell(G, hi)) {
      ivec2 th = texelOf(G, hi);
      vec4 fh = texelFetch(uFrac, th, 0);
      vec2 nb = texelFetch(uRho, th, 0).rg;
      if (fh[uAxis] > 0.0 && fh.a > 0.0 && nb.r > 0.5 * fh.a) r += exchange(me, fr.a, nb, fh.a);
    }
  }
  o = vec4(r, 0.0, 0.0);
}`;

  // ---------------------------------------------------------------- sharpening (Sec. 3.5) + solid excess (Sec. 3.6)
  // For every cell decide how much density to remove and where to re-deposit it:
  //   * air-side cells (rho' < 0.5): Eq. 14-15 with the local mass conservation of Eq. 17 and
  //     Algorithm 2 (TraceAlongField up the density gradient, at most D cells)
  //   * cells holding more than their non-solid volume: excess d = rho - V is moved S cells
  //     out of the solid along the solid distance gradient
  S.sharpen = `${H}
uniform Grid G;
${TRACE}
uniform sampler2D uRho;
uniform sampler2D uLiq;
uniform sampler2D uFrac;
uniform float uCs;       // Delta T / Delta x
uniform float uTau;
uniform float uD;
uniform float uS;
uniform float uEps;
uniform int uSharpen;
layout(location = 0) out vec4 oRho;   // (rho - removed, gamma)
layout(location = 1) out vec4 oSc;    // xyz = deposit position, w = removed / capacity normalisation
// rho' of a neighbour; a cell that does not exist shows no difference to this one (the dense
// backend gets that from fetchC, which repeats the cell at the edge of the box)
#ifdef SPARSE
float rhoP(ivec3 c, float self) { return hasCell(G, c) ? 0.5 - fetchC(uLiq, G, c).r : self; }
#else
float rhoP(ivec3 c, float self) { return 0.5 - fetchC(uLiq, G, c).r; }
#endif
vec3 gradRhoP(vec3 p) {
  vec3 g = vec3(0.0);
  g.x = sampleFast(uLiq, G, p - vec3(0.5, 0.0, 0.0)).r - sampleFast(uLiq, G, p + vec3(0.5, 0.0, 0.0)).r;
  g.y = sampleFast(uLiq, G, p - vec3(0.0, 0.5, 0.0)).r - sampleFast(uLiq, G, p + vec3(0.0, 0.5, 0.0)).r;
#if DIM == 3
  g.z = sampleFast(uLiq, G, p - vec3(0.0, 0.0, 0.5)).r - sampleFast(uLiq, G, p + vec3(0.0, 0.0, 0.5)).r;
#endif
  return g;
}
vec3 traceAlongField(vec3 p, float dist) {
  const float h = 0.5;
  for (int k = 0; k < 8; k++) {
    if (dist <= 0.0) break;
    vec3 g = gradRhoP(p);
    float l = length(g);
    if (l < 1.0e-5) break;
    float st = min(h, dist);
    vec3 pn = clampDomain(p + g / l * st);
    if (sdfAt(pn).w < 0.0) break;                       // would cross a solid boundary
    p = pn;
    dist -= st;
    if (sampleFast(uLiq, G, p).r <= 0.0) break;         // reached the 0.5 iso-contour
  }
  return p;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec2 rg = texelFetch(uRho, t, 0).rg;
  vec4 fr = texelFetch(uFrac, t, 0);
  float rho = rg.r;
  float V = fr.a;
  float rp = 0.5 - texelFetch(uLiq, t, 0).r;
  vec3 x = cellPos(c, vec3(0.5));
  vec3 p = x;
  float amount = 0.0;
  if (V < 1.0 && rho > V + 1.0e-6) {
    amount = rho - V;
    float dist = uS + max(0.0, -sdfAt(x).w);
    for (int k = 0; k < 4; k++) {
      vec3 g = sdfAt(p).xyz;
      float l = length(g);
      if (l < 1.0e-6) break;
      p = clampDomain(p + g / l * (0.25 * dist));
    }
  } else if (uSharpen > 0 && rho > 0.0 && rp < 0.5) {
    float gm = 0.0;
    float maxDiff = 0.0;
    for (int d = 0; d < DIM; d++) {
      ivec3 lo = c - AX[d];
      ivec3 hi = c + AX[d];
      float aLo = fr[d];
      float aHi = hasCell(G, hi) ? fetchC(uFrac, G, hi)[d] : 0.0;
      float dPlus = -(rho * aHi - fetchC(uRho, G, lo).r * aLo);    // Eq. 18
      float dMinus = -(fetchC(uRho, G, hi).r * aHi - rho * aLo);   // Eq. 19
      float a = min(dPlus, 0.0);
      float b = max(dMinus, 0.0);
      gm += max(a * a, b * b);                                     // Eq. 11-13
      maxDiff = max(maxDiff, max(abs(rp - rhoP(lo, rp)), abs(rp - rhoP(hi, rp))));
    }
    float w = rp - 0.5;
    w = w * w * w * (1.0 - min(1.0, maxDiff / uTau));              // Eq. 14
    float dRho = uCs * w * sqrt(gm);                               // Eq. 15 (w < 0 here)
    if (rho + dRho < 0.0 || rho < uEps) dRho = -rho;               // Eq. 17
    amount = -dRho;
    if (amount > 0.0) p = traceAlongField(x, uD);
  }
  float sc = 0.0;
  if (amount > 0.0) {
    vec3 q = p - 0.5;
    vec3 f = floor(q);
    vec3 a = q - f;
    float norm = 0.0;
    for (int k = 0; k < NC; k++) norm += cornerWeight(k, a) * capW(uFrac, G, cellAt(f) + cornerOffset(k));
#ifdef SPARSE
    if (norm <= 0.0) { p = x; norm = capW(uFrac, G, c); }
#endif
    sc = amount / norm;
  }
  oRho = vec4(rho - amount, V > 0.0 ? rg.g : 1.0, 0.0, 0.0);
  oSc = vec4(p, sc);
}`;

  S.scatterSharpVS = scatterVS(
    `uniform sampler2D uFrac;`,
    `if (src.w > 0.0) val = vec4(src.w * (texelFetch(uFrac, tt, 0).a + ${EPSV}), 0.0, 0.0, 0.0);`,
  );

  // ---------------------------------------------------------------- velocity advection + forces
  S.velAdvect = `${H}
uniform Grid G;
${FARS}
${TRACE}
uniform float uDt;
uniform vec3 uGravity;
uniform vec4 uMouse;      // xyz = position, w = radius (0 = off)
uniform vec4 uMouseVel;   // xyz = target velocity, w = strength
uniform vec3 uMouseDir;   // non-zero: the brush is a line through uMouse (3D picking ray)
out vec4 o;
vec3 back(vec3 x) {
  float h = -uDt / float(uTraceSteps);
  for (int i = 0; i < 4; i++) {
    if (i >= uTraceSteps) break;
    vec3 k1 = velAt(x);
    x = clampDomain(x + h * velAt(clampDomain(x + 0.5 * h * k1)));
  }
  return x;
}
float brush(vec3 x) {
  if (uMouse.w <= 0.0) return 0.0;
  vec3 d = shapePos(x) - uMouse.xyz;
#if DIM == 2
  d.z = 0.0;
#endif
  d -= uMouseDir * dot(d, uMouseDir);
  return clamp(uMouseVel.w * exp(-dot(d, d) / (uMouse.w * uMouse.w)), 0.0, 1.0);
}
void main() {
  ivec3 c = cellOf(G, ivec2(gl_FragCoord.xy));
  vec3 v = vec3(0.0);
  vec3 xu = cellPos(c, vec3(0.0, 0.5, 0.5));
  v.x = sampleFast(uVel, G, back(xu) + vec3(0.5, 0.0, 0.0)).x;
  v.x = mix(v.x, uMouseVel.x, brush(xu));
  vec3 xv = cellPos(c, vec3(0.5, 0.0, 0.5));
  v.y = sampleFast(uVel, G, back(xv) + vec3(0.0, 0.5, 0.0)).y;
  v.y = mix(v.y, uMouseVel.y, brush(xv));
#if DIM == 3
  vec3 xw = cellPos(c, vec3(0.5, 0.5, 0.0));
  v.z = sampleFast(uVel, G, back(xw) + vec3(0.0, 0.0, 0.5)).z;
  v.z = mix(v.z, uMouseVel.z, brush(xw));
#endif
#ifdef SPARSE
  // (towards the velocity of the water at rest, which over a height field is not zero)
  vec3 vf = farVel(c);
  v.x = vf.x + (v.x - vf.x) * spongeKeep(xu);
  v.y *= spongeKeep(xv);
#if DIM == 3
  v.z = vf.z + (v.z - vf.z) * spongeKeep(xw);
#endif
#endif
  o = vec4(v + uGravity * uDt, 0.0);
}`;

  // ---------------------------------------------------------------- pressure projection (Sec. 3.7, [CM11a])
  // Coarse levels of the multigrid hierarchy: phi and V by 2^d-to-1 averaging, W by averaging
  // the staggered cells covered.
  //   * phi is averaged with the non-solid volume V as weight. Cells deep inside a solid carry
  //     no liquid and would otherwise count as air, which puts a spurious p = 0 condition along
  //     every wall that is not aligned with the grid.
  //   * phi = 0.5 - rho' is a distance only for rho' <= 1, so it is clamped: a cell that
  //     momentarily holds rho' = 8 must not outvote three empty siblings.
  S.downsample = `${H}
uniform Grid G;    // coarse
uniform GridX GF;   // fine
uniform sampler2D uLiqF;
uniform sampler2D uWF;
layout(location = 0) out vec4 oLiq;
layout(location = 1) out vec4 oW;
void main() {
  ivec3 c = cellOf(G, ivec2(gl_FragCoord.xy));
  ivec3 f = c * 2;
#if DIM == 2
  f.z = 0;
#endif
  float sumV = 0.0, sumPhi = 0.0, minPhi = BIG;
  bool covered = false;
  for (int k = 0; k < NC; k++) {
    vec2 l = fetchC(uLiqF, GF, f + cornerOffset(k)).rg;
#ifdef SPARSE
    if (l.g < 0.0) l.g = 0.0; else covered = true;
#endif
    float phi = max(l.r, -0.5);
    sumV += l.g;
    sumPhi += l.g * phi;
    minPhi = min(minPhi, phi);
  }
  // a coarse cell without any non-solid volume only matters through its partly open faces;
  // it is liquid if one of its children was reached by the extrapolation of rho'
  oLiq = vec4(sumV > 1.0e-4 ? sumPhi / sumV : minPhi, sumV / float(NC), 0.0, 0.0);
#ifdef SPARSE
  if (!covered) oLiq.g = -1.0;   // stored, but none of the cells it stands for exists
#endif
  vec3 W = vec3(0.0);
  for (int d = 0; d < DIM; d++) {
    float s = 0.0;
    for (int k = 0; k < NC; k++) {
      ivec3 o = cornerOffset(k);
      if (o[d] != 0) continue;
      ivec3 b = f + o;
      s += 0.25 * fetchC(uWF, GF, b - AX[d])[d] + 0.5 * fetchC(uWF, GF, b)[d] + 0.25 * fetchC(uWF, GF, b + AX[d])[d];
    }
    W[d] = s / float(NC / 2);
  }
  oW = vec4(W, 0.0);
#ifdef SPARSE
  for (int k = 0; k < NC; k++) oW.a = max(oW.a, fetchC(uWF, GF, f + cornerOffset(k)).a);
#endif
}`;

  // Matrix coefficients of  sum_f W_f (p_i - p_nb) = b_i  with the ghost-fluid treatment of
  // air neighbours (p_nb = p_i * phi_nb / phi_i, [CM11a] Eq. 6-7).
  //
  // Coarse levels (uCoarse = 1) are re-discretised from the averaged phi, which places the free
  // surface to sub-cell accuracy but erases every air pocket smaller than a coarse cell, and
  // with it the p = 0 condition on its boundary. The coarse operator is then softer than the
  // fine one and the cycle diverges. So the ghost-fluid terms towards air that the averaging
  // removed are kept as an extra diagonal term K ("leak"):
  //   K_coarse = 4 / 2^d * sum over the children of ( K_child + ghost-fluid terms of the child
  //              towards fine air cells that the coarse level no longer sees )
  // (4 / 2^d is the scaling of the restricted right-hand side, i.e. of a diagonal term: for a
  // bubbly mixture the leak per cell grows with the cell area, as it must.)
  // A fine air cell is still seen if its coarse parent is air or if it touches a fine air cell
  // whose parent is air: at an ordinary free surface the air stays represented, and counting it
  // twice would shift the surface.
  S.coef = `${H}
uniform Grid G;
uniform sampler2D uLiq;
uniform sampler2D uW;
uniform float uInvThetaMax;
uniform int uCoarse;
uniform GridX GF;            // next finer level (uCoarse = 1)
uniform sampler2D uLiqF;
uniform sampler2D uWF;
uniform sampler2D uCBF;     // its coefficients; .w = K
#ifdef SPARSE
uniform float uHeldInv;     // coarse levels: 1 / (distance to the centre of a held neighbour's nearest fine cell), else 0
uniform float uHeldK;       // weight of a face between a solved and a held liquid cell (see "project")
uniform int uHeldFloor;     // 1: on coarse levels held water above and below is a lid and a floor, as on the finest
#endif
layout(location = 0) out vec4 oA;   // xyz = coupling to low neighbours, w = diagonal (negative: held)
layout(location = 1) out vec4 oB;   // xyz = coupling to high neighbours, w = K
bool parentLiquid(ivec3 f) {
  ivec3 pc = f >> 1;
#if DIM == 2
  pc.z = 0;
#endif
  return texelFetch(uLiq, texelOf(G, pc), 0).r < 0.0;
}
float ghost(float w, float phiAir, float phiLiq) { return w * min(uInvThetaMax, 1.0 - phiAir / phiLiq); }
// A coarse cell that is solid throughout is not air, whatever its averaged phi says: its faces
// carry a little weight only because W is averaged over a wider stencil than the cell. Treated
// as air it would put p = 0 behind every wall that is more than a few cells thick. (The dense
// box ends in its walls, so there the case only arises around thick obstacles; it is left as it
// was, the dense solver being the reference. The sparse one can be switched to match it.)
#ifdef SPARSE
bool solidAir(vec2 l) { return uCoarse == 1 && uCoarseSolids == 1 && l.g <= 1.0e-4; }
#else
bool solidAir(vec2 l) { return false; }
#endif
// fine air cell a: is its air still present on this (coarse) level?
bool airSeen(ivec3 a) {
  if (!parentLiquid(a)) return true;
  for (int d = 0; d < DIM; d++) {
    for (int sgn = -1; sgn <= 1; sgn += 2) {
      ivec3 b = a + sgn * AX[d];
      if (present(uLiqF, GF, b) && texelFetch(uLiqF, texelOf(GF, b), 0).r >= 0.0 && !parentLiquid(b)) return true;
    }
  }
  return false;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float phi = texelFetch(uLiq, t, 0).r;
  vec4 A = vec4(0.0);
  vec4 B = vec4(0.0);
#ifdef SPARSE
  // A held cell (water at rest that is not solved) keeps its pressure: no equation, diagonal -1.
  // To its neighbours it is a liquid cell whose pressure is known, coupled with uHeldK times the
  // weight of the face (see "project"). A coarse cell is held if one of its children is; its
  // correction is zero, at the centre of its nearest fine cell, which lies 0.5 + 2^-(l+1)
  // coarse cells from the centre of the neighbour (uHeldInv is 1 over that).
  // Sideways only. Above and below, held water is a lid and a floor to solved water (pass
  // "solid" closes those faces), and it has to be one on the coarse levels too: their face
  // weights are averages over three layers of fine faces, so the closed layer came out half
  // open, and the coarse levels solved for a pool with its pressure fixed at the floor. Their
  // corrections were too small by that much: 0.6 to 0.8 of the residual was left per V-cycle
  // where a tank leaves 0.1 to 0.3.
  if (texelFetch(uW, t, 0).a > 0.5) {
    oA = vec4(0.0, 0.0, 0.0, -1.0);
    oB = vec4(0.0);
    return;
  }
#endif
  if (phi < 0.0) {
    vec4 Wc = texelFetch(uW, t, 0);
    float diag = 0.0;
    for (int d = 0; d < DIM; d++) {
      ivec3 lo = c - AX[d];
      if (Wc[d] > 0.0 && present(uLiq, G, lo)) {
        vec2 ln = fetchC(uLiq, G, lo).rg;
#ifdef SPARSE
        if (ln.r < 0.0 && fetchC(uW, G, lo).a > 0.5) {
          if (uHeldInv > 0.0) { if (d != 1 || uHeldFloor == 0) diag += Wc[d] * uHeldK * uHeldInv; }
          else { A[d] = Wc[d] * uHeldK; diag += Wc[d] * uHeldK; }
        } else
#endif
        if (ln.r < 0.0) { A[d] = Wc[d]; diag += Wc[d]; }
        else if (!solidAir(ln)) diag += ghost(Wc[d], ln.r, phi);
      }
      ivec3 hi = c + AX[d];
      if (present(uLiq, G, hi)) {
        ivec2 th = texelOf(G, hi);
        float w = texelFetch(uW, th, 0)[d];
        if (w > 0.0) {
          vec2 ln = texelFetch(uLiq, th, 0).rg;
#ifdef SPARSE
          if (ln.r < 0.0 && texelFetch(uW, th, 0).a > 0.5) {
            if (uHeldInv > 0.0) { if (d != 1 || uHeldFloor == 0) diag += w * uHeldK * uHeldInv; }
            else { B[d] = w * uHeldK; diag += w * uHeldK; }
          } else
#endif
          if (ln.r < 0.0) { B[d] = w; diag += w; }
          else if (!solidAir(ln)) diag += ghost(w, ln.r, phi);
        }
      }
    }
    float K = 0.0;
    if (uCoarse == 1) {
      ivec3 f0 = c * 2;
#if DIM == 2
      f0.z = 0;
#endif
      for (int k = 0; k < NC; k++) {
        ivec3 f = f0 + cornerOffset(k);
        ivec2 tf = texelOf(GF, f);
        K += texelFetch(uCBF, tf, 0).w;
        float pf = texelFetch(uLiqF, tf, 0).r;
        if (pf >= 0.0) continue;
        vec4 Wf = texelFetch(uWF, tf, 0);
        for (int d = 0; d < DIM; d++) {
          ivec3 lo = f - AX[d];
          if (Wf[d] > 0.0 && present(uLiqF, GF, lo)) {
            float pn = fetchC(uLiqF, GF, lo).r;
            if (pn >= 0.0 && !airSeen(lo)) K += ghost(Wf[d], pn, pf);
          }
          ivec3 hi = f + AX[d];
          if (present(uLiqF, GF, hi)) {
            ivec2 th = texelOf(GF, hi);
            float w = texelFetch(uWF, th, 0)[d];
            float pn = texelFetch(uLiqF, th, 0).r;
            if (w > 0.0 && pn >= 0.0 && !airSeen(hi)) K += ghost(w, pn, pf);
          }
        }
      }
      K *= 4.0 / float(NC);
    }
    A.w = diag + K;
    B.w = K;
  }
  oA = A;
  oB = B;
}`;

  // Right-hand side: negative weighted divergence of the relative velocity, the solid
  // volume-change term, and the artificial divergence that expels rho' > 1 (Sec. 3.7).
  // g channel: p_min of the separating solid boundary condition ([CM11a] Eq. 17).
  S.rhs = `${H}
uniform Grid G;
${FARS}
uniform sampler2D uVel;
uniform sampler2D uUs;
uniform sampler2D uW;
uniform sampler2D uLiq;
uniform sampler2D uSdf;
uniform float uSrcScale;   // lambda / dt
uniform float uSrcMax;     // eta / dt
uniform float uSinkScale;  // lambda_c / dt   (extension, see below)
uniform float uSinkMax;    // eta_c / dt
uniform int uSeparate;
#ifdef SPARSE
uniform float uHeldLive;   // 1: a face between a solved and a held liquid cell keeps its velocity (see "project")
#endif
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec2 l = texelFetch(uLiq, t, 0).rg;
  vec4 sc = texelFetch(uUs, t, 0);
  float b = 0.0;
#ifdef SPARSE
  if (texelFetch(uW, t, 0).a > 0.5) { o = vec4(0.0, -BIG, 0.0, 0.0); return; }   // held: no equation
#endif
  if (l.r < 0.0) {
    vec4 Wc = texelFetch(uW, t, 0);
    vec4 uc = texelFetch(uVel, t, 0);
    float div = 0.0;
    float divS = 0.0;
    bool interior = true;     // every open face leads to another liquid cell
    for (int d = 0; d < DIM; d++) {
      float ul = uc[d] - sc[d];
      divS -= sc[d];
      ivec3 lo = c - AX[d];
#ifdef SPARSE
      // (a face towards a held liquid cell carries no velocity of its own: see "project". It
      // counts as at rest, not as moving with the nearest obstacle: us is that obstacle's
      // velocity however far away it is, and is added back below (divS).)
      if (Wc[d] > 0.0 && hasCell(G, lo)) {
        ivec2 tl = texelOf(G, lo);
        if (texelFetch(uLiq, tl, 0).r >= 0.0) interior = false;
        else if (texelFetch(uW, tl, 0).a > 0.5 && uHeldLive < 0.5) ul = farVel(c)[d] - sc[d];
      }
#else
      if (Wc[d] > 0.0 && hasCell(G, lo) && fetchC(uLiq, G, lo).r >= 0.0) interior = false;
#endif
      div -= Wc[d] * ul;
      ivec3 hi = c + AX[d];
      if (hasCell(G, hi)) {
        ivec2 th = texelOf(G, hi);
        float s = texelFetch(uUs, th, 0)[d];
        vec4 wh = texelFetch(uW, th, 0);
        float w = wh[d];
        float uh = texelFetch(uVel, th, 0)[d] - s;
        float lh = texelFetch(uLiq, th, 0).r;
#ifdef SPARSE
        if (lh < 0.0 && wh.a > 0.5 && uHeldLive < 0.5) uh = farVel(hi)[d] - s;
#endif
        div += w * uh;
        divS += s;
        if (w > 0.0 && lh >= 0.0) interior = false;
      }
    }
    float rp = 0.5 - l.r;
    // Sec. 3.7: rho' > 1 is expelled with an artificial divergence min(lambda (rho' - 1), eta) / dt.
    // Extension (not in the paper): liquid cells that are completely surrounded by liquid but
    // hold less than their volume are contracted the same way. The paper's sharpening leaves
    // rho > 0.5 untouched, so without this nothing ever undoes numerical dilution of the bulk
    // and the 0.5 iso-contour can swell to up to twice the true volume (its Sec. 5 caveat).
    float src = 0.0;
    if (rp > 1.0) src = min(uSrcScale * (rp - 1.0), uSrcMax);
    else if (interior) src = -min(uSinkScale * (1.0 - rp), uSinkMax);
    b = -div + l.g * (src - divS);
  }
  // p >= 0 only where a solid cell actually carries a pressure unknown
  o = vec4(b, (uSeparate == 1 && l.r < 0.0 && texelFetch(uSdf, t, 0).w < 0.0) ? 0.0 : -BIG, 0.0, 0.0);
}`;

  // Projected red-black Gauss-Seidel sweep over one colour ([CM11a] Eq. 14, 18).
  S.smooth = `${H}
uniform Grid G;
uniform sampler2D uP;
uniform sampler2D uRhs;
uniform sampler2D uCA;
uniform sampler2D uCB;
uniform int uColor;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float p = texelFetch(uP, t, 0).r;
  if (((c.x + c.y + c.z) & 1) == uColor) {
    vec4 A = texelFetch(uCA, t, 0);
    if (A.w > 0.0) {
      vec4 B = texelFetch(uCB, t, 0);
      vec2 r = texelFetch(uRhs, t, 0).rg;
      float s = r.x;
      for (int d = 0; d < DIM; d++) {
        if (A[d] != 0.0) s += A[d] * fetchC(uP, G, c - AX[d]).r;
        if (B[d] != 0.0) s += B[d] * fetchC(uP, G, c + AX[d]).r;
      }
      p = max(r.y, s / A.w);
    } else {
#ifdef SPARSE
      if (A.w == 0.0)       // (negative: a held cell keeps its pressure)
#endif
      p = 0.0;
    }
  }
  o = vec4(p, 0.0, 0.0, 0.0);
}`;

  // Residual of the fine level restricted to the coarse right-hand side, plus the
  // DownsampleSubtract of p_min ([CM11a] Eq. 19-20).
  S.restrict = `${H}
uniform Grid G;    // coarse
uniform GridX GF;   // fine
uniform sampler2D uP;
uniform sampler2D uRhs;
uniform sampler2D uCA;
uniform sampler2D uCB;
uniform int uUsePmin;
out vec4 o;
void main() {
  ivec3 c = cellOf(G, ivec2(gl_FragCoord.xy));
  ivec3 f0 = c * 2;
#if DIM == 2
  f0.z = 0;
#endif
  float sum = 0.0;
  float pm = -BIG;
  for (int k = 0; k < NC; k++) {
    ivec3 f = f0 + cornerOffset(k);
    ivec2 t = texelOf(GF, f);
    vec4 A = texelFetch(uCA, t, 0);
    float p = texelFetch(uP, t, 0).r;
    vec2 r = texelFetch(uRhs, t, 0).rg;
    if (A.w > 0.0) {
      vec4 B = texelFetch(uCB, t, 0);
      float Ap = A.w * p;
      for (int d = 0; d < DIM; d++) {
        if (A[d] != 0.0) Ap -= A[d] * fetchC(uP, GF, f - AX[d]).r;
        if (B[d] != 0.0) Ap -= B[d] * fetchC(uP, GF, f + AX[d]).r;
      }
      sum += r.x - Ap;
    }
    pm = max(pm, r.y - p);
  }
  o = vec4(sum * (4.0 / float(NC)), uUsePmin == 1 ? pm : -BIG, 0.0, 0.0);
}`;

  S.prolong = `${H}
uniform Grid G;    // fine
uniform GridX GC;   // coarse
uniform sampler2D uP;
uniform sampler2D uPc;
uniform sampler2D uLiqC;   // liq of the coarse level (which of its cells stand for real cells)
uniform sampler2D uCA;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float p = texelFetch(uP, t, 0).r;
  if (texelFetch(uCA, t, 0).w > 0.0) p += sampleCoarseIn(uPc, uLiqC, GC, c).r;
  o = vec4(p, 0.0, 0.0, 0.0);
}`;

  // Max-norm of the residual per cell (diagnostics only).
  S.residual = `${H}
uniform Grid G;
uniform sampler2D uP;
uniform sampler2D uRhs;
uniform sampler2D uCA;
uniform sampler2D uCB;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 A = texelFetch(uCA, t, 0);
  float res = 0.0;
  if (A.w > 0.0) {
    vec4 B = texelFetch(uCB, t, 0);
    float p = texelFetch(uP, t, 0).r;
    vec2 r = texelFetch(uRhs, t, 0).rg;
    float Ap = A.w * p;
    for (int d = 0; d < DIM; d++) {
      Ap -= A[d] * fetchC(uP, G, c - AX[d]).r;
      Ap -= B[d] * fetchC(uP, G, c + AX[d]).r;
    }
    res = r.x - Ap;
    if (p <= r.y && res < 0.0) res = 0.0;   // active separating constraint: complementarity holds
  }
  o = vec4(res, texelFetch(uRhs, t, 0).r, 0.0, 0.0);
}`;

  // Velocity update u -= grad p on every face that touches a liquid cell; solid faces take
  // the solid velocity.
  // Sparse backend, the faces between a solved liquid cell and a held one (water at rest whose
  // pressure is that of rest): they carry u = -uHeldK * (p_rest - p) and nothing of what they
  // carried before. That is the condition of a boundary that lets waves out: the liquid leaves
  // at a speed proportional to how far the pressure next to the boundary is above that of rest,
  // u = (p - p_rest) / Z, Z = 1 / uHeldK being the speed of the waves in cells per step. A face
  // that kept its velocity (u -= grad p, a fixed pressure next to it) would be the open end of
  // an organ pipe instead: waves come back from it upside down, and the liquid moves fastest
  // exactly there.
  // Over a height field (uHeldLive) the pressure next to the face is not fixed: the level there
  // rises with what the face lets through, and the height field carries the wave on. The face
  // then is one like any other.
  S.project = `${H}
uniform Grid G;
${FARS}
uniform sampler2D uVel;
uniform sampler2D uUs;
uniform sampler2D uW;
uniform sampler2D uLiq;
uniform sampler2D uP;
uniform float uInvThetaMax;
#ifdef SPARSE
uniform float uHeldK;
uniform float uHeldLive;    // 1: such a face keeps its velocity like any other (see below)
#endif
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 v = texelFetch(uVel, t, 0);
  vec4 W = texelFetch(uW, t, 0);
  vec4 us = texelFetch(uUs, t, 0);
  float pb = texelFetch(uP, t, 0).r;
  float fb = texelFetch(uLiq, t, 0).r;
  for (int d = 0; d < DIM; d++) {
    ivec3 lo = c - AX[d];
    if (W[d] <= 0.0 || !hasCell(G, lo)) { v[d] = us[d]; continue; }
    ivec2 ta = texelOf(G, lo);
    float pa = texelFetch(uP, ta, 0).r;
    float fa = texelFetch(uLiq, ta, 0).r;
#ifdef SPARSE
    // a face between two held cells is at rest; one between a held and a solved cell is live
    float ha = texelFetch(uW, ta, 0).a;
    // (at rest: with the velocity of the water at rest, which over a height field is that of its flow)
    if (W.a > 0.5 && ha > 0.5) { v[d] = farVel(c)[d]; continue; }
    if (W.a != ha && fa < 0.0 && fb < 0.0 && uHeldLive < 0.5) { v[d] = farVel(c)[d] - uHeldK * (pb - pa); continue; }
#endif
    if (fa < 0.0 && fb < 0.0) v[d] -= pb - pa;
    else if (fa < 0.0) v[d] += pa * min(uInvThetaMax, 1.0 - fb / fa);
    else if (fb < 0.0) v[d] -= pb * min(uInvThetaMax, 1.0 - fa / fb);
  }
#if DIM == 2
  v.z = 0.0;
#endif
  o = vec4(v.xyz, 0.0);
}`;

  // ---------------------------------------------------------------- diagnostics
  // Block reduction: total mass, volume enclosed by the 0.5 iso-contour, gamma range, speeds.
  S.stats = `${H}
uniform Grid G;
uniform sampler2D uRho;
uniform sampler2D uLiq;
uniform sampler2D uVel;
uniform sampler2D uRes;
uniform int uB;
layout(location = 0) out vec4 o0;   // sum rho, sum volume, sum |residual|, sum |rhs|
layout(location = 1) out vec4 o1;   // min gamma, max gamma, max liquid speed, max rho'
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * uB;
  float mass = 0.0, vol = 0.0, res = 0.0, rhs = 0.0;
  float gmin = BIG, gmax = -BIG, vmax = 0.0, rmax = 0.0;
  for (int j = 0; j < uB; j++) {
    for (int i = 0; i < uB; i++) {
      ivec2 t = base + ivec2(i, j);
      if (!liveTexel(G, t)) continue;
      ivec3 c = cellOf(G, t);
      vec2 rg = texelFetch(uRho, t, 0).rg;
      vec2 l = texelFetch(uLiq, t, 0).rg;
      vec2 rr = texelFetch(uRes, t, 0).rg;
      mass += rg.r;
      res += abs(rr.x);
      rhs += abs(rr.y);
      if (l.g > 0.0) {
        float rp = 0.5 - l.r;
        float g1 = 0.0;
        for (int d = 0; d < DIM; d++) g1 += 0.5 * abs(fetchC(uLiq, G, c + AX[d]).r - fetchC(uLiq, G, c - AX[d]).r);
        vol += l.g * clamp(0.5 + (rp - 0.5) / max(g1, 1.0e-6), 0.0, 1.0);
        rmax = max(rmax, rp);
        if (rp > 0.01) { gmin = min(gmin, rg.g); gmax = max(gmax, rg.g); }
        if (l.r < 0.0) vmax = max(vmax, length(texelFetch(uVel, t, 0).xyz));
      }
    }
  }
  o0 = vec4(mass, vol, res, rhs);
  o1 = vec4(gmin, gmax, vmax, rmax);
}`;

  // ---------------------------------------------------------------- sources
  // Liquid primitives: coverage = clamp(0.5 - sd) (one-cell anti-aliased edge).
  //   uOp 0: initialise   rho = V * coverage, gamma = 1
  //   uOp 1: add          rho = max(rho, V * coverage)
  //   uOp 2: remove       rho = rho * (1 - coverage)
  S.sourceRho = `${H}
uniform Grid G;
${prims('L', sparse)}
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform int uOp;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float V = texelFetch(uFrac, t, 0).a;
  float cov = clamp(0.5 - sdL(shapePos(cellPos(c, vec3(0.5)))).x, 0.0, 1.0);
  vec2 rg = texelFetch(uRho, t, 0).rg;
  if (uOp == 0) rg = vec2(V * cov, 1.0);
  else if (uOp == 1) rg.r = max(rg.r, V * cov);
  else rg.r *= 1.0 - cov;
  o = vec4(rg, 0.0, 0.0);
}`;

  //   uOp 0: initialise  v = primitive velocity inside the liquid, 0 elsewhere
  //   uOp 1: add         v = mix(v, primitive velocity, coverage)
  S.sourceVel = `${H}
uniform Grid G;
${prims('L', sparse)}
uniform sampler2D uVel;
uniform int uOp;
out vec4 o;
float comp(vec3 xf, int d, float old) {
  vec3 x = shapePos(xf);
  vec2 s = sdL(x);
  float cov = clamp(0.5 - s.x, 0.0, 1.0);
  float target = s.y >= 0.0 ? velL(int(s.y), x)[d] : 0.0;
  return uOp == 0 ? target * cov : mix(old, target, cov);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 v = texelFetch(uVel, t, 0);
  v.x = comp(cellPos(c, vec3(0.0, 0.5, 0.5)), 0, v.x);
  v.y = comp(cellPos(c, vec3(0.5, 0.0, 0.5)), 1, v.y);
#if DIM == 3
  v.z = comp(cellPos(c, vec3(0.5, 0.5, 0.0)), 2, v.z);
#else
  v.z = 0.0;
#endif
  o = vec4(v.xyz, 0.0);
}`;

  // ---------------------------------------------------------------- liquid -> rigid body coupling
  // Pressure force and torque on each body: sum over cells of -p * grad(W_body), where W_body is
  // the body's own non-solid staggered volume fraction (the discrete surface normal times area
  // of the variational pressure discretisation). One point per cell is scattered to the texel
  // of the body it touches.
  S.bodyForceVS = `${H}
uniform Grid G;
uniform sampler2D uP;
uniform sampler2D uLiq;
uniform sampler2D uVel;
uniform float uSlots;
uniform int uBase;
${prims('B', sparse)}
out vec4 vA;   // xyz = pressure force, w = surface band weight
out vec4 vB;   // xyz = torque, w = wet part of the band
out vec4 vC;   // xyz = liquid velocity summed over the wet band, w = its weight
float vol(float d) { return clamp(0.5 + d, 0.0, 1.0); }
void main() {
  ivec2 st = pointTexel(G, gl_VertexID + uBase);
  ivec3 c = cellOf(G, st);
  vec3 xc = shapePos(cellPos(c, vec3(0.5)));
  vec2 s = sdB(xc);
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vA = vec4(0.0);
  vB = vec4(0.0);
  vC = vec4(0.0);
  if (!g_live || s.y < 0.0 || abs(s.x) > 1.5) return;
  int b = int(s.y);
  vec3 dW = vec3(0.0);
  dW.x = vol(sdBPrim(b, xc + vec3(0.5, 0.0, 0.0))) - vol(sdBPrim(b, xc - vec3(0.5, 0.0, 0.0)));
  dW.y = vol(sdBPrim(b, xc + vec3(0.0, 0.5, 0.0))) - vol(sdBPrim(b, xc - vec3(0.0, 0.5, 0.0)));
#if DIM == 3
  dW.z = vol(sdBPrim(b, xc + vec3(0.0, 0.0, 0.5))) - vol(sdBPrim(b, xc - vec3(0.0, 0.0, 0.5)));
#endif
  float band = abs(dW.x) + abs(dW.y) + abs(dW.z);
  if (band <= 0.0) return;
  vec3 f = -texelFetch(uP, st, 0).r * dW;
  vec3 r = xc - uBA[b].xyz;
#if DIM == 2
  r.z = 0.0;
#endif
  float wetBand = texelFetch(uLiq, st, 0).r < 0.0 ? band : 0.0;
  vA = vec4(f, band);
  vB = vec4(cross(r, f), wetBand);
  vC = vec4(texelFetch(uVel, st, 0).xyz, 1.0) * wetBand;
  gl_Position = vec4((float(b) + 0.5) / uSlots * 2.0 - 1.0, 0.0, 0.0, 1.0);
}`;
  S.bodyForceFS = `${H}
in vec4 vA;
in vec4 vB;
in vec4 vC;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
void main() { o0 = vA; o1 = vB; o2 = vC; }`;

  return S;
}
