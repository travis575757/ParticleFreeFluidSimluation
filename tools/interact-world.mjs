// Drives the World app with synthetic mouse input: bricks appear where the water goes, the
// books balance, pour / drain / push act where the pointer is, the camera moves, every scene runs.
//   node tools/interact.mjs world [--shots dir] [--browser chrome|firefox|librewolf] [--pref name=value ...]
import { startServer } from './serve.mjs';
import { launch, browserArgs } from './browser.mjs';

const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const server = await startServer(0);
const port = server.address().port;
const browser = await launch({ ...browserArgs(process.argv), width: 1280, height: 800 });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  // the cascade with its source stopping after 0.8 s: the top basin then holds water that calms down
  await page.goto(`http://localhost:${port}/world3d.html?scene=cascade&until=0.8&capture`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__frames > 30 || window.__error, { timeout: 60000 });
  check('app starts', !(await page.evaluate(() => window.__error)), await page.evaluate(() => window.__error || ''));
  await page.waitForFunction(() => window.world.time > 9 || window.__error, { timeout: 180000 });

  // the state of the books: liquid in (sources, pour) - out (drains) - evaporated against what is stored
  const stats = () => page.evaluate(async () => {
    const w = window.world, sim = w.sim;
    await sim.settleLedger();
    const s = sim.measureSync();
    return { mass: s.mass, cfl: s.maxSpeed * sim.params.dt, added: sim.added, removed: sim.removed, freed: sim.freedMass,
      bricks: sim.bricks, cells: sim.storedCells, box: w.boundsCells(), refused: sim.refused, time: w.time };
  });
  // the fastest liquid, cells per step: the median of a few frames (one drop going over a rim
  // is fast for a moment)
  const speed = () => page.evaluate(async () => {
    const sim = window.world.sim, v = [];
    for (let i = 0; i < 9; i++) { v.push(sim.measureSync().maxSpeed * sim.params.dt); await new Promise((r) => setTimeout(r, 50)); }
    return v.sort((a, b) => a - b)[4];
  });
  const box = await (await page.$('#view')).boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  const tool = (name) => page.evaluate((n) => { [...document.querySelectorAll('.seg button')].find((b) => b.dataset.v === n).click(); }, name);
  const drag = async (from, to, steps = 12, button = 'left', hold = 0) => {
    await page.mouse.move(...from);
    await page.mouse.down({ button });
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps);
      await sleep(16);
    }
    if (hold) await sleep(hold);
    await page.mouse.up({ button });
  };
  const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/world_${name}.png` }); };
  // where a point of the world is on screen (fractions of the view)
  const screen = (p) => page.evaluate((p) => {
    const cam = window.app.camera;
    const { pos, right, up, fwd } = cam.basis();
    const d = [p[0] - pos[0], p[1] - pos[1], p[2] - pos[2]];
    const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    const z = dot(d, fwd);
    const cv = document.getElementById('view');
    return [(dot(d, right) / (z * cam.fov * cv.width / cv.height)) * 0.5 + 0.5, 0.5 - (dot(d, up) / (z * cam.fov)) * 0.5];
  }, p);
  const floor0 = 122;      // floor of the top basin (src/world/scenes.js)

  const s0 = await stats();
  check('bricks are stored where the water is', s0.bricks > 20 && s0.cells < 0.8 * s0.box, `${s0.bricks} bricks, ${(s0.cells / 1e6).toFixed(2)} M cells of ${(s0.box / 1e6).toFixed(2)} M in the box around them`);
  const off0 = Math.abs(s0.added - s0.removed - s0.freed - s0.mass) / s0.added;
  check('liquid in = stored + out', off0 < 1e-4, `in ${s0.added.toFixed(1)}, out ${s0.removed.toFixed(1)}, stored ${s0.mass.toFixed(1)} (off by ${off0.toExponential(1)})`);
  const v0 = await speed();
  check('the water in the top basin has calmed down', v0 < 0.5, `fastest ${v0.toFixed(2)} cells per step`);
  await shot('start');

  // push: drag through the water of the top basin
  await tool('push');
  const a = await screen([14, floor0 + 3, -14]), b = await screen([40, floor0 + 3, 14]);
  await drag(at(...a), at(...b), 14);
  const v1 = await speed();
  const s1 = await stats();
  check('push tool moves the liquid', v1 > v0 + 0.15, `fastest ${v0.toFixed(2)} -> ${v1.toFixed(2)} cells per step`);
  check('push tool conserves mass', Math.abs(s1.mass + s1.freed - s0.mass - s0.freed) < 1e-4 * s0.mass, `mass x${(s1.mass / s0.mass).toFixed(6)}`);
  await shot('push');

  // pour: onto the dry floor of the third basin
  await tool('pour');
  const c = await screen([2 * 64 + 26, floor0 - 44 + 1, 0]);
  await page.mouse.move(...at(...c));
  await sleep(300);
  await drag(at(...c), at(c[0] + 0.01, c[1]), 4, 'left', 500);
  await sleep(200);
  const s2 = await stats();
  check('pour tool adds liquid', s2.added > s1.added + 50, `${(s2.added - s1.added).toFixed(0)} cells of liquid`);
  check('bricks are stored where it lands', s2.bricks > s1.bricks, `${s1.bricks} -> ${s2.bricks} bricks`);
  await shot('pour');

  // drain: in the top basin
  await tool('drain');
  const d = await screen([28, floor0 + 2, 0]);
  await page.mouse.move(...at(...d));
  await sleep(300);
  await drag(at(...d), at(d[0] + 0.02, d[1]), 10, 'left', 400);
  await sleep(100);
  const s3 = await stats();
  check('drain tool removes liquid', s3.removed > s2.removed + 50, `${(s3.removed - s2.removed).toFixed(0)} cells of liquid`);
  const off3 = Math.abs(s3.added - s3.removed - s3.freed - s3.mass) / s3.added;
  check('the books still balance', off3 < 1e-4, `off by ${off3.toExponential(1)}`);

  check('the app is still running', !(await page.evaluate(() => window.__error)), (await page.evaluate(() => window.__error || '')).slice(0, 600));

  // camera
  const yaw0 = await page.evaluate(() => window.app.camera.yaw);
  await drag(at(0.2, 0.15), at(0.5, 0.2), 10, 'right');
  const yaw1 = await page.evaluate(() => window.app.camera.yaw);
  check('right-drag orbits the camera', Math.abs(yaw1 - yaw0) > 0.2, `yaw ${yaw0.toFixed(2)} -> ${yaw1.toFixed(2)}`);
  const d0 = await page.evaluate(() => window.app.camera.dist);
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.wheel({ deltaY: -400 });
  await sleep(50);
  const d1 = await page.evaluate(() => window.app.camera.dist);
  check('wheel zooms', d1 < d0 * 0.9, `dist ${d0.toFixed(0)} -> ${d1.toFixed(0)}`);

  // every scene loads, runs and keeps its books (sources running)
  const scenes = await page.evaluate(() => [...document.querySelector('#c-scene').options].map((o) => o.value));
  for (const sc of scenes) {
    await page.goto(`http://localhost:${port}/world3d.html?scene=${sc}&capture`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.world?.time > 4 || window.__error, { timeout: 300000 });
    const err = await page.evaluate(() => window.__error || null);
    const s = err ? null : await stats();
    const m0 = err ? 0 : await page.evaluate(() => window.world.mass0);
    const shown = err ? '' : await page.evaluate(() => document.querySelector('#panel').innerText.match(/In − out − stored\s*([^\n]+)/)?.[1] || '');
    const perf = err ? '' : await page.evaluate(() => document.querySelector('#panel').innerText.match(/Step \/ frame\s*([^\n]+)/)?.[1] || '');
    const off = s ? Math.abs(m0 + s.added - s.removed - s.freed - s.mass) / Math.max(m0 + s.added, 1) : 1;
    const ok = !err && Number.isFinite(s.mass) && s.cfl < 14 && off < 1e-4 && s.refused === 0 && s.bricks > 0 && s.cells < 0.8 * s.box;
    check(`scene "${sc}" runs`, ok, err || `${s.bricks} bricks = ${(s.cells / 1e6).toFixed(2)} M cells (${(100 * s.cells / s.box).toFixed(0)} % of the box around them), ` +
      `books off by ${off.toExponential(1)} (shown: ${shown}), fastest ${s.cfl.toFixed(1)} cells per step, ${perf}`);
    await shot('scene_' + sc);
  }
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  console.log('FAIL  harness error: ' + (e.stack || e.message));
  failures++;
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
