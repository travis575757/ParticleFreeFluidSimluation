// Passes of the surface-wave map (src/world/swell.js): small waves on water that is not solved.
//
// The map is a square of N x N texels, CELL cells each, over x and z. Per texel it holds
// h (cells the surface stands above rest) and v = dh/dt (cells per second). On water that is
// deep against the wavelength a wave of wavenumber q swings with omega^2 = g q, and no stencil
// of a few texels does that for waves much longer than the stencil. So the map is stepped in
// Fourier space, where each wave is turned by its own omega * dt exactly: transform, turn,
// transform back, every step.
import { header, FAR, TERRAIN, MAX_WATER } from './common.js';

export const SWELL_REACH = 8;      // most rows above and below the level that are searched for the surface

export function swellShaders(cell) {
  const H = header(3, false, 'sparse');
  const S = {};

  // One stage of a radix-2 FFT along one axis of a complex field (r + i g), decimation in time:
  //   out[i] = in[e] + exp(sign 2 pi i j / size) in[e + size / 2],   j = i mod size, e = i - j + (j mod size / 2)
  // The first stage along an axis reads its input in bit-reversed order (uBits = log2 N).
  S.fft = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSrc;
uniform int uAxis;
uniform int uSize;
uniform int uBits;
uniform float uSign;
out vec4 o;
int rev(int i) {
  int r = 0;
  for (int b = 0; b < 14; b++) {
    if (b >= uBits) break;
    r = (r << 1) | ((i >> b) & 1);
  }
  return r;
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int i = uAxis == 0 ? t.x : t.y;
  int half_ = uSize >> 1;
  int j = i & (uSize - 1);
  int e = i - j + (j & (half_ - 1));
  int d = e + half_;
  if (uBits > 0) { e = rev(e); d = rev(d); }
  ivec2 te = t, td = t;
  if (uAxis == 0) { te.x = e; td.x = d; } else { te.y = e; td.y = d; }
  vec2 a = texelFetch(uSrc, te, 0).rg;
  vec2 b = texelFetch(uSrc, td, 0).rg;
  float ang = uSign * 6.283185307179586 * float(j) / float(uSize);
  vec2 w = vec2(cos(ang), sin(ang));
  o = vec4(a + vec2(w.x * b.x - w.y * b.y, w.x * b.y + w.y * b.x), 0.0, 0.0);
}`;

  // One time step in Fourier space. The field is z = h + i v, both real, so the transforms of
  // h and v are (z(q) + conj z(-q)) / 2 and (z(q) - conj z(-q)) / 2i. Each wave turns by omega dt:
  //   h' = h cos + v sin / omega,   v' = v cos - h omega sin,   omega^2 = g q tanh(q depth)
  // Short waves lose a little (uVisc q^2 per second): the solver's own short waves die fast too.
  // Also divides by N^2 for the inverse transform that follows.
  S.propagate = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uF;
uniform float uG;        // gravity, cells / s^2
uniform float uDt;
uniform float uCell;     // cells per texel
uniform float uDepth;    // cells
uniform float uVisc;     // cells^2 / s
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 n = textureSize(uF, 0);
  ivec2 m = (n - t) % n;
  vec2 a = texelFetch(uF, t, 0).rg;
  vec2 b = texelFetch(uF, m, 0).rg;
  b.y = -b.y;
  vec2 hh = 0.5 * (a + b);
  vec2 d = 0.5 * (a - b);
  vec2 vv = vec2(d.y, -d.x);
  vec2 k = vec2(t) - vec2(greaterThanEqual(t, n / 2)) * vec2(n);
  float q = length(6.283185307179586 * k / (vec2(n) * uCell));
  float w = sqrt(uG * q * tanh(min(q * uDepth, 20.0)));
  float c = cos(w * uDt), s = sin(w * uDt);
  vec2 h1 = hh * c + vv * (w > 1.0e-6 ? s / w : uDt);
  vec2 v1 = vv * c - hh * (w * s);
  // (the level as a whole stays where it is: what falls into a sea spreads over all of it, not
  // over this window, which would keep it for good)
  if (t == ivec2(0)) { h1 = vec2(0.0); v1 = vec2(0.0); }
  float keep = exp(-uVisc * q * q * uDt) / float(n.x * n.y);
  o = vec4(vec2(h1.x - v1.y, h1.y + v1.x) * keep, 0.0, 0.0);
}`;

  // After the step: where the water under a texel is solved, the map takes the surface of that
  // water instead of its own, and the speed at which that surface rises (the liquid's vertical
  // velocity there). Without the speed the map keeps one of its own under the solved water, the
  // one its waves would have, which has nothing to do with what the water does: a brick that
  // went to sleep let go of its surface with a kick. "Solved" is the brick that holds the top
  // liquid row of the water at rest. The weight falls from 1 to 0 over the last brick before
  // water that is not solved: there the solver damps its waves (spongeKeep) and the map carries
  // them on.
  //   oE: r = surface of the solved water above rest (cells), g = weight, b = 1 where there is water
  // The window is periodic to the transform; a band along its edge takes the waves out.
  S.slave = `${H}
uniform Grid G;
${FAR}
${TERRAIN}
uniform sampler2D uZ;
uniform sampler2D uLiq;
uniform sampler2D uVel;
uniform ivec2 uOrigin;     // world cell (x, z) of the corner of texel (0, 0)
uniform int uReach;        // rows above and below the level in which the surface is looked for
uniform float uBand;       // texels
uniform float uLoss;       // share lost per step at the very edge
layout(location = 0) out vec4 oZ;
layout(location = 1) out vec4 oE;
const int CELL = ${cell};
// slot of brick b, -1 if it is not stored
int storedSlot(ivec3 b, out float state) {
  state = 0.0;
  int s = pageLookup(G, b);
  if (s < 0) return -1;
  vec4 sl = texelFetch(uSl0, ivec2(s % G.tiles.x, s / G.tiles.x), 0);
  if (sl.w < 0.5 || ivec3(sl.xyz) != b) return -1;
  state = sl.w;
  return s;
}
bool solved(ivec3 b) {
  float st;
  return storedSlot(b, st) >= 0 && st < 1.5;
}
// World height at which the liquid of column (x, z) ends, going up from uReach rows below row
// top (where the renderer has the surface: the density, interpolated between cell centres,
// crosses 0.5), and the vertical velocity of the liquid there (vy). ok = 0 where the liquid ends
// at a solid: under a floating body that is its underside, not a surface. (Taken for one, the map
// held a dent as deep as the body's draught for as long as the water around it was solved, and
// let go of it as a ring of waves when that water went back to rest. Left to itself there, it
// kept what the splash had left under the body, which cannot get out through the solved water
// around it, and let go of that.)
float columnSurface(ivec2 xz, int top, out float vy, out float ok) {
  int j0 = top - uReach;
  float prev = 1.0, Vprev = 1.0;
  int by = -1000000, s = -1;
  vy = 0.0;
  ok = 1.0;
  for (int k = 0; k < ${2 * SWELL_REACH + 2}; k++) {
    if (k > 2 * uReach + 1) break;
    int j = j0 + k;
    ivec3 c = ivec3(xz.x, j, xz.y);
    int sb = s;                   // slot of the brick of the row below
    if ((j >> LB) != by) { by = j >> LB; float st; s = storedSlot(c >> LB, st); }
    vec2 lq = s >= 0 ? texelFetch(uLiq, slotTexel(G.tiles, s, c & BM), 0).rg : vec2(0.5 - farState(c).x, 1.0);
    float rp = max(0.5 - lq.r, 0.0), V = lq.g;      // V: the share of the cell that is not solid
    if (rp < 0.5) {
      if (V < 0.5 || Vprev < 0.5) ok = 0.0;
      if (k == 0) return float(j);
      // (the top liquid cell is the one below: the mean of its two faces)
      float va = sb >= 0 ? texelFetch(uVel, slotTexel(G.tiles, sb, (c - AX[1]) & BM), 0).y : 0.0;
      float vb = s >= 0 ? texelFetch(uVel, slotTexel(G.tiles, s, c & BM), 0).y : 0.0;
      vy = 0.5 * (va + vb);
      return float(j) - 0.5 + (prev - 0.5) / (prev - rp);
    }
    prev = rp;
    Vprev = V;
  }
  return float(j0 + 2 * uReach + 2);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 n = textureSize(uZ, 0);
  vec2 z = texelFetch(uZ, t, 0).rg;
  ivec2 c0 = uOrigin + t * CELL;
  vec2 xc = vec2(c0) + 0.5 * float(CELL);
  oZ = vec4(0.0);
  oE = vec4(0.0);
  // the body of water this texel lies in
  vec3 r = vec3(xc.x - float(uAnchor.x), 0.0, xc.y - float(uAnchor.z));
  vec4 L = vec4(0.0);
  bool found = false;
  for (int i = 0; i < ${MAX_WATER}; i++) {
    if (i >= uWaterN) break;
    vec4 b = uWaterBox[i];
    if (r.x < b.x || r.x > b.z || r.z < b.y || r.z > b.w) continue;
    L = uWaterLvl[i];
    found = true;
    break;
  }
  if (!found) return;
  // (land, and water too shallow to speak of)
  if (uTerMap.w > 0.5 && terrainAt(r).x > L.x - 1.0) return;
  int top = int(L.y) + uAnchor.y;
  float fa = min(L.x - L.y, 1.0), fb = max(L.x - L.y - 1.0, 0.0);
  float rest = float(top) + 0.5 + (fa - 0.5) / (fa - fb);
  ivec3 bs = ivec3(c0.x >> LB, top >> LB, c0.y >> LB);
  float w = 0.0, eta = 0.0, rise = 0.0;
  if (solved(bs)) {
    vec2 f = xc - vec2(bs.xz * BS);
    float d = float(BS);
    for (int k = -1; k <= 1; k++) {
      for (int i = -1; i <= 1; i++) {
        if ((i == 0 && k == 0) || solved(bs + ivec3(i, 0, k))) continue;
        d = min(d, length(vec2(i < 0 ? f.x : i > 0 ? float(BS) - f.x : 0.0, k < 0 ? f.y : k > 0 ? float(BS) - f.y : 0.0)));
      }
    }
    w = smoothstep(0.0, 1.0, d / float(BS));
    // (a column without a surface, under a body, counts as water at rest)
    for (int k = 0; k < CELL; k++) {
      for (int i = 0; i < CELL; i++) {
        float vy, ok;
        float y = columnSurface(c0 + ivec2(i, k), top, vy, ok);
        eta += ok * (y - rest);
        rise += ok * vy;
      }
    }
    eta /= float(CELL * CELL);
    rise /= float(CELL * CELL);
  }
  float de = float(min(min(t.x, n.x - 1 - t.x), min(t.y, n.y - 1 - t.y)));
  float e = max(1.0 - de / uBand, 0.0);
  float keep = 1.0 - uLoss * e * e;
  oZ = vec4(mix(z.x, eta, w) * keep, mix(z.y, rise, w) * keep, 0.0, 0.0);
  oE = vec4(eta, w, 1.0, 0.0);
}`;

  // What the renderer reads, filtered linearly: r = h, g = how far the map's surface stands above
  // that of the solved water under it (where there is such water; beside it, what its neighbours
  // say, so that the filter has something to blend with), b and a = slope of h in x and z.
  S.show = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uZ;
uniform sampler2D uE;
uniform float uInvCell;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 n = textureSize(uZ, 0);
  float h = texelFetch(uZ, t, 0).r;
  vec4 e = texelFetch(uE, t, 0);
  float lift = 0.0;
  if (e.g > 0.0) lift = h - e.r;
  else {
    float s = 0.0, ws = 0.0;
    for (int k = -1; k <= 1; k++) {
      for (int i = -1; i <= 1; i++) {
        ivec2 q = clamp(t + ivec2(i, k), ivec2(0), n - 1);
        vec4 en = texelFetch(uE, q, 0);
        if (en.g > 0.0) { s += texelFetch(uZ, q, 0).r - en.r; ws += 1.0; }
      }
    }
    if (ws > 0.0) lift = s / ws;
  }
  float hx = texelFetch(uZ, min(t + ivec2(1, 0), n - 1), 0).r - texelFetch(uZ, max(t - ivec2(1, 0), ivec2(0)), 0).r;
  float hz = texelFetch(uZ, min(t + ivec2(0, 1), n - 1), 0).r - texelFetch(uZ, max(t - ivec2(0, 1), ivec2(0)), 0).r;
  o = vec4(h, lift, 0.5 * uInvCell * hx, 0.5 * uInvCell * hz);
}`;

  // Each texel: the largest |h| and |v| of an 8 x 8 block of uSrc (r, g).
  S.max8 = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 o;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * 8;
  ivec2 n = textureSize(uSrc, 0);
  vec2 m = vec2(0.0);
  for (int j = 0; j < 8; j++) {
    for (int i = 0; i < 8; i++) {
      ivec2 t = base + ivec2(i, j);
      if (t.x < n.x && t.y < n.y) m = max(m, abs(texelFetch(uSrc, t, 0).rg));
    }
  }
  o = vec4(m, 0.0, 0.0);
}`;

  return S;
}
