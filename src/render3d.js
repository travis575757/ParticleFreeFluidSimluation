// 3D renderer: ray-marches the density atlas. The liquid surface is the 0.5 iso-surface of the
// (optionally post-processed, Sec. 3.8) density; solids are sphere-traced analytically.
import { header, prims, MAX_PRIMS } from './shaders/common.js';
import { packPrims } from './sim.js';

export const VIEWS3D = [
  ['liquid', 'Liquid surface (0.5 iso-surface)'],
  ['volume', 'Density volume (Fig. 1 right)'],
  ['mist', 'Surface + sub-0.5 density as mist'],
];

export class Camera {
  constructor() { this.yaw = 0.6; this.pitch = 0.32; this.dist = 3; this.target = [0, 0, 0]; this.fov = 0.42; }
  basis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch), cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const fwd = [-sy * cp, -sp, -cy * cp];
    const right = [cy, 0, -sy];
    const up = [-sy * sp, cp, -cy * sp];   // right x fwd ... orthonormal, y-up
    const pos = [this.target[0] - fwd[0] * this.dist, this.target[1] - fwd[1] * this.dist, this.target[2] - fwd[2] * this.dist];
    return { pos, right, up, fwd };
  }
  /** World-space ray through a point given in normalised device coordinates (-1..1, y up). */
  ray(ndcX, ndcY, aspect) {
    const { pos, right, up, fwd } = this.basis();
    const x = ndcX * aspect * this.fov, y = ndcY * this.fov;
    const d = [fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y];
    const l = Math.hypot(d[0], d[1], d[2]);
    return { origin: pos, dir: [d[0] / l, d[1] / l, d[2] / l] };
  }
}

export class Renderer3D {
  constructor(glc) {
    this.glc = glc;
    const H = header(3, glc.floatLinear);

    // Sec. 3.8 post-process: gamma = 2 min(rho, 0.5), Gaussian blur, rho'' = rho / min(max(gamma, theta), 1)
    this.pInit = glc.program('pp3Init', `${H}
uniform sampler2D uLiq;
out vec4 o;
void main() {
  float rp = 0.5 - texelFetch(uLiq, ivec2(gl_FragCoord.xy), 0).r;
  o = vec4(2.0 * min(rp, 0.5), rp, 0.0, 0.0);
}`);
    this.pBlur = glc.program('pp3Blur', `${H}
uniform Grid G;
uniform sampler2D uSrc;
uniform ivec3 uDir;
uniform float uSigma;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  ivec3 c = cellOf(G, t);
  float sum = 0.0, wsum = 0.0;
  for (int i = -5; i <= 5; i++) {
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    sum += w * fetchC(uSrc, G, c + uDir * i).r;
    wsum += w;
  }
  o = vec4(sum / wsum, texelFetch(uSrc, t, 0).g, 0.0, 0.0);
}`);
    this.pFinal = glc.program('pp3Final', `${H}
uniform sampler2D uSrc;
uniform float uTheta;
out vec4 o;
void main() {
  vec2 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rg;
  o = vec4(s.g / min(max(s.r, uTheta), 1.0), s.g, 0.0, 0.0);
}`);

    const COMMON = `${H}
uniform Grid G;
uniform sampler2D uVol;       // r = density that defines the surface, g = raw rho'
uniform vec3 uLo;             // interior of the tank (cells)
uniform vec3 uHi;
uniform vec4 uSphere;         // spherical container: xyz centre, w radius (0 = box container)
float dens(vec3 p) { return sampleFast(uVol, G, p).r; }
vec2 boxHit(vec3 ro, vec3 rd, vec3 lo, vec3 hi) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (lo - ro) * inv, t1 = (hi - ro) * inv;
  vec3 a = min(t0, t1), b = max(t0, t1);
  return vec2(max(max(a.x, a.y), a.z), min(min(b.x, b.y), b.z));
}
// parametric interval of the ray inside the tank interior
vec2 tankHit(vec3 ro, vec3 rd) {
  vec2 t = boxHit(ro, rd, uLo, uHi);
  if (uSphere.w > 0.0) {
    vec3 oc = ro - uSphere.xyz;
    float b = dot(oc, rd);
    float h = b * b - dot(oc, oc) + uSphere.w * uSphere.w;
    if (h < 0.0) return vec2(1.0, -1.0);
    h = sqrt(h);
    t = vec2(max(t.x, -b - h), min(t.y, -b + h));
  }
  return t;
}
// first crossing of the 0.5 iso-surface from outside; returns t or -1
float surfaceHit(vec3 ro, vec3 rd, float stepLen, float jitter) {
  vec2 tb = tankHit(ro, rd);
  if (tb.x >= tb.y) return -1.0;
  float t = max(tb.x, 0.0) + 0.01;
  float prev = dens(ro + rd * t);
  if (prev > 0.5) return t;
  t += jitter * stepLen;
  for (int i = 0; i < 700; i++) {
    t += stepLen;
    if (t >= tb.y) break;
    float d = dens(ro + rd * t);
    if (d > 0.5) return t - stepLen * (d - 0.5) / max(d - prev, 1.0e-5);
    prev = d;
  }
  return -1.0;
}`;

    // 1x1 picking pass: distance along the pointer ray to the liquid surface
    this.pPick = glc.program('pick3d', `${COMMON}
uniform vec3 uRo;
uniform vec3 uRd;
out vec4 o;
void main() { o = vec4(surfaceHit(uRo, uRd, 0.7, 0.0), 0.0, 0.0, 1.0); }`);
    this.pickTex = glc.texture(1, 1, 'rgba32f');
    this.pickBusy = false;

    this.pShade = glc.program('shade3d', `${COMMON}
uniform vec2 uRes;
uniform vec3 uCamPos;
uniform mat3 uCamRot;         // columns: right, up, forward
uniform float uFov;
uniform int uView;
uniform float uStep;
uniform vec3 uLight;
uniform float uScale;         // cells per reference cell (keeps the look resolution independent)
uniform vec4 uCursor;         // xyz position, w radius (0 = hidden)
uniform float uKind[${MAX_PRIMS}];
${prims('S')}
out vec4 o;

const float IOR = 1.33;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 grad(vec3 p) {
  const float e = 1.0;
  return vec3(dens(p + vec3(e, 0.0, 0.0)) - dens(p - vec3(e, 0.0, 0.0)),
              dens(p + vec3(0.0, e, 0.0)) - dens(p - vec3(0.0, e, 0.0)),
              dens(p + vec3(0.0, 0.0, e)) - dens(p - vec3(0.0, 0.0, e)));
}
vec3 sky(vec3 d) {
  float t = clamp(d.y, -1.0, 1.0);
  vec3 c = t > 0.0 ? mix(vec3(0.60, 0.69, 0.80), vec3(0.10, 0.22, 0.46), pow(t, 0.5))
                   : mix(vec3(0.60, 0.69, 0.80), vec3(0.10, 0.11, 0.13), pow(-t, 0.3));
  float s = max(dot(d, uLight), 0.0);
  return c + vec3(1.0, 0.93, 0.80) * (pow(s, 900.0) * 6.0 + pow(s, 24.0) * 0.18);
}
// union of the non-container solids
float traceSolid(vec3 ro, vec3 rd, float tmax, out float kind) {
  kind = 0.0;
  if (uSN == 0) return -1.0;
  float t = 0.0;
  for (int i = 0; i < 80; i++) {
    vec2 s = sdS(ro + rd * t);
    if (s.x < 0.02) { kind = uKind[int(s.y)]; return t; }
    t += max(s.x, 0.02);
    if (t > tmax) break;
  }
  return -1.0;
}
vec3 solidNormal(vec3 p) {
  const float e = 0.05;
  return normalize(vec3(sdS(p + vec3(e, 0.0, 0.0)).x - sdS(p - vec3(e, 0.0, 0.0)).x,
                        sdS(p + vec3(0.0, e, 0.0)).x - sdS(p - vec3(0.0, e, 0.0)).x,
                        sdS(p + vec3(0.0, 0.0, e)).x - sdS(p - vec3(0.0, 0.0, e)).x));
}
// how much liquid lies between p and the light (soft shadow / caustic cue)
float liquidShade(vec3 p) {
  float acc = 0.0;
  float st = 2.5 * uScale;
  for (int i = 1; i <= 10; i++) acc += clamp(dens(p + uLight * (float(i) * st)), 0.0, 1.0);
  return acc * st;
}
float solidShadow(vec3 p) {
  if (uSN == 0) return 1.0;
  float res = 1.0;
  float t = 0.5;
  for (int i = 0; i < 20; i++) {
    float d = sdS(p + uLight * t).x;
    res = min(res, 6.0 * d / t);
    if (res < 0.02) break;
    t += clamp(d, 0.6, 6.0);
  }
  return clamp(res, 0.0, 1.0);
}
vec3 solidColor(float kind) {
  return kind < 1.5 ? vec3(0.50, 0.54, 0.60)
    : kind < 2.5 ? vec3(0.95, 0.60, 0.20)
    : kind < 3.5 ? vec3(0.90, 0.33, 0.35)
    : kind < 4.5 ? vec3(0.42, 0.78, 0.50)
    : vec3(0.68, 0.55, 0.93);
}
// everything behind the liquid: tank floor, ground, sky
vec3 background(vec3 ro, vec3 rd) {
  float floorY = uLo.y;
  if (rd.y < -1.0e-4) {
    float t = (floorY - ro.y) / rd.y;
    if (t > 0.0) {
      vec3 p = ro + rd * t;
      vec2 q = p.xz;
      bool inTank = uSphere.w > 0.0 ? false : all(greaterThan(q, uLo.xz)) && all(lessThan(q, uHi.xz));
      vec3 c;
      if (inTank) {
        vec2 g = abs(fract(q / (8.0 * uScale)) - 0.5);
        float line = 1.0 - smoothstep(0.0, 0.04, min(g.x, g.y));
        c = mix(vec3(0.66, 0.68, 0.70), vec3(0.50, 0.53, 0.57), line);
      } else {
        float chk = step(0.5, fract(q.x / (32.0 * uScale))) + step(0.5, fract(q.y / (32.0 * uScale)));
        c = mix(vec3(0.150, 0.160, 0.180), vec3(0.185, 0.195, 0.215), mod(chk, 2.0));
      }
      float sh = exp(-0.05 * liquidShade(p + vec3(0.0, 0.3, 0.0)) / uScale) * (0.35 + 0.65 * solidShadow(p + vec3(0.0, 0.3, 0.0)));
      c *= 0.45 + 0.55 * sh;
      float fog = 1.0 - exp(-t / (1400.0 * uScale));
      return mix(c, sky(vec3(rd.x, 0.02, rd.z)), fog);
    }
  }
  return sky(rd);
}
// soft lines along the edges of the glass tank
float tankEdges(vec3 p) {
  if (uSphere.w > 0.0) return 0.0;
  vec3 d = min(abs(p - uLo), abs(p - uHi));
  float w = 0.45 * uScale;
  vec3 n = step(d, vec3(w));
  float m = n.x * n.y + n.y * n.z + n.x * n.z;
  return clamp(m, 0.0, 1.0);
}
vec3 volumeColor(float d) {
  // density -> colour, low densities warm, liquid blue (cf. the volume rendering of Fig. 1 / 12)
  vec3 a = vec3(1.0, 0.25, 0.55), b = vec3(0.95, 0.80, 0.15), c = vec3(0.15, 0.85, 0.45), e = vec3(0.05, 0.30, 0.95), f = vec3(1.0, 0.35, 0.1);
  if (d < 0.2) return mix(a, b, d / 0.2);
  if (d < 0.5) return mix(b, c, (d - 0.2) / 0.3);
  if (d < 1.03) return mix(c, e, clamp((d - 0.5) / 0.4, 0.0, 1.0));
  return mix(e, f, clamp((d - 1.03) * 3.0, 0.0, 1.0));
}

void main() {
  vec2 ndc = (gl_FragCoord.xy / uRes) * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 rd = normalize(uCamRot * vec3(ndc.x * uFov * uRes.x / uRes.y, ndc.y * uFov, 1.0));
  float jitter = hash(gl_FragCoord.xy);
  vec3 col = vec3(0.0);
  vec3 trans = vec3(1.0);
  float mist = 0.0;
  float thick = 0.0;
  vec3 absorb = vec3(0.075, 0.020, 0.010) / uScale;

  // glass: edges where the primary ray enters and leaves the tank
  vec2 tk = tankHit(ro, rd);
  float edge = 0.0;
  float rim = 0.0;
  if (tk.x < tk.y && tk.y > 0.0) {
    edge = max(tankEdges(ro + rd * max(tk.x, 0.0)), 0.6 * tankEdges(ro + rd * tk.y));
    if (uSphere.w > 0.0) {
      vec3 n = normalize(ro + rd * max(tk.x, 0.0) - uSphere.xyz);
      rim = pow(1.0 - abs(dot(n, rd)), 3.0);
    }
  }

  float kind;
  float tS = traceSolid(ro, rd, 4000.0 * uScale, kind);
  bool done = false;

  if (tk.x < tk.y && tk.y > 0.0) {
    float t = max(tk.x, 0.0) + 0.01;
    float tEnd = tS > 0.0 ? min(tk.y, tS) : tk.y;
    float prev = dens(ro + rd * t);
    bool inside = prev > 0.5;
    bool refracted = false;
    t += jitter * uStep;
    for (int i = 0; i < 900; i++) {
      float tn = min(t + uStep, tEnd);
      float d = dens(ro + rd * tn);
      float seg = tn - t;
      if (uView == 1) {
        // emission-absorption volume rendering of the density field
        float a = 1.0 - exp(-clamp(d, 0.0, 1.5) * seg * 0.075 / uScale);
        col += trans * a * volumeColor(d) * 0.9;
        trans *= 1.0 - a;
      } else if ((d > 0.5) != inside) {
        // locate the crossing inside this segment
        float th = t + seg * clamp((0.5 - prev) / (d - prev), 0.0, 1.0);
        vec3 ph = ro + rd * th;
        vec3 n = -grad(ph);
        float nl = length(n);
        n = nl > 1.0e-5 ? n / nl : -rd;
        if (!inside) {
          if (dot(n, rd) > 0.0) n = -n;
          float c = clamp(dot(-rd, n), 0.0, 1.0);
          float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
          col += trans * F * sky(reflect(rd, n));
          trans *= 1.0 - F;
          trans *= exp(-absorb * (tn - th));
          thick += tn - th;
          if (!refracted) {
            vec3 rr = refract(rd, n, 1.0 / IOR);
            if (dot(rr, rr) > 0.0) {
              ro = ph; rd = normalize(rr); refracted = true;
              vec2 t2 = tankHit(ro, rd);
              float k2;
              tS = traceSolid(ro, rd, 4000.0 * uScale, k2);
              kind = k2;
              tEnd = tS > 0.0 ? min(t2.y, tS) : t2.y;
              tn = 0.02;
              d = dens(ro + rd * tn);
            }
          }
          inside = true;
        } else {
          trans *= exp(-absorb * (th - t));
          thick += th - t;
          // faint internal reflection when the ray leaves the liquid
          if (dot(n, rd) < 0.0) n = -n;
          float c = clamp(dot(rd, n), 0.0, 1.0);
          float F = 0.02 + 0.98 * pow(1.0 - c, 5.0);
          trans *= 1.0 - 0.6 * F;
          inside = false;
        }
      } else if (inside) {
        trans *= exp(-absorb * seg);
        thick += seg;
      } else {
        mist += max(d, 0.0) * seg;
      }
      prev = d;
      t = tn;
      if (t >= tEnd - 1.0e-4 || max(trans.r, max(trans.g, trans.b)) < 0.01) break;
    }
  }

  // what the (possibly refracted) ray finally lands on
  vec3 behind;
  if (tS > 0.0) {
    vec3 p = ro + rd * tS;
    vec3 n = solidNormal(p);
    float dif = max(dot(n, uLight), 0.0);
    float sh = exp(-0.05 * liquidShade(p + n * 0.5) / uScale);
    vec3 base = solidColor(kind);
    behind = base * (0.30 + 0.25 * (n.y * 0.5 + 0.5) + 0.75 * dif * sh);
    vec3 hv = normalize(uLight - rd);
    behind += vec3(0.35) * pow(max(dot(n, hv), 0.0), 60.0) * sh;
  } else {
    behind = background(ro, rd);
  }
  // light scattered inside the liquid gives it body where the background alone would wash it out
  float body = uView == 1 ? 0.0 : 1.0 - exp(-thick * 0.035 / uScale);
  col += trans * mix(behind, vec3(0.03, 0.30, 0.52), body * 0.75);

  if (uView != 1) {
    float m = 1.0 - exp(-mist * (uView == 2 ? 0.5 : 0.03) / uScale);
    col = mix(col, vec3(0.86, 0.93, 0.98), m * 0.85);
  }
  col = mix(col, vec3(0.86, 0.92, 0.98), edge * 0.35);
  col += vec3(0.5, 0.6, 0.7) * rim * 0.25;

  // tone map + gamma
  col = col / (1.0 + 0.35 * col);
  col = pow(col * 1.25, vec3(1.0 / 2.2));
  o = vec4(col, 1.0);
}`);
    this.T = null;
  }

  _ensure(grid) {
    if (this.T && this.T.w === grid.w && this.T.h === grid.h) return;
    if (this.T) this.T.tex.forEach((t) => this.glc.deleteTexture(t));
    const mk = () => this.glc.texture(grid.w, grid.h, 'rg32f', { linear: true });
    this.T = { w: grid.w, h: grid.h, tex: [mk(), mk()] };
  }

  _volumeUniforms(runner, vol) {
    const sim = runner.sim;
    const G = sim.grid;
    const m = runner.scene.margin;
    const c = runner.container;
    return {
      G, uVol: vol,
      uLo: [m, m, m], uHi: [G.n[0] - m, G.n[1] - m, G.n[2] - m],
      uSphere: c.type === 'ball' ? [c.center[0], c.center[1], c.center[2], c.radius] : [0, 0, 0, 0],
    };
  }

  /** Density texture the surface is extracted from: raw rho' or the Sec. 3.8 post-processed rho''. */
  _volume(runner, postProcess) {
    const glc = this.glc;
    const sim = runner.sim;
    const G = sim.grid;
    this._ensure(G);
    const [A, B] = this.T.tex;
    glc.draw(this.pInit, A, { uLiq: sim.liq });
    glc.draw(this.pBlur, B, { G, uSrc: A, uDir: [1, 0, 0], uSigma: 2 });
    glc.draw(this.pBlur, A, { G, uSrc: B, uDir: [0, 1, 0], uSigma: 2 });
    glc.draw(this.pBlur, B, { G, uSrc: A, uDir: [0, 0, 1], uSigma: 2 });
    glc.draw(this.pFinal, A, { uSrc: B, uTheta: 0.01 });
    return A;
  }

  render(runner, camera, o = {}) {
    const glc = this.glc;
    const sim = runner.sim;
    const G = sim.grid;
    let vol;
    if (o.postProcess) vol = this._volume(runner, true);
    else {
      // no post-process: rho' itself (pFinal with theta = 1 divides by 1)
      this._ensure(G);
      const [A, B] = this.T.tex;
      glc.draw(this.pInit, A, { uLiq: sim.liq });
      glc.draw(this.pFinal, B, { uSrc: A, uTheta: 1.0 });
      vol = B;
    }
    this.vol = vol;
    const { pos, right, up, fwd } = camera.basis();
    const canvas = glc.canvas;
    const kinds = new Float32Array(MAX_PRIMS);
    kinds.set(runner.solidKinds().slice(1));
    const l = [0.45, 0.80, 0.35];
    const ll = Math.hypot(...l);
    glc.draw(this.pShade, null, {
      ...this._volumeUniforms(runner, vol),
      uRes: [canvas.width, canvas.height],
      uCamPos: pos,
      uCamRot: [right[0], right[1], right[2], up[0], up[1], up[2], fwd[0], fwd[1], fwd[2]],
      uFov: camera.fov,
      uView: Math.max(0, VIEWS3D.findIndex((v) => v[0] === o.view)),
      uStep: o.step ?? 0.6,
      uLight: [l[0] / ll, l[1] / ll, l[2] / ll],
      uScale: G.n[1] / 64,
      uCursor: o.cursor || [0, 0, 0, 0],
      uKind: kinds,
      ...packPrims(sim.solids.slice(1), 'S', 3),
    });
  }

  /** Distance along a ray to the liquid surface (asynchronous 1-pixel readback); -1 if none. */
  async pick(runner, origin, dir) {
    if (this.pickBusy || !this.vol) return null;
    this.pickBusy = true;
    try {
      this.glc.draw(this.pPick, this.pickTex, { ...this._volumeUniforms(runner, this.vol), uRo: origin, uRd: dir });
      const px = await this.glc.readAsync(this.pickTex);
      return px[0];
    } finally {
      this.pickBusy = false;
    }
  }
}
