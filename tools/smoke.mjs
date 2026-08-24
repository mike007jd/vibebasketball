import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 5198;
const origin = `http://127.0.0.1:${port}`;
const vite = new URL('../node_modules/vite/bin/vite.js', import.meta.url).pathname;
const server = spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('..', import.meta.url),
  stdio: ['ignore', 'pipe', 'pipe'],
});

const waitForServer = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Vite did not become ready within 15 seconds');
};

let browser;
try {
  await waitForServer();
  const localMac = process.platform === 'darwin' && !process.env.CI;
  browser = await chromium.launch({
    headless: !localMac,
    args: localMac ? ['--use-angle=metal'] : [],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  const failedRequests = [];
  const assetRequests = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(request.url()));
  page.on('request', (request) => {
    if (/\/(?:models?|animations?)\//i.test(new URL(request.url()).pathname)) {
      assetRequests.push(request.url());
    }
  });

  await page.goto(`${origin}/?attract=1&clean=1&lite=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game?.players?.length === 2, null, { timeout: 60_000 });
  const state = await page.evaluate(() => {
    window.advanceTime(1000);
    return {
      title: document.title,
      rigs: window.__game.players.map((player) => player.rig.constructor.name),
      animators: window.__game.players.map((player) => player.animator.constructor.name),
      gameState: window.__game.state,
    };
  });

  const perfect = await page.evaluate(() => {
    const g = window.__game;
    const shooter = g.userPlayer;
    const defender = g.otherPlayer(shooter);
    const ball = g.ball;

    g.state = 'live';
    g.attract = false;
    g.offenseIdx = shooter.team;
    shooter.pos.set(0, 0, 8);
    shooter.vel.set(0, 0, 0);
    shooter.facing = Math.PI;
    shooter.stamina = 1;
    shooter.hasBall = true;
    shooter.action = { name: 'shot', variant: 'jumpshot', hand: 'Right' };
    defender.hasBall = false;
    defender.pos.set(0, 0, 7.4);
    ball.attach(shooter, shooter.shotSetPoint(ball.pos.clone()));

    shooter.releaseShot(ball, g, 1, '');
    const livePalm = defender.rig.palmPosition.bind(defender.rig);
    defender.rig.palmPosition = (_hand, out) => out.copy(ball.pos);
    defender.action = {
      name: 'contest', swat: true, blocked: false, jumped: true,
      t: 0.5, dur: 1, blockWindow: [0, 1], hand: 'Right', style: 'front',
      prevBlockPalm: ball.pos.clone(),
    };
    g.resolveBlock();
    defender.rig.palmPosition = livePalm;

    const shown = g.lastShot?.grade === 'perfect';
    const survivedLateBlock = ball.state === 'shot' && ball.shot?.intendedMake === true;
    let scored = false;
    for (let frame = 0; frame < 360 && ball.state === 'shot'; frame++) {
      ball.update(1 / 120, []);
      if (ball.consumeEvents().some((event) => event.type === 'score')) {
        scored = true;
        break;
      }
    }
    return { shown, survivedLateBlock, scored };
  });

  const failures = [];
  if (state.title !== 'Vibe Basketball') failures.push(`unexpected title: ${state.title}`);
  if (state.rigs.some((name) => name !== 'Rig')) failures.push(`unexpected rigs: ${state.rigs.join(', ')}`);
  if (state.animators.some((name) => name !== 'Animator')) {
    failures.push(`unexpected animators: ${state.animators.join(', ')}`);
  }
  if (!state.gameState) failures.push('game did not enter a valid state');
  if (!Object.values(perfect).every(Boolean)) {
    failures.push(`PERFECT result was not preserved: ${JSON.stringify(perfect)}`);
  }
  if (assetRequests.length) failures.push(`external model/animation requests: ${assetRequests.join(', ')}`);
  if (failedRequests.length) failures.push(`failed requests: ${failedRequests.join(', ')}`);
  if (pageErrors.length) failures.push(`page errors: ${pageErrors.join(' | ')}`);

  if (failures.length) throw new Error(failures.join('\n'));
  console.log(`PASS Vibe Basketball public smoke ${JSON.stringify({ ...state, perfect })}`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
