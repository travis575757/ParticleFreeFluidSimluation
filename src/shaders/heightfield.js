// Passes of the height field (src/world/heightfield.js): shallow water over a bed, for the water
// of a world that is not solved in 3D.
//
// A map of texels over x and z, `cell` cells of the 3D grid on a side. Per texel
//   h   depth of the water (cells): its volume per unit of area
//   u   velocity through the texel's low-x face, w through its low-z face (cells per second)
//   m   1 where the 3D solver owns the column (see src/shaders/hfcouple.js): the height field
//       then leaves the texel alone and lets nothing through its faces
// and a bed b (cells, the height of the ground). The scheme is the usual staggered explicit one:
// depths from the fluxes u * (h of the texel the flow comes from), then velocities from the slope
// of the new surface b + h. Both first order. What keeps it out of trouble:
//   - a face between a dry texel and water that stands below the dry bed is closed
//   - a face next to a dry texel lets water onto it, never off it
//   - no face is faster than uUmax, a quarter of a texel per sub-step (half in 1D): a texel
//     cannot lose more than it holds, so no depth goes negative and nothing has to be put back
// Lengths are 3D cells, times seconds, like the solver's.

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

// state and bed of a texel; outside the map: nothing, and blocked
const FETCH = `
uniform sampler2D uH;
uniform sampler2D uBed;      // r = bed (cells), g = 1 where the texel is no part of the height field (a wall)
vec4 st(ivec2 t) {
  ivec2 n = textureSize(uH, 0);
  if (t.x < 0 || t.y < 0 || t.x >= n.x || t.y >= n.y) return vec4(0.0);
  return texelFetch(uH, t, 0);
}
vec2 bed(ivec2 t) {
  ivec2 n = textureSize(uH, 0);
  if (t.x < 0 || t.y < 0 || t.x >= n.x || t.y >= n.y) return vec2(0.0, 1.0);
  return texelFetch(uBed, t, 0).rg;
}
`;

// What the sum s of a and b in single precision has lost of them: a + b = s + lost(a, b, s) exactly
// (Knuth's two-sum). uOne is 1. Written plainly, the NVIDIA compiler takes (a + b) - a for b and
// the remainder for nothing (seen: 16 + 1e-7 "loses" 0); it cannot when every term that would
// cancel carries a factor it does not know. tests/heightfield.html?only=sum checks it.
export const LOST = `
uniform float uOne;
float lost(float a, float b, float s) {
  float bb = s - a * uOne;
  float aa = s - bb * uOne;
  return (a - aa * uOne) + (b - bb * uOne);
}
`;

export function heightfieldShaders() {
  const S = {};

  // Velocities. The advection is the momentum-conserving form of Stelling and Duinmeijer
  // (2003): du/dt + (d(Q u)/dx - u dQ/dx) / h + g d(b + h)/dx = 0 with the discharge Q taken
  // between the faces and u upwind of it, which comes to
  //   [min(Q+, 0) (u+ - u) + max(Q-, 0) (u - u-)] / (dx h)
  // per axis, Q+ and Q- being the discharge on either side of the face. (With u du/dx instead a
  // bore travels a seventh too slowly, and the front over a dry bed hardly at all: a face that
  // stands still receives no momentum.)
  S.vel = `${HEAD}${FETCH}
uniform float uDt;        // of the sub-step
uniform float uDx;        // cells per texel
uniform float uG;         // gravity, cells / s^2
uniform float uDry;       // a texel with less water than this is dry
uniform float uFric;      // drag of the bed: dv/dt = -uFric |v| v / h
uniform float uUmax;
out vec4 o;
float comp(vec4 s, int ax) { return ax == 0 ? s.g : s.b; }
// what goes through the low face of texel t along ax, per unit of width
float flux(ivec2 t, int ax) {
  ivec2 e = ax == 0 ? ivec2(1, 0) : ivec2(0, 1);
  vec4 R = st(t), L = st(t - e);
  float v = comp(R, ax);
  return v * (v > 0.0 ? L.r : R.r);
}
float faceVel(ivec2 t, int ax) {
  ivec2 e = ax == 0 ? ivec2(1, 0) : ivec2(0, 1);
  ivec2 f = ax == 0 ? ivec2(0, 1) : ivec2(1, 0);
  if (t[ax] == 0) return 0.0;
  vec4 R = st(t), L = st(t - e);
  float v0 = comp(R, ax);
  if (R.a > 0.5 || L.a > 0.5) return v0;       // a face of the 3D solver's: what "fold" put there
  vec2 bR = bed(t), bL = bed(t - e);
  if (bR.y > 0.5 || bL.y > 0.5) return 0.0;
  bool wetL = L.r > uDry, wetR = R.r > uDry;
  if (!wetL && !wetR) return 0.0;
  // (the two differences are small and exact; b + h of either side alone is neither. What is
  // left of a level surface is the rounding of the depths, a few 1e-7 of them: not a slope.)
  float db = bR.x - bL.x;
  float dEta = (R.r - L.r) + db;
  if (abs(dEta) < 4.0e-7 * max(max(L.r, R.r), 1.0)) dEta = 0.0;
  if (!wetL && R.r + db <= 0.0) return 0.0;
  if (!wetR && L.r - db <= 0.0) return 0.0;
  float hb = max(0.5 * (L.r + R.r), uDry);
  // along the axis: the discharge in the middle of the texel on either side
  float q0 = v0 * (v0 > 0.0 ? L.r : R.r);
  float Qp = 0.5 * (q0 + flux(t + e, ax)), Qm = 0.5 * (q0 + flux(t - e, ax));
  float adv = min(Qp, 0.0) * (comp(st(t + e), ax) - v0) + max(Qm, 0.0) * (v0 - comp(L, ax));
  // across it: the discharge at the two corners of the face
  int ox = 1 - ax;
  if (textureSize(uH, 0).y > 1) {
    float Qt = 0.5 * (flux(t + f, ox) + flux(t - e + f, ox)), Qb = 0.5 * (flux(t, ox) + flux(t - e, ox));
    adv += min(Qt, 0.0) * (comp(st(t + f), ax) - v0) + max(Qb, 0.0) * (v0 - comp(st(t - f), ax));
  }
  float v = v0 - uDt / uDx * (adv / hb + uG * dEta);
  if (!wetL) v = min(v, 0.0);
  if (!wetR) v = max(v, 0.0);
  float hf = max(v > 0.0 ? L.r : R.r, uDry);
  v /= 1.0 + uDt * uFric * abs(v) / hf;
  return clamp(v, -uUmax, uUmax);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH, t, 0);
  o = vec4(s.r, faceVel(t, 0), textureSize(uH, 0).y > 1 ? faceVel(t, 1) : 0.0, s.a);
}`;

  // Depths: h -= dt / dx * (what leaves through the faces - what comes in).
  //
  // A second texture, uX, goes with the depths: water that belongs to the texel and is not in its
  // depth yet (negative: that the texel owes). volume() counts it.
  //   r  what another solver has moved into or out of the texel ("fold" in
  //      src/shaders/hfcouple.js). The pass takes it in, an equal share in each of the sub-steps
  //      that are left, so that the velocities never see it as a step in the surface. A texel
  //      cannot give more than it holds: what it still owes stays here.
  //   g  what the sums in single precision have lost. In a river that is nearly steady the
  //      change of a depth in a sub-step is less than the last bit of the depth: rounded away it
  //      would leave the depths as they are for ever, with a little more water coming in at one
  //      end than leaves at the other (4e-5 of a channel in half a minute, measured). Kept, it
  //      goes into the depth as soon as it amounts to something, and no water is lost at all.
  S.depth = `${HEAD}${FETCH}
uniform float uDt;
uniform float uDx;
uniform float uUmax;
uniform sampler2D uX;
uniform float uLeft;      // sub-steps left, this one included
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oX;
${LOST}
// what goes through the low face of texel t along ax, per unit of its width (cells^2 / s)
float flux(ivec2 t, int ax) {
  ivec2 n = textureSize(uH, 0);
  if (t[ax] <= 0 || t[ax] >= n[ax]) return 0.0;
  ivec2 e = ax == 0 ? ivec2(1, 0) : ivec2(0, 1);
  vec4 R = texelFetch(uH, t, 0), L = texelFetch(uH, t - e, 0);
  if (R.a > 0.5 || L.a > 0.5) return 0.0;      // the 3D solver moves the water through this face
  // (the limit of this sub-step: the velocity may be that of a longer one, or one handed over)
  float v = clamp(ax == 0 ? R.g : R.b, -uUmax, uUmax);
  return v * (v > 0.0 ? L.r : R.r);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH, t, 0);
  vec2 x = texelFetch(uX, t, 0).rg;
  o = s;
  oX = vec4(x, 0.0, 0.0);
  if (s.a > 0.5) return;
  float d = flux(t + ivec2(1, 0), 0) - flux(t, 0);
  if (textureSize(uH, 0).y > 1) d += flux(t + ivec2(0, 1), 1) - flux(t, 1);
  float dh = -uDt / uDx * d;
  float h = s.r + dh;
  x.g += lost(s.r, dh, h);
  // (the limit on the velocities keeps a texel from giving more than it has, up to rounding)
  if (h < 0.0) { x.g += h; h = 0.0; }
  // the share of what was handed over
  float share = x.r / uLeft, rest = x.r - share;
  x.g += lost(x.r, -share, rest);
  float h2 = h + share;
  x.g += lost(h, share, h2);
  if (h2 < 0.0) { float r2 = rest + h2; x.g += lost(rest, h2, r2); rest = r2; h2 = 0.0; }
  // and what rounding has left over so far
  float h3 = h2 + x.g;
  x.g = lost(h2, x.g, h3);
  if (h3 < 0.0) { x.g += h3; h3 = 0.0; }
  o.r = h3;
  oX = vec4(rest, x.g, 0.0, 0.0);
}`;

  // Sources and sinks, once per step: boxes of texels in which the depth changes at a given rate,
  // or is drawn towards a level (an end of the map that stands for water beyond it).
  //   uSrcBox  x0, z0, x1, z1 in texels (x1 and z1 exclusive)
  //   uSrcVal  rate (cells of depth per second), level, share of the way to that level per step (0: the rate applies), unused
  // oD.r is what the texel gained (cells of depth), for the books.
  S.source = `${HEAD}${FETCH}
uniform int uSrcN;
uniform vec4 uSrcBox[8];
uniform vec4 uSrcVal[8];
uniform float uDt;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oD;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH, t, 0);
  o = s;
  oD = vec4(0.0);
  vec2 b = texelFetch(uBed, t, 0).rg;
  if (s.a > 0.5 || b.y > 0.5) return;
  float h = s.r;
  for (int i = 0; i < 8; i++) {
    if (i >= uSrcN) break;
    vec4 B = uSrcBox[i];
    if (float(t.x) < B.x || float(t.y) < B.y || float(t.x) >= B.z || float(t.y) >= B.w) continue;
    vec4 V = uSrcVal[i];
    if (V.z > 0.0) h += (max(V.y - b.x, 0.0) - h) * V.z;
    else h += V.x * uDt;
    h = max(h, 0.0);
  }
  o.r = h;
  oD = vec4(max(h - s.r, 0.0), max(s.r - h, 0.0), 0.0, 0.0);
}`;

  // Links: water that goes from one place of the map to another by a way the map does not show
  // (a sinkhole and the spring it feeds). Each link joins two boxes of texels, A and B. What flows
  // follows from the difference of their levels: through a pipe (uLinkP.y = 0) c sqrt(dH), by
  // seepage (1) c dH; uLinkP.z is the highest point of the way, below which nothing flows.
  // "linkStat" looks at the boxes, one texel per link (o0: box A, o1: box B): r = the depths added
  // up, g = the number of texels (those that are the height field's to move: not walls, not the
  // 3D solver's), b = the level (the mean over the wet texels; dry: the lowest bed), a = 1 if wet.
  // "link" then moves the water: every texel of the higher box gives the same share of its
  // depth, every texel of the other gets the same amount. Nothing is created: both come from the
  // same numbers. oD.b is what a texel gained, oD.a what it lost.
  const LINK = `
uniform int uLinkN;
uniform vec4 uLinkA[4];      // x0, z0, x1, z1 in texels (x1 and z1 exclusive)
uniform vec4 uLinkB[4];
uniform vec4 uLinkP[4];      // c, law, highest point of the way, unused
bool inBox(ivec2 t, vec4 B) { return float(t.x) >= B.x && float(t.y) >= B.y && float(t.x) < B.z && float(t.y) < B.w; }
`;
  S.linkStat = `${HEAD}${FETCH}${LINK}
uniform float uDry;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
vec4 look(vec4 B) {
  float sum = 0.0, n = 0.0, lv = 0.0, wet = 0.0, low = 1.0e30;
  ivec2 size = textureSize(uH, 0);
  for (int j = max(int(B.y), 0); j < min(int(B.w), size.y); j++) {
    for (int i = max(int(B.x), 0); i < min(int(B.z), size.x); i++) {
      ivec2 t = ivec2(i, j);
      vec2 b = texelFetch(uBed, t, 0).rg;
      vec4 s = texelFetch(uH, t, 0);
      if (b.y > 0.5 || s.a > 0.5) continue;
      n += 1.0;
      sum += s.r;
      low = min(low, b.x);
      if (s.r > uDry) { wet += 1.0; lv += b.x + s.r; }
    }
  }
  return vec4(sum, n, wet > 0.0 ? lv / wet : low, wet > 0.0 ? 1.0 : 0.0);
}
void main() {
  int i = int(gl_FragCoord.x);
  o0 = vec4(0.0);
  o1 = vec4(0.0);
  if (i >= uLinkN) return;
  o0 = look(uLinkA[i]);
  o1 = look(uLinkB[i]);
}`;

  S.link = `${HEAD}${FETCH}${LINK}
uniform sampler2D uStatA;
uniform sampler2D uStatB;
uniform float uDt;
uniform float uArea;      // of a texel
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oD;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uH, t, 0);
  o = s;
  oD = vec4(0.0);
  vec2 b = texelFetch(uBed, t, 0).rg;
  if (s.a > 0.5 || b.y > 0.5) return;
  float h = s.r;
  for (int i = 0; i < 4; i++) {
    if (i >= uLinkN) break;
    bool inA = inBox(t, uLinkA[i]), inB = inBox(t, uLinkB[i]);
    if (!inA && !inB) continue;
    vec4 A = texelFetch(uStatA, ivec2(i, 0), 0), B = texelFetch(uStatB, ivec2(i, 0), 0);
    bool fromA = A.b > B.b;
    vec4 D = fromA ? A : B, R = fromA ? B : A;       // the one that gives, the one that receives
    if (D.a < 0.5 || D.r <= 0.0 || R.g < 0.5) continue;
    float head = max(D.b - max(R.b, uLinkP[i].z), 0.0);
    float q = uLinkP[i].x * (uLinkP[i].y < 0.5 ? sqrt(head) : head);
    // (never more than a quarter of what is there in one step)
    float amount = min(q * uDt, 0.25 * D.r * uArea);
    if (inA == fromA) h -= h * amount / (D.r * uArea);
    else h += amount / (R.g * uArea);
  }
  o.r = h;
  oD = vec4(0.0, 0.0, max(h - s.r, 0.0), max(s.r - h, 0.0));
}`;

  // Reductions, 8 x 8 texels to one. "sum" adds up all four channels; "peak" takes the largest
  // values. The first peak pass (uFirst) reads the state: r = the fastest a wave travels in the
  // texel (|velocity| + sqrt(g h)), g = the largest depth, b = the fastest water.
  S.sum = `${HEAD}
uniform sampler2D uSrc;
out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  ivec2 n = textureSize(uSrc, 0);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      ivec2 t = base + ivec2(i, j);
      if (t.x < n.x && t.y < n.y) sum += texelFetch(uSrc, t, 0);
    }
  }
  o = sum;
}`;

  S.peak = `${HEAD}
uniform sampler2D uSrc;
uniform int uFirst;
uniform float uG;
uniform float uDry;
out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  ivec2 n = textureSize(uSrc, 0);
  vec4 m = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      ivec2 t = base + ivec2(i, j);
      if (t.x >= n.x || t.y >= n.y) continue;
      vec4 s = texelFetch(uSrc, t, 0);
      if (uFirst == 1) {
        float v = s.r > uDry ? max(abs(s.g), abs(s.b)) : 0.0;
        s = vec4(s.r > uDry ? v + sqrt(uG * s.r) : 0.0, s.r, v, 0.0);
      }
      m = max(m, s);
    }
  }
  o = m;
}`;

  return S;
}
