// Shared GLSL chunks. All simulation shaders are written once for a 3D grid stored as a
// 2D "atlas" of z-slices; the 2D simulator is the nz = 1 special case (DIM == 2 strips the
// z-work at compile time).
//
// Conventions (grid units, one cell = 1):
//   cell (i,j,k) spans [i,i+1]x[j,j+1]x[k,k+1], centre at (i+.5, j+.5, k+.5)
//   velocity texel (i,j,k) stores the staggered components on the cell's LOW faces:
//       u at (i, j+.5, k+.5), v at (i+.5, j, k+.5), w at (i+.5, j+.5, k)

export const MAX_PRIMS = 12;

export function header(dim, floatLinear = true) {
  return `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
#define DIM ${dim}
#define NC ${dim === 2 ? 4 : 8}
${floatLinear ? '' : '#define NO_LINEAR'}
struct Grid { ivec3 n; int tx; vec2 inv; };
const float BIG = 1.0e30;
const ivec3 AX[3] = ivec3[3](ivec3(1, 0, 0), ivec3(0, 1, 0), ivec3(0, 0, 1));

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
ivec3 clampCell(Grid g, ivec3 c) { return clamp(c, ivec3(0), g.n - 1); }
vec4 fetchC(sampler2D s, Grid g, ivec3 c) { return texelFetch(s, texelOf(g, clampCell(g, c)), 0); }
ivec3 cornerOffset(int k) { return ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1); }
float cornerWeight(int k, vec3 a) {
  vec3 w = mix(1.0 - a, a, vec3(cornerOffset(k)));
#if DIM == 2
  return w.x * w.y;
#else
  return w.x * w.y * w.z;
#endif
}
// position of the cell-relative offset; in 2D the z coordinate is pinned to the slab centre
vec3 cellPos(ivec3 c, vec3 off) {
#if DIM == 2
  return vec3(vec2(c.xy) + off.xy, 0.5);
#else
  return vec3(c) + off;
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
`;
}

// Velocity sampling + characteristic tracing. Requires: uniform Grid G; sampler2D uVel, uSdf.
export const TRACE = `
uniform sampler2D uVel;
uniform sampler2D uSdf;
uniform int uTraceSteps;
vec3 clampDomain(vec3 x) {
#if DIM == 2
  return vec3(clamp(x.xy, vec2(0.5), vec2(G.n.xy) - 0.5), 0.5);
#else
  return clamp(x, vec3(0.5), vec3(G.n) - 0.5);
#endif
}
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
