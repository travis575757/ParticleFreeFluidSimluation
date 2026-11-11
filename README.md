# Mass-Conserving Eulerian Liquid Simulation — WebGL2

A browser implementation of

> N. Chentanez, M. Müller. *Mass-Conserving Eulerian Liquid Simulation.*
> ACM SIGGRAPH / Eurographics Symposium on Computer Animation, 2012. (`masscon_sca.pdf`)

in 2D and 3D. The whole solver runs on the GPU as WebGL2 shader passes over float textures
(about 190–215 passes per time step). JavaScript only sequences the passes, integrates the
few rigid bodies and sums a small reduced texture for the on-screen statistics.

## Run

```sh
node tools/serve.mjs          # or: python3 -m http.server 8080
# open http://localhost:8080/   (2d.html, 3d.html)
```

ES modules do not load from `file://`, so the folder has to be served. Requirements: WebGL2
with `EXT_color_buffer_float`, `EXT_float_blend`, `OES_texture_float_linear`.

Tested in Chrome 154, Firefox 159 and LibreWolf 156 (Linux, NVIDIA). Two things differ in the
Firefox family:

* Firefox refuses a draw call with more than 30 million vertices
  (`webgl.max-vert-ids-per-draw`) and only says so in the console. The scatter passes of the
  256×128×128 grid have 33.5 million points, so they are drawn in pieces of 2²⁴
  (`GLContext.scatter`); before that the conservative advection silently did nothing at that
  resolution and the liquid lost mass and blew up within a second. The first step on every
  new grid now also checks `gl.getError()` and stops with a message if a pass was refused.
* With `privacy.resistFingerprinting` on (the default in LibreWolf) every read-back from the
  GPU returns random numbers. The apps test this at start-up and say so: the liquid still
  runs, but the statistics, the liquid's force on rigid bodies and 3D picking are switched
  off. With that setting off LibreWolf still flips the last bits of some values that are read
  back, which is harmless here.

WebGL2 was chosen over WebGPU because WebGPU has no adapter in stock Chrome 154 on
Linux/NVIDIA (it needs three launch flags), while WebGL2 is hardware accelerated out of the box.

## What is implemented

| Paper | Where |
|---|---|
| Sec. 3.1 staggered grid | `src/shaders/common.js` (layout, sampling, characteristic tracing) |
| Sec. 3.3 velocity extrapolation | `extrapInit / extrapPull / extrapPush` in `src/shaders/sim.js` |
| Sec. 3.4 conservative advection (modified scheme, steps 1–8) | `advTrace`, `scatterBeta`, `advGather`, `scatterFwd`, `diffuse` |
| Sec. 3.5 sharpening, Eq. 4–17, Algorithm 2 | `sharpen`, `scatterSharp` |
| Sec. 3.6 solids, Eq. 18–19, excess density | `solid`, `sharpen` |
| Sec. 3.7 incompressibility, Eq. 20, ρ′ > 1 divergence | `liq`, `coef`, `rhs`, `smooth`, `restrict`, `prolong`, `project` |
| Sec. 3.8 density post-processing | `src/render2d.js`, `src/render3d.js` |
| Multigrid with separating solid boundaries [CM11a] | `smooth` (projected red–black Gauss–Seidel), `restrict` (DownsampleSubtract) |

One code path serves both dimensions: the grid is stored as a 2D atlas of z-slices and the 2D
simulator is the `nz = 1` case (`#define DIM` strips the z work).

The scatter steps of the advection and sharpening (the part the paper calls expensive on GPUs)
are drawn as `GL_POINTS`, one point per (cell, stencil corner), with additive blending into
32-bit float targets.

Scenes: dam break, splat, ball into pool / crown splash, double dam, jet, filling a dry tank,
dam break over a step, fast moving obstacle, rotating paddle, round and spherical containers,
shaken container, floating rigid bodies, still pool. Mouse: push, pour, drain, spawn / grab /
throw rigid bodies; orbit and zoom in 3D.

## Measured

Chrome 154, RTX 3090, default settings unless stated.

| Grid | Step time | Paper, Table 2 (GTX 680) |
|---|---|---|
| 128² (2D) | ≈ 1.4 ms | – |
| 128 × 64 × 64 | 3.2 ms | 26.7 ms (for 128 × 128 × 64) |
| 128³ | 8.8 ms | 53.4–54.2 ms |
| 256 × 128 × 128 | 18.0 ms | 113.2–118.6 ms |

* Mass: drifts by at most 5e-6 relative over 10 s in every 2D scene, at Δt = 1/60 s and at
  Δt = 1/30 s with CFL up to 21, and by 1e-6 to 3e-6 over 240 steps in 3D. The drift is 32-bit
  float round-off (tiny deposits added to cells holding ρ ≈ 1) and keeps accumulating: 4e-5
  after 60 s of the floating bodies scene. The paper's own Fig. 10 shows ±0.05 %.
* Row sums γ for the ball drop at 128², Δt = 1/60 s, over cells holding liquid: 0.77–2.62 over
  the whole run, 0.91–1.09 once the pool has settled. The paper's Table 1 reports 0.627–2.403
  for its run of this test.
* A pool at rest stays at rest: after 120 s at 64², 128² and 256² the liquid speed is
  0.0000 m/s, the surface height has not changed in the second decimal of a cell and the bulk
  density is 1.000 ± 0.000. (At 384² see the limitations.)
* Plain semi-Lagrangian advection on the same dam break: 10 % of the mass left after 10 s.
* Volume of the 0.5 iso-contour stays within roughly 95–107 % once splashes settle, with dips
  while liquid is spread thinner than a cell (as in the paper's Fig. 10).

Reproduce with the pages in `tests/` through `node tools/run.mjs <page>` (`still2d.html` runs
any 2D scene for a long time and reports rest, residuals and rigid body motion, `body2d.html`
drops one body into a pool, `glinfo.html` prints the browser's WebGL2 limits and whether
float read-back is exact) and with `node tools/interact.mjs 2d|3d`, which drives the real
apps with synthetic mouse input. Both tools take `--browser chrome|firefox|librewolf`;
`npm test` runs the interaction checks in Chrome, `npm run test:firefox` and
`npm run test:librewolf` in the other two.

## Where the paper leaves a choice open

These are interpretations, not things the paper states. Each was decided by experiment.

1. **γ is the per-step row sum of the advection operator**, not an advected cumulative field.
   The text supports this ("γᵢ = Σⱼ Aᵢⱼ", "can be done in-place"); the formula in step 7 has an
   extra γⱼ factor that I dropped. An advected cumulative γ fights the intentional divergence of
   Sec. 3.7 and was unstable. The row scale γᵢ / max(1, βₗ) is used as printed; the solver menu
   also offers 1/γ and no feedback.
2. **γ diffusion (advection step 8) exchanges pairwise, between liquid cells only, and never
   uphill.** As [LAF11] describes it, two neighbours meet at the mean of their γ: one pass per
   axis and pair parity, (2k, 2k+1) then (2k+1, 2k+2). Exchanging with both neighbours at once
   (a Jacobi sweep with the same coefficient) flips a cell-to-cell alternation instead of
   damping it; a pool at rest then slowly grew a density checkerboard and its surface started
   to move up and down at grid frequency. Outside the liquid the velocity is an extrapolation
   that is not divergence free, so row sums there are not a compression signal; exchanging with
   them smeared the surface. And an exchange may level ρ′ between two cells but never moves
   liquid from the emptier into the fuller one, which would work against the intentional
   divergence of Sec. 3.7.
3. **Solids in the advection.** Capacities are the non-solid volume fractions V, so the scheme
   transports ρ′ = ρ/V and γᵢ = (Σ Aᵢₗ Vₗ)/Vᵢ. Without this, wall cells inflated γ and still
   water next to a wall was unstable.
4. **Artificial divergence** for ρ′ > 1 is min(λ(ρ′−1), η)/Δt. The paper prints Δx in the
   denominator, which is not a divergence dimensionally.
5. **Sharpening near solids** uses ρ′ (extrapolated into solid cells) for the weight, the
   limiter and the gradient trace, and ρ with face area fractions for Eq. 18–19 as printed.
6. **Coarse multigrid levels** average the interface position φ = 0.5 − ρ′ of their children
   (weighted with the non-solid volume, and clamped at −0.5 so that over-full cells do not
   dominate). Averaging erases air pockets smaller than a coarse cell together with their
   p = 0 condition, which made the V-cycle diverge as soon as a splash trapped air. Every
   coarse cell therefore carries a diagonal "leak" term: the ghost-fluid coupling of its
   children to the air that the coarse level no longer sees. Measured convergence per V-cycle:
   0.05–0.1 on a pool at rest, about 0.3 in the round tank. Keeping every coarse cell that
   covers both liquid and air as air (what this code did first) was stable but only reached
   0.76–0.87; the unconverged remainder showed as a pulsing flow with air pockets in the
   corners of a pool at rest. The reference's "average of positive φ" rule was not monotone.
7. **Solid fractions** are computed from analytic distance fields: volume fractions as
   clamp(0.5 + d), area fractions as a planar cut. A wider ramp leaked pressure through wall
   corners. Faces between two cells that are both almost entirely solid (V < 0.1) are closed:
   such a sliver, for instance under a body lying on the floor, has no neighbour with real
   volume to take its liquid/air state from and otherwise acts as an air pocket at the bottom
   of the pool that the liquid next to it rushes into.
8. **Velocity advection** is semi-Lagrangian with a midpoint trace (the paper does not say).
9. **Velocity extrapolation** uses the grid hierarchy only; the reference additionally runs an
   eikonal solver in a two-cell band.

## Additions beyond the paper

* **Volume correction (on by default, switchable under *Solver*).** The paper's sharpening
  never touches ρ > 0.5 and it notes that the 0.5 iso-contour could in theory swell to twice
  the true volume, "which does not happen in practice". Here it did happen: numerically diluted
  liquid (ρ′ between 0.5 and 1) is incompressible and stays diluted, and the ball-drop pool grew
  to 138–148 % volume in 15 s. Interior liquid cells holding less than their volume are
  therefore contracted with a negative artificial divergence, the mirror image of the paper's
  ρ′ > 1 term. With it the same run stays at 96–101 %. Switch it off to see the method exactly
  as published.
* **Two-way rigid bodies.** The paper couples solids to the liquid one way. Bodies here also
  feel the liquid: pressure force and torque are integrated over each body on the GPU, read
  back asynchronously, and applied one step late with an added-mass term, a force cap and
  liquid-relative drag for stability. Contacts between bodies and with walls are solved with
  sequential impulses. Within 1.5 cells of another solid the liquid may stop a body's approach
  and carry it, but not push it away harder than that: the stiff force of a squeezed film
  arrives after the contact has already stopped the body and would otherwise throw it back.
  This is a plausible game-style coupling, not a strongly coupled solve as in [BBB07].
* **Rendering.** The surface is ray-marched instead of meshed with marching cubes.

## Known limitations

* Verified on Linux with an NVIDIA GPU only (Chrome 154, Firefox 159, LibreWolf 156). Firefox
  has no GPU timer queries for WebGL2, so the step time read-out stays empty there.
* Density below 0.5 ("mist") has no dynamics of its own: as in the paper it moves with velocity
  extrapolated from the nearest liquid, so spray can hang in the air until sharpening gathers it.
* Two V-cycles per step leave a pressure residual around 1e-2 during violent motion; raise
  *V-cycles / step* for a tighter solve.
* At 384² a pool at rest starts a slow long slosh after about a minute (±1.4 cells of 153
  after 120 s). The pressure residual sits at 1.6e-3 from the first step there and more
  V-cycles do not lower it, which points at 32-bit float precision of the pressure solve.
* Rigid bodies are coupled explicitly (see above). Floating bodies keep bobbing on the slosh
  they caused for a long time, since nothing in the inviscid solver damps it (about ±2 cells
  a minute after four bodies were dropped into the 128² pool), and a body lying on the floor
  can jitter by less than a tenth of a cell. Removing this needs the bodies inside the
  pressure solve.
* Fast impacts on solids momentarily produce ρ′ well above 1 (the paper mentions the same); it
  is expelled over the following steps.

## Layout

```
2d.html, 3d.html, index.html   apps and landing page
src/gl.js                      WebGL2 helpers (programs, float targets, scatter, async readback)
src/sim.js                     FluidSim: textures, hierarchy, the time step
src/shaders/                   GLSL for every pass
src/runner.js                  scene driver: obstacles, bodies, emitters, interaction verbs
src/bodies.js                  rigid bodies and contacts
src/render2d.js, render3d.js   renderers
src/scenes2d.js, scenes3d.js   scenarios
tests/, tools/                 headless diagnostics and interaction checks (puppeteer-core)
references/                    the eight papers the method builds on
```

## References (in `references/`)

| Key | Paper |
|---|---|
| MMTD07 | Mullen, McKenzie, Tong, Desbrun. A Variational Approach to Eulerian Geometry Processing. SIGGRAPH 2007 |
| LGF11 | Lentine, Grétarsson, Fedkiw. An Unconditionally Stable Fully Conservative Semi-Lagrangian Method. JCP 2011 |
| LAF11 | Lentine, Aanjaneya, Fedkiw. Mass and Momentum Conservation for Fluid Simulation. SCA 2011 |
| CM11a | Chentanez, Müller. A Multigrid Fluid Pressure Solver Handling Separating Solid Boundary Conditions. SCA 2011 |
| CM11b | Chentanez, Müller. Real-Time Eulerian Water Simulation Using a Restricted Tall Cell Grid. SIGGRAPH 2011 |
| BBB07 | Batty, Bertails, Bridson. A Fast Variational Framework for Accurate Solid-Fluid Coupling. SIGGRAPH 2007 |
| ENGF03 | Enright, Nguyen, Gibou, Fedkiw. Using the Particle Level Set Method and a Second Order Accurate Pressure Boundary Condition for Free Surface Flows. FEDSM 2003 |
| JRW07 | Jeong, Whitaker. A Fast Iterative Method for a Class of Hamilton-Jacobi Equations on Parallel Systems. Utah TR UUCS-07-010 |
