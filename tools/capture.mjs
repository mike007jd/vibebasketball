/**
 * Gameplay capture harness (Playwright).
 *
 * usage:
 *   node tools/capture.mjs --out output/game.png --wait 8000 [--url "http://localhost:5173/?attract=1"]
 *   node tools/capture.mjs --trace --wait 30000        # sample #debug every 2s
 *   node tools/capture.mjs --video output/clip.webm --wait 20000
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

// dev-server location: the harness may place it on any port
const BASE = process.env.GAME_URL ?? `http://localhost:${process.env.GAME_PORT ?? 5173}`;


const args = parseArgs({
  options: {
    out: { type: 'string' },
    url: { type: 'string', default: `${BASE}/?attract=1&debug=1` },
    wait: { type: 'string', default: '8000' },
    trace: { type: 'boolean' },
    video: { type: 'string' },
    headless: { type: 'string', default: 'false' },
    w: { type: 'string', default: '1600' },
    h: { type: 'string', default: '900' },
  },
});

const waitMs = parseInt(args.values.wait, 10);
const headless = args.values.headless === 'true';
const browser = await chromium.launch({ headless, args: headless ? [] : ['--use-angle=metal'] });
const ctx = await browser.newContext({
  viewport: { width: parseInt(args.values.w, 10), height: parseInt(args.values.h, 10) },
  recordVideo: args.values.video ? { dir: '.', size: { width: 1600, height: 900 } } : undefined,
});
const page = await ctx.newPage();

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto(args.values.url, { waitUntil: 'domcontentloaded' });

if (args.values.trace) {
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await page.waitForTimeout(2000);
    const dbg = await page.locator('#debug').textContent();
    console.log(`--- t+${((Date.now() - t0) / 1000).toFixed(0)}s ---\n${dbg}`);
  }
} else {
  await page.waitForTimeout(waitMs);
}

if (args.values.out) {
  mkdirSync(args.values.out.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await page.screenshot({ path: args.values.out });
  console.log('saved ' + args.values.out);
}

await ctx.close();
if (args.values.video) {
  try {
    const vid = page.video();
    if (vid) {
      const target = args.values.video.endsWith('.webm') ? args.values.video : args.values.video + '/clip_' + Date.now() + '.webm';
      await vid.saveAs(target);
      console.log('video saved ' + target);
    }
  } catch (e) {
    console.log('video save issue: ' + e.message);
  }
}

if (errors.length) console.log('CONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n'));
else console.log('no console errors');

await browser.close();
