// World renderer: ray-marches the liquid stored in bricks. Empty space is skipped on three
// levels: a group of 16 bricks per side without any brick (one fetch of the page table's top
// level), a brick that is not stored, and the part of a stored brick that holds no liquid (the
// per-brick statistics the solver keeps anyway). The ground is traced as a height field,
// obstacles are sphere-traced analytically.
//
// The density is first copied into a pool of its own in which every brick carries a border of
// one cell from its neighbours: inside a brick the GPU's own filtering then gives a continuous
// trilinear density from two fetches.
import { header, prims, TERRAIN, BRICK } from '../shaders/common.js';
import { packPrims } from '../sim.js';

export { Camera } from '../render3d.js';

const B = BRICK[3];
const AP = B + 2;          // a brick with its border, per axis
const AT = AP * AP;        // width of its tile: AP slices side by side

export class WorldRenderer {
  constructor(glc) {
    this.glc = glc;
    const H = header(3, false, 'sparse');
    this.perRow = Math.min(80, Math.floor(glc.maxTextureSize / AT));
    this.vol = null;
    this.volRows = 0;

    // density of every stored brick with a border of one cell, tile by tile
    this.pApron = glc.program('worldApron', `${H}
uniform Grid G;
uniform sampler2D uLiq;
uniform int uVolRow;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec2 tile = ivec2(t.x / ${AT}, t.y / ${AP});
  int slot = tile.x + tile.y * uVolRow;
  o = vec4(0.0);
  if (tile.x >= uVolRow || slot >= G.tiles.x * G.tiles.y) return;
  enterSlot(G, slot);
  if (!g_live) return;
  int lx = t.x - tile.x * ${AT};
  ivec3 l = ivec3(lx % ${AP}, t.y - tile.y * ${AP}, lx / ${AP}) - 1;
  o = vec4(max(0.5 - fetchC(uLiq, G, g_frame + l).r, 0.0), 0.0, 0.0, 0.0);
}`);

    const COMMON = `${H}
uniform Grid G;
uniform sampler2D uVol;       // density with borders (pass worldApron)
uniform vec2 uVolInv;
uniform int uVolRow;
uniform sampler2D uS1;        // per slot: lowest wet cell, number of wet cells
uniform sampler2D uS2;        // per slot: highest wet cell
uniform float uStep;
uniform float uTerMax;        // highest point of the ground
${TERRAIN}
${prims('S')}
const float FAR = 20000.0;

// slot of brick b, -1 if it is not stored (the top level of the page table wraps: the answer
// is checked against the brick the slot belongs to)
int brickSlot(ivec3 b) {
  int s = pageLookup(G, b);
  if (s < 0) return -1;
  vec4 sl = texelFetch(uSl0, ivec2(s % G.tiles.x, s / G.tiles.x), 0);
  return sl.w > 0.5 && ivec3(sl.xyz) == b ? s : -1;
}
// density at l (cells from the corner of the brick in slot s; valid from -0.5 to BS + 0.5)
float densIn(int s, vec3 l) {
  vec2 org = vec2(float((s % uVolRow) * ${AT}), float((s / uVolRow) * ${AP}));
  float u = clamp(l.z + 0.5, 0.0, ${(AP - 1).toFixed(1)});
  float k = min(floor(u), ${(AP - 2).toFixed(1)});
  vec2 xy = clamp(l.xy + 1.0, vec2(0.5), vec2(${(AP - 0.5).toFixed(1)}));
  vec2 uv = (org + vec2(k * ${AP.toFixed(1)}, 0.0) + xy) * uVolInv;
  return mix(texture(uVol, uv).r, texture(uVol, uv + vec2(${AP.toFixed(1)} * uVolInv.x, 0.0)).r, u - k);
}
float densAt(vec3 p) {
  ivec3 b = ivec3(floor(p / float(BS)));
  int s = brickSlot(b);
  return s < 0 ? 0.0 : densIn(s, p - vec3(b * BS));
}
vec2 boxHit(vec3 ro, vec3 inv, vec3 lo, vec3 hi) {
  vec3 t0 = (lo - ro) * inv, t1 = (hi - ro) * inv;
  vec3 a = min(t0, t1), b = max(t0, t1);
  return vec2(max(max(a.x, a.y), a.z), min(min(b.x, b.y), b.z));
}
// First place after t0 where the density crosses 0.5, away from the side the ray starts on
// (inside: in liquid); -1 if there is none before tEnd. Adds up the density met in air (mist)
// and, with uOverlay, lines along the edges of the stored bricks the ray enters.
uniform int uOverlay;
float crossing(vec3 ro, vec3 rd, float t0, float tEnd, bool inside, float jitter, inout float mist, inout vec4 lines) {
  vec3 inv = 1.0 / rd;
  float t = t0;
  float prev = inside ? 1.0 : 0.0;
  for (int i = 0; i < 220; i++) {
    if (t >= tEnd) break;
    vec3 p = ro + rd * (t + 2.0e-3);
    ivec3 b = ivec3(floor(p / float(BS)));
    float size = float(BS);
    int s = -1;
    if (texelFetch(uPg0, topTexel(b, G.top, G.topTile), 0).r < 0.0) size = float(BS << LS);
    else s = brickSlot(b);
    vec3 lo = floor(p / size) * size;
    float tOut = max(boxHit(ro, inv, lo, lo + size).y, t + 2.0e-3);
    float tA = t, tB = tOut;
    if (s >= 0) {
      ivec2 st = ivec2(s % G.tiles.x, s / G.tiles.x);
      vec4 w1 = texelFetch(uS1, st, 0);
      if (uOverlay == 1 && lines.a < 0.9) {
        vec3 q = abs(fract((ro + rd * t) / size + 0.5) - 0.5) * size;      // distance to the brick's faces
        float w = 0.05 + 0.0012 * t;
        float e = float(q.x < w) + float(q.y < w) + float(q.z < w);
        if (e > 1.5) {
          vec3 c = w1.w > 0.5 ? vec3(0.25, 0.85, 1.0) : vec3(0.75, 0.75, 0.8);
          float a = (w1.w > 0.5 ? 0.40 : 0.16) * (1.0 - lines.a);
          lines += vec4(c * a, a);
        }
      }
      if (w1.w < 0.5) s = -1;
      else {
        vec2 tw = boxHit(ro, inv, lo + w1.xyz - 1.5, lo + texelFetch(uS2, st, 0).xyz + 2.5);
        tA = max(t, tw.x); tB = min(tOut, tw.y);
        if (tA >= tB) s = -1;
      }
    }
    if (s < 0) {
      if (inside) return t;       // liquid ends where the wet cells do
      prev = 0.0;
      t = tOut;
      continue;
    }
    if (inside && tA > t + 1.0e-3) return t;
    if (tA > t) prev = 0.0;
    float tt = tA + (i == 0 ? jitter * uStep : 0.0);
    float tStop = min(tB, tEnd);
    for (int k = 0; k < 48; k++) {
      float tn = min(tt + uStep, tStop);
      float d = densIn(s, ro + rd * tn - lo);
      if ((d > 0.5) != inside) return tt + (tn - tt) * clamp((0.5 - prev) / (d - prev), 0.0, 1.0);
      if (!inside) mist += d * (tn - tt);
      prev = d;
      tt = tn;
      if (tt >= tStop - 1.0e-4) break;
    }
    if (tB < tOut) { if (inside) return tB; prev = 0.0; }
    t = tOut;
  }
  return -1.0;
}
// the ground: distance along the ray, -1 if it is not hit before tmax
float traceTerrain(vec3 ro, vec3 rd, float tmax) {
  if (uTerMap.w < 0.5) return -1.0;
  float t = 0.0;
  if (ro.y > uTerMax + 1.0) {
    if (rd.y >= -1.0e-5) return -1.0;
    t = (uTerMax + 1.0 - ro.y) / rd.y;
  }
  float ta = t, d = sdTerrain(ro + rd * t);
  if (d < 0.0) return t;
  for (int i = 0; i < 140; i++) {
    t += clamp(d * 0.8, 0.2, 40.0) + t * 0.004;
    if (t > tmax) return -1.0;
    vec3 p = ro + rd * t;
    if (rd.y > 0.0 && p.y > uTerMax + 1.0) return -1.0;
    d = sdTerrain(p);
    if (d < 0.0) {
      float tb = t;
      for (int k = 0; k < 7; k++) {
        float m = 0.5 * (ta + tb);
        if (sdTerrain(ro + rd * m) < 0.0) tb = m; else ta = m;
      }
      return 0.5 * (ta + tb);
    }
    ta = t;
  }
  return -1.0;
}
float traceSolid(vec3 ro, vec3 rd, float tmax, out float idx) {
  idx = -1.0;
  if (uSN == 0) return -1.0;
  float t = 0.0;
  for (int i = 0; i < 80; i++) {
    vec2 s = sdS(ro + rd * t);
    if (s.x < 0.02) { idx = s.y; return t; }
    t += max(s.x, 0.02);
    if (t > tmax) break;
  }
  return -1.0;
}
// nearest thing that is not liquid: x = distance (-1: none), y = -1 for the ground, else the primitive
vec2 traceOpaque(vec3 ro, vec3 rd) {
  float idx;
  float tS = traceSolid(ro, rd, FAR, idx);
  float tT = traceTerrain(ro, rd, tS > 0.0 ? tS : FAR);
  if (tT >= 0.0) return vec2(tT, -1.0);
  return vec2(tS, idx);
}`;

    // 1x1 picking pass: distances along the pointer ray to the liquid surface and to the ground / an obstacle
    this.pPick = glc.program('worldPick', `${COMMON}
uniform vec3 uRo;
uniform vec3 uRd;
out vec4 o;
void main() {
  vec3 rd = uRd + vec3(equal(uRd, vec3(0.0))) * 1.0e-6;
  vec2 op = traceOpaque(uRo, rd);
  float mist = 0.0;
  vec4 lines = vec4(0.0);
  o = vec4(crossing(uRo, rd, 0.0, op.x > 0.0 ? op.x : FAR, false, 0.0, mist, lines), op.x, 0.0, 1.0);
}`);
    this.pickTex = glc.texture(1, 1, 'rgba32f');
    this.pickBusy = false;

    this.pShade = glc.program('worldShade', `${COMMON}
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform mat3 uCamRot;         // columns: right, up, forward
uniform float uFov;
uniform vec3 uLight;
uniform float uMist;
uniform vec4 uCursor;         // xyz position, w radius (0 = hidden)
out vec4 o;

const float IOR = 1.33;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 sky(vec3 d) {
  float t = clamp(d.y, -1.0, 1.0);
  vec3 c = t > 0.0 ? mix(vec3(0.66, 0.74, 0.84), vec3(0.16, 0.32, 0.62), pow(t, 0.5))
                   : mix(vec3(0.66, 0.74, 0.84), vec3(0.30, 0.32, 0.34), pow(-t, 0.3));
  float s = max(dot(d, uLight), 0.0);
  return c + vec3(1.0, 0.93, 0.80) * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.18);
}
vec3 liquidNormal(vec3 p) {
  ivec3 b = ivec3(floor(p / float(BS)));
  int s = brickSlot(b);
  if (s < 0) return vec3(0.0, 1.0, 0.0);
  vec3 l = p - vec3(b * BS);
  const float e = 0.5;
  vec3 g = vec3(densIn(s, l + vec3(e, 0.0, 0.0)) - densIn(s, l - vec3(e, 0.0, 0.0)),
                densIn(s, l + vec3(0.0, e, 0.0)) - densIn(s, l - vec3(0.0, e, 0.0)),
                densIn(s, l + vec3(0.0, 0.0, e)) - densIn(s, l - vec3(0.0, 0.0, e)));
  float n = length(g);
  return n > 1.0e-5 ? -g / n : vec3(0.0, 1.0, 0.0);
}
// how much of the sun reaches p past the ground (obstacles and liquid cast no shadow)
float groundShadow(vec3 p) {
  if (uTerMap.w < 0.5) return 1.0;
  float res = 1.0;
  float t = 1.5;
  for (int i = 0; i < 24; i++) {
    vec3 q = p + uLight * t;
    if (q.y > uTerMax) break;
    float d = sdTerrain(q);
    res = min(res, 5.0 * d / t);
    if (res < 0.02) break;
    t += clamp(d, 1.0, 24.0);
  }
  return clamp(res, 0.0, 1.0);
}
// colour of the ground or of an obstacle at p
vec3 shadeOpaque(vec3 p, float idx, float t) {
  vec3 n, base;
  if (idx < 0.0) {
    vec3 h = terrainAt(p);
    n = normalize(vec3(-h.y, 1.0, -h.z));
    float steep = 1.0 - n.y;
    float patchy = fract(sin(dot(floor(p.xz / 24.0), vec2(12.9898, 78.233))) * 43758.5453);
    vec3 soil = mix(vec3(0.21, 0.17, 0.10), vec3(0.10, 0.19, 0.06), 0.35 + 0.4 * patchy);
    // rock where it is steep, in layers
    float layer = fract(sin(floor(p.y / 5.0 + 0.6 * sin(p.x * 0.05) + 0.6 * sin(p.z * 0.07)) * 12.9898) * 43758.5453);
    base = mix(soil, vec3(0.17, 0.155, 0.14) * (0.8 + 0.4 * layer), smoothstep(0.10, 0.40, steep));
    // contour lines every 8 cells of height, a faint grid every 8 cells (one brick)
    float c = abs(fract(p.y / 8.0 + 0.5) - 0.5) * 8.0;
    base *= 1.0 - 0.16 * (1.0 - smoothstep(0.0, 0.25 + 0.0015 * t, c)) * smoothstep(0.03, 0.2, steep);
    vec2 g = abs(fract(p.xz / 8.0 + 0.5) - 0.5) * 8.0;
    base *= 1.0 - 0.10 * (1.0 - smoothstep(0.0, 0.12 + 0.0015 * t, min(g.x, g.y))) * (1.0 - smoothstep(0.1, 0.4, steep));
  } else {
    const float e = 0.05;
    n = normalize(vec3(sdS(p + vec3(e, 0.0, 0.0)).x - sdS(p - vec3(e, 0.0, 0.0)).x,
                       sdS(p + vec3(0.0, e, 0.0)).x - sdS(p - vec3(0.0, e, 0.0)).x,
                       sdS(p + vec3(0.0, 0.0, e)).x - sdS(p - vec3(0.0, 0.0, e)).x));
    base = vec3(0.50, 0.44, 0.40);
  }
  float dif = max(dot(n, uLight), 0.0) * groundShadow(p + n * 0.3);
  vec3 c = base * (0.26 + 0.20 * (n.y * 0.5 + 0.5) + 1.0 * dif);
  return mix(c, sky(vec3(0.0, 0.02, 1.0)), 1.0 - exp(-t / 12000.0));
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamRot * vec3(ndc.x * uFov * uRes.x / uRes.y, ndc.y * uFov, 1.0));
  rd += vec3(equal(rd, vec3(0.0))) * 1.0e-6;
  float jitter = hash(gl_FragCoord.xy);
  float mist = 0.0, none = 0.0;
  vec4 lines = vec4(0.0), noLines = vec4(1.0);

  vec2 op = traceOpaque(ro, rd);
  float tEnd = op.x > 0.0 ? op.x : FAR;
  float tw = crossing(ro, rd, 0.0, tEnd, false, jitter, mist, lines);
  vec3 col;
  if (tw >= 0.0) {
    vec3 ph = ro + rd * tw;
    vec3 n = liquidNormal(ph);
    if (dot(n, rd) > 0.0) n = -n;
    float c = clamp(dot(-rd, n), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
    col = F * sky(reflect(rd, n));
    // into the liquid: how far the refracted ray travels in it, and what it lands on
    vec3 rr = refract(rd, n, 1.0 / IOR);
    rr = normalize(rr + vec3(equal(rr, vec3(0.0))) * 1.0e-6);
    vec2 op2 = traceOpaque(ph, rr);
    float tEnd2 = op2.x > 0.0 ? op2.x : 400.0;
    float te = crossing(ph, rr, 0.05, tEnd2, true, 0.0, none, noLines);
    float thick = te >= 0.0 ? te : tEnd2;
    vec3 behind = op2.x > 0.0 ? shadeOpaque(ph + rr * op2.x, op2.y, tw + op2.x) : sky(rr);
    vec3 trans = exp(-vec3(0.075, 0.020, 0.010) * thick);
    float body = 1.0 - exp(-thick * 0.035);
    col += (1.0 - F) * trans * mix(behind, vec3(0.03, 0.30, 0.52), body * 0.75);
  } else if (op.x > 0.0) {
    col = shadeOpaque(ro + rd * op.x, op.y, op.x);
  } else {
    col = sky(rd);
  }
  // spray: density below the surface threshold, met on the way
  float m = 1.0 - exp(-mist * uMist);
  col = mix(col, vec3(0.90, 0.95, 0.99), m * 0.9);
  if (uCursor.w > 0.0) {
    // the brush: a ring where the pointer acts
    vec3 oc = ro - uCursor.xyz;
    float bq = dot(oc, rd), disc = bq * bq - dot(oc, oc) + uCursor.w * uCursor.w;
    if (disc > 0.0 && -bq > 0.0) {
      float rim = 1.0 - sqrt(disc) / uCursor.w;
      col = mix(col, vec3(1.0, 0.85, 0.35), 0.35 * smoothstep(0.75, 1.0, rim) + 0.05);
    }
  }
  col = col * (1.0 - lines.a) + lines.rgb;
  // tone map + gamma
  col = col / (1.0 + 0.35 * col);
  col = pow(col * 1.25, vec3(1.0 / 2.2));
  o = vec4(col, 1.0);
}`);
  }

  _uniforms(world) {
    const sim = world.sim;
    const L0 = sim.levels[0];
    const set = L0.set;
    // the density pool with borders: as many rows of tiles as the slots in use need
    const rows = Math.max(1, Math.ceil(set.high / this.perRow));
    if (!this.vol || rows > this.volRows) {
      if (this.vol) this.glc.deleteTexture(this.vol);
      this.volRows = Math.ceil(rows * 1.5);
      this.vol = this.glc.texture(this.perRow * AT, this.volRows * AP, 'r16f', { linear: true });
    }
    return {
      ...sim._U(L0), ...sim._solidUniforms(),
      uVol: this.vol, uVolInv: [1 / this.vol.w, 1 / this.vol.h], uVolRow: this.perRow,
      uS1: sim.R.s[1], uS2: sim.R.s[2],
      uTerMax: world.terrain ? world.terrain.max : 0,
      ...packPrims(world.solids, 'S', 3),
      _rows: rows,
    };
  }

  /** Bring the density pool and the per-brick statistics up to date with the solver's state. */
  _prepare(world) {
    const sim = world.sim;
    sim._syncBricks();
    if (sim.statsFrame !== sim.frame || sim._statsVersion !== sim.levels[0].set.version) sim.refreshSlotStats();
    const U = this._uniforms(world);
    this.glc.draw(this.pApron, this.vol, { ...U, uLiq: sim.liq }, { viewport: [0, 0, this.vol.w, U._rows * AP] });
    return U;
  }

  render(world, camera, o = {}) {
    const glc = this.glc;
    const U = this._prepare(world);
    this.U = U;
    const { pos, right, up, fwd } = camera.basis();
    const canvas = glc.canvas;
    const l = [0.45, 0.80, 0.35];
    const ll = Math.hypot(...l);
    glc.draw(this.pShade, null, {
      ...U,
      uRes: [canvas.width, canvas.height],
      uCamPos: pos,
      uCamRot: [right[0], right[1], right[2], up[0], up[1], up[2], fwd[0], fwd[1], fwd[2]],
      uFov: camera.fov,
      uStep: o.step ?? 0.6,
      uLight: [l[0] / ll, l[1] / ll, l[2] / ll],
      uMist: o.mist === false ? 0 : 0.22,
      uOverlay: o.overlay ? 1 : 0,
      uCursor: o.cursor || [0, 0, 0, 0],
    });
  }

  /**
   * Distances along a ray to the liquid surface and to the ground or an obstacle (asynchronous
   * 1-pixel readback): { liquid, solid }, each -1 if there is none; null if busy or unavailable.
   */
  async pick(world, origin, dir) {
    if (this.pickBusy || !this.U || this.glc.readback === 'scrambled') return null;
    this.pickBusy = true;
    try {
      this.glc.draw(this.pPick, this.pickTex, { ...this.U, uRo: origin, uRd: dir, uStep: 0.7, uOverlay: 0 });
      const px = await this.glc.readAsync(this.pickTex);
      return { liquid: px[0], solid: px[1] };
    } finally {
      this.pickBusy = false;
    }
  }

  dispose() {
    if (this.vol) this.glc.deleteTexture(this.vol);
    this.glc.deleteTexture(this.pickTex);
  }
}
