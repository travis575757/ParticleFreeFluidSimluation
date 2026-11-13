// World application in 2D: a section through a world (src/world) seen from the side. The
// scenes here are about hulls: bodies with a shape of their own (src/world/hull.js) that can
// be holed.
import { GLContext } from '../gl.js';
import { World } from './world.js';
import { WorldRenderer2D } from './render2d.js';
import { WORLD_SCENES_2D } from './scenes.js';
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
  scene: q.get('scene') in WORLD_SCENES_2D ? q.get('scene') : 'flood',
  paused: q.has('paused'),
  tool: 'hole',
  brush: 2.5,               // radius in cells: of a hole, of what is poured or drained
  overlay: q.has('bricks'),
  stepsPerFrame: Number(q.get('spf')) || 2,
  overrides: {},
};
for (const [k, v] of q) if (k.startsWith('p.')) state.overrides[k.slice(2)] = Number(v);

let glc, renderer, world, readouts, panel;
const view = { center: [0, 0], width: 200 };
const pointer = { down: false, pan: false, at: [0, 0], last: null, inside: false };

function loadScene(keepView = false) {
  if (world) world.dispose();
  // &first=, &second=: when the scene makes its holes (seconds; by default the second is left to the mouse)
  const when = {};
  for (const k of ['first', 'second']) if (q.has(k)) when[k] = Number(q.get(k));
  const scene = WORLD_SCENES_2D[state.scene].build(when);
  world = new World(glc, 2, scene, { params: state.overrides });
  window.world = world;
  if (!keepView) { view.center = scene.view.center.slice(); view.width = Number(q.get('width')) || scene.view.width; }
  const blurb = document.getElementById('blurb');
  if (blurb) blurb.textContent = WORLD_SCENES_2D[state.scene].blurb;
}

function fitCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const w = Math.max(64, Math.round(stage.clientWidth * dpr));
  const h = Math.max(64, Math.round(stage.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

// ---------------------------------------------------------------- pointer
/** The point of the world under a pointer event (cells). */
function worldOf(ev) {
  const r = canvas.getBoundingClientRect();
  const cpp = view.width / r.width;
  return [view.center[0] + (ev.clientX - r.left - 0.5 * r.width) * cpp, view.center[1] - (ev.clientY - r.top - 0.5 * r.height) * cpp];
}
const point3 = (p) => [p[0], p[1], 0.5];

canvas.addEventListener('pointerdown', (ev) => {
  canvas.setPointerCapture(ev.pointerId);
  pointer.down = true;
  pointer.at = worldOf(ev);
  pointer.last = [ev.clientX, ev.clientY];
  pointer.pan = ev.button !== 0 || ev.shiftKey || ev.ctrlKey;
  canvas.style.cursor = pointer.pan ? 'grabbing' : 'crosshair';
  if (!pointer.pan && state.tool === 'hole') hole(pointer.at);
  ev.preventDefault();
});
canvas.addEventListener('pointermove', (ev) => {
  if (pointer.down && pointer.pan && pointer.last) {
    const cpp = view.width / canvas.getBoundingClientRect().width;
    view.center[0] -= (ev.clientX - pointer.last[0]) * cpp;
    view.center[1] += (ev.clientY - pointer.last[1]) * cpp;
  }
  pointer.last = [ev.clientX, ev.clientY];
  pointer.at = worldOf(ev);
  pointer.inside = true;
});
const end = () => { pointer.down = false; pointer.pan = false; canvas.style.cursor = 'crosshair'; };
canvas.addEventListener('pointerup', end);
canvas.addEventListener('pointercancel', end);
canvas.addEventListener('pointerleave', () => { pointer.inside = false; });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('wheel', (ev) => {
  // (about the point under the pointer)
  const at = worldOf(ev), k = Math.exp(ev.deltaY * 0.001);
  const width = Math.min(Math.max(view.width * k, 40), 4000), s = width / view.width;
  view.center = [at[0] + (view.center[0] - at[0]) * s, at[1] + (view.center[1] - at[1]) * s];
  view.width = width;
  ev.preventDefault();
}, { passive: false });

/** A hole through the hull under p, if there is one. */
function hole(p) {
  return world.breachAt(point3(p), state.brush, 1.5);
}

function applyPointer() {
  if (!pointer.down || pointer.pan) return;
  const r = Math.max(state.brush, 3);
  if (state.tool === 'pour') world.pour(point3(pointer.at), [0, -20, 0], r);
  else if (state.tool === 'drain') world.erase(point3(pointer.at), r);
}

// ---------------------------------------------------------------- panel
function buildPanel() {
  const P = new Panel(document.getElementById('panel'));
  const setParam = (k, v) => { state.overrides[k] = v; world.sim.params[k] = v; };

  P.section('Scenario');
  P.select('scene', 'Scene', Object.entries(WORLD_SCENES_2D).map(([k, s]) => [k, s.title]), state.scene, (v) => { state.scene = v; loadScene(); });
  const blurb = P.note(WORLD_SCENES_2D[state.scene].blurb, 'note blurb');
  blurb.id = 'blurb';
  P.buttons([
    { label: 'Restart', title: 'Restart the scene (R)', onClick: () => loadScene(true), primary: true },
    { id: 'pause', label: state.paused ? 'Resume' : 'Pause', title: 'Space', onClick: togglePause },
    { label: 'Step', title: 'Advance one step (.)', onClick: () => { state.paused = true; syncPause(); stepOnce(); } },
  ]);

  P.section('Mouse');
  P.segmented('tool', [
    ['hole', 'Hole', 'Click on a hull to make a hole through it'],
    ['pour', 'Pour', 'Hold to add liquid under the pointer'],
    ['drain', 'Drain', 'Hold to remove liquid'],
  ], state.tool, (v) => { state.tool = v; });
  P.slider('brush', 'Size (cells)', { min: 1.5, max: 6, step: 0.5, value: state.brush }, (v) => { state.brush = v; });
  P.note('Right-drag or Shift-drag moves the view, the wheel zooms.');

  P.section('View');
  P.checkbox('bricks', 'Show the stored bricks', state.overlay, (v) => { state.overlay = v; },
    'Outlines of the 16 x 16 cell bricks that are stored: blue where the water is solved, amber where it is at rest and kept but not solved. The rest of the sea is not stored at all.');

  P.section('Storage');
  readouts = P.stats([
    ['bricks', 'Bricks stored', 'Bricks of 16 x 16 cells that exist right now, and how many of them hold water at rest that is kept but not solved'],
    ['hull', 'Hull', 'Its trim, how deep the middle of its keel lies under the sea, and whether it is being stepped (a hull that has come to rest sleeps)'],
    ['holes', 'Holes', 'Holes made in it so far'],
    ['couple', 'Coupling', 'Iterations in which hull and pressure were made to agree in the last step, and the hull\'s added mass in heave in units of its own mass'],
    ['budget', 'Unaccounted for', 'Liquid above the water at rest, with what the bodies displace and what the water at rest has taken in, against what the scene started with: zero if nothing is lost (cells of liquid)'],
    ['cfl', 'Fastest liquid', 'Largest liquid speed in cells per time step'],
    ['perf', 'Step / frame', 'GPU time of one simulation step and frame rate'],
    ['gpu', 'Runs on', 'The whole solver executes as WebGL2 shader passes on this GPU'],
  ]);
  readouts.gpu.textContent = gpuName();
  readouts.gpu.title = glc.renderer;

  P.section('Solver', { collapsible: true, open: false });
  const p = world.sim.params;
  P.slider('spf', 'Steps / frame', { min: 1, max: 4, step: 1, value: state.stepsPerFrame }, (v) => { state.stepsPerFrame = v; });
  P.slider('vc', 'V-cycles / step', { min: 1, max: 8, step: 1, value: p.vcycles }, (v) => setParam('vcycles', v));

  P.section('Keys', { collapsible: true, open: false });
  const keys = P.note('');
  keys.innerHTML = '<kbd>Space</kbd> pause · <kbd>R</kbd> restart · <kbd>.</kbd> single step · <kbd>B</kbd> bricks';
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
});

// ---------------------------------------------------------------- main loop
let frame = 0;
let fps = 60;
let stepMs = 0;
let lastFrameT = performance.now();
let passesPerStep = 0;

function stepOnce() {
  applyPointer();
  const before = glc.passCount;
  world.step();
  passesPerStep = glc.passCount - before;
}

function updateStats() {
  const sim = world.sim, rep = sim.report, dt = sim.params.dt;
  readouts.bricks.textContent = `${sim.bricks} · ${sim.nHeld} at rest`;
  const b = world.hulls[0];
  if (b) {
    const up = b.toWorldDir([0, 1, 0]), m = world.scene.marks;
    const keel = m ? m.level - b.fromDrawing([0, -m.ship.b, 0])[1] : 0;
    readouts.hull.textContent = `trim ${(Math.atan2(-up[0], up[1]) * 180 / Math.PI).toFixed(1)}° · keel ${keel.toFixed(1)} under · ${b.asleep ? 'asleep' : `${(Math.hypot(...b.vel) * dt).toFixed(3)} cells/step`}`;
    readouts.holes.textContent = String(b.holes || 0);
    const cp = world.coupler;
    readouts.couple.textContent = cp && cp.changes ? `${b.asleep ? 0 : cp.changes.length} · added mass ${b.addedMatrix ? (b.addedMatrix[4] / b.mass).toFixed(1) : '–'}` : '–';
  }
  const bk = sim.books;
  if (bk) readouts.budget.textContent = `${world.balance().toFixed(2)} of ${Math.round(bk.stored)}`;
  if (rep) readouts.cfl.textContent = (rep.maxSpeed * dt).toFixed(2);
  readouts.perf.textContent = `${stepMs > 0 ? stepMs.toFixed(1) + ' ms' : '–'} · ${fps.toFixed(0)} fps`;
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
    const show = pointer.inside || pointer.down;
    renderer.render(world, view, { bricks: state.overlay, cursor: show ? [pointer.at[0], pointer.at[1], state.tool === 'hole' ? state.brush : Math.max(state.brush, 3), 0.6] : null });
    if (frame % 6 === 0) {
      world.readBooksAsync();
      updateStats();
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
  renderer = new WorldRenderer2D(glc);
  loadScene();
  fitCanvas();
  panel = buildPanel();
  canvas.style.cursor = 'crosshair';
  window.app = { state, view, loadScene, stepOnce, hole, renderer, get world() { return world; } };
  requestAnimationFrame(tick);
} catch (e) {
  fail(String(e.message || e).startsWith('World mode') ? e.message : 'This demo needs WebGL2 with float render targets.\n\n' + String(e.stack || e.message || e));
}
