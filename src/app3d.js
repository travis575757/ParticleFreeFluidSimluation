// 3D application: orbit camera, ray-based mouse interaction, rigid bodies, live diagnostics.
import { GLContext } from './gl.js';
import { Runner } from './runner.js';
import { Renderer3D, Camera, VIEWS3D } from './render3d.js';
import { SCENES3D, buildScene3D } from './scenes3d.js';
import { Panel, ConservationPlot, el } from './ui.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('view');
const hud = document.getElementById('hud');
const stage = document.getElementById('stage');

// Non-fatal notice at the bottom of the view.
function notice(msg) {
  const e = document.getElementById('notice');
  e.textContent = msg;
  const close = document.createElement('button');
  close.textContent = '×';
  close.title = 'Dismiss';
  close.addEventListener('click', () => { e.style.display = 'none'; });
  e.append(close);
  e.style.display = 'block';
  window.__notice = msg;
}

function fail(msg) {
  const e = document.getElementById('error');
  e.style.display = 'grid';
  e.textContent = msg;
  window.__error = msg;
}

const state = {
  scene: q.get('scene') in SCENES3D ? q.get('scene') : 'damBreak',
  N: Number(q.get('n')) || 64,
  paused: q.has('paused'),
  tool: 'push',
  brush: 0.08,              // brush radius in tank units
  view: q.get('view') || 'liquid',
  postProcess: q.has('pp'),
  renderScale: Number(q.get('rs')) || 1,
  stepsPerFrame: Number(q.get('spf')) || 1,
  overrides: {},
};
for (const [k, v] of q) if (k.startsWith('p.')) state.overrides[k.slice(2)] = Number(v);

let glc, renderer, runner, scene, plot, readouts, panel;
const camera = new Camera();
const pointer = { down: false, orbit: false, ndc: [0, 0], lastNdc: null, lastT: 0, vel: [0, 0, 0], inside: false, button: 0, hitT: -1, pos: null };

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
};

function frameCamera() {
  const g = runner.sim.grid.n;
  camera.target = [g[0] / 2, g[1] * 0.40, g[2] / 2];
  const r = Math.hypot(g[0], g[1], g[2]) / 2;
  const asp = Math.max(stage.clientWidth, 1) / Math.max(stage.clientHeight, 1);
  camera.dist = (r / (camera.fov * Math.min(1, asp))) * 0.98;
  if (q.has('yaw')) camera.yaw = Number(q.get('yaw'));
  if (q.has('pitch')) camera.pitch = Number(q.get('pitch'));
}

function loadScene(keepCamera = false) {
  if (runner) runner.dispose();
  scene = buildScene3D(SCENES3D[state.scene], state.N);
  runner = new Runner(glc, 3, scene, state.overrides);
  window.runner = runner;
  plot?.clear();
  if (!keepCamera) frameCamera();
  const blurb = document.getElementById('blurb');
  if (blurb) blurb.textContent = SCENES3D[state.scene].blurb;
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
const brushCells = () => state.brush * scene.L;
const pointerRay = () => camera.ray(pointer.ndc[0], pointer.ndc[1], aspect());

/** Point on the pointer ray at the depth of the plane through `through`, facing the camera. */
function onViewPlane(ray, through) {
  const { fwd } = camera.basis();
  const t = v3.dot(v3.sub(through, ray.origin), fwd) / v3.dot(ray.dir, fwd);
  return v3.add(ray.origin, v3.mul(ray.dir, t));
}
function clampInside(p, r) {
  const g = runner.sim.grid.n;
  const m = scene.margin + r;
  return [Math.min(Math.max(p[0], m), g[0] - m), Math.min(Math.max(p[1], m), g[1] - m), Math.min(Math.max(p[2], m), g[2] - m)];
}
/** Sphere-trace the pointer ray against the dynamic bodies. */
function pickBody(ray) {
  if (!runner.bodies.length) return null;
  let t = 0;
  const far = camera.dist * 3;
  for (let i = 0; i < 96 && t < far; i++) {
    const p = v3.add(ray.origin, v3.mul(ray.dir, t));
    let dmin = Infinity;
    let best = null;
    for (const b of runner.bodies) { const d = b.sd(p); if (d < dmin) { dmin = d; best = b; } }
    if (dmin < 0.15) return { body: best, point: p };
    t += dmin;
  }
  return null;
}
/** Where the tools act: the liquid surface under the pointer if there is one, else the focus plane. */
function actionPoint() {
  const ray = pointerRay();
  if (pointer.hitT > 0 && (state.tool === 'push' || state.tool === 'drain')) return v3.add(ray.origin, v3.mul(ray.dir, pointer.hitT));
  return onViewPlane(ray, camera.target);
}

function spawnBody(shape, pos) {
  const L = scene.L;
  const n = runner.bodies.length;
  const density = [0.45, 0.8, 1.8, 0.3][n % 4];
  const p = clampInside(pos, 0.1 * L);
  const spec = shape === 'ball'
    ? { shape: 'ball', pos: p, radius: 0.07 * L, density, color: n }
    : { shape: 'box', pos: p, half: [0.09 * L, 0.055 * L, 0.07 * L], quat: [0.2, 0.3, 0.1, 0.92], density, color: n };
  if (!runner.addBody(spec)) hud.textContent = 'Solid limit reached. Remove bodies to add more.';
}

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.button = ev.button;
  pointer.ndc = ndcOf(ev);
  pointer.lastNdc = pointer.ndc;
  pointer.lastT = performance.now();
  pointer.vel = [0, 0, 0];
  pointer.orbit = false;
  const ray = pointerRay();
  const hit = ev.button === 0 ? pickBody(ray) : null;
  if (hit) {
    runner.grab(hit.body, hit.point);
    pointer.grabPoint = hit.point;
  } else if (ev.button !== 0 || state.tool === 'orbit' || ev.shiftKey) {
    pointer.orbit = true;
  } else if (state.tool === 'ball' || state.tool === 'box') {
    spawnBody(state.tool, onViewPlane(ray, camera.target));
  }
  canvas.style.cursor = pointer.orbit ? 'grabbing' : 'crosshair';
  ev.preventDefault();
});
canvas.addEventListener('pointermove', (ev) => {
  const n = ndcOf(ev);
  const now = performance.now();
  if (pointer.down && pointer.lastNdc) {
    const dx = n[0] - pointer.lastNdc[0];
    const dy = n[1] - pointer.lastNdc[1];
    if (pointer.orbit) {
      camera.yaw -= dx * 1.6;
      camera.pitch = Math.min(1.45, Math.max(-0.25, camera.pitch - dy * 1.2));
    } else {
      // pointer motion as a world-space velocity at the depth of the action point
      const { right, up, fwd, pos } = camera.basis();
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
  if (runner.grabbedBody) runner.dragTo(onViewPlane(pointerRay(), pointer.grabPoint));
});
const end = () => { pointer.down = false; pointer.orbit = false; runner.release(); canvas.style.cursor = state.tool === 'orbit' ? 'grab' : 'crosshair'; };
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.addEventListener('pointerleave', () => { pointer.inside = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('wheel', (ev) => {
  camera.dist = Math.min(Math.max(camera.dist * Math.exp(ev.deltaY * 0.001), scene.L * 0.6), scene.L * 14);
  ev.preventDefault();
}, { passive: false });

function applyPointer() {
  const dt = runner.sim.params.dt;
  const r = brushCells();
  if (performance.now() - pointer.lastT > 60) pointer.vel = [0, 0, 0];
  runner.setBrush([0, 0, 0], [0, 0, 0], 0, 0);
  if (!pointer.inside && !pointer.down) return;
  // keep the liquid-surface distance under the pointer up to date (1-pixel GPU pick)
  const ray = pointerRay();
  renderer.pick(runner, ray.origin, ray.dir).then((t) => { if (t !== null) pointer.hitT = t; }).catch(() => {});
  pointer.pos = actionPoint();
  if (!pointer.down || pointer.orbit || runner.grabbedBody) return;
  const vmax = 12 / dt;
  const sp = Math.hypot(...pointer.vel);
  const v = sp > vmax ? v3.mul(pointer.vel, vmax / sp) : pointer.vel;
  if (state.tool === 'drain') runner.erase(pointer.pos, r);
  else if (state.tool === 'pour') runner.pour(clampInside(pointer.pos, r), v3.mul(v, 0.6), r);
  else if (state.tool === 'push') runner.setBrush(pointer.pos, v, r * 1.4, 1.0);
}

// ---------------------------------------------------------------- panel
function buildPanel() {
  const P = new Panel(document.getElementById('panel'));
  const setParam = (k, v) => { state.overrides[k] = v; runner.sim.params[k] = v; };

  P.section('Scenario');
  P.select('scene', 'Scene', Object.entries(SCENES3D).map(([k, s]) => [k, s.title]), state.scene, (v) => { state.scene = v; loadScene(); });
  const blurb = P.note(SCENES3D[state.scene].blurb, 'note blurb');
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
    ['ball', '+ Ball', 'Click to drop a rigid ball'],
    ['box', '+ Box', 'Click to drop a rigid box'],
  ], state.tool, (v) => { state.tool = v; canvas.style.cursor = v === 'orbit' ? 'grab' : 'crosshair'; });
  P.slider('brush', 'Brush size', { min: 0.03, max: 0.2, step: 0.005, value: state.brush, fmt: (v) => v.toFixed(3) }, (v) => { state.brush = v; });
  P.note('Right-drag or Shift-drag orbits, the wheel zooms. Rigid bodies can always be grabbed and thrown.');
  P.buttons([{ label: 'Remove bodies', onClick: () => runner.removeBodies() }]);

  P.section('View');
  P.select('view', 'Show', VIEWS3D, state.view, (v) => { state.view = v; });
  P.checkbox('pp', 'Reveal sub-grid detail (Sec. 3.8)', state.postProcess, (v) => { state.postProcess = v; },
    'Density post-processing: thin sheets and droplets with density below 0.5 are scaled up so they appear in the iso-surface.');
  P.select('rs', 'Render scale', [[0.5, '50 %'], [0.75, '75 %'], [1, '100 %']], state.renderScale, (v) => { state.renderScale = Number(v); });

  P.section('Conservation');
  readouts = P.stats([
    ['mass', 'Mass', 'Total density relative to the initial value'],
    ['volume', 'Volume (0.5 iso)', 'Volume enclosed by the 0.5 iso-surface relative to the initial value'],
    ['gamma', 'γ range', 'Row sums of the advection operator over cells that hold liquid (1 = incompressible)'],
    ['cfl', 'CFL', 'Largest liquid speed in cells per time step'],
    ['res', 'Pressure residual', 'Relative L1 residual of the pressure solve'],
    ['perf', 'Step / frame', 'GPU time of one simulation step and frame rate'],
    ['gpu', 'Runs on', 'The whole solver executes as WebGL2 shader passes on this GPU'],
  ]);
  readouts.gpu.textContent = gpuName();
  readouts.gpu.title = glc.renderer;
  const pc = el('canvas', { id: 'plot' });
  P.cur.append(pc, el('div', { class: 'legend' },
    el('span', {}, el('i', { style: 'background:#f2b84b' }), 'mass'),
    el('span', {}, el('i', { style: 'background:#39c5cf' }), 'volume of the 0.5 iso-surface')));
  plot = new ConservationPlot(pc);

  P.section('Solver', { collapsible: true, open: false });
  const p = runner.sim.params;
  P.select('n', 'Resolution (height)', [[32, '32 cells'], [48, '48'], [64, '64'], [96, '96'], [128, '128 (paper)']], state.N, (v) => { state.N = Number(v); loadScene(true); frameCamera(); });
  P.select('dt', 'Time step', [[1 / 30, '1/30 s (paper)'], [1 / 60, '1/60 s'], [1 / 120, '1/120 s']], p.dt, (v) => setParam('dt', Number(v)));
  P.slider('spf', 'Steps / frame', { min: 1, max: 4, step: 1, value: state.stepsPerFrame }, (v) => { state.stepsPerFrame = v; });
  P.slider('g', 'Gravity', { min: 0, max: 20, step: 0.5, value: -p.gravity[1], fmt: (v) => v.toFixed(1) }, (v) => setParam('gravity', [0, -v, 0]));
  P.select('advection', 'Density advection', [
    [1, 'Conservative, γ feedback (paper)'],
    [3, 'Conservative, no γ feedback'],
    [2, 'Conservative, 1/γ row scale'],
    [0, 'Plain semi-Lagrangian (loses mass)'],
  ], p.advection, (v) => setParam('advection', Number(v)));
  P.slider('diff', 'γ diffusion sweeps', { min: 0, max: 7, step: 1, value: p.diffusionIters }, (v) => setParam('diffusionIters', v));
  P.checkbox('sharpen', 'Density sharpening (Sec. 3.5)', !!p.sharpen, (v) => setParam('sharpen', v ? 1 : 0));
  P.slider('D', 'Redistribution D', { min: 0.1, max: 4.1, step: 0.1, value: p.D, fmt: (v) => v.toFixed(1) }, (v) => setParam('D', v));
  P.slider('K', 'Sharpening ΔT/Δt', { min: 0, max: 12, step: 0.5, value: p.sharpenK, fmt: (v) => v.toFixed(1) }, (v) => setParam('sharpenK', v));
  P.checkbox('compress', 'Volume correction for under-full liquid', p.compress > 0, (v) => setParam('compress', v ? 0.1 : 0),
    'Extension beyond the paper: interior liquid cells holding less than their volume are contracted. Off = the paper as published.');
  P.checkbox('separate', 'Separating solid boundaries [CM11a]', !!p.separate, (v) => setParam('separate', v ? 1 : 0),
    'Liquid may peel off walls instead of sticking to them.');
  P.slider('vc', 'V-cycles / step', { min: 1, max: 8, step: 1, value: p.vcycles }, (v) => setParam('vcycles', v));

  P.section('Keys', { collapsible: true, open: false });
  const keys = P.note('');
  keys.innerHTML = '<kbd>Space</kbd> pause · <kbd>R</kbd> restart · <kbd>.</kbd> single step · <kbd>1</kbd>–<kbd>9</kbd> scenes · <kbd>V</kbd> next view';
  return P;
}

function gpuName() {
  // "ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL 4.5.0)" -> "NVIDIA GeForce RTX 3090"
  const m = /ANGLE \([^,]*,\s*([^,(/]+)/.exec(glc.renderer);
  return (m ? m[1] : glc.renderer).replace(/\s+(Direct3D|OpenGL|Vulkan).*$/, '').trim().slice(0, 30);
}
let passesPerStep = 0;
function syncPause() { panel.controls.pause.textContent = state.paused ? 'Resume' : 'Pause'; }
function togglePause() { state.paused = !state.paused; syncPause(); }

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLInputElement) return;
  if (ev.code === 'Space') { togglePause(); ev.preventDefault(); }
  else if (ev.key === 'r' || ev.key === 'R') loadScene(true);
  else if (ev.key === '.') { state.paused = true; syncPause(); stepOnce(); }
  else if (ev.key === 'v' || ev.key === 'V') {
    const i = VIEWS3D.findIndex((v) => v[0] === state.view);
    state.view = VIEWS3D[(i + 1) % VIEWS3D.length][0];
    panel.controls.view.value = state.view;
  } else if (/^[1-9]$/.test(ev.key)) {
    const k = Object.keys(SCENES3D)[Number(ev.key) - 1];
    if (k) { state.scene = k; panel.controls.scene.value = k; loadScene(); }
  }
});

// ---------------------------------------------------------------- main loop
let frame = 0;
let fps = 60;
let stepMs = 0;
let lastFrameT = performance.now();

function stepOnce() {
  applyPointer();
  const before = glc.passCount;
  runner.step();
  passesPerStep = glc.passCount - before;
}

function updateStats(s) {
  if (!s) return;
  readouts.mass.textContent = (s.massRatio * 100).toFixed(4) + ' %';
  readouts.volume.textContent = (s.volumeRatio * 100).toFixed(1) + ' %';
  readouts.gamma.textContent = Number.isFinite(s.gammaMin) ? `${s.gammaMin.toFixed(2)} – ${s.gammaMax.toFixed(2)}` : '–';
  readouts.cfl.textContent = s.cfl.toFixed(1);
  readouts.res.textContent = s.residual.toExponential(1);
  readouts.perf.textContent = `${stepMs > 0 ? stepMs.toFixed(1) + ' ms' : '–'} · ${fps.toFixed(0)} fps`;
  plot.push(s.time, s.massRatio, s.volumeRatio);
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
    renderer.render(runner, camera, { view: state.view, postProcess: state.postProcess });
    if (frame % 6 === 0 && glc.readback !== 'scrambled') runner.sim.measure().then(updateStats).catch(() => {});
    const g = runner.sim.grid;
    hud.textContent = `${g.n[0]}×${g.n[1]}×${g.n[2]}  t = ${runner.time.toFixed(2)} s${state.paused ? '  (paused)' : ''}\n${passesPerStep} GPU shader passes / step`;
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
  renderer = new Renderer3D(glc);
  scene = buildScene3D(SCENES3D[state.scene], state.N);
  runner = new Runner(glc, 3, scene, state.overrides);
  window.runner = runner;
  frameCamera();
  fitCanvas();
  panel = buildPanel();
  if (glc.readback === 'scrambled') {
    notice('This browser returns random numbers when a page reads results back from the GPU (Firefox / LibreWolf with ' +
      'privacy.resistFingerprinting on). The liquid is simulated and drawn as usual, but the statistics are unavailable, ' +
      'rigid bodies do not feel the liquid and the tools act at a fixed depth. Turn that setting off in about:config and reload to get them back.');
  }
  window.app = { state, camera, loadScene, stepOnce, get runner() { return runner; } };
  requestAnimationFrame(tick);
} catch (e) {
  fail('This demo needs WebGL2 with float render targets.\n\n' + String(e.stack || e.message || e));
}
