// World application: scenes on an unbounded grid (src/world), orbit camera, push / pour / drain,
// and the counters that show what is stored.
import { GLContext } from '../gl.js';
import { World } from './world.js';
import { WorldRenderer, Camera } from './render3d.js';
import { WORLD_SCENES } from './scenes.js';
import { Panel } from '../ui.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const stage = document.getElementById('stage');

function fail(msg) {
  const e = document.getElementById('error');
  e.style.display = 'grid';
  e.textContent = msg;
  window.__error = msg;
}

const state = {
  scene: q.get('scene') in WORLD_SCENES ? q.get('scene') : 'waterfall',
  paused: q.has('paused'),
  tool: 'orbit',
  brush: 6,                 // brush radius in cells
  overlay: q.has('bricks'),
  mist: !q.has('nomist'),
  swell: !q.has('noswell'),
  focus: !q.has('nofocus'),   // with a height field: solve its water in 3D around what the camera looks at
  tiers: !q.has('notiers'),   // ... and show the map of who has the water
  renderScale: Number(q.get('rs')) || 1,
  stepsPerFrame: Number(q.get('spf')) || 1,
  overrides: {},
};
for (const [k, v] of q) if (k.startsWith('p.')) state.overrides[k.slice(2)] = Number(v);

let glc, renderer, world, readouts, panel;
const camera = new Camera();
const pointer = { down: false, orbit: false, pan: false, ndc: [0, 0], lastNdc: null, lastT: 0, vel: [0, 0, 0], inside: false, hit: null, pos: null };

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
};

let crates = 0;      // crates dropped with the tool (their colours)

function frameCamera() {
  const c = world.scene.camera;
  camera.target = c.target.slice();
  camera.dist = c.dist;
  camera.yaw = q.has('yaw') ? Number(q.get('yaw')) : c.yaw;
  camera.pitch = q.has('pitch') ? Number(q.get('pitch')) : c.pitch;
  if (q.has('dist')) camera.dist = Number(q.get('dist'));
  if (q.has('target')) camera.target = q.get('target').split(',').map(Number);
}

function loadScene(keepCamera = false) {
  if (world) world.dispose();
  // &first=, &second=: when the ship scene makes its holes (seconds)
  const when = {};
  for (const k of ['first', 'second']) if (q.has(k)) when[k] = Number(q.get(k));
  const scene = WORLD_SCENES[state.scene].build(when);
  // &until=seconds: the sources stop then
  if (q.has('until')) for (const e of scene.emitters) e.until = Number(q.get('until'));
  world = new World(glc, 3, scene, { params: state.overrides });
  window.world = world;
  crates = 0;
  if (!keepCamera) frameCamera();
  const blurb = document.getElementById('blurb');
  if (blurb) blurb.textContent = WORLD_SCENES[state.scene].blurb;
}

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5) * state.renderScale;
  const w = Math.max(64, Math.round(stage.clientWidth * dpr));
  const h = Math.max(64, Math.round(stage.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// ---------------------------------------------------------------- pointer
function ndcOf(ev) {
  const r = canvas.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * 2 - 1, 1 - ((ev.clientY - r.top) / r.height) * 2];
}
const aspect = () => canvas.width / canvas.height;
const pointerRay = () => camera.ray(pointer.ndc[0], pointer.ndc[1], aspect());

/** Where the tools act: the liquid under the pointer, else the ground, else the plane through the camera's target. */
function actionPoint() {
  const ray = pointerRay();
  const h = pointer.hit;
  const lift = state.tool === 'pour' ? state.brush * 1.5 : 0;
  if (state.tool === 'hole' && h && h.solid > 0) return v3.add(ray.origin, v3.mul(ray.dir, h.solid));
  if (h && h.liquid > 0) return v3.add(v3.add(ray.origin, v3.mul(ray.dir, h.liquid)), [0, lift, 0]);
  if (h && h.solid > 0) return v3.add(v3.add(ray.origin, v3.mul(ray.dir, h.solid)), [0, lift + state.brush * 0.5, 0]);
  const { fwd } = camera.basis();
  const t = v3.dot(v3.sub(camera.target, ray.origin), fwd) / v3.dot(ray.dir, fwd);
  return v3.add(ray.origin, v3.mul(ray.dir, t));
}

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.ndc = ndcOf(ev);
  pointer.lastNdc = pointer.ndc;
  pointer.lastT = performance.now();
  pointer.vel = [0, 0, 0];
  pointer.pan = ev.button === 1 || (ev.button === 0 && ev.ctrlKey);
  pointer.orbit = !pointer.pan && (ev.button !== 0 || state.tool === 'orbit' || ev.shiftKey);
  canvas.style.cursor = pointer.orbit || pointer.pan ? 'grabbing' : 'crosshair';
  if (state.tool === 'crate' && !pointer.orbit && !pointer.pan) dropCrate();
  if (state.tool === 'hole' && !pointer.orbit && !pointer.pan) holeAtPointer();
  ev.preventDefault();
});

const holeRadius = () => Math.max(2.5, state.brush / 2);
/**
 * A hole through the hull under the pointer: a ball centred half a wall inside the surface the
 * pointer's ray meets (so that it comes out on the other side of the plating).
 */
async function holeAtPointer() {
  const ray = pointerRay();
  let h = null;
  for (let k = 0; k < 30 && !h; k++) {
    h = await renderer.pick(world, ray.origin, ray.dir).catch(() => null);
    if (!h) await new Promise((r) => setTimeout(r, 16));
  }
  if (!h || !(h.solid > 0)) return null;
  return world.breachAt(v3.add(ray.origin, v3.mul(ray.dir, h.solid + 1.5)), holeRadius(), 1);
}

/** A crate above the point under the pointer (one per click, while there is room in the table of solids). */
function dropCrate() {
  pointer.pos = actionPoint();
  if (!pointer.pos || !world.canAddBody()) return;
  const s = Math.max(3, state.brush * 0.6), a = crates * 2.4;
  world.addBody({
    shape: 'box', pos: v3.add(pointer.pos, [0, 14 + 2 * s, 0]), half: [s, s * 0.8, s], round: 1, density: 0.45, color: crates++,
    quat: [0.17 * Math.cos(a), Math.sin(a / 2), 0.17 * Math.sin(a), Math.cos(a / 2)], omega: [0.3, 0, 0.2],
  });
}
canvas.addEventListener('pointermove', (ev) => {
  const n = ndcOf(ev);
  const now = performance.now();
  if (pointer.down && pointer.lastNdc) {
    const dx = n[0] - pointer.lastNdc[0];
    const dy = n[1] - pointer.lastNdc[1];
    const { right, up, fwd, pos } = camera.basis();
    if (pointer.orbit) {
      camera.yaw -= dx * 1.6;
      camera.pitch = Math.min(1.45, Math.max(-0.1, camera.pitch - dy * 1.2));
    } else if (pointer.pan) {
      const s = camera.dist * camera.fov;
      camera.target = v3.sub(camera.target, v3.add(v3.mul(right, dx * aspect() * s), v3.mul(up, dy * s)));
    } else {
      // pointer motion as a world-space velocity at the depth of the action point
      const depth = v3.dot(v3.sub(pointer.pos || camera.target, pos), fwd);
      const dt = Math.max((now - pointer.lastT) / 1000, 1 / 240);
      const w = v3.add(v3.mul(right, dx * aspect() * camera.fov * depth), v3.mul(up, dy * camera.fov * depth));
      for (let k = 0; k < 3; k++) pointer.vel[k] += 0.5 * (w[k] / dt - pointer.vel[k]);
    }
  }
  pointer.ndc = n;
  pointer.lastNdc = n;
  pointer.lastT = now;
  pointer.inside = true;
});
const end = () => { pointer.down = false; pointer.orbit = false; pointer.pan = false; canvas.style.cursor = state.tool === 'orbit' ? 'grab' : 'crosshair'; };
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.addEventListener('pointerleave', () => { pointer.inside = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('wheel', (ev) => {
  camera.dist = Math.min(Math.max(camera.dist * Math.exp(ev.deltaY * 0.001), 20), 6000);
  ev.preventDefault();
}, { passive: false });

function applyPointer() {
  const dt = world.sim.params.dt;
  const r = state.brush;
  if (performance.now() - pointer.lastT > 60) pointer.vel = [0, 0, 0];
  world.setBrush([0, 0, 0], [0, 0, 0], 0, 0);
  pointer.pos = null;
  if ((!pointer.inside && !pointer.down) || state.tool === 'orbit') return;
  // keep the distances under the pointer up to date (1-pixel GPU pick)
  const ray = pointerRay();
  renderer.pick(world, ray.origin, ray.dir).then((h) => { if (h) pointer.hit = h; }).catch(() => {});
  pointer.pos = actionPoint();
  if (!pointer.down || pointer.orbit || pointer.pan) return;
  const vmax = 10 / dt;
  const sp = Math.hypot(...pointer.vel);
  const v = sp > vmax ? v3.mul(pointer.vel, vmax / sp) : pointer.vel;
  if (state.tool === 'drain') world.erase(pointer.pos, r);
  else if (state.tool === 'pour') world.pour(pointer.pos, v3.add(v3.mul(v, 0.6), [0, -20, 0]), r);
  else if (state.tool === 'push') world.setBrush(pointer.pos, v, r * 1.4, 1.0);
}

// ---------------------------------------------------------------- panel
function buildPanel() {
  const P = new Panel(document.getElementById('panel'));
  const setParam = (k, v) => { state.overrides[k] = v; world.sim.params[k] = v; };

  P.section('Scenario');
  P.select('scene', 'Scene', Object.entries(WORLD_SCENES).map(([k, s]) => [k, s.title]), state.scene, (v) => { state.scene = v; loadScene(); });
  const blurb = P.note(WORLD_SCENES[state.scene].blurb, 'note blurb');
  blurb.id = 'blurb';
  P.buttons([
    { label: 'Restart', title: 'Restart the scene (R)', onClick: () => loadScene(true), primary: true },
    { id: 'pause', label: state.paused ? 'Resume' : 'Pause', title: 'Space', onClick: togglePause },
    { label: 'Step', title: 'Advance one step (.)', onClick: () => { state.paused = true; syncPause(); stepOnce(); } },
  ]);

  P.section('Mouse');
  P.segmented('tool', [
    ['orbit', 'Orbit', 'Drag to rotate the camera'],
    ['push', 'Push', 'Drag across the liquid to push it'],
    ['pour', 'Pour', 'Hold to add liquid under the pointer'],
    ['drain', 'Drain', 'Hold to remove liquid'],
    ['crate', 'Crate', 'Click to drop a crate (its size follows the brush; up to twelve solids in a scene)'],
    ['hole', 'Hole', 'Click on a ship to make a hole through her hull (half the brush across, at least 2.5 cells)'],
  ], state.tool, (v) => { state.tool = v; canvas.style.cursor = v === 'orbit' ? 'grab' : 'crosshair'; });
  P.slider('brush', 'Brush size (cells)', { min: 3, max: 16, step: 1, value: state.brush }, (v) => { state.brush = v; });
  P.note('Right-drag or Shift-drag orbits, middle-drag or Ctrl-drag moves the view, the wheel zooms.');

  P.section('View');
  P.checkbox('bricks', 'Show the stored bricks', state.overlay, (v) => { state.overlay = v; },
    'Outlines of the 8 x 8 x 8 cell bricks that are stored: blue where they hold liquid, amber where they hold water at rest that is kept but not solved, grey where they are kept as a margin.');
  P.checkbox('mist', 'Show spray', state.mist, (v) => { state.mist = v; },
    'Density below the surface threshold of 0.5 (sheets and drops thinner than a cell) drawn as a white haze.');
  P.checkbox('swell', 'Show the waves beyond the solved water', state.swell, (v) => { state.swell = v; },
    'Where the water of a sea is not solved, a map of its surface carries the waves on. Off: the sea is drawn flat there, which is all the solver itself knows of it.');
  P.checkbox('focus', 'Solve in 3D around the view target', state.focus, (v) => { state.focus = v; },
    'In a scene with a height field, the water around the point the camera turns about is handed to the 3D solver, as far as the budget of solved bricks allows, and goes back to the height field when the view moves on. Off: only what a height field cannot hold is solved in 3D (fronts, falls, splashes, the water around bodies and the brush).');
  P.checkbox('tiers', 'Show who has the water', state.tiers, (v) => { state.tiers = v; },
    'In a scene with a height field: a map of its columns of bricks, seen from above. Blue: the height field alone. Amber: a copy of it stored next to solved water. Light: solved in 3D. Red: should be solved (a front, a fall) but the budget of solved bricks is used up. Violet: a source, a sink or the end of a link, which stays the height field\'s.');
  P.select('rs', 'Render scale', [[0.5, '50 %'], [0.75, '75 %'], [1, '100 %']], state.renderScale, (v) => { state.renderScale = Number(v); });

  P.section('Storage');
  readouts = P.stats([
    ['bricks', 'Bricks stored', 'Bricks of 8 x 8 x 8 cells that exist right now (those inside the ground are never stored), and how many of them hold water at rest that is kept but not solved. Water at rest away from anything that moves is not stored at all.'],
    ['cells', 'Cells stored', 'Cells the solver works on'],
    ['box', 'Box around them', 'Cells a dense grid over the same region would hold, and the share of it that is stored'],
    ['hf', 'Height field', 'In a scene with a height field: the columns of its map (one per brick, 8 x 8 cells) that hold water, how many of them are solved in 3D, and the solved bricks against the budget of them. The rest of the water is moved as shallow water, two numbers per 2 x 2 cells of ground.'],
    ['budget', 'Unaccounted for', 'The liquid the scene started with plus what the sources and the pour tool fed in, minus what the drains took, minus what is there now: zero if nothing is lost (cells of liquid). In a scene with a sea, what is there is counted above the water at rest, with what the bodies displace and what the water at rest has taken in.'],
    ['flow', 'In / out', 'Totals of the sources and of the drains, in cells of liquid'],
    ['bodies', 'Bodies awake', 'Rigid bodies that are being stepped, of all there are. A body that has been slow for a while sleeps, and stops keeping the water around it solved, until that water moves again.'],
    ['cfl', 'Fastest liquid', 'Largest liquid speed in cells per time step (the limit of the brick storage is 14)'],
    ['perf', 'Step / frame', 'GPU time of one simulation step and frame rate'],
    ['gpu', 'Runs on', 'The whole solver executes as WebGL2 shader passes on this GPU'],
  ]);
  readouts.gpu.textContent = gpuName();
  readouts.gpu.title = glc.renderer;

  P.section('Solver', { collapsible: true, open: false });
  const p = world.sim.params;
  P.slider('spf', 'Steps / frame', { min: 1, max: 4, step: 1, value: state.stepsPerFrame }, (v) => { state.stepsPerFrame = v; });
  P.slider('vc', 'V-cycles / step', { min: 1, max: 8, step: 1, value: p.vcycles }, (v) => setParam('vcycles', v));
  P.slider('margin', 'Margin around the liquid (cells)', { min: 2, max: 12, step: 1, value: p.margin }, (v) => setParam('margin', v));

  P.section('Keys', { collapsible: true, open: false });
  const keys = P.note('');
  keys.innerHTML = '<kbd>Space</kbd> pause · <kbd>R</kbd> restart · <kbd>.</kbd> single step · <kbd>B</kbd> bricks · <kbd>1</kbd>–<kbd>9</kbd>, <kbd>0</kbd>, <kbd>-</kbd> scenes';
  return P;
}

function gpuName() {
  const m = /ANGLE \([^,]*,\s*([^,(/]+)/.exec(glc.renderer);
  return (m ? m[1] : glc.renderer).replace(/\s+(Direct3D|OpenGL|Vulkan).*$/, '').trim().slice(0, 30);
}
function syncPause() { panel.controls.pause.textContent = state.paused ? 'Resume' : 'Pause'; }
function togglePause() { state.paused = !state.paused; syncPause(); }

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLInputElement) return;
  if (ev.code === 'Space') { togglePause(); ev.preventDefault(); }
  else if (ev.key === 'r' || ev.key === 'R') loadScene(true);
  else if (ev.key === '.') { state.paused = true; syncPause(); stepOnce(); }
  else if (ev.key === 'b' || ev.key === 'B') { state.overlay = !state.overlay; panel.controls.bricks.checked = state.overlay; }
  else if (ev.key === '0') { const k = Object.keys(WORLD_SCENES)[9]; if (k) { state.scene = k; panel.controls.scene.value = k; loadScene(); } }
  else if (ev.key === '-') { const k = Object.keys(WORLD_SCENES)[10]; if (k) { state.scene = k; panel.controls.scene.value = k; loadScene(); } }
  else if (/^[1-9]$/.test(ev.key)) {
    const k = Object.keys(WORLD_SCENES)[Number(ev.key) - 1];
    if (k) { state.scene = k; panel.controls.scene.value = k; loadScene(); }
  }
});

// ---------------------------------------------------------------- main loop
let frame = 0;
let fps = 60;
let stepMs = 0;
let lastFrameT = performance.now();
let passesPerStep = 0;
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e4 ? (n / 1e3).toFixed(0) + ' k' : String(Math.round(n)));

function stepOnce() {
  applyPointer();
  world.setFocus(camera.target.slice(), state.focus);
  const before = glc.passCount;
  world.step();
  passesPerStep = glc.passCount - before;
}

function updateStats() {
  const sim = world.sim;
  const rep = sim.report;
  const box = world.boundsCells();
  readouts.bricks.textContent = sim.water.length ? `${sim.bricks} · ${sim.nHeld} at rest` : sim.hf ? `${sim.bricks} · ${sim.nHeld} copies` : `${sim.bricks}`;
  const tr = world.tiers();
  if (tr) {
    let wet = 0, solved = 0, short = 0;
    for (const t of tr.tier) { if (t & 7) wet++; if ((t & 3) === 3) solved++; if (t & 4) short++; }
    const budget = sim.params.maxSolved || 3000;
    readouts.hf.textContent = `${fmt(wet)} columns · ${solved} in 3D${short ? ` (${short} more should be)` : ''} · ${sim.bricks - sim.nHeld} of ${budget} bricks`;
  } else readouts.hf.textContent = '–';
  readouts.bodies.textContent = world.bodies.length ? `${world.bodies.filter((b) => !b.asleep).length} of ${world.bodies.length}` : '–';
  readouts.cells.textContent = fmt(sim.storedCells);
  readouts.box.textContent = box ? `${fmt(box)} · ${(100 * sim.storedCells / box).toFixed(1)} % stored` : '–';
  const bk = sim.books;
  if (bk && sim.hf) {
    const off = world.unaccounted;
    if (off !== null) readouts.budget.textContent = `${off.toFixed(1)} of ${fmt(sim.hfWater)}`;
    readouts.flow.textContent = `${fmt(bk.added + world.hf.added)} / ${fmt(bk.removed + world.hf.removed)}`;
  } else if (bk) {
    readouts.budget.textContent = `${world.balance().toFixed(2)} of ${fmt(bk.stored)}`;
    readouts.flow.textContent = `${fmt(bk.added)} / ${fmt(bk.removed)}`;
  }
  if (rep) readouts.cfl.textContent = (rep.maxSpeed * sim.params.dt).toFixed(1);
  readouts.perf.textContent = `${stepMs > 0 ? stepMs.toFixed(1) + ' ms' : '–'} · ${fps.toFixed(0)} fps`;
}

// The map of who has the water (World.tiers), one pixel per column of bricks, with a cross where the camera looks.
const tierCanvas = document.getElementById('tiers'), tierKey = document.getElementById('tiersKey');
const TIER_RGB = [[0, 0, 0, 0], [47, 111, 163, 255], [232, 163, 61, 255], [127, 227, 245, 255]];
function drawTiers() {
  const tr = state.tiers && world ? world.tiers() : null;
  if (!tierCanvas) return;
  tierCanvas.style.display = tr ? 'block' : 'none';
  tierKey.style.display = tr ? 'block' : 'none';
  if (!tr) return;
  const [nw, nh] = tr.n;
  const B = world.sim.B;
  const fx = Math.round(camera.target[0] / B - tr.origin[0]), fz = Math.round(camera.target[2] / B - tr.origin[1]);
  // The whole map if it fits on 320 by 180 pixels with at least two pixels per column; else the
  // part of it around what the camera looks at.
  const px = Math.max(Math.min(Math.floor(320 / nw), Math.floor(180 / nh), 6), 2);
  const w = Math.min(nw, Math.floor(320 / px)), h = Math.min(nh, Math.floor(180 / px));
  const i0 = Math.min(Math.max(fx - (w >> 1), 0), nw - w), j0 = Math.min(Math.max(fz - (h >> 1), 0), nh - h);
  if (tierCanvas.width !== w || tierCanvas.height !== h) { tierCanvas.width = w; tierCanvas.height = h; }
  tierCanvas.style.width = `${w * px}px`;
  tierCanvas.style.height = `${h * px}px`;
  tierKey.style.bottom = `${h * px + 18}px`;
  const ctx = tierCanvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const t = tr.tier[(j0 + j) * nw + i0 + i];
      const c = t & 4 ? [224, 82, 77, 255] : t & 8 && (t & 3) ? [141, 111, 209, 255] : TIER_RGB[t & 3];
      // (z towards the viewer at the bottom, as the scenes are looked at)
      img.data.set(c, 4 * ((h - 1 - j) * w + i));
    }
  }
  ctx.putImageData(img, 0, 0);
  ctx.fillStyle = '#fff';
  ctx.fillRect(fx - i0 - 2, h - 1 - (fz - j0), 5, 1);
  ctx.fillRect(fx - i0, h - 1 - (fz - j0) - 2, 1, 5);
}

function tick() {
  const now = performance.now();
  fps += 0.05 * (1000 / Math.max(now - lastFrameT, 1) - fps);
  lastFrameT = now;
  try {
    fitCanvas();
    if (!state.paused) {
      if (frame % 20 === 0) {
        glc.timeGpu(() => { for (let i = 0; i < state.stepsPerFrame; i++) stepOnce(); })
          .then((ms) => { if (ms !== null) stepMs = ms / state.stepsPerFrame; });
      } else {
        for (let i = 0; i < state.stepsPerFrame; i++) stepOnce();
      }
    } else {
      applyPointer();
    }
    const showBrush = pointer.pos && state.tool !== 'orbit' && (pointer.inside || pointer.down);
    renderer.render(world, camera, { overlay: state.overlay, mist: state.mist, swell: state.swell, cursor: showBrush ? [...pointer.pos, state.tool === 'hole' ? holeRadius() : state.brush] : null });
    if (frame % 6 === 0) {
      // the totals of the sources and drains follow the same report the storage counters come from
      if (glc.readback !== 'scrambled') {
        world.readBooksAsync();
      }
      updateStats();
      if (frame % 12 === 0) drawTiers();
    }
    hud.textContent = `t = ${world.time.toFixed(2)} s${state.paused ? '  (paused)' : ''}\n${passesPerStep} GPU shader passes / step`;
    frame++;
    window.__frames = frame;
  } catch (e) {
    fail(String(e.stack || e));
    return;
  }
  requestAnimationFrame(tick);
}

try {
  glc = new GLContext(canvas, { preserveDrawingBuffer: q.has('capture') });
  if (glc.readback === 'scrambled') {
    throw new Error('World mode decides which cells to store from numbers it reads back from the GPU, and this browser returns random ' +
      'numbers for those (Firefox / LibreWolf with privacy.resistFingerprinting on). Turn that setting off in about:config and reload. ' +
      'The 2D and 3D tank simulators run without it.');
  }
  renderer = new WorldRenderer(glc);
  loadScene();
  fitCanvas();
  panel = buildPanel();
  window.app = { state, camera, loadScene, stepOnce, renderer, holeAtPointer, get world() { return world; } };
  requestAnimationFrame(tick);
} catch (e) {
  fail(String(e.message || e).startsWith('World mode') ? e.message : 'This demo needs WebGL2 with float render targets.\n\n' + String(e.stack || e.message || e));
}
