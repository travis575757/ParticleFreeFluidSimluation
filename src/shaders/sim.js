// Simulation passes for "Mass-Conserving Eulerian Liquid Simulation" (Chentanez & Mueller, SCA 2012).
// Section/equation numbers in comments refer to that paper unless another reference is named.
import { header, TRACE, prims } from './common.js';

const EPSV = '1.0e-3'; // floor on the capacity weight so scatter weights can always be normalised
const VMIN = '0.05';   // floor on V when normalising row sums of nearly solid cells

export function simShaders(dim, floatLinear) {
  const H = header(dim, floatLinear);
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
  S.solid = `${H}
uniform Grid G;
${prims('S')}
layout(location = 0) out vec4 oSdf;
layout(location = 1) out vec4 oUs;
layout(location = 2) out vec4 oFrac;
layout(location = 3) out vec4 oW;
ivec3 gc;
float D(float x, float y, float z) { return sdS(cellPos(gc, vec3(x, y, z))).x; }
float ramp(float d, float l1) { return clamp(0.5 + d / max(l1, 1.0e-6), 0.0, 1.0); }
float vol(float d) { float w = clamp(0.5 + d, 0.0, 1.0); return w < 0.01 ? 0.0 : w; }
void main() {
  gc = cellOf(G, ivec2(gl_FragCoord.xy));
  // A wall lying exactly on a face must count as closed, hence the small bias on the area fraction.
  const float bias = 1.0e-3;
  float dc = D(0.5, 0.5, 0.5);
  vec3 xf;
  vec3 us = vec3(0.0);
  xf = cellPos(gc, vec3(0.0, 0.5, 0.5)); vec2 sx = sdS(xf); if (sx.y >= 0.0) us.x = velS(int(sx.y), xf).x;
  xf = cellPos(gc, vec3(0.5, 0.0, 0.5)); vec2 sy = sdS(xf); if (sy.y >= 0.0) us.y = velS(int(sy.y), xf).y;
  vec3 g = vec3(D(1.0, 0.5, 0.5) - sx.x, D(0.5, 1.0, 0.5) - sy.x, 0.0);
  vec3 A = vec3(0.0);
  vec3 W = vec3(vol(sx.x), vol(sy.x), 0.0);
#if DIM == 2
  float n00 = D(0.0, 0.0, 0.5), n01 = D(0.0, 1.0, 0.5), n10 = D(1.0, 0.0, 0.5);
  A.x = ramp(sx.x - bias, abs(n01 - n00));
  A.y = ramp(sy.x - bias, abs(n10 - n00));
#else
  xf = cellPos(gc, vec3(0.5, 0.5, 0.0)); vec2 sz = sdS(xf); if (sz.y >= 0.0) us.z = velS(int(sz.y), xf).z;
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
  oSdf = vec4(g, dc);
  oUs = vec4(us, 0.0);
  oFrac = vec4(A, clamp(0.5 + dc, 0.0, 1.0));
  oW = vec4(W, 0.0);
}`;

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
    for (int d = 0; d < DIM; d++) {
      for (int s = -1; s <= 1; s += 2) {
        ivec3 nb = c + s * AX[d];
        if (!inGrid(G, nb)) continue;
        ivec2 tn = texelOf(G, nb);
        float Vn = texelFetch(uFrac, tn, 0).a;
        if (Vn >= uVthr) rp = max(rp, texelFetch(uRho, tn, 0).r / Vn);
      }
    }
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
    if (a[d] < 0 || W[d] <= 0.0) continue;
    if (pc < 0.0 || fetchC(uLiq, G, a).r < 0.0) known[d] = 1.0;
  }
  oA = vec4(v.xyz * known, 0.0);
  oB = vec4(known, 0.0);
}`;

  S.extrapPull = `${H}
uniform Grid G;    // coarse (target)
uniform Grid GF;   // fine (source)
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
uniform Grid GC;   // coarser level
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
  if (uTop == 0) {
    vec3 x = (vec3(c) + 0.5) * 0.5;
#if DIM == 2
    x.z = 0.5;
#endif
    coarse = sampleLin(uFc, GC, x).xyz;
  }
  vec3 r;
  for (int d = 0; d < 3; d++) r[d] = b[d] > 0.0 ? a[d] / b[d] : coarse[d];
  o = vec4(r, 0.0);
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
      ivec2 ts = texelOf(G, clampCell(G, ivec3(f) + cornerOffset(k)));
      float w = cornerWeight(k, a);
      gt += w * texelFetch(uRho, ts, 0).g;
      Vsrc += w * texelFetch(uFrac, ts, 0).a;
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
${decl}
out vec4 vVal;
void main() {
  int corner = gl_VertexID % NC;
  int ci = gl_VertexID / NC;
  int aw = G.n.x * G.tx;
  ivec2 st = ivec2(ci % aw, ci / aw);
  vec4 src = texelFetch(uSrc, st, 0);
  vec3 q = src.xyz - 0.5;
  vec3 f = floor(q);
  float w = cornerWeight(corner, q - f);
  ivec2 tt = texelOf(G, clampCell(G, ivec3(f) + cornerOffset(corner)));
  vec4 val = vec4(0.0);
  ${body}
  vVal = val * w;
  gl_PointSize = 1.0;
  gl_Position = (w > 0.0 && val != vec4(0.0))
    ? vec4((vec2(tt) + 0.5) * G.inv * 2.0 - 1.0, 0.0, 1.0)
    : vec4(2.0, 2.0, 2.0, 1.0);
}`;

  S.scatterFS = `${H}
in vec4 vVal;
out vec4 o;
void main() { o = vVal; }`;

  // Step 3: beta_l += w-_li s_i
  S.scatterBetaVS = scatterVS('', 'val = vec4(src.w);');

  // Steps 4-5 (gather) and the forward characteristics needed by steps 6-7.
  S.advGather = `${H}
uniform Grid G;
${TRACE}
uniform sampler2D uRho;
uniform sampler2D uTraceTex;
uniform sampler2D uBeta;
uniform sampler2D uFrac;
uniform float uDt;
layout(location = 0) out vec4 oRho;   // (rho, gamma) before the forward scatter
layout(location = 1) out vec4 oFwd;   // xyz = x+, w = (1 - beta_j) / capacity normalisation
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 tr = texelFetch(uTraceTex, t, 0);
  float V = texelFetch(uFrac, t, 0).a;
  vec2 acc = vec2(0.0);
  if (tr.w > 0.0) {
    vec3 q = tr.xyz - 0.5;
    vec3 f = floor(q);
    vec3 a = q - f;
    for (int k = 0; k < NC; k++) {
      ivec2 ts = texelOf(G, clampCell(G, ivec3(f) + cornerOffset(k)));
      acc += cornerWeight(k, a) * vec2(texelFetch(uRho, ts, 0).r, texelFetch(uFrac, ts, 0).a) / max(1.0, texelFetch(uBeta, ts, 0).r);
    }
    acc *= tr.w;
    acc.y /= max(V, ${VMIN});
  }
  oRho = vec4(acc, 0.0, 0.0);

  // Steps 6-7: whatever this cell was not asked for (beta_j < 1) is carried forward.
  float rem = max(0.0, 1.0 - texelFetch(uBeta, t, 0).r);
  vec3 x = cellPos(c, vec3(0.5));
  vec3 xf = x;
  float amt = 0.0;
  if (rem > 0.0 && (V > 0.0 || texelFetch(uRho, t, 0).r > 0.0)) {
    xf = trace(x, uDt);
    vec3 q = xf - 0.5;
    vec3 f = floor(q);
    vec3 a = q - f;
    float norm = 0.0;
    for (int k = 0; k < NC; k++) norm += cornerWeight(k, a) * (fetchC(uFrac, G, ivec3(f) + cornerOffset(k)).a + ${EPSV});
    amt = rem / norm;
  }
  oFwd = vec4(xf, amt);
}`;

  // Steps 6-7: rho_k += rho_j (1 - beta_j) w+_jk, and the same entries added to the row sums.
  S.scatterFwdVS = scatterVS(
    `uniform sampler2D uRho; uniform sampler2D uFrac;`,
    `if (src.w > 0.0) {
    float Vt = texelFetch(uFrac, tt, 0).a;
    val = vec4(texelFetch(uRho, st, 0).r, texelFetch(uFrac, st, 0).a / max(Vt, ${VMIN}), 0.0, 0.0) * (src.w * (Vt + ${EPSV}));
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

  // Step 8: diffusion of the row sums [LAF11 Sec. 2.1], one axis per pass (Jacobi within the
  // axis). gamma relaxes towards its neighbours and carries the matching share of rho along.
  // Only pairs of liquid cells (rho' > 0.5) exchange: outside the liquid the velocity is an
  // extrapolation that is not divergence free, so row sums there say nothing about compression
  // and exchanging with them would just smear the free surface.
  S.diffuse = `${H}
uniform Grid G;
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform int uAxis;
uniform float uKappa;
out vec4 o;
vec2 exchange(vec2 me, vec2 nb) {
  float dg = (nb.g - me.g) * uKappa;
  float dr = dg > 0.0 ? nb.r * dg / max(nb.g, 1.0e-6) : me.r * dg / max(me.g, 1.0e-6);
  return vec2(dr, dg);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec4 fr = texelFetch(uFrac, t, 0);
  vec2 me = texelFetch(uRho, t, 0).rg;
  vec2 r = me;
  if (fr.a > 0.0 && me.r > 0.5 * fr.a) {
    ivec3 lo = c - AX[uAxis];
    ivec3 hi = c + AX[uAxis];
    if (lo[uAxis] >= 0 && fr[uAxis] > 0.0) {
      ivec2 tl = texelOf(G, lo);
      float Vl = texelFetch(uFrac, tl, 0).a;
      vec2 nb = texelFetch(uRho, tl, 0).rg;
      if (Vl > 0.0 && nb.r > 0.5 * Vl) r += exchange(me, nb);
    }
    if (hi[uAxis] < G.n[uAxis]) {
      ivec2 th = texelOf(G, hi);
      vec4 fh = texelFetch(uFrac, th, 0);
      vec2 nb = texelFetch(uRho, th, 0).rg;
      if (fh[uAxis] > 0.0 && fh.a > 0.0 && nb.r > 0.5 * fh.a) r += exchange(me, nb);
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
float rhoP(ivec3 c) { return 0.5 - fetchC(uLiq, G, c).r; }
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
      float aHi = hi[d] < G.n[d] ? fetchC(uFrac, G, hi)[d] : 0.0;
      float dPlus = -(rho * aHi - fetchC(uRho, G, lo).r * aLo);    // Eq. 18
      float dMinus = -(fetchC(uRho, G, hi).r * aHi - rho * aLo);   // Eq. 19
      float a = min(dPlus, 0.0);
      float b = max(dMinus, 0.0);
      gm += max(a * a, b * b);                                     // Eq. 11-13
      maxDiff = max(maxDiff, max(abs(rp - rhoP(lo)), abs(rp - rhoP(hi))));
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
    for (int k = 0; k < NC; k++) norm += cornerWeight(k, a) * (fetchC(uFrac, G, ivec3(f) + cornerOffset(k)).a + ${EPSV});
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
  vec3 d = x - uMouse.xyz;
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
  o = vec4(v + uGravity * uDt, 0.0);
}`;

  // ---------------------------------------------------------------- pressure projection (Sec. 3.7, [CM11a])
  // Coarse levels of the multigrid hierarchy: phi and V by 2^d-to-1 averaging (with the
  // "keep air bubbles on the finest levels" rule), W by averaging the staggered cells covered.
  S.downsample = `${H}
uniform Grid G;    // coarse
uniform Grid GF;   // fine
uniform sampler2D uLiqF;
uniform sampler2D uWF;
uniform int uBubbles;
layout(location = 0) out vec4 oLiq;
layout(location = 1) out vec4 oW;
void main() {
  ivec3 c = cellOf(G, ivec2(gl_FragCoord.xy));
  ivec3 f = c * 2;
#if DIM == 2
  f.z = 0;
#endif
  float sum = 0.0, sumPos = 0.0, nPos = 0.0, V = 0.0;
  for (int k = 0; k < NC; k++) {
    vec2 l = fetchC(uLiqF, GF, f + cornerOffset(k)).rg;
    sum += l.r;
    V += l.g;
    if (l.r >= 0.0) { sumPos += l.r; nPos += 1.0; }
  }
  float phi = sum / float(NC);
  if (nPos > 0.0 && nPos < float(NC)) {
    // A coarse cell that covers both liquid and air. Losing the air (and with it the p = 0
    // condition) makes the coarse operator softer than the fine one and the cycle can diverge.
    //   1: [CM11a/b] average of the positive values
    //   2: stay air, but keep the averaged interface position (phi >= small positive)
    if (uBubbles == 1) phi = sumPos / nPos;
    else if (uBubbles == 2) phi = max(phi, 1.0e-3);
  }
  oLiq = vec4(phi, V / float(NC), 0.0, 0.0);
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
}`;

  // Matrix coefficients of  sum_f W_f (p_i - p_nb) = b_i  with the ghost-fluid treatment of
  // air neighbours (p_nb = p_i * phi_nb / phi_i, [CM11a] Eq. 6-7).
  S.coef = `${H}
uniform Grid G;
uniform sampler2D uLiq;
uniform sampler2D uW;
uniform float uInvThetaMax;
layout(location = 0) out vec4 oA;   // xyz = coupling to low neighbours, w = diagonal
layout(location = 1) out vec4 oB;   // xyz = coupling to high neighbours
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float phi = texelFetch(uLiq, t, 0).r;
  vec4 A = vec4(0.0);
  vec4 B = vec4(0.0);
  if (phi < 0.0) {
    vec4 Wc = texelFetch(uW, t, 0);
    float diag = 0.0;
    for (int d = 0; d < DIM; d++) {
      ivec3 lo = c - AX[d];
      if (lo[d] >= 0 && Wc[d] > 0.0) {
        float pn = fetchC(uLiq, G, lo).r;
        if (pn < 0.0) { A[d] = Wc[d]; diag += Wc[d]; }
        else diag += Wc[d] * min(uInvThetaMax, 1.0 - pn / phi);
      }
      ivec3 hi = c + AX[d];
      if (hi[d] < G.n[d]) {
        ivec2 th = texelOf(G, hi);
        float w = texelFetch(uW, th, 0)[d];
        if (w > 0.0) {
          float pn = texelFetch(uLiq, th, 0).r;
          if (pn < 0.0) { B[d] = w; diag += w; }
          else diag += w * min(uInvThetaMax, 1.0 - pn / phi);
        }
      }
    }
    A.w = diag;
  }
  oA = A;
  oB = B;
}`;

  // Right-hand side: negative weighted divergence of the relative velocity, the solid
  // volume-change term, and the artificial divergence that expels rho' > 1 (Sec. 3.7).
  // g channel: p_min of the separating solid boundary condition ([CM11a] Eq. 17).
  S.rhs = `${H}
uniform Grid G;
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
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  vec2 l = texelFetch(uLiq, t, 0).rg;
  vec4 sc = texelFetch(uUs, t, 0);
  float b = 0.0;
  if (l.r < 0.0) {
    vec4 Wc = texelFetch(uW, t, 0);
    vec4 uc = texelFetch(uVel, t, 0);
    float div = 0.0;
    float divS = 0.0;
    bool interior = true;     // every open face leads to another liquid cell
    for (int d = 0; d < DIM; d++) {
      div -= Wc[d] * (uc[d] - sc[d]);
      divS -= sc[d];
      ivec3 lo = c - AX[d];
      if (lo[d] >= 0 && Wc[d] > 0.0 && fetchC(uLiq, G, lo).r >= 0.0) interior = false;
      ivec3 hi = c + AX[d];
      if (hi[d] < G.n[d]) {
        ivec2 th = texelOf(G, hi);
        float s = texelFetch(uUs, th, 0)[d];
        float w = texelFetch(uW, th, 0)[d];
        div += w * (texelFetch(uVel, th, 0)[d] - s);
        divS += s;
        if (w > 0.0 && texelFetch(uLiq, th, 0).r >= 0.0) interior = false;
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
      p = 0.0;
    }
  }
  o = vec4(p, 0.0, 0.0, 0.0);
}`;

  // Residual of the fine level restricted to the coarse right-hand side, plus the
  // DownsampleSubtract of p_min ([CM11a] Eq. 19-20).
  S.restrict = `${H}
uniform Grid G;    // coarse
uniform Grid GF;   // fine
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
uniform Grid GC;   // coarse
uniform sampler2D uP;
uniform sampler2D uPc;
uniform sampler2D uCA;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float p = texelFetch(uP, t, 0).r;
  if (texelFetch(uCA, t, 0).w > 0.0) {
    vec3 x = (vec3(c) + 0.5) * 0.5;
#if DIM == 2
    x.z = 0.5;
#endif
    p += sampleLin(uPc, GC, x).r;
  }
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
  S.project = `${H}
uniform Grid G;
uniform sampler2D uVel;
uniform sampler2D uUs;
uniform sampler2D uW;
uniform sampler2D uLiq;
uniform sampler2D uP;
uniform float uInvThetaMax;
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
    if (lo[d] < 0 || W[d] <= 0.0) { v[d] = us[d]; continue; }
    ivec2 ta = texelOf(G, lo);
    float pa = texelFetch(uP, ta, 0).r;
    float fa = texelFetch(uLiq, ta, 0).r;
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
  ivec2 size = ivec2(G.n.x * G.tx, int(floor(1.0 / G.inv.y + 0.5)));
  float mass = 0.0, vol = 0.0, res = 0.0, rhs = 0.0;
  float gmin = BIG, gmax = -BIG, vmax = 0.0, rmax = 0.0;
  for (int j = 0; j < uB; j++) {
    for (int i = 0; i < uB; i++) {
      ivec2 t = base + ivec2(i, j);
      if (t.x >= size.x || t.y >= size.y) continue;
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
${prims('L')}
uniform sampler2D uRho;
uniform sampler2D uFrac;
uniform int uOp;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float V = texelFetch(uFrac, t, 0).a;
  float cov = clamp(0.5 - sdL(cellPos(c, vec3(0.5))).x, 0.0, 1.0);
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
${prims('L')}
uniform sampler2D uVel;
uniform int uOp;
out vec4 o;
float comp(vec3 x, int d, float old) {
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
${prims('B')}
out vec4 vA;   // xyz = pressure force, w = surface band weight
out vec4 vB;   // xyz = torque, w = wet part of the band
out vec4 vC;   // xyz = liquid velocity summed over the wet band, w = its weight
float vol(float d) { return clamp(0.5 + d, 0.0, 1.0); }
void main() {
  int aw = G.n.x * G.tx;
  ivec2 st = ivec2(gl_VertexID % aw, gl_VertexID / aw);
  ivec3 c = cellOf(G, st);
  vec3 xc = cellPos(c, vec3(0.5));
  vec2 s = sdB(xc);
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vA = vec4(0.0);
  vB = vec4(0.0);
  vC = vec4(0.0);
  if (s.y < 0.0 || abs(s.x) > 1.5) return;
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
