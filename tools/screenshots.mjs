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
      await page.waitForFunction((n) => window.runner?.sim.frame >= n || window.__error, { timeout: 120000 }, shot.steps);
      const file = path.join(out, `${shot.name}.png`);
      await page.screenshot({ path: file });
      console.log(`${path.relative(process.cwd(), file)}  step ${await page.evaluate(() => window.runner.sim.frame)}  ${(fs.statSync(file).size / 1024).toFixed(0)} kB`);
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
          if (window.runner.bodies.length) await window.runner.forcesReady;   // as in a real-time run
        }
        const s = await window.runner.sim.measure();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return `t ${window.runner.time.toFixed(2)} s  mass ${(s.massRatio * 100).toFixed(4)} %  CFL ${s.cfl.toFixed(1)}`;
      }, n - done);
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
