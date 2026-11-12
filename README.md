# Mass-Conserving Eulerian Liquid Simulation — WebGL2

A browser implementation of

> N. Chentanez, M. Müller. *Mass-Conserving Eulerian Liquid Simulation.*
> ACM SIGGRAPH / Eurographics Symposium on Computer Animation, 2012.

in 2D and 3D. The whole solver runs on the GPU as WebGL2 shader passes over float textures
(about 190–215 passes per time step). JavaScript only sequences the passes, integrates the
few rigid bodies and sums a small reduced texture for the on-screen statistics.

A third app, **World** (`world3d.html`), runs the same passes on an unbounded grid of which
only the 8×8×8 bricks around the liquid are stored, over a height-map terrain: see
[World mode](#world-mode).

![3D simulator: dam break in a 192×96×96 tank](docs/screenshots/app-3d.png)

## Screenshots

3D (`3d.html`): the liquid surface is ray-marched from the density field.

| | | |
|:-:|:-:|:-:|
| ![Dam break hitting the far wall](docs/screenshots/3d-dam-break.png) | ![Crown splash](docs/screenshots/3d-crown.png) | ![Floating rigid bodies](docs/screenshots/3d-floaters.png) |
| Dam break, 256×128×128, t = 1.5 s | Ball dropped into a pool, 96³, t = 0.5 s | Rigid bodies of different densities, 144×96×96 |
| ![Flow around a moving sphere](docs/screenshots/3d-obstacle.png) | ![Density volume rendering](docs/screenshots/3d-volume.png) | |
| Fast moving obstacle, 192×96×96 | The density field itself (volume view), dam break | |

2D (`2d.html`), 256² grids:

| | | | |
|:-:|:-:|:-:|:-:|
| ![2D dam break](docs/screenshots/2d-dam-break.png) | ![Rotating paddle](docs/screenshots/2d-mixer.png) | ![Liquid ball hitting a pool](docs/screenshots/2d-splash.png) | ![Speed view](docs/screenshots/2d-speed.png) |
| Dam break | Rotating paddle | Ball into pool | Dam break, speed view |

![2D simulator: rigid bodies falling into a pool](docs/screenshots/app-2d.png)

World (`world3d.html`): the same liquid, stored in bricks where it is. Right: the stored bricks
(blue: holding liquid, grey: kept around it, amber: water at rest next to water that moves).

| | |
|:-:|:-:|
| ![Waterfall](docs/screenshots/world-waterfall.png) | ![Waterfall, stored bricks](docs/screenshots/world-waterfall-bricks.png) |
| High waterfall: 16 m fall, 10 cm cells, t = 7 s | 1.89 M cells stored of the 11.2 M in the box around them |
| ![Terraced cascade](docs/screenshots/world-cascade.png) | ![Terraced cascade, stored bricks](docs/screenshots/world-cascade-bricks.png) |
| Terraced cascade: six basins, 5 cm cells, t = 15 s | 1.92 M cells stored of 8.6 M |
| ![Crate in an open sea](docs/screenshots/world-sea.png) | ![Crate in an open sea, stored bricks](docs/screenshots/world-sea-bricks.png) |
| A crate dropped into a sea that is a formula: 5 cm cells, t = 1.8 s | 576 bricks exist: solved (blue), kept around them (grey), water at rest (amber). Ten seconds later there are none |
| ![Launch in a harbour](docs/screenshots/world-harbour.png) | ![Launch in a harbour, stored bricks](docs/screenshots/world-harbour-bricks.png) |
| A launch going round a harbour basin, 10 cm cells, t = 10 s | The bricks follow the boat and its wake; the buoys and the crate sleep until it passes |
| ![Scattered buoys, stored bricks](docs/screenshots/world-buoys-bricks.png) | |
| Five buoys up to 50 m apart, 10 cm cells, t = 21 s: a lump of water dropped next to one buoy six seconds ago and next to another a second ago. The 819 bricks around those two exist, and none around the other three | |

![World app: the terraced cascade with its bricks](docs/screenshots/app-world.png)

The pictures are produced from the real apps by `node tools/screenshots.mjs`.

## Run

```sh
node tools/serve.mjs          # or: python3 -m http.server 8080
# open http://localhost:8080/   (2d.html, 3d.html, world3d.html)
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
* Floating bodies in contact (`tests/contact2d.html`, six arrangements from two touching balls
  to five bodies dropped on top of each other, three slightly different pool depths each,
  128²): between 90 s and 120 s the fastest body moves at 0.05–0.13 m/s (0.02–0.04 cells per
  step), depending on the arrangement. Runs that differ only in the pool depth differ by up
  to a factor of five in the bodies' kinetic energy, so single runs say little.

Reproduce with the pages in `tests/` through `node tools/run.mjs <page>` (`still2d.html` runs
any 2D scene for a long time and reports rest, residuals and rigid body motion, `body2d.html`
drops one body into a pool, `contact2d.html` floats bodies that touch each other and reports
whether they settle, `glinfo.html` prints the browser's WebGL2 limits and whether
float read-back is exact) and with `node tools/interact.mjs 2d|3d`, which drives the real
apps with synthetic mouse input (`2d|3d|world`). Both tools take
`--browser chrome|firefox|librewolf`; `npm test` runs the interaction checks in Chrome,
`npm run test:firefox` and `npm run test:librewolf` in the other two. The pages for world mode
(`golden.html`, `sparse.html`, `world.html`) are described [there](#world-mode).

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
* **Two-way rigid bodies.** The paper couples solids to the liquid one way; bodies here also
  feel the liquid. The next section describes how.
* **Rendering.** The surface is ray-marched instead of meshed with marching cubes.
* **World mode.** Sparse storage, a terrain, metered sources and drains: its own section below.

## Rigid bodies

No physics library is used. The rigid bodies are a small solver in `src/bodies.js` that runs
in JavaScript on the CPU (a scene holds at most 12 solids, container included); everything
that touches grid cells stays in shaders.

**State and shapes.** A body is a ball or a (rounded) box with a position, an orientation
quaternion, a linear and an angular velocity, and a density relative to the liquid. Shapes are
analytic signed distance functions, the same primitives the liquid solver rasterises. A 2D
body is the same object restricted to the plane (rotation about z only). Scripted obstacles
(paddle, moving sphere) and the container are bodies of infinite mass whose velocity is the
finite difference of their scripted position.

**One time step** (`Runner.step`):

1. Scripted obstacles and the container move to their position at t + Δt.
2. `stepBodies` advances the dynamic bodies, using the liquid force measured after the
   previous liquid step: velocities first, then positions (semi-implicit Euler; the
   orientation is rotated by ω Δt), then contacts.
3. The liquid step runs with the bodies at their new positions and velocities.
4. The pressure of that step is integrated over every body on the GPU and read back for the
   next step.

**Body → liquid** is the paper's solid coupling (Sec. 3.6, 3.7). The `solid` pass turns all
primitives into a solid distance, a solid velocity v + ω × r per face, face area fractions and
cell volume fractions. The pressure solve takes the solid velocity as its boundary condition
(variational discretisation, separating boundaries), so a moving body pushes liquid aside and
drags it along, and density that ends up inside a solid is pushed out.

**Liquid → body** is not in the paper. The `bodyForce` pass draws one point per cell; cells
within 1.5 cells of a body's surface evaluate −p ∇W, where W is that body's own non-solid
volume fraction, so ∇W is the discrete surface normal times area of the pressure
discretisation. Force, torque r × f, the wet fraction of the surface and the mean liquid
velocity next to the body are summed by additive blending into one texel per body and read
back through a pixel-pack buffer and a fence, without stalling the GPU. Buoyancy is not a
separate formula: it is what the hydrostatic part of the pressure integrates to.

The force arrives one step late: what is measured after a step is the liquid's answer to the
acceleration A the body had in that step, f = s − m A, where s is the force on a body that
does not accelerate (buoyancy, waves) and m its added mass, the liquid it has to accelerate
with it, in units of its own mass. Applying f as measured treats the added mass explicitly,
which diverges as soon as m > 1: a light body, a body next to a wall or to another body,
bodies that cover the surface. It is therefore conditioned before use:

* **Added mass, identified while running.** s is recovered as f + r A and the equation of
  motion (1 + r) a = g + s is solved for the new acceleration. With r = m this is exact; an r
  that is too large delays the liquid's answer and feeds a bobbing body, one that is too
  small overshoots. m depends on the direction and on everything around the body, so r is
  estimated per axis (and once for the rotation) by recursive least squares from the second
  differences of f and A over the last three steps (s changes smoothly from step to step,
  m A does not), forgetting 2 % per step (0.5 % next to another solid), starting from
  0.5 · max(wet, 0.3) / density. A is the acceleration the body really had, contacts and
  drag included.
* **No smoothing.** A low-pass filter on the force delays the restoring force, and a delayed
  restoring force adds energy to every oscillation.
* **Four V-cycles** instead of two while a body that feels the liquid is wet. What an
  unconverged pressure solve leaves out of the liquid's answer arrives one step later, and
  bodies wedged against each other, where the multigrid converges slowest, turn that delay
  into a hopping motion with a period of four steps.
* a cap at 3 g / min(density, 1), with the torque scaled by the same factor, so that a late
  impact spike cannot catapult a light body;
* next to another solid (within 1.5 cells) the liquid may stop a body's approach and carry
  its weight, but not push it away harder than that: the stiff force of a squeezed film
  arrives after the contact has already stopped the body and would otherwise throw it back;
* quadratic and linear drag relative to the surrounding liquid and damping of the spin
  (both unconditionally stable), because the inviscid solver exerts no shear on a body.

**Contacts** are found by testing sample points on each body's surface (16 in 2D, 26 in 3D:
for a box its corners, edge midpoints and face centres) against the distance functions of
the container, the scripted obstacles and the other bodies. The deepest point is pushed out along the normal
(80 % per step, shared by inverse mass). Velocities are corrected with sequential impulses
(projected Gauss–Seidel, 10 iterations): one non-penetration constraint per touching point
with an accumulated, non-negative normal impulse, and Coulomb friction (μ = 0.4) limited by
it. A contact only bounces (restitution 0.25) if the approach speed before this step's
forces exceeds 8 cells/s, so a body lying on the floor ends the step exactly at rest; any
residual velocity would be seen by the liquid as a moving wall and pump it.

**Mouse.** A grabbed body is driven towards the pointer with a limited velocity and still
takes part in contacts, so it cannot be pulled through a wall; on release it keeps its
velocity and can be thrown.

This is a partitioned, explicit coupling, not a strongly coupled solve with the bodies inside
the pressure system as in [BBB07]; the consequences are listed under the limitations below.
Because contacts use surface sample points, two boxes meeting edge to edge between sample
points can interpenetrate slightly before the contact is seen.

## World mode

`world3d.html` runs the solver without the box. Cells are world integers on an unbounded grid;
only bricks of 8×8×8 cells that hold liquid, or that liquid can reach before anyone looks again,
are stored, and the ground is a height map. The numerics are the passes described above.
Two of four planned steps towards large scenes are in: storage in bricks, and water at rest
that is neither solved nor stored. Still to come: a height-field far field, and ships with
compartments.

**Storage** (`src/world/bricks.js`, `src/world/sparsesim.js`)

* A brick is one tile of a pool texture: in 3D its eight z-slices side by side (64×8 texels),
  in 2D 16×16. Every field of every multigrid level has a pool; the pools double when they
  are full, up to 16384 bricks (8.4 million cells).
* A two-level page table, kept by the CPU, maps a brick coordinate to its slot: a wrapped top
  table with one entry per group of 16³ bricks, then that group's leaf. Two fetches, no search.
* From the page table the GPU builds a neighbour table: for every slot, the slots of the 5×5×5
  bricks around it. The solver passes read nothing else, so a cell access costs one extra
  fetch wherever the cell lies. It also sets the speed limit of world mode: what a pass reads
  must lie within two bricks of the brick it writes, so liquid moves at most 14.5 cells per step.
* Every pool has two extra tiles that hold the field's default value. A brick that is not
  stored resolves to one of them, so no pass has to ask whether a neighbour exists before
  reading it. For the liquid a missing brick is a wall: the faces towards it are closed.
* Positions inside a shader are measured from the corner of the brick being written, so their
  precision is the same anywhere in the world.

**One set of pass sources.** `header(dim, floatLinear, backend)` in `src/shaders/common.js`
emits either the dense or the sparse version of a dozen helpers (is this cell present, texel
of a cell, capacity of a deposit target, where a scatter point comes from and goes to, …) and
`src/shaders/sim.js` is written against those. Two checks keep this honest:

* `tests/golden.html` prints hashes of density, velocity and pressure of the dense solver for
  the app scenes. They are bit for bit what they were before the helpers went in.
* `tests/sparse.html?dim=2|3` stores every brick of a box and steps the dense and the sparse
  solver side by side, comparing every field after every pass: at most 1e-5 apart after one
  step, 1e-3 after 30 steps in 2D (dam break, pool, splash, ball) and 10 in 3D (dam break,
  splash), same mass, same residual after the V-cycles. `?mode=run` then stores only the
  bricks around the liquid and checks the mass and the per-brick reports.

In world mode itself five things differ from the dense solver, each for a reason:

1. A deposit of the advection or the sharpening whose stencil reaches a missing brick is
   normalised over the corners that exist, as at a wall.
2. The multigrid coarsens until the *longest* side of the stored region is under four cells
   (the dense solver stops at the shortest): a river is long and thin. Level l consists of the
   parents of the bricks of level l − 1, kept by reference counts; the scenes below have 8 or 9.
3. Coarse cells that are solid throughout are walls. The dense solver treats them as air with
   no volume, which is harmless for a tank with thin walls and made the V-cycle converge badly
   over terrain, where a large part of every coarse level is ground.
4. A characteristic of the advection may end as deep inside a solid as it began, and a cell
   that a solid fills almost completely takes its density from the cells beside it before
   those above and below (`pushRel`, `sliverSide`: options of the dense solver too, off
   there). As the tank simulators run, a current of 0.10 to 0.15 cells per step goes round
   every solid that crosses a surface at rest, for good. Two causes: a characteristic that
   ends inside a solid is moved to its surface, so a cut cell whose centre lies in the solid
   is displaced even at rest, and what it asks of its neighbours and what it hands on do not
   cancel; and a cell with almost no volume takes the larger density of all its neighbours,
   including the one below, so the cell at the waterline counts as liquid. In a tank this
   goes unnoticed among the slosh. Here water that never comes to rest can never be handed
   back. `tests/waterline.html`: 0.157 cells per step without the options, 0.0001 to 0.0015
   with them (box, tilted box, ball in a 64³ pool).
5. A face that is closed because the brick behind it is missing stands still, and a face to
   water at rest (below) counts as at rest. The `solid` pass gives every face the velocity of
   the nearest obstacle, however far away; in a tank the nearest thing to a closed face is the
   wall that closes it. In the open it was the nearest floating body, and a crate falling
   through the air pushed the sea around before it arrived.

**Which bricks exist.** After every step two passes reduce each brick to eight numbers: its
mass, its fastest liquid, how many of its cells are wet, the bounding box of those, how many
wet cells sit on a face towards a missing brick, and two flags (a brick my liquid could reach
is missing; a neighbour's liquid can reach me). The CPU reads these back, two texels per
brick, and looks only at bricks that raised a flag, about two per step in the scenes below.

* *Stored:* every brick within ⌈speed · Δt⌉ cells times the number of steps until the next
  report is acted on, plus a margin of 5 cells, of a wet cell.
* *Dropped:* a brick without a wet cell that has been out of reach for 40 reports.
* *Wet* means ρ > 1e-6. Advection and sharpening leave traces of 1e-9 and less around every
  splash; counting those as liquid stored the whole waterfall scene within seconds. What is
  left in a brick when it is dropped is added to an "evaporated" total, so the books below
  still close: it came to 2e-3 cells of liquid out of 187 000 in the cascade run.
* *Never stored:* bricks that lie at least a cell and a half inside the ground or a fixed
  obstacle everywhere. They are marked in the page table so that the reports do not keep
  asking for them.
* *Pool full:* the brick is refused and counted, and the liquid meets a wall there.

**Ground, sources, drains** (`src/world/terrain.js`, `src/world/world.js`). The terrain is a
texture of height and slope per sample, read with the same bilinear formula in the `solid`
pass and in JavaScript; the distance to it is the vertical clearance divided by
√(1 + slope²). Sources and drains are boxes that are filled or emptied before each step, on
the tiles of the bricks they touch only. They are metered on the GPU: the change of every
cell is summed by three 8×8 reductions into a one-texel ledger. (Blending thousands of small
per-cell changes straight into one float lost 1.5e-4 of them.) The app shows
*in − out − stored*; the tests require in = stored + out + evaporated to 1e-5.

**Rendering** (`src/world/render3d.js`). The density is copied into a second pool with a
one-cell apron around every brick (10³ texels, half float), so that two hardware-filtered
fetches give a trilinear sample without looking anything up. A ray steps through the page
table and skips empty space on three levels: groups of 16³ bricks, bricks, and the bounding
box of the wet cells inside a brick. The terrain is traced directly from its height map.
Density below the 0.5 surface is drawn as white haze ("Show spray").

**Measured** (Chrome 154, RTX 3090)

Every brick of a box stored, against the dense solver on the same box (`?mode=perf`, the
fastest of five turns of 20 steps):

| Grid | Dense | Sparse, all bricks | Ratio | Sparse per million cells |
|---|---|---|---|---|
| 128 × 64 × 64 | 4.0 ms | 5.5 ms | 1.4 | 10.5 ms |
| 128³ | 8.2 ms | 12.9 ms | 1.6 | 6.1 ms |
| 256 × 128 × 128 | 15.0 ms | 23.2 ms | 1.5 | 5.5 ms |

(Interpolating by hand instead of with hardware filtering is the smaller part of the
difference: the dense solver with its filtering switched off takes 15.6 ms on the largest grid.)

The two scenes (`tests/world.html?scene=…&time=1`, without drawing):

| | High waterfall | Terraced cascade |
|---|---|---|
| Cell size | 10 cm | 5 cm |
| Scene | 16 m fall, river 3 m wide, 44 m × 22 m of terrain | six basins of 3.2 m × 3.6 m, 1.1 m apart in height |
| After | 10 s | 15 s |
| Bricks stored | 3720 | 3757 |
| of those without a wet cell (the margin) | 1803 | 1874 |
| Cells stored | 1.91 M | 1.92 M |
| Cells in the box around them | 11.2 M (17 % stored) | 8.6 M (22 % stored) |
| Bricks left out because they are in the ground | 1236 | 743 |
| Step | 16.5 ms | 15.2 ms |
| Per million stored cells | 8.8 ms | 9.2 ms |
| in − (stored + out + evaporated), relative | 5.0e-6 | 2.3e-6 |
| Fastest liquid | 7.1 cells per step | 3.0 cells per step |
| Wet cells at the edge of the stored bricks, bricks refused | 0, 0 | 0, 0 |

A stored cell costs about 9 ms per million in a real scene against 5.5 for a full box and 3.6
for the dense solver: there are more multigrid levels, the slots of neighbouring bricks are
scattered over the pool, and the per-brick reports are read back every step. On top of that
half of the stored bricks are margin: dry, but within reach. While the set of bricks changes
quickly (water arriving in a new basin) a step costs up to 20 ms per million cells.

The app at 1280×800, drawing included, runs the cascade at 60 frames per second up to
1.7 million stored cells and at 37–52 beyond 2 million, the waterfall at 52–55; LibreWolf 156
gives the same rates.

`node tools/interact.mjs world` drives the app: bricks follow the water, the books balance,
pour / drain / push act under the pointer and conserve what they should, every scene runs,
a crate dropped with the crate tool lands in the sea.

**Water at rest** (`src/world/water.js`, held bricks in `src/world/sparsesim.js`)

A scene can name up to four bodies of water, each a level and an extent in x and z. Where
such water is at rest it is not solved and mostly not stored. A brick below the level is

* *solved*, as above;
* *held*: stored, not solved. After the density passes of every step its cells are put back
  to the state of rest, and the pressure solve treats them as cells whose pressure is known.
  Every solved brick has the water at rest beside it stored like this, because to the solver
  a missing brick is a wall;
* or *implicit*: not stored. The renderer draws it from the level; nothing else touches it.

The open sea of the scenes below is one line, `water: [{ box: [-1e6, -1e6, 1e6, 1e6], level:
24.25 }]`, and costs nothing until something falls into it.

*The state of rest* is the one the solver itself settles into: ρ′ = clamp(level − y, 0, 1)
and p = G (θ + rows below the top liquid cell), G = g Δt / h, θ being where the ghost-fluid
pressure solve puts the surface above the centre of the top liquid cell. That is not the
hydrostatic pressure of the level. The two differ by up to 0.086 cells of head, and a held
cell with the analytic value next to a solved one drives a steady flow.
`tests/held.html?mode=rest` compares the formula with the dense solver at nine fill levels:
within 9e-5 cells of head. (A top cell that is exactly half full is neither liquid nor air,
and the dense solver does not keep that pool at rest. A thousandth of a cell to either side
it does.)

*Between solved and held water.* Sideways the faces are open and carry u = (p − p_rest) / Z
in place of what the projection would give them: a boundary that lets out a wave travelling
Z cells per step (Z = 1), entered into the pressure matrix as a coupling of that weight to a
known pressure. A face that kept its own velocity next to a fixed pressure would be the open
end of an organ pipe, which sends waves back upside down. What crosses into held cells is
added up per brick before they are reset. Above and below, water at rest is a lid and a
floor to solved water, stored or not: through an open floor the whole solved column moves up
and down as one, with nothing but its own inertia against it. A solved brick next to a held
one also damps the liquid, by up to a tenth of its velocity per step at the held face.

*Waking and sleeping.* The per-brick reports also carry: how many cells are not at rest
(faster than 0.02 cells per step, pressure more than 0.15 cells of head or density more than
0.6 from rest), the bounding box of the cells faster than 0.06 ("waking"), the liquid above
the state of rest, and what a held brick took in. From these, per report:

* a solved brick is held after 60 steps at rest, or after 300 steps in which its surface and
  pressure were at rest and nothing in it was as fast as waking (a splash leaves slow eddies
  that nothing damps);
* a held or implicit brick is solved when waking cells can reach it, when more than 0.03
  cells per face cell and step flow into it, or when it lies within 8 cells of a body that
  is awake, a scripted solid that moves, or the brush;
* a brick stays solved for at least 30 steps, and for 120 after a body or the brush has left
  it (a body that bobs moves the edge of its 8 cells back and forth across a brick boundary);
* waves slower than 0.15 cells per step wake the same brick once in 10 s at most (`rewake`):
  a brick at the edge of what a wake reaches would otherwise change state with every group
  of waves. Faster water (something has fallen in, a bow wave) wakes it whenever it comes;
* while 3000 bricks are solved only a body or the brush wakes more: the held bricks then
  take the waves in;
* a held brick with no solved brick beside it is dropped.

Speed counts below the surface only. A surface that has moved stays smeared over two or
three cells and is never quite at rest in its top cell.

*The books.* With water that has no end, "mass is conserved" reads: liquid above the state
of rest in the stored bricks − what solids displace + what the held bricks took in − what
sources put in + what drains took and what evaporated is constant. The app shows the
difference as *Unaccounted for*.

*Rigid bodies* (`src/world/world.js`) are those of the tank simulators, with the terrain as
one more thing to collide with; scripted solids follow a function of time. Forces are
measured in the bricks around a body only. A body goes to sleep once, for 90 steps, it has
moved less than 0.02 cells per step and its height has stayed within 0.1 cells: it stays
where it is, and its water is free to come to rest and be handed back. (Slow alone is not
enough. A buoy that bobs a quarter of a cell up and down is slow all the time, and was
stopped at the bottom of its bob, 0.3 cells under its float line, every time.) It wakes
when grabbed, when a moving body comes near, to water faster than 0.15 cells per step next
to it, and to any waking water once that water has been at rest for 4 s. (The water a body
stirred up itself must not wake it again.)

Three scenes use this, and a *Crate* tool drops crates into any of them:

| | Crate into open sea | Scattered buoys | Boat across a harbour |
|---|---|---|---|
| Cell size | 5 cm | 10 cm | 10 cm |
| Scene | a 50 × 40 × 50 cm crate falls 1.2 m into a sea without shores or bed | five buoys up to 50 m apart; from 15 s on a 380 l lump of water drops next to one of them every 5 s | a 2.6 m launch goes round a 30 m × 13 m basin behind breakwaters once in 28 s; two buoys and a crate ride its wake |
| Bricks stored at most (solved at most) | 715 (537) | 1138 (745) | 997 (709) |
| Cells stored then, of those in the box around them | 0.37 M of 0.60 M | 0.58 M of 6.88 M | 0.51 M of 0.87 M |
| Step, mean over 60 s | 2.3 ms | 14.6 ms | 13.9 ms |
| Books off by, of the liquid stored at the peak | 3.3e-6 | 2.0e-5 | 3.4e-5 |
| Bodies | crate asleep after 7.2 s | each lump wakes the buoy next to it and no other; asleep again 0.01 to 0.26 cells below the float line (half of the eight times within 0.08) | the buoys woken twice, once per round of the launch, the crate once; asleep 0.04 to 0.14 cells below their float lines |
| Most changes between solved and held of one brick in 60 s | 2 | 6 | 9 |
| Wet cells at the edge of the stored bricks, bricks refused | 0, 0 | 0, 0 | 0, 0 |

(Chrome 154, RTX 3090, `tests/sea.html?scene=…&time=1`, without drawing. The step times
were taken while another job kept the machine busy, a load of 26 to 33 on 32 threads; the
app's own GPU timer read 7 to 12 ms per step with the buoys and in the harbour at the same
time, and it draws all three scenes at 60 frames per second.)

In the first scene nothing is stored from 10.8 s on: the crate is asleep, its waves have
left, and the sea is a formula once more. Where water stays solved for the whole minute the
books drift by 2 to 3e-5, which is the solver's own loss in the solved cells (the dense
solver ends its scene of four floating bodies 1e-6 short per second). The buoys and the
harbour cost more per cell than the waterfall: while a body is awake the pressure solve runs
four V-cycles instead of two and the forces on the bodies are read back, and five islands
far apart make nine multigrid levels.

How far a wave travels before the sea counts as at rest is the waking speed. Halving both
thresholds (`?p.wakeSpeed=0.03&p.sleepSpeed=0.01`) keeps the rings of the crate for longer
and further out: 3235 bricks at the most instead of 715, and the sea is empty again after
15.1 s instead of 10.8.

`tests/held.html` checks the pieces on fixed sets of bricks in 2D and 3D: a pool with only
its middle third solved stays at rest for 120 s with every column within 0.01 cells and no
steady flow through the held faces (and for 20 s at 15 levels across a cell and 7 around a
brick boundary; the sixteenth, a top cell exactly half full, is not at rest in the dense
solver either); a brick held and released every 10 steps for 600 steps changes stored + absorbed
by less than 1e-6; a block of water three cells high on the solved band has left through
the held bricks after 4 s (the surface is back within 0.1 cells of rest); and a ball of
water dropped into an open sea leaves nothing stored afterwards, also when the reports are
acted on 1, 3 or 6 steps late or read back without blocking.

`tests/sea.html` runs the three scenes for a minute each without drawing them and checks
the books, the storage and the bodies (the table above). With `&lump=9` a ball of water
lands 1.6 m from the crate nine seconds after it, on water that has just gone back to rest:
it has to splash all the same (1040 bricks at the most) and leave nothing stored (after
22 s).

**Limits of world mode as it stands**

* It needs read-back from the GPU to decide which bricks to store. With
  `privacy.resistFingerprinting` on, the page says so and does not start.
* Liquid cannot move more than 14.5 cells per step (see the neighbour table).
* A sheet of falling water thins as it accelerates. Once it is thinner than a cell it is
  density below 0.5, which this method moves with a velocity extrapolated from the nearest
  liquid instead of letting it fall (the "mist" item under the limitations below). The
  waterfall is sized so that its sheet stays about two cells thick; one that falls much
  further turns into spray that drifts. Even so, about a quarter of its bricks hold spray only.
* The terrain is a height map: no overhangs or caves, and the distance to a steep face is
  only approximate (it is the vertical clearance scaled by the slope).
* The per-brick reports are read back with a blocking call every step. A non-blocking variant
  (`reportAsync`) passes the same tests but needs a wider margin, hence more bricks.
* A body of water has a fixed level. What the held bricks take in is entered in the books
  and gone: a lake does not rise when a river runs into it. (Levels that follow the volume
  come with the height field.)
* Waves slower than the waking speed (0.06 cells per step: 18 cm/s at 5 cm cells) end at the
  held bricks instead of travelling on, and a held face only lets waves of one speed out
  cleanly; others are partly reflected. Where the last ripples of a wake end is a straight
  line along the bricks.
* Water that waves have woken is not woken again for 10 s by waves slower than 0.15 cells
  per step: the outer, slow rings of a second disturbance that soon after the first end
  where the water is still solved.
* Beyond the budget of 3000 solved bricks nothing more is woken by water. Liquid that falls
  onto water at rest is then taken in by it without a splash.
* A sleeping body stays exactly where it is until something wakes it, so a slow drift ends
  when it goes to sleep.
* With `pushRel` and `sliverSide` a slower flow remains at a tilted solid in a pool at rest:
  0.03 to 0.05 cells per step in the dense 64³ test after 15 to 40 s. In the scenes the body
  is asleep and its water handed back before that.
* No 2D app (2D exists in the tests).

## Known limitations

* Verified on Linux with an NVIDIA GPU only (Chrome 154, Firefox 159, LibreWolf 156). Firefox
  has no GPU timer queries for WebGL2, so the step time read-out stays empty there.
* Density below 0.5 ("mist") has no dynamics of its own: as in the paper it moves with velocity
  extrapolated from the nearest liquid, so spray can hang in the air until sharpening gathers it.
* Two V-cycles per step (four while rigid bodies are in the liquid) leave a pressure residual
  around 1e-2 during violent motion; raise *V-cycles / step* for a tighter solve.
* At 384² a pool at rest starts a slow long slosh after about a minute (±1.4 cells of 153
  after 120 s). The pressure residual sits at 1.6e-3 from the first step there and more
  V-cycles do not lower it, which points at 32-bit float precision of the pressure solve.
* Rigid bodies are coupled explicitly (see above) and floating bodies do not come to complete
  rest. Two minutes after four bodies were dropped into the 128² pool they still move by
  ±0.1 to ±0.5 cells (slowly decaying), in 3D at 64 cells by about ±1 cell, and bodies packed
  against each other keep creeping at up to 0.04 cells per step. Three things feed this:
  nothing in the inviscid solver damps the slosh the bodies caused; the paper's solid model
  moves liquid that a solid displaces out of its cells and expels it with the ρ′ > 1
  divergence over the following steps, which a body that feels the pressure receives as a
  force ripple once per grid cell it travels (`tests/contact2d.html?case=single&piston=0.1,60`:
  ±0.35 of the body's weight, gone with λ = 0, which instead leaves the displaced liquid
  compressed, while a small λ calms a single body and destabilises packed ones); and the volume correction, whose
  contraction of diluted liquid pulls on the surface (the larger share in 3D). Removing it
  needs density advection that is consistent with moving solids in cut cells, or the bodies
  inside the pressure solve as in [BBB07].
* Fast impacts on solids momentarily produce ρ′ well above 1 (the paper mentions the same); it
  is expelled over the following steps.

## Layout

```
2d.html, 3d.html, index.html   apps and landing page
world3d.html                   the World app
src/gl.js                      WebGL2 helpers (programs, float targets, scatter, async readback)
src/sim.js                     FluidSim: textures, hierarchy, the time step
src/shaders/                   GLSL for every pass (sparse.js: brick bookkeeping passes)
src/runner.js                  scene driver: obstacles, bodies, emitters, interaction verbs
src/bodies.js                  rigid bodies and contacts
src/render2d.js, render3d.js   renderers
src/scenes2d.js, scenes3d.js   scenarios
src/world/                     world mode: bricks.js (page table), sparsesim.js (solver on bricks),
                               water.js (water at rest), terrain.js, world.js, scenes.js,
                               render3d.js, app3d.js
tests/, tools/                 headless diagnostics and interaction checks (puppeteer-core)
docs/screenshots/              the pictures above (tools/screenshots.mjs regenerates them)
```

## References

The papers are not part of this repository. Links go to the authors' own copies where one
could be confirmed.

| Key | Paper |
|---|---|
| MMTD07 | Mullen, McKenzie, Tong, Desbrun. [A Variational Approach to Eulerian Geometry Processing](http://www.geometry.caltech.edu/pubs/MMTD07.pdf). SIGGRAPH 2007 |
| LGF11 | Lentine, Grétarsson, Fedkiw. An Unconditionally Stable Fully Conservative Semi-Lagrangian Method. JCP 2011 |
| LAF11 | Lentine, Aanjaneya, Fedkiw. [Mass and Momentum Conservation for Fluid Simulation](https://pages.cs.wisc.edu/~aanjneya/papers/MMCFS/conservative_fluids.pdf). SCA 2011 |
| CM11a | Chentanez, Müller. [A Multigrid Fluid Pressure Solver Handling Separating Solid Boundary Conditions](https://matthias-research.github.io/pages/publications/separatingBoundaries.pdf). SCA 2011 |
| CM11b | Chentanez, Müller. [Real-Time Eulerian Water Simulation Using a Restricted Tall Cell Grid](https://matthias-research.github.io/pages/publications/tallCells.pdf). SIGGRAPH 2011 |
| BBB07 | Batty, Bertails, Bridson. [A Fast Variational Framework for Accurate Solid-Fluid Coupling](https://www.cs.ubc.ca/labs/imager/tr/2007/Batty_VariationalFluids/variationalFluids.pdf). SIGGRAPH 2007 |
| ENGF03 | Enright, Nguyen, Gibou, Fedkiw. Using the Particle Level Set Method and a Second Order Accurate Pressure Boundary Condition for Free Surface Flows. FEDSM 2003 |
| JRW07 | Jeong, Whitaker. [A Fast Iterative Method for a Class of Hamilton-Jacobi Equations on Parallel Systems](https://www-old.cs.utah.edu/docs/techreports/2007/pdf/UUCS-07-010.pdf). Utah TR UUCS-07-010 |
