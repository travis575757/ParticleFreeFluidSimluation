# Mass-Conserving Eulerian Liquid Simulation — WebGL2

A browser implementation of

> N. Chentanez, M. Müller. *Mass-Conserving Eulerian Liquid Simulation.*
> ACM SIGGRAPH / Eurographics Symposium on Computer Animation, 2012. (`masscon_sca.pdf`)

in 2D and 3D. The whole solver runs on the GPU as WebGL2 shader passes over float textures
(about 160–210 passes per time step). JavaScript only sequences the passes, integrates the
few rigid bodies and sums a small reduced texture for the on-screen statistics.

## Run

```sh
node tools/serve.mjs          # or: python3 -m http.server 8080
# open http://localhost:8080/   (2d.html, 3d.html)
```

ES modules do not load from `file://`, so the folder has to be served. Requirements: WebGL2
with `EXT_color_buffer_float`, `EXT_float_blend`, `OES_texture_float_linear`.

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
| 128² (2D) | ≈ 1.1 ms | – |
| 128 × 64 × 64 | 3.1 ms | 26.7 ms (for 128 × 128 × 64) |
| 128³ | 9.8 ms | 53.4–54.2 ms |
| 256 × 128 × 128 | 15.1 ms | 113.2–118.6 ms |

* Mass: drifts by 2e-6 to 5e-6 relative over 240–900 steps in every scene, 2D and 3D, including
  Δt = 1/30 s with CFL up to 11. The drift is 32-bit float round-off (tiny deposits added to
  cells holding ρ ≈ 1); the paper's own Fig. 10 shows ±0.05 %.
* Row sums γ for the ball drop at 128², Δt = 1/60 s, over cells holding liquid: 0.25–11.8 over
  the whole run, 0.86–1.05 once the pool has settled. The extremes last a few steps while the
  ball hits the floor at CFL ≈ 7 and several rows of liquid land in the floor row. The paper's
  Table 1 reports 0.627–2.403 for its run of this test; I did not reproduce that narrower
  range (the paper does not give the time step of its 2D test).
* Plain semi-Lagrangian advection on the same dam break: 10 % of the mass left after 10 s.
* Volume of the 0.5 iso-contour stays within roughly 95–107 % once splashes settle, with dips
  while liquid is spread thinner than a cell (as in the paper's Fig. 10).

Reproduce with the pages in `tests/` through `node tools/run.mjs <page>` and with
`node tools/interact.mjs 2d|3d`, which drives the real apps with synthetic mouse input.

## Where the paper leaves a choice open

These are interpretations, not things the paper states. Each was decided by experiment.

1. **γ is the per-step row sum of the advection operator**, not an advected cumulative field.
   The text supports this ("γᵢ = Σⱼ Aᵢⱼ", "can be done in-place"); the formula in step 7 has an
   extra γⱼ factor that I dropped. An advected cumulative γ fights the intentional divergence of
   Sec. 3.7 and was unstable. The row scale γᵢ / max(1, βₗ) is used as printed; the solver menu
   also offers 1/γ and no feedback.
2. **γ diffusion only exchanges between liquid cells.** Outside the liquid the velocity is an
   extrapolation that is not divergence free, so row sums there are not a compression signal;
   exchanging with them smeared the surface.
3. **Solids in the advection.** Capacities are the non-solid volume fractions V, so the scheme
   transports ρ′ = ρ/V and γᵢ = (Σ Aᵢₗ Vₗ)/Vᵢ. Without this, wall cells inflated γ and still
   water next to a wall was unstable.
4. **Artificial divergence** for ρ′ > 1 is min(λ(ρ′−1), η)/Δt. The paper prints Δx in the
   denominator, which is not a divergence dimensionally.
5. **Sharpening near solids** uses ρ′ (extrapolated into solid cells) for the weight, the
   limiter and the gradient trace, and ρ with face area fractions for Eq. 18–19 as printed.
6. **Coarse multigrid levels keep air.** A coarse cell covering both liquid and air stays air,
   with the averaged interface position. Plain averaging converges faster on simple cases
   (factor ≈ 0.1 per V-cycle) but diverged as soon as a splash trapped an air pocket; the
   reference's "average of positive φ" rule was stable but non-monotone. Convergence with the
   rule used is about 0.7 per V-cycle on splashing scenes.
7. **Solid fractions** are computed from analytic distance fields: volume fractions as
   clamp(0.5 + d), area fractions as a planar cut. A wider ramp leaked pressure through wall
   corners.
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
  back asynchronously, and applied with an added-mass term, a force cap and liquid-relative
  drag for stability. This is a plausible game-style coupling, not a strongly coupled solve.
* **Rendering.** The surface is ray-marched instead of meshed with marching cubes.

## Known limitations

* Verified in Chrome 154 on Linux with an NVIDIA GPU only. Firefox could not be launched
  headlessly here and is untested.
* Density below 0.5 ("mist") has no dynamics of its own: as in the paper it moves with velocity
  extrapolated from the nearest liquid, so spray can hang in the air until sharpening gathers it.
* Two V-cycles per step leave a pressure residual around 1e-2 during violent motion; raise
  *V-cycles / step* for a tighter solve.
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
