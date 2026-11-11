// Drives the real apps with synthetic mouse input and checks that every interaction does what
// it says: push, pour, drain, spawn + drag bodies, orbit/zoom (3D), scene switching.
//   node tools/interact.mjs [2d|3d] [--shots dir]
import puppeteer from 'puppeteer-core';
import { startServer } from './serve.mjs';

const which = process.argv[2] || '2d';
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const server = await startServer(0);
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-first-run', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', '--window-size=1280,800'],
  defaultViewport: { width: 1280, height: 800 },
});
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://localhost:${port}/${which}.html?scene=still&capture`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__frames > 90 || window.__error, { timeout: 30000 });
  check('app starts', !(await page.evaluate(() => window.__error)), await page.evaluate(() => window.__error || ''));

  const stats = () => page.evaluate(() => { const s = window.runner.sim.measureSync(); return { mass: s.mass, cfl: s.cfl, vol: s.volumeRatio, massRatio: s.massRatio }; });
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
  const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${which}_${name}.png` }); };

  const s0 = await stats();
  check('still pool is at rest', s0.cfl < 0.08, `CFL ${s0.cfl.toFixed(3)}`);

  // push: drag through the pool
  await tool('push');
  const yPool = which === '2d' ? 0.9 : 0.62;
  await drag(at(0.3, yPool), at(0.7, yPool), 14);
  await sleep(150);
  const s1 = await stats();
  check('push tool moves the liquid', s1.cfl > 0.2, `CFL ${s1.cfl.toFixed(2)}`);
  check('push tool conserves mass', Math.abs(s1.mass / s0.mass - 1) < 1e-4, `mass x${(s1.mass / s0.mass).toFixed(6)}`);
  await shot('push');

  // pour
  await tool('pour');
  await drag(at(0.45, 0.3), at(0.55, 0.3), 10, 'left', 400);
  await sleep(100);
  const s2 = await stats();
  check('pour tool adds liquid', s2.mass > s1.mass * 1.004, `mass x${(s2.mass / s1.mass).toFixed(3)}`);
  await shot('pour');

  // drain
  await tool('drain');
  await sleep(600);
  const s2b = await stats();
  await drag(at(0.35, yPool), at(0.65, yPool), 20, 'left', 300);
  await sleep(100);
  const s3 = await stats();
  check('drain tool removes liquid', s3.mass < s2b.mass * 0.99, `mass x${(s3.mass / s2b.mass).toFixed(3)}`);

  // bodies: spawn, then grab and drag
  await tool('ball');
  await page.mouse.click(...at(0.5, 0.35));
  await tool('box');
  await page.mouse.click(...at(0.3, 0.3));
  await sleep(200);
  const nb = await page.evaluate(() => window.runner.bodies.length);
  check('click spawns rigid bodies', nb === 2, `${nb} bodies`);
  await sleep(1500);
  await shot('bodies');
  const bodyScreen = async (i) => page.evaluate((i, is3d) => {
    const b = window.runner.bodies[i];
    if (!is3d) { const sc = window.runner.scene; return [b.pos[0] / sc.nx, 1 - b.pos[1] / sc.ny]; }
    const cam = window.app.camera;
    const { pos, right, up, fwd } = cam.basis();
    const d = [b.pos[0] - pos[0], b.pos[1] - pos[1], b.pos[2] - pos[2]];
    const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    const z = dot(d, fwd);
    const cv = document.getElementById('view');
    const asp = cv.width / cv.height;
    return [(dot(d, right) / (z * cam.fov * asp)) * 0.5 + 0.5, 0.5 - (dot(d, up) / (z * cam.fov)) * 0.5];
  }, i, which === '3d');
  await tool('push');
  const b0 = await bodyScreen(0);
  const p0 = await page.evaluate(() => [...window.runner.bodies[0].pos]);
  await page.mouse.move(...at(b0[0], b0[1]));
  await page.mouse.down();
  const grabbed = await page.evaluate(() => !!window.runner.grabbedBody);
  for (let i = 1; i <= 20; i++) { await page.mouse.move(...at(b0[0] + 0.2 * i / 20, b0[1] - 0.25 * i / 20)); await sleep(16); }
  await sleep(200);
  const p1 = await page.evaluate(() => [...window.runner.bodies[0].pos]);
  await page.mouse.up();
  const moved = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  check('bodies can be grabbed', grabbed);
  check('grabbed body follows the pointer', moved > 3, `moved ${moved.toFixed(1)} cells`);
  await shot('drag');

  if (which === '3d') {
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
  }

  // every scene loads and runs for a while without errors or non-finite values
  const scenes = await page.evaluate(() => [...document.querySelector('#c-scene').options].map((o) => o.value));
  for (const sc of scenes) {
    await page.evaluate((v) => { const s = document.querySelector('#c-scene'); s.value = v; s.dispatchEvent(new Event('change')); }, sc);
    const f0 = await page.evaluate(() => window.__frames);
    await page.waitForFunction((f) => window.__frames > f + 90 || window.__error, { timeout: 60000 }, f0);
    const s = await page.evaluate(() => { const s = window.runner.sim.measureSync(); return { mass: s.massRatio, vol: s.volumeRatio, cfl: s.cfl, rmax: s.maxRhoP, err: window.__error || null }; });
    const emits = await page.evaluate(() => (window.runner.scene.emitters || []).length > 0);
    const ok = !s.err && Number.isFinite(s.mass) && Number.isFinite(s.cfl) && s.cfl < 40 && (emits || Math.abs(s.mass - 1) < 1e-3);
    check(`scene "${sc}" runs`, ok, `mass ${(s.mass * 100).toFixed(4)}%  volume ${(s.vol * 100).toFixed(1)}%  CFL ${s.cfl.toFixed(1)}${s.err ? '  ' + s.err : ''}`);
    await shot('scene_' + sc);
  }
  // the first scene at the highest resolution in the menu, watched through its first seconds
  // (the deepest grid hierarchy and the largest scatter passes the app can be asked for)
  const top = await page.evaluate(() => { const o = [...document.querySelector('#c-n').options]; return o[o.length - 1].value; });
  await page.evaluate((v, n) => {
    const s = document.querySelector('#c-scene'); s.value = v; s.dispatchEvent(new Event('change'));
    const r = document.querySelector('#c-n'); r.value = n; r.dispatchEvent(new Event('change'));
  }, scenes[0], top);
  const w = { cfl: 0, rmax: 0, vlo: 1, vhi: 1, dm: 0, bad: null };
  const fTop = await page.evaluate(() => window.__frames);
  for (let k = 1; k <= 12 && !w.bad; k++) {
    await page.waitForFunction((f) => window.__frames >= f || window.__error, { timeout: 120000 }, fTop + 25 * k);
    const s = await page.evaluate(() => { const s = window.runner.sim.measureSync(); return { mass: s.massRatio, vol: s.volumeRatio, cfl: s.cfl, rmax: s.maxRhoP, err: window.__error || null }; });
    if (s.err || ![s.mass, s.vol, s.cfl, s.rmax].every(Number.isFinite)) { w.bad = s.err || 'non-finite state'; break; }
    w.cfl = Math.max(w.cfl, s.cfl); w.rmax = Math.max(w.rmax, s.rmax);
    w.vlo = Math.min(w.vlo, s.vol); w.vhi = Math.max(w.vhi, s.vol); w.dm = Math.max(w.dm, Math.abs(s.mass - 1));
  }
  check(`scene "${scenes[0]}" at ${top} cells stays bounded for 300 steps`,
    !w.bad && w.cfl < 40 && w.dm < 1e-3 && w.vlo > 0.8 && w.vhi < 1.25,
    w.bad || `CFL <= ${w.cfl.toFixed(1)}  rho' <= ${w.rmax.toFixed(1)}  volume ${(w.vlo * 100).toFixed(1)}-${(w.vhi * 100).toFixed(1)}%  mass drift ${w.dm.toExponential(1)}`);
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
