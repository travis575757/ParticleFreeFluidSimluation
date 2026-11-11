// 2D renderer: density post-processing (Sec. 3.8) and the final shading pass.
import { header, prims, MAX_PRIMS } from './shaders/common.js';
import { packPrims } from './sim.js';

export const VIEWS2D = [
  ['liquid', 'Liquid (0.5 iso-contour)'],
  ['density', 'Density field ρ (volumetric)'],
  ['diagnostic', "Diagnostic ρ′ (mist / liquid / over-full)"],
  ['gamma', 'Row sums γ of the advection operator'],
  ['pressure', 'Pressure'],
  ['speed', 'Speed'],
];

export class Renderer2D {
  constructor(glc) {
    this.glc = glc;
    const H = header(2, glc.floatLinear);

    // Sec. 3.8: gamma = 2 min(rho, 0.5)
    this.pInit = glc.program('ppInit', `${H}
uniform sampler2D uLiq;
out vec4 o;
void main() {
  float rp = 0.5 - texelFetch(uLiq, ivec2(gl_FragCoord.xy), 0).r;
  o = vec4(2.0 * min(rp, 0.5), rp, 0.0, 0.0);
}`);

    // separable Gaussian blur of gamma (sigma in cells); g channel carries rho' through
    this.pBlur = glc.program('ppBlur', `${H}
uniform Grid G;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform float uSigma;
out vec4 o;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  float sum = 0.0, wsum = 0.0;
  for (int i = -6; i <= 6; i++) {
    float w = exp(-0.5 * float(i * i) / (uSigma * uSigma));
    sum += w * texelFetch(uSrc, clamp(t + uDir * i, ivec2(0), G.n.xy - 1), 0).r;
    wsum += w;
  }
  o = vec4(sum / wsum, texelFetch(uSrc, t, 0).g, 0.0, 0.0);
}`);

    // rho'' = rho / min(max(gamma, theta), 1); r = rho'' (or rho' when disabled), g = blurred gamma
    this.pFinal = glc.program('ppFinal', `${H}
uniform sampler2D uSrc;
uniform float uTheta;
uniform int uEnable;
out vec4 o;
void main() {
  vec2 s = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).rg;
  float r = uEnable == 1 ? s.g / min(max(s.r, uTheta), 1.0) : s.g;
  o = vec4(r, s.r, 0.0, 0.0);
}`);

    this.pShade = glc.program('shade2d', `${H}
uniform Grid G;
uniform sampler2D uPP;      // r = density used for the surface, g = blurred gamma (soft depth cue)
uniform sampler2D uRho;
uniform sampler2D uLiq;
uniform sampler2D uVel;
uniform sampler2D uP;
uniform vec2 uRes;
uniform int uView;
uniform float uPScale;
uniform float uVScale;
uniform float uTime;
uniform vec4 uCursor;       // xy = grid position, z = radius (cells), w = intensity
uniform float uKind[${MAX_PRIMS}];
${prims('S')}
out vec4 o;

// cubic B-spline filtering with four bilinear taps
vec4 smoothTex(sampler2D s, vec2 x) {
  vec2 st = x - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 w0 = (1.0 - f) * (1.0 - f) * (1.0 - f) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f * f + 3.0 * f * f * f) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f * f - 3.0 * f * f * f) / 6.0;
  vec2 w3 = f * f * f / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) + 0.5;
  vec2 h1 = (i + 1.5 + w3 / g1) + 0.5;
  vec2 lo = vec2(0.5), hi = vec2(G.n.xy) - 0.5;
  vec4 a = textureLod(s, clamp(vec2(h0.x, h0.y), lo, hi) * G.inv, 0.0);
  vec4 b = textureLod(s, clamp(vec2(h1.x, h0.y), lo, hi) * G.inv, 0.0);
  vec4 c = textureLod(s, clamp(vec2(h0.x, h1.y), lo, hi) * G.inv, 0.0);
  vec4 d = textureLod(s, clamp(vec2(h1.x, h1.y), lo, hi) * G.inv, 0.0);
  return mix(mix(a, b, g1.x), mix(c, d, g1.x), g1.y);
}
vec3 diagRamp(float r) {
  if (r <= 0.0005) return vec3(0.0);
  if (r < 0.5) return mix(vec3(0.10, 0.0, 0.16), vec3(0.85, 0.15, 0.75), r / 0.5);
  if (r <= 1.0) return mix(vec3(0.0, 0.15, 0.75), vec3(0.85, 0.97, 1.0), (r - 0.5) / 0.5);
  if (r <= 1.03) return vec3(0.85, 0.97, 1.0);
  return mix(vec3(1.0, 0.95, 0.2), vec3(1.0, 0.1, 0.0), clamp(r - 1.0, 0.0, 1.0));
}
vec3 heat(float t) {
  t = clamp(t, 0.0, 1.0);
  return clamp(vec3(1.6 * t - 0.2, 1.4 * sin(3.14159 * t) * 0.9, 1.1 - 1.9 * t), 0.0, 1.0) * (0.25 + 0.75 * sqrt(t)) + vec3(0.02, 0.03, 0.06);
}
void main() {
  vec2 x = gl_FragCoord.xy / uRes * vec2(G.n.xy);
  float px = uRes.y / float(G.n.y);            // screen pixels per cell
  ivec3 c = ivec3(ivec2(floor(x)), 0);
  vec2 uv = gl_FragCoord.xy / uRes;

  // backdrop
  vec3 col = mix(vec3(0.030, 0.043, 0.075), vec3(0.070, 0.098, 0.155), uv.y);
  vec2 gridc = abs(fract(x / 8.0) - 0.5) * 8.0 * px;
  col += vec3(0.03, 0.04, 0.06) * (1.0 - smoothstep(0.0, 1.2, min(gridc.x, gridc.y)));

  vec2 pp = smoothTex(uPP, x).rg;
  float rho = pp.r;
  float fw = max(fwidth(rho), 1.0e-4);
  float a = smoothstep(0.5 - 0.7 * fw, 0.5 + 0.7 * fw, rho);

  if (uView == 0) {
    // sub-grid spray: density below the iso-value shows as a soft glow
    float mist = clamp(rho / 0.5, 0.0, 1.0);
    col += vec3(0.20, 0.50, 0.85) * pow(mist, 1.4) * 0.55 * (1.0 - a);
    // liquid body: lighter near the surface, deeper blue inside, brighter where it moves fast
    float depth = smoothstep(0.55, 1.0, pp.g);
    vec3 liq = mix(vec3(0.20, 0.66, 0.98), vec3(0.035, 0.26, 0.70), depth);
    float sp = length(sampleFast(uVel, G, vec3(x, 0.5)).xy) * uVScale;
    liq += vec3(0.30, 0.34, 0.30) * smoothstep(0.25, 1.4, sp) * (1.0 - 0.6 * depth);
    liq *= 0.90 + 0.10 * uv.y;
    col = mix(col, liq, a);
    float edge = 1.0 - smoothstep(0.0, 1.6 * fw, abs(rho - 0.5));
    col = mix(col, vec3(0.80, 0.95, 1.0), edge * 0.75 * step(0.02, rho));
  } else if (uView == 1) {
    float r = smoothTex(uRho, x).r;
    col = mix(col, vec3(0.10, 0.45, 0.95), clamp(r, 0.0, 1.0));
    col += vec3(0.75, 0.80, 0.55) * clamp(r - 1.0, 0.0, 1.0);
  } else if (uView == 2) {
    col = diagRamp(0.5 - fetchC(uLiq, G, c).r);
  } else if (uView == 3) {
    float g = fetchC(uRho, G, c).g;
    col = vec3(0.16) + (g > 1.0 ? vec3(1.0, 0.45, 0.1) * (g - 1.0) : vec3(0.1, 0.5, 1.0) * (1.0 - g) * 2.0);
    col = mix(col, col * 1.6, a * 0.5);
  } else if (uView == 4) {
    col = mix(col, heat(fetchC(uP, G, c).r * uPScale), a);
  } else {
    float sp = length(sampleFast(uVel, G, vec3(x, 0.5)).xy) * uVScale;
    col = mix(col, heat(sp * 0.5), a);
  }

  // solids, drawn analytically so their edges stay crisp at any zoom
  vec2 s = sdS(vec3(x, 0.5));
  float sa = clamp(0.5 - s.x * px, 0.0, 1.0);
  if (sa > 0.0) {
    float kind = uKind[int(s.y)];
    vec3 base = kind < 0.5 ? vec3(0.150, 0.170, 0.215)
      : kind < 1.5 ? vec3(0.42, 0.47, 0.55)
      : kind < 2.5 ? vec3(0.96, 0.62, 0.22)
      : kind < 3.5 ? vec3(0.93, 0.36, 0.38)
      : kind < 4.5 ? vec3(0.45, 0.80, 0.52)
      : vec3(0.72, 0.58, 0.95);
    float inner = smoothstep(0.0, 2.5, -s.x);
    vec3 sc = base * (kind < 0.5 ? 1.0 - 0.25 * inner : 1.0 - 0.22 * inner);
    sc += (kind < 0.5 ? vec3(0.10, 0.12, 0.16) : vec3(0.22)) * (1.0 - smoothstep(0.0, 1.5 / px + 0.35, -s.x));
    col = mix(col, sc, sa);
  }

  // brush cursor
  if (uCursor.w > 0.0) {
    float d = abs(length(x - uCursor.xy) - uCursor.z) * px;
    col += vec3(0.9, 0.95, 1.0) * (1.0 - smoothstep(0.6, 1.8, d)) * uCursor.w;
  }
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

  /**
   * @param runner  Runner
   * @param o       { view, postProcess, sigma, theta, cursor:[x,y,r,intensity] }
   */
  render(runner, o) {
    const glc = this.glc;
    const sim = runner.sim;
    const G = sim.grid;
    this._ensure(G);
    const [A, B] = this.T.tex;
    glc.draw(this.pInit, A, { uLiq: sim.liq });
    glc.draw(this.pBlur, B, { G, uSrc: A, uDir: [1, 0], uSigma: o.sigma ?? 2 });
    glc.draw(this.pBlur, A, { G, uSrc: B, uDir: [0, 1], uSigma: o.sigma ?? 2 });
    glc.draw(this.pFinal, B, { uSrc: A, uTheta: o.theta ?? 0.01, uEnable: o.postProcess ? 1 : 0 });
    const kinds = new Float32Array(MAX_PRIMS);
    kinds.set(runner.solidKinds());
    const p = sim.params;
    const canvas = glc.canvas;
    glc.draw(this.pShade, null, {
      G, uPP: B, uRho: sim.rho, uLiq: sim.liq, uVel: sim.vel, uP: sim.pressure,
      uRes: [canvas.width, canvas.height],
      uView: Math.max(0, VIEWS2D.findIndex((v) => v[0] === o.view)),
      // hydrostatic pressure of a full tank maps to ~1
      uPScale: 1 / (Math.abs(p.gravity[1]) / p.h * p.dt * G.n[1] * 0.6 + 1e-6),
      uVScale: p.h / 4.0,
      uTime: runner.time,
      uCursor: o.cursor || [0, 0, 0, 0],
      uKind: kinds,
      ...packPrims(sim.solids, 'S', 2),
    });
  }
}
