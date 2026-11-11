// 2D application: scenario selection, mouse interaction, rigid bodies, live diagnostics.
import { GLContext } from './gl.js';
import { Runner } from './runner.js';
import { Renderer2D, VIEWS2D } from './render2d.js';
import { SCENES2D, buildScene } from './scenes2d.js';
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
  scene: q.get('scene') in SCENES2D ? q.get('scene') : 'damBreak',
  N: Number(q.get('n')) || 128,
  paused: q.has('paused'),
  tool: 'push',
  brush: 0.05,              // brush radius in tank units
  view: q.get('view') || 'liquid',
  postProcess: q.has('pp'),
  stepsPerFrame: Number(q.get('spf')) || 1,
  overrides: {},            // solver parameters changed in the panel (kept across scene changes)
};
for (const [k, v] of q) if (k.startsWith('p.')) state.overrides[k.slice(2)] = Number(v);

let glc, renderer, runner, scene, plot, readouts;
const pointer = { down: false, pos: [0, 0, 0.5], vel: [0, 0, 0], last: null, lastT: 0, inside: false, button: 0 };

function loadScene() {
  if (runner) runner.dispose();
  scene = buildScene(SCENES2D[state.scene], state.N);
  runner = new Runner(glc, 2, scene, state.overrides);
  window.runner = runner;
  plot?.clear();
  fitCanvas();
  const blurb = document.getElementById('blurb');
  if (blurb) blurb.textContent = SCENES2D[state.scene].blurb;
}

function fitCanvas() {
  const pad = 28;
  const aw = stage.clientWidth - pad;
  const ah = stage.clientHeight - pad;
  const aspect = scene.nx / scene.ny;
  let w = Math.min(aw, ah * aspect);
  let h = w / aspect;
  w = Math.max(64, Math.floor(w));
  h = Math.max(64, Math.floor(h));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
}

// ---------------------------------------------------------------- pointer
function gridPos(ev) {
  const r = canvas.getBoundingClientRect();
  return [((ev.clientX - r.left) / r.width) * scene.nx, (1 - (ev.clientY - r.top) / r.height) * scene.ny, 0.5];
}
const brushCells = () => state.brush * scene.L;

function spawnBody(shape, pos) {
  const L = scene.L;
  const n = runner.bodies.length;
  const density = [0.45, 0.8, 1.8, 0.3][n % 4];
  const spec = shape === 'ball'
    ? { shape: 'ball', pos, radius: 0.05 * L, density, color: n }
    : { shape: 'box', pos, half: [0.07 * L, 0.045 * L, 1], angle: (n * 0.7) % 3.14, density, color: n };
  if (!runner.addBody(spec)) hud.textContent = 'Solid limit reached. Remove bodies to add more.';
}

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.button = ev.button;
  pointer.pos = gridPos(ev);
  pointer.vel = [0, 0, 0];
  pointer.last = pointer.pos;
  pointer.lastT = performance.now();
  const body = runner.pick(pointer.pos);
  if (body) runner.grab(body, pointer.pos);
  else if (state.tool === 'ball' || state.tool === 'box') spawnBody(state.tool, pointer.pos);
  ev.preventDefault();
});
canvas.addEventListener('pointermove', (ev) => {
  const p = gridPos(ev);
  const now = performance.now();
  if (pointer.last && pointer.down) {
    const dt = Math.max((now - pointer.lastT) / 1000, 1 / 240);
    const v = [(p[0] - pointer.last[0]) / dt, (p[1] - pointer.last[1]) / dt, 0];
    for (let k = 0; k < 2; k++) pointer.vel[k] += 0.5 * (v[k] - pointer.vel[k]);
  }
  pointer.pos = p;
  pointer.last = p;
  pointer.lastT = now;
  pointer.inside = true;
  if (runner.grabbedBody) runner.dragTo(p);
});
const end = () => { pointer.down = false; runner.release(); };
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.addEventListener('pointerleave', () => { pointer.inside = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

function applyPointer() {
  const dt = runner.sim.params.dt;
  const r = brushCells();
  // velocity estimate decays when the pointer rests
  if (performance.now() - pointer.lastT > 60) pointer.vel = [0, 0, 0];
  const vmax = 12 / dt;
  const sp = Math.hypot(pointer.vel[0], pointer.vel[1]);
  const v = sp > vmax ? [pointer.vel[0] * vmax / sp, pointer.vel[1] * vmax / sp, 0] : pointer.vel;
  runner.setBrush([0, 0, 0], [0, 0, 0], 0, 0);
  if (!pointer.down || runner.grabbedBody) return;
  const erase = state.tool === 'drain' || pointer.button === 2;
  if (erase) runner.erase(pointer.pos, r);
  else if (state.tool === 'pour') runner.pour(pointer.pos, [v[0] * 0.6, v[1] * 0.6, 0], r);
  else if (state.tool === 'push') runner.setBrush(pointer.pos, v, r * 1.3, 1.0);
}

// ---------------------------------------------------------------- panel
function buildPanel() {
  const P = new Panel(document.getElementById('panel'));
  const setParam = (k, v) => { state.overrides[k] = v; runner.sim.params[k] = v; };

  P.section('Scenario');
  P.select('scene', 'Scene', Object.entries(SCENES2D).map(([k, s]) => [k, s.title]), state.scene, (v) => { state.scene = v; loadScene(); });
  const blurb = P.note(SCENES2D[state.scene].blurb, 'note blurb');
  blurb.id = 'blurb';
  P.buttons([
    { label: 'Restart', title: 'Restart the scene (R)', onClick: () => loadScene(), primary: true },
    { id: 'pause', label: state.paused ? 'Resume' : 'Pause', title: 'Space', onClick: togglePause },
    { label: 'Step', title: 'Advance one step (.)', onClick: () => { state.paused = true; syncPause(); stepOnce(); } },
  ]);

  P.section('Mouse');
  P.segmented('tool', [
    ['push', 'Push', 'Drag to push the liquid'],
    ['pour', 'Pour', 'Hold to add liquid'],
    ['drain', 'Drain', 'Hold to remove liquid (also: right mouse button)'],
    ['ball', '+ Ball', 'Click to drop a rigid ball'],
    ['box', '+ Box', 'Click to drop a rigid box'],
  ], state.tool, (v) => { state.tool = v; });
  P.slider('brush', 'Brush size', { min: 0.02, max: 0.15, step: 0.005, value: state.brush, fmt: (v) => v.toFixed(3) }, (v) => { state.brush = v; });
  P.note('Rigid bodies can always be grabbed, dragged and thrown.');
  P.buttons([{ label: 'Remove bodies', onClick: () => runner.removeBodies() }]);

  P.section('View');
  P.select('view', 'Show', VIEWS2D, state.view, (v) => { state.view = v; });
  P.checkbox('pp', 'Reveal sub-grid detail (Sec. 3.8)', state.postProcess, (v) => { state.postProcess = v; },
    'Density post-processing: thin sheets and droplets with density below 0.5 are scaled up so they appear in the iso-contour.');

  P.section('Conservation');
  readouts = P.stats([
    ['mass', 'Mass', 'Total density relative to the initial value'],
    ['volume', 'Volume (0.5 iso)', 'Volume enclosed by the 0.5 iso-contour relative to the initial value'],
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
    el('span', {}, el('i', { style: 'background:#39c5cf' }), 'volume of the 0.5 iso-contour')));
  plot = new ConservationPlot(pc);

  P.section('Solver', { collapsible: true, open: false });
  const p = runner.sim.params;
  P.select('n', 'Resolution', [[64, '64'], [96, '96'], [128, '128 (paper, Fig. 2)'], [192, '192'], [256, '256'], [384, '384']], state.N, (v) => { state.N = Number(v); loadScene(); });
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

let panel;
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
  else if (ev.key === 'r' || ev.key === 'R') loadScene();
  else if (ev.key === '.') { state.paused = true; syncPause(); stepOnce(); }
  else if (ev.key === 'v' || ev.key === 'V') {
    const i = VIEWS2D.findIndex((v) => v[0] === state.view);
    state.view = VIEWS2D[(i + 1) % VIEWS2D.length][0];
    panel.controls.view.value = state.view;
  } else if (/^[1-9]$/.test(ev.key)) {
    const k = Object.keys(SCENES2D)[Number(ev.key) - 1];
    if (k) { state.scene = k; panel.controls.scene.value = k; loadScene(); }
  }
});
window.addEventListener('resize', () => fitCanvas());

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
    const showCursor = pointer.inside && !runner.grabbedBody && ['push', 'pour', 'drain'].includes(state.tool);
    renderer.render(runner, {
      view: state.view, postProcess: state.postProcess,
      cursor: showCursor ? [pointer.pos[0], pointer.pos[1], brushCells() * (state.tool === 'push' ? 1.3 : 1), pointer.down ? 0.5 : 0.22] : [0, 0, 0, 0],
    });
    if (frame % 6 === 0 && glc.readback !== 'scrambled') runner.sim.measure().then(updateStats).catch(() => {});
    const g = runner.sim.grid;
    hud.textContent = `${g.n[0]}×${g.n[1]}  t = ${runner.time.toFixed(2)} s${state.paused ? '  (paused)' : ''}\n${passesPerStep} GPU shader passes / step`;
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
  renderer = new Renderer2D(glc);
  scene = buildScene(SCENES2D[state.scene], state.N);
  runner = new Runner(glc, 2, scene, state.overrides);
  window.runner = runner;
  fitCanvas();
  panel = buildPanel();
  if (glc.readback === 'scrambled') {
    notice('This browser returns random numbers when a page reads results back from the GPU (Firefox / LibreWolf with ' +
      'privacy.resistFingerprinting on). The liquid is simulated and drawn as usual, but the statistics are unavailable, ' +
      'rigid bodies do not feel the liquid. Turn that setting off in about:config and reload to get them back.');
  }
  window.app = { state, loadScene, stepOnce, get runner() { return runner; } };
  requestAnimationFrame(tick);
} catch (e) {
  fail('This demo needs WebGL2 with float render targets.\n\n' + String(e.message || e));
}
