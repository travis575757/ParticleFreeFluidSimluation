// Regenerates the README screenshots in docs/screenshots/ from the real apps. The simulation
// view alone is captured from a paused app stepped a fixed number of times, so those pictures
// are reproducible; the whole-page shots are taken from the running app.
//   node tools/screenshots.mjs [name ...] [--out dir] [--at 30,60,90] [--browser chrome|firefox|librewolf]
// --at overrides the step counts of the selected shots and adds the step to the file name
// (for choosing a moment).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { launch, browserArgs } from './browser.mjs';

const SHOTS = [
  // whole page
  { name: 'app-3d', page: '3d.html?scene=damBreak&n=96', steps: 90, ui: true },
  { name: 'app-2d', page: '2d.html?scene=floaters&n=192', steps: 150, ui: true },
  // simulation view only
  { name: '3d-dam-break', page: '3d.html?scene=damBreak&n=128&yaw=0.75&pitch=0.3', steps: 90 },
  { name: '3d-crown', page: '3d.html?scene=crown&n=96', steps: 30 },
  { name: '3d-floaters', page: '3d.html?scene=floaters&n=96', steps: 60 },
  { name: '3d-obstacle', page: '3d.html?scene=obstacle&n=96', steps: 90 },
  { name: '3d-volume', page: '3d.html?scene=damBreak&n=96&view=volume', steps: 100 },
  { name: '2d-dam-break', page: '2d.html?scene=damBreak&n=256', steps: 100 },
  { name: '2d-mixer', page: '2d.html?scene=mixer&n=256', steps: 45 },
  { name: '2d-splash', page: '2d.html?scene=splash&n=256', steps: 45 },
  { name: '2d-speed', page: '2d.html?scene=damBreak&n=256&view=speed', steps: 80 },
  // world mode
  { name: 'app-world', page: 'world3d.html?scene=cascade&bricks', steps: 360, ui: true },
  { name: 'world-waterfall', page: 'world3d.html?scene=waterfall', steps: 420 },
  { name: 'world-waterfall-bricks', page: 'world3d.html?scene=waterfall&bricks', steps: 420 },
  { name: 'world-cascade', page: 'world3d.html?scene=cascade', steps: 900 },
  { name: 'world-cascade-bricks', page: 'world3d.html?scene=cascade&bricks', steps: 900 },
  { name: 'world-sea', page: 'world3d.html?scene=sea&dist=150&pitch=0.42', steps: 110 },
  { name: 'world-sea-bricks', page: 'world3d.html?scene=sea&dist=150&pitch=0.42&bricks', steps: 110 },
  { name: 'world-sea-rings', page: 'world3d.html?scene=sea', steps: 300 },
  { name: 'world-sea-rings-bricks', page: 'world3d.html?scene=sea&bricks', steps: 300 },
  { name: 'world-harbour', page: 'world3d.html?scene=harbour', steps: 600 },
  { name: 'world-harbour-bricks', page: 'world3d.html?scene=harbour&bricks', steps: 600 },
  { name: 'world-buoys', page: 'world3d.html?scene=buoys', steps: 1260 },
  { name: 'world-buoys-bricks', page: 'world3d.html?scene=buoys&bricks', steps: 1260 },
  // ... with a height field: the view, and the page with the map of who has the water
  { name: 'world-river', page: 'world3d.html?scene=river', steps: 1800 },
  { name: 'world-surf', page: 'world3d.html?scene=surf', steps: 2400 },
  { name: 'world-dam', page: 'world3d.html?scene=dam', steps: 480 },
  { name: 'world-dam-later', page: 'world3d.html?scene=dam', steps: 1800 },
  { name: 'world-cave', page: 'world3d.html?scene=cave', steps: 1445 },
  { name: 'world-spring', page: 'world3d.html?scene=spring', steps: 2400 },
  { name: 'app-world-surf', page: 'world3d.html?scene=surf', steps: 2400, ui: true },
  // ... a ship: holed under the bow, going down after the second hole, on the bed
  { name: 'world-ship', page: 'world3d.html?scene=ship', steps: 840 },
  { name: 'world-ship-bricks', page: 'world3d.html?scene=ship&bricks', steps: 840 },
  { name: 'world-ship-sinking', page: 'world3d.html?scene=ship', steps: 2310 },
  { name: 'world-ship-sunk', page: 'world3d.html?scene=ship', steps: 3300 },
  { name: 'app-world-ship', page: 'world3d.html?scene=ship', steps: 840, ui: true },
  // ... and in section (world2d.html): one compartment open; two (the second hole made by the page, at 12 s)
  { name: 'world2d-flood', page: 'world2d.html?scene=flood', steps: 600 },
  { name: 'world2d-flood-bricks', page: 'world2d.html?scene=flood&bricks', steps: 600 },
  { name: 'world2d-flood-sinking', page: 'world2d.html?scene=flood&second=12', steps: 1200 },
  { name: 'world2d-flood-sunk', page: 'world2d.html?scene=flood&second=12', steps: 3000 },
  { name: 'app-world2d', page: 'world2d.html?scene=flood', steps: 600, ui: true },
];

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const names = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--out', '--at', '--browser', '--pref'].includes(argv[i - 1])));
const out = path.resolve(opt('out', path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'screenshots')));
const at = opt('at', null)?.split(',').map(Number);
fs.mkdirSync(out, { recursive: true });

const server = await startServer(0);
const port = server.address().port;
const browser = await launch({ ...browserArgs(argv), width: 1280, height: 800 });
let failed = false;
try {
  for (const shot of SHOTS.filter((s) => !names.length || names.includes(s.name))) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => { failed = true; console.log('PAGE ERROR: ' + e.message); });
    if (shot.ui) {
      // the whole page, running: captured on the first frame at or after the given step
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(`http://localhost:${port}/${shot.page}&capture`, { waitUntil: 'load' });
      await page.waitForFunction((n) => (window.runner || window.world)?.sim.frame >= n || window.__error, { timeout: 300000 }, shot.steps);
      const file = path.join(out, `${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log(`${path.relative(process.cwd(), file)}  step ${await page.evaluate(() => (window.runner || window.world).sim.frame)}  ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
      await page.close();
      continue;
    }
    // the view alone, at 800x600 (3D) or at the canvas size (2D), without the overlay text
    await page.setViewport({ width: 1128, height: 600 });
    await page.goto(`http://localhost:${port}/${shot.page}&paused&capture`, { waitUntil: 'load' });
    await page.addStyleTag({ content: '#hud { display: none; }' });
    await page.waitForFunction(() => window.__frames > 5 || window.__error, { timeout: 60000 });
    let done = 0;
    for (const n of at || [shot.steps]) {
      const info = await page.evaluate(async (k) => {
        for (let i = 0; i < k; i++) {
          window.app.stepOnce();
          if ((window.runner || window.world).bodies.length) await (window.runner || window.world).forcesReady;   // as in a real-time run
          if (window.world && i % 50 === 49) await new Promise((r) => setTimeout(r));   // (a long run: let the page breathe)
        }
        const R = window.runner || window.world;
        const s = await R.sim.measure();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (window.world) {
          let row = `t ${R.time.toFixed(2)} s  ${R.sim.bricks} bricks, ${(R.sim.storedCells / 1e6).toFixed(2)} M cells stored of ${(R.boundsCells() / 1e6).toFixed(1)} M in the box around them`;
          const tr = R.tiers();
          if (tr) {
            // who has the water, per column of bricks, and how much of the budget of solved bricks is in use
            let wet = 0, solved = 0;
            for (const t of tr.tier) { if (t & 7) wet++; if ((t & 3) === 3) solved++; }
            row += `; height field: ${wet} columns of bricks with water, ${solved} solved in 3D, ${R.sim.bricks - R.sim.nHeld} of ${R.sim.params.maxSolved || 3000} solved bricks, ${R.sim.nHeld} copies`;
          }
          return row;
        }
        return `t ${R.time.toFixed(2)} s  mass ${(s.massRatio * 100).toFixed(4)} %  CFL ${s.cfl.toFixed(1)}`;
      }, n - done).catch((e) => { failed = true; return 'FAILED: ' + e.message; });
      done = n;
      const file = path.join(out, at ? `${shot.name}-${String(n).padStart(4, '0')}.png` : `${shot.name}.png`);
      await (await page.$('#view')).screenshot({ path: file });
      console.log(`${path.relative(process.cwd(), file)}  step ${n}  ${info}  ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
