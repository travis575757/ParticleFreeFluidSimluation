// Headless test runner: loads a page in the system Chrome with the real GPU (ANGLE/OpenGL, the
// same WebGL2 backend a normal Chrome window uses here), relays console output, waits for
// `window.__done`, and optionally saves screenshots.
//
//   node tools/run.mjs <page> [--shot out.png] [--timeout ms] [--size WxH] [--eval "js"] [--headed] [--port n]
//                            [--browser chrome|firefox|librewolf] [--pref name=value ...]
import { startServer } from './serve.mjs';
import { launch, browserArgs } from './browser.mjs';

const args = process.argv.slice(2);
const page_ = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !['--headed'].includes(args[i - 1]))) || 'index.html';
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);
const [W, H] = opt('size', '1000x800').split('x').map(Number);
const timeout = Number(opt('timeout', 60000));
const server = await startServer(Number(opt('port', 0)));
const port = server.address().port;
const browser = await launch({ ...browserArgs(args), width: W, height: H, unthrottled: true });
let failed = false;
try {
  const page = await browser.newPage();
  page.on('console', (m) => console.log(m.text()));
  page.on('pageerror', (e) => { failed = true; console.log('PAGE ERROR: ' + (e.stack || e.message)); });
  page.on('requestfailed', (r) => console.log('REQUEST FAILED: ' + r.url()));
  await page.goto(`http://localhost:${port}/${page_}`, { waitUntil: 'load' });
  const code = opt('eval', null);
  if (code) await page.evaluate(code);
  const t0 = Date.now();
  for (;;) {
    const done = await page.evaluate(() => window.__done === true || window.__error || null);
    if (done === true) break;
    if (done) { failed = true; console.log('ERROR: ' + done); break; }
    if (Date.now() - t0 > timeout) { failed = true; console.log('TIMEOUT waiting for window.__done'); break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  const shot = opt('shot', null);
  if (shot) {
    const clip = opt('clip', null);
    await page.screenshot({ path: shot, ...(clip ? { clip: Object.fromEntries(clip.split(',').map((v, i) => [['x', 'y', 'width', 'height'][i], Number(v)])) } : {}) });
    console.log('screenshot: ' + shot);
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
