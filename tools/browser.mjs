// Launches the browser the tests run in, on the real GPU.
//   chrome              system Chrome, ANGLE on OpenGL (what a normal Chrome window uses here)
//   firefox | librewolf Gecko through WebDriver BiDi, in a throw-away profile. The prefs below are
//                       the ones that matter for this project and differ between the two:
//                       LibreWolf ships with WebGL behind a prompt and fingerprinting protection on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const GECKO = { firefox: process.env.FIREFOX || '/snap/bin/firefox', librewolf: process.env.LIBREWOLF || '/usr/bin/librewolf' };

// A snap-packaged Firefox has its own /tmp and cannot see a profile created in the system one;
// its profile goes into the snap's own data directory instead (removed again on exit).
function snapTmp(exe) {
  if (!exe.startsWith('/snap/')) return null;
  const dir = path.join(os.homedir(), 'snap', path.basename(exe), 'common', 'masscon-test-tmp');
  fs.mkdirSync(dir, { recursive: true });
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } });
  return dir;
}

export async function launch({ browser = 'chrome', headed = false, width = 1280, height = 800, unthrottled = false, prefs = {} } = {}) {
  if (browser === 'chrome') {
    return puppeteer.launch({
      executablePath: process.env.CHROME || '/usr/bin/google-chrome',
      headless: !headed,
      args: ['--no-first-run', '--use-gl=angle', '--use-angle=gl', '--ignore-gpu-blocklist', `--window-size=${width},${height}`,
        ...(unthrottled ? ['--enable-gpu-rasterization', '--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])],
      defaultViewport: { width, height },
    });
  }
  if (!GECKO[browser]) throw new Error(`unknown browser "${browser}"`);
  const tmp = snapTmp(GECKO[browser]);
  const savedTmp = process.env.TMPDIR;
  if (tmp) process.env.TMPDIR = tmp;
  try {
    return await launchGecko(GECKO[browser], { headed, width, height, prefs });
  } finally {
    if (tmp) { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; }
  }
}

function launchGecko(executablePath, { headed, width, height, prefs }) {
  return puppeteer.launch({
    browser: 'firefox',
    executablePath,
    headless: !headed,
    args: [`--width=${width}`, `--height=${height}`],
    defaultViewport: { width, height },
    extraPrefsFirefox: {
      'webgl.disabled': false,
      'webgl.force-enabled': true,
      'librewolf.webgl.prompt': false,
      // on by default in LibreWolf: every read-back from the GPU then returns random numbers,
      // which the apps detect and report, but the tests measure the liquid through read-back
      'privacy.resistFingerprinting': false,
      ...prefs,
    },
  });
}

/** Reads --browser <kind>, --headed and any number of --pref name=value (Gecko preferences) from a command line. */
export function browserArgs(argv) {
  const at = argv.indexOf('--browser');
  const prefs = {};
  argv.forEach((a, i) => {
    if (a !== '--pref') return;
    const eq = argv[i + 1].indexOf('=');
    const v = argv[i + 1].slice(eq + 1);
    prefs[argv[i + 1].slice(0, eq)] = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);
  });
  return { browser: at >= 0 ? argv[at + 1] : process.env.BROWSER_KIND || 'chrome', headed: argv.includes('--headed'), prefs };
}
