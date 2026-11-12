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
  // (how fast depends on the frame rate, which sets how many steps the push acts for: 0.34 to 0.55
  // cells per step in headless Firefox, 0.54 to 0.80 in Chrome)
  check('push tool moves the liquid', v1 > v0 + 0.1, `fastest ${v0.toFixed(2)} -> ${v1.toFixed(2)} cells per step`);
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
    // (a scene with a sea keeps its books above the water at rest: World.balance; what it stores is
    // one island round whatever moves, which fills the box around itself, so sparsity is not asked of it)
    // (with a height field: all the water there is, the height field's and the 3D solver's)
    const bal = err ? 0 : await page.evaluate(async () => {
      const w = window.world;
      const off = await w.balanceSettled();
      const tr = w.tiers();
      let solved = 0;
      if (tr) for (const t of tr.tier) if ((t & 3) === 3) solved++;
      return { off, stored: w.sim.books.stored, sea: w.sim.water.length > 0, hf: !!w.hf, water: w.sim.hfWater, solved };
    });
    const shown = err ? '' : await page.evaluate(() => document.querySelector('#panel').innerText.match(/Unaccounted for\s*([^\n]+)/)?.[1] || '');
    const perf = err ? '' : await page.evaluate(() => document.querySelector('#panel').innerText.match(/Step \/ frame\s*([^\n]+)/)?.[1] || '');
    const off = !s ? 1 : bal.hf ? Math.abs(bal.off) / Math.max(bal.water, 1) : bal.sea ? Math.abs(bal.off) / Math.max(bal.stored, 1) : Math.abs(m0 + s.added - s.removed - s.freed - s.mass) / Math.max(m0 + s.added, 1);
    // (a height field needs no brick at all while nothing in view asks for one)
    const ok = !err && Number.isFinite(s.mass) && s.cfl < 14 && off < 1e-4 && s.refused === 0 && (bal.hf || s.bricks > 0) && (bal.sea || bal.hf || s.cells < 0.8 * s.box);
    check(`scene "${sc}" runs`, ok, err || `${s.bricks} bricks = ${(s.cells / 1e6).toFixed(2)} M cells (${(100 * s.cells / Math.max(s.box, 1)).toFixed(0)} % of the box around them), ` +
      (bal.hf ? `${(bal.water / 1e6).toFixed(2)} M cells of water on the map, ${bal.solved} columns of bricks solved in 3D, ` : '') +
      `books off by ${off.toExponential(1)} (shown: ${shown}), fastest ${s.cfl.toFixed(1)} cells per step, ${perf}`);
    await shot('scene_' + sc);
  }
  // a height field: the water around the view target is solved in 3D, and goes back to the map
  // when the view moves on (the target is set as a Ctrl-drag would set it)
  // (what was pinned by the view stays solved for 2 s after it has left: pinHold)
  await page.goto(`http://localhost:${port}/world3d.html?scene=surf&capture`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.world?.time > 2 || window.__error, { timeout: 300000 });
  const solvedAround = (p) => page.evaluate((p) => {
    const w = window.world, tr = w.tiers(), B = w.sim.B;
    let n = 0;
    for (let k = 0; k < tr.tier.length; k++) {
      if ((tr.tier[k] & 3) !== 3) continue;
      const i = k % tr.n[0], j = (k - i) / tr.n[0];
      if (Math.hypot((tr.origin[0] + i + 0.5) * B - p[0], (tr.origin[1] + j + 0.5) * B - p[2]) < 100) n++;
    }
    return n;
  }, p);
  const t0 = await page.evaluate(() => window.app.camera.target.slice());
  const here0 = await solvedAround(t0);
  check('the water around the view target is solved in 3D', here0 > 50, `${here0} columns of bricks within 10 m of it`);
  const t1 = [t0[0], t0[1], t0[2] + 220];
  const tm = await page.evaluate((t) => { window.app.camera.target = t; return window.world.time; }, t1);
  await page.waitForFunction((t) => window.world.time > t + 4 || window.__error, { timeout: 300000 }, tm);
  const there = await solvedAround(t1), left = await solvedAround(t0);
  check('it follows the view', there > 50 && left === 0, `4 s after the target moved 22 m along the beach: ${there} columns solved around it, ${left} left where it was`);
  const hb = await page.evaluate(async () => {
    const w = window.world;
    return { off: await w.balanceSettled(), water: w.sim.hfWater, evicted: w.sim.evicted, refused: w.sim.refused };
  });
  check('handing the water over and back loses none', Math.abs(hb.off) < 1e-5 * hb.water && hb.refused === 0, `off by ${hb.off.toFixed(2)} of ${(hb.water / 1e6).toFixed(2)} M cells`);
  await shot('handover');

  // the crate tool: a crate dropped into the open sea lands in it, and its water is stored
  await page.goto(`http://localhost:${port}/world3d.html?scene=sea&capture`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.world?.time > 0.2 || window.__error, { timeout: 120000 });
  await tool('crate');
  const n0 = await page.evaluate(() => window.world.bodies.length);
  await page.mouse.click(...at(0.3, 0.62));
  await page.waitForFunction(() => window.world.time > 3.5 || window.__error, { timeout: 300000 });
  const cr = await page.evaluate(() => {
    const w = window.world, b = w.bodies[w.bodies.length - 1], set = w.sim.levels[0].set, B = w.sim.B;
    return { n: w.bodies.length, y: b.pos[1] - w.scene.water[0].level, here: set.get(Math.floor(b.pos[0] / B), Math.floor((b.pos[1] - 2) / B), Math.floor(b.pos[2] / B)) >= 0,
      shown: document.querySelector('#panel').innerText.match(/Bodies awake\s*([^\n]+)/)?.[1] || '' };
  });
  check('crate tool drops a crate into the sea', cr.n === n0 + 1 && Math.abs(cr.y) < 6 && cr.here, `${cr.n} bodies, the new one ${cr.y.toFixed(1)} cells above the surface, its water ${cr.here ? 'stored' : 'not stored'} (bodies awake: ${cr.shown})`);
  await shot('crate');

  // ... and on water that is a height field: the lake of the spring scene, far from the view target.
  // The water under it is solved for as long as it moves; it comes to rest at its float line.
  await page.goto(`http://localhost:${port}/world3d.html?scene=spring&capture`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.world?.time > 1 || window.__error, { timeout: 120000 });
  const lake = await page.evaluate(() => {
    const w = window.world, level = w.scene.marks.lake;
    window.__crate = w.addBody({ shape: 'box', pos: [280, level + 20, 60], half: [5, 4, 5], round: 1, density: 0.45, color: 1 });
    return { level, t: w.time };
  });
  await page.waitForFunction((t) => window.world.time > t + 14 || window.__error, { timeout: 300000 }, lake.t);
  const fl = await page.evaluate(async () => {
    const w = window.world, b = window.__crate;
    return { y: b.pos[1], v: Math.hypot(...b.vel), asleep: b.asleep, off: await w.balanceSettled(), water: w.sim.hfWater, refused: w.sim.refused };
  });
  // (8 cells high, 0.45 of the water's density: 3.6 cells of it under water)
  const line = lake.level + 4 - 0.45 * 8;
  check('a crate dropped on the lake of a height field floats', Math.abs(fl.y - line) < 0.5 && fl.v < 1 && Math.abs(fl.off) < 1e-5 * fl.water && fl.refused === 0,
    `14 s later ${(fl.y - line).toFixed(2)} cells above its float line, ${fl.asleep ? 'asleep' : `moving at ${fl.v.toFixed(2)} cells/s`}; books off by ${fl.off.toFixed(2)} of ${(fl.water / 1e3).toFixed(0)} k cells`);
  await shot('crate_lake');
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
