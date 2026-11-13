// A view of a 2D world: liquid, solids and the water at rest that is not stored, straight from
// the solver's pools (no copy: a pixel looks up its cells through the page table as a pass of
// the solver does).
import { header, prims, TERRAIN, FAR as FAR_FIELD, MAX_PRIMS, MAX_WATER } from '../shaders/common.js';

export class WorldRenderer2D {
  constructor(glc) {
    this.glc = glc;
    const H = header(2, false, 'sparse');
    this.prog = glc.program('world2d', `${H}
uniform Grid G;
${TERRAIN}
${FAR_FIELD}
${prims('S', true)}
uniform sampler2D uLiq;
uniform sampler2D uVel;
uniform vec2 uRes;
uniform vec4 uView;       // xy: where the lower left corner of the canvas is (cells, as the primitives are measured), z: cells per pixel
uniform float uKind[${MAX_PRIMS}];   // per primitive: 0 obstacle, 1 scripted body, 2..5 rigid bodies, 6 rock, 7 hull
uniform vec4 uCursor;     // xy = position, z = radius (cells), w = intensity
uniform int uBricks;      // 1: outline the bricks that are stored
uniform float uVScale;
out vec4 o;

// The texel of cell c in the pools, (-1, -1) if its brick is not stored; g_state: 1 solved,
// 2 held. (Through the page table: a pixel has no brick of its own for the solver's shortcuts
// to start from.)
float g_state = 0.0;
ivec2 texelAt(ivec3 c) {
  ivec3 b = ivec3(c.x >> LB, c.y >> LB, 0);
  g_state = 0.0;
  int s = pageLookup(G, b);
  if (s < 0) return ivec2(-1);
  vec4 sl = texelFetch(uSl0, ivec2(s % G.tiles.x, s / G.tiles.x), 0);
  if (!(sl.w > 0.5 && ivec3(sl.xyz) == b)) return ivec2(-1);
  g_state = sl.w;
  return ivec2((s % G.tiles.x) * BS + (c.x & (BS - 1)), (s / G.tiles.x) * BS + (c.y & (BS - 1)));
}
// rho' of cell c: as the solver has it, or of the water at rest where nothing is stored
float fillOf(ivec3 c) {
  ivec2 t = texelAt(c);
  if (t.x >= 0) return 0.5 - texelFetch(uLiq, t, 0).r;
  return FAR_ON ? farFill(c, 1.0) : 0.0;
}
vec2 velOf(ivec3 c) { ivec2 t = texelAt(c); return t.x >= 0 ? texelFetch(uVel, t, 0).xy : vec2(0.0); }
// the level of the water at rest over x, -1e30 where there is none
float restLevel(vec2 x) {
  for (int i = 0; i < ${MAX_WATER}; i++) {
    if (i >= uWaterN) break;
    if (x.x >= uWaterBox[i].x && x.x <= uWaterBox[i].z) return uWaterLvl[i].x;
  }
  return -1.0e30;
}

void main() {
  float cpp = uView.z;                        // cells per pixel
  float px = 1.0 / cpp;
  vec2 x = uView.xy + gl_FragCoord.xy * cpp;  // in the frame of the primitives
  vec2 uv = gl_FragCoord.xy / uRes;

  // backdrop
  vec3 col = mix(vec3(0.030, 0.043, 0.075), vec3(0.070, 0.098, 0.155), uv.y);
  vec2 gridc = abs(fract(x / 16.0) - 0.5) * 16.0 * px;
  col += vec3(0.02, 0.03, 0.045) * (1.0 - smoothstep(0.0, 1.2, min(gridc.x, gridc.y)));

  // the liquid: rho' between the centres of the four cells around
  vec2 q = x - 0.5;
  ivec3 c0 = ivec3(ivec2(floor(q)), 0) + uAnchor;
  vec2 f = q - floor(q);
  float r00 = fillOf(c0), r10 = fillOf(c0 + ivec3(1, 0, 0)), r01 = fillOf(c0 + ivec3(0, 1, 0)), r11 = fillOf(c0 + ivec3(1, 1, 0));
  float rho = mix(mix(r00, r10, f.x), mix(r01, r11, f.x), f.y);
  float fw = max(fwidth(rho), 1.0e-4);
  float a = smoothstep(0.5 - 0.7 * fw, 0.5 + 0.7 * fw, rho);
  float mist = clamp(rho / 0.5, 0.0, 1.0);
  col += vec3(0.20, 0.50, 0.85) * pow(mist, 1.4) * 0.55 * (1.0 - a);
  // deeper blue under more water: below the level of the water at rest where there is such
  // water, else by rows four cells apart above this one (the first and the last weighted so
  // that the sum has no steps)
  ivec3 cc = ivec3(ivec2(floor(x)), 0) + uAnchor;
  float depth = 0.0, lvl = restLevel(x);
  if (lvl > -1.0e29) depth = clamp((lvl - x.y) / 24.0, 0.0, 1.0);
  else {
    float y4 = (x.y - 0.5) / 4.0, f4 = y4 - floor(y4);
    ivec3 cb = ivec3(int(floor(x.x)), 4 * int(floor(y4)), 0) + uAnchor;
    for (int k = 1; k <= 7; k++)
      depth += clamp(fillOf(cb + ivec3(0, 4 * k, 0)), 0.0, 1.0) * (k == 1 ? 1.0 - f4 : k == 7 ? f4 : 1.0) / 6.0;
  }
  vec3 liq = mix(vec3(0.20, 0.66, 0.98), vec3(0.035, 0.26, 0.70), depth);
  vec2 v = mix(mix(velOf(c0), velOf(c0 + ivec3(1, 0, 0)), f.x), mix(velOf(c0 + ivec3(0, 1, 0)), velOf(c0 + ivec3(1, 1, 0)), f.x), f.y);
  liq += vec3(0.30, 0.34, 0.30) * smoothstep(0.25, 1.4, length(v) * uVScale) * (1.0 - 0.6 * depth);
  col = mix(col, liq, a);
  float edge = 1.0 - smoothstep(0.0, 1.6 * fw, abs(rho - 0.5));
  col = mix(col, vec3(0.80, 0.95, 1.0), edge * 0.75 * step(0.02, rho));

  // solids, drawn from their shapes so that their edges stay crisp at any zoom
  vec2 s = sdS(vec3(x, 0.5));
  float sa = clamp(0.5 - s.x * px, 0.0, 1.0);
  if (sa > 0.0) {
    float kind = uKind[int(s.y)];
    vec3 base = kind < 0.5 ? vec3(0.150, 0.170, 0.215)
      : kind < 1.5 ? vec3(0.42, 0.47, 0.55)
      : kind < 2.5 ? vec3(0.96, 0.62, 0.22)
      : kind < 3.5 ? vec3(0.93, 0.36, 0.38)
      : kind < 4.5 ? vec3(0.45, 0.80, 0.52)
      : kind < 5.5 ? vec3(0.72, 0.58, 0.95)
      : kind < 6.5 ? vec3(0.17, 0.155, 0.14)
      : vec3(0.56, 0.60, 0.66);
    float inner = smoothstep(0.0, 2.5, -s.x);
    vec3 sc = base * (1.0 - 0.24 * inner);
    sc += (kind < 0.5 ? vec3(0.10, 0.12, 0.16) : vec3(0.22)) * (1.0 - smoothstep(0.0, 1.5 / px + 0.35, -s.x));
    col = mix(col, sc, sa);
  }
  float g = sdTerrain(vec3(x, 0.5));
  col = mix(col, vec3(0.19, 0.17, 0.15) * (1.0 - 0.3 * smoothstep(0.0, 6.0, -g)), clamp(0.5 - g * px, 0.0, 1.0));

  if (uBricks == 1) {
    texelAt(cc);
    float st = g_state;
    vec2 e = abs(fract(x / float(BS)) - 0.5) * float(BS) * px;
    float line = 1.0 - smoothstep(0.0, 1.2, float(BS) * px * 0.5 - max(e.x, e.y));
    vec3 lc = st > 1.5 ? vec3(0.91, 0.64, 0.24) : vec3(0.35, 0.78, 0.95);
    if (st > 0.5) col = mix(col, lc, 0.45 * line + 0.04);
  }

  if (uCursor.w > 0.0) {
    float d = abs(length(x - uCursor.xy) - uCursor.z) * px;
    col += vec3(0.9, 0.95, 1.0) * (1.0 - smoothstep(0.6, 1.8, d)) * uCursor.w;
  }
  o = vec4(col, 1.0);
}`);
  }

  /**
   * @param world  World (2D)
   * @param view   { center: [x, y], width } in cells: what the canvas shows
   * @param o      { bricks, cursor: [x, y, radius, intensity] }
   */
  render(world, view, o = {}) {
    const glc = this.glc, sim = world.sim, canvas = glc.canvas;
    sim._syncBricks();
    const L0 = sim.levels[0];
    const cpp = view.width / canvas.width;
    const kinds = new Float32Array(MAX_PRIMS);
    kinds.set(world.solidKinds());
    glc.draw(this.prog, null, {
      ...sim._U(L0), ...sim._solidUniforms(), ...sim._prims(world.solidPrims(), 'S'),
      uLiq: sim.liq, uVel: sim.vel,
      uRes: [canvas.width, canvas.height],
      uView: [view.center[0] - 0.5 * view.width, view.center[1] - 0.5 * cpp * canvas.height, cpp, 0],
      uKind: kinds,
      uCursor: o.cursor || [0, 0, 0, 0],
      uBricks: o.bricks ? 1 : 0,
      uVScale: sim.params.h / 4.0,
    });
  }
}
