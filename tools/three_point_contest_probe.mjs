import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.GAME_URL ?? 'http://127.0.0.1:5199';
const outDir = path.resolve('output/three-point-probe');
fs.mkdirSync(outDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForGame(page) {
  await page.waitForFunction(() => window.__game?.mode === 'three-point', null, { timeout: 120_000 });
  await page.evaluate(() => window.advanceTime(1));
}

async function tick(page, frames) {
  await page.evaluate((count) => {
    for (let index = 0; index < count; index++) window.__game.update(1 / 60);
  }, frames);
}

async function openContest(browser, seed) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Chromium emits this when a headless worker has no audio device; gameplay
    // and WebAudio initialization are otherwise unaffected.
    if (text.includes('AudioContext encountered an error from the audio device')) return;
    errors.push(text);
  });
  await page.goto(`${base}/?mode=three-point&lite=1&rig=proc&anim=procedural&seed=${seed}`, {
    waitUntil: 'domcontentloaded', timeout: 120_000,
  });
  await waitForGame(page);
  return { page, errors };
}

async function chooseRack(page, rack = 'top') {
  if (!await page.evaluate(() => window.__game.state === 'money-select')) {
    await page.evaluate(() => window.__game.simToMyTurn());
    await tick(page, 1);
  }
  assert(
    await page.evaluate(() => window.__game.state === 'money-select' && !!window.__game.currentProfile?.user),
    `expected the next local player's money-rack prompt before selecting ${rack}`,
  );
  await page.evaluate((id) => document.querySelector(`[data-rack="${id}"]`)?.click(), rack);
  await tick(page, 1);
}

async function setupPlayers(page, count = 1) {
  await page.locator(`[data-player-count="${count}"]`).click();
  await tick(page, 1);
}

async function simToUser(page) {
  await page.evaluate(() => window.__game.simToMyTurn());
  await tick(page, 1);
}

async function finishUser(page, score) {
  const ok = await page.evaluate((value) => window.__game.debugCompleteUserRound(value), score);
  assert(ok, `debug user round was unavailable for requested score ${score}`);
  await tick(page, 1);
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});

try {
  // Default route and keyboard mode selection.
  const menu = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await menu.goto(`${base}/?rig=proc&lite=1`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await menu.waitForFunction(() => typeof window.render_game_to_text === 'function', null, { timeout: 120_000 });
  const menuState = JSON.parse(await menu.evaluate(() => window.render_game_to_text()));
  assert(menuState.mode === 'menu' && menuState.options.length === 3, 'default URL must open two modes plus How to Play');
  await menu.keyboard.press('ArrowDown');
  const selected = JSON.parse(await menu.evaluate(() => window.render_game_to_text())).selected;
  assert(selected === 'three-point', 'keyboard navigation must select the 3-Point Contest card');
  await menu.screenshot({ path: path.join(outDir, 'menu.png') });
  await menu.keyboard.press('ArrowDown');
  assert(JSON.parse(await menu.evaluate(() => window.render_game_to_text())).selected === 'how-to', 'keyboard navigation must reach How to Play');
  await menu.keyboard.press('Enter');
  const howTo = JSON.parse(await menu.evaluate(() => window.render_game_to_text()));
  assert(
    howTo.state === 'how-to-play' && JSON.stringify(howTo.howTo.sections) === JSON.stringify(['1v1', 'three-point']) && howTo.howTo.canReturn,
    `How to Play state must expose both modes and a return action: ${JSON.stringify(howTo)}`,
  );
  assert(await menu.locator('#how-to-play').isVisible(), 'How to Play panel must be visible after confirmation');
  assert((await menu.locator('#how-to-play').innerText()).includes('CHECK BALL:'), '1V1 instructions must explain the clear-arc rule');
  assert((await menu.locator('#how-to-play').innerText()).includes('MONEY BALL'), 'contest instructions must explain scoring');
  await menu.screenshot({ path: path.join(outDir, 'how-to-play.png') });
  await menu.keyboard.press('Escape');
  assert(JSON.parse(await menu.evaluate(() => window.render_game_to_text())).state === 'mode-select', 'Escape must return from How to Play to the menu');
  await menu.locator('#mode-how-to').click();
  assert(JSON.parse(await menu.evaluate(() => window.render_game_to_text())).state === 'how-to-play', 'mouse click must open How to Play');
  await menu.locator('#how-to-back').click();
  assert(JSON.parse(await menu.evaluate(() => window.render_game_to_text())).state === 'mode-select', 'Back button must return to mode select');
  await menu.close();

  // The fixed card order must open on P1, never on a random CPU card.
  const deterministic = await openContest(browser, 'watch-0');
  assert(await deterministic.page.evaluate(() => window.__game.rackSet.source === 'glb'), 'contest GLB did not cold-load in the game runtime');
  const playerCountState = JSON.parse(await deterministic.page.evaluate(() => window.render_game_to_text()));
  assert(playerCountState.state === 'player-count' && playerCountState.setup.playerCount === 1, 'contest must open on the 1-4 player-count step');
  assert(await deterministic.page.locator('[data-player-count]').count() === 4, 'player-count step must expose four local-player choices');
  assert(await deterministic.page.evaluate(() => window.__game.localPlayers.filter((player) => player.rig.group.visible).length === 4), 'setup must line up all four selectable athletes');
  assert(
    JSON.stringify(playerCountState.setup.assignments) === JSON.stringify(['P1', 'CPU', 'CPU', 'CPU']),
    `one-player setup must assign only the first fixed slot to P1: ${JSON.stringify(playerCountState.setup)}`,
  );
  assert(
    await deterministic.page.evaluate(() => window.__game.setupState().pose === 'neutral-static' &&
      window.__game.localPlayers.every((player) => !player.hasBall && !player.animator.activeName && !player.animator.baseName)),
    'setup lineup must freeze a neutral rest pose instead of playing any gameplay animation',
  );
  const poseBefore = await deterministic.page.evaluate(() => window.__game.localPlayers.map((player) => {
    const left = player.rig.bones?.LeftHand?.getWorldPosition(new player.pos.constructor());
    const right = player.rig.bones?.RightHand?.getWorldPosition(new player.pos.constructor());
    return [left?.toArray(), right?.toArray()];
  }));
  await tick(deterministic.page, 60);
  const poseAfter = await deterministic.page.evaluate(() => window.__game.localPlayers.map((player) => {
    const left = player.rig.bones?.LeftHand?.getWorldPosition(new player.pos.constructor());
    const right = player.rig.bones?.RightHand?.getWorldPosition(new player.pos.constructor());
    return [left?.toArray(), right?.toArray()];
  }));
  assert(JSON.stringify(poseAfter) === JSON.stringify(poseBefore), 'character-select rest pose must remain static over time');
  await deterministic.page.waitForTimeout(650);
  await deterministic.page.screenshot({ path: path.join(outDir, 'local-player-count.png') });
  await deterministic.page.keyboard.press('Enter');
  await tick(deterministic.page, 1);
  assert(
    await deterministic.page.evaluate(() => window.__game.localProfiles.length === 1 &&
      window.__game.localProfiles[0].id === 'volt' && window.__game.contestRoster.length === 4 &&
      JSON.stringify(window.__game.contestRoster.filter((profile) => !profile.user).map((profile) => profile.id).sort()) ===
        JSON.stringify(['jett', 'mira', 'nova'])),
    'one-player mode must create P1 plus the other three setup cards as CPU',
  );
  const openingRoadmap = JSON.parse(await deterministic.page.evaluate(() => window.render_game_to_text())).roadmap;
  assert(openingRoadmap.first.length === 4, 'tournament road must show exactly the four setup-card entrants');
  assert(
    JSON.stringify(openingRoadmap.first.map((entry) => entry.name)) === JSON.stringify(['VOLT', 'NOVA', 'MIRA', 'JETT']),
    `Round 1 road must preserve the fixed card order: ${JSON.stringify(openingRoadmap.first)}`,
  );
  assert(openingRoadmap.final.length === 3 && openingRoadmap.final.every((entry) => !entry.entrantId), 'tournament road must reserve three final slots');
  assert(
    await deterministic.page.evaluate(() => window.__game.state === 'money-select' && window.__game.currentProfile?.playerLabel === 'P1'),
    'Round 1 must open on P1 rack setup',
  );
  await deterministic.page.screenshot({ path: path.join(outDir, 'money-rack.png') });
  await chooseRack(deterministic.page, 'top');
  assert(await deterministic.page.evaluate(() => window.__game.round?.profile.user), 'P1 money-rack confirmation must start P1 physical round');

  // Real player input: authored jumper, overlapping live balls, then a full win route.
  await tick(deterministic.page, 205);
  await deterministic.page.keyboard.down('Space');
  await tick(deterministic.page, 42);
  await deterministic.page.keyboard.up('Space');
  const landingWindow = await deterministic.page.evaluate(() => {
    for (let index = 0; index < 90; index++) {
      window.__game.update(1 / 60);
      const shooter = window.__game.round?.shooter;
      if (window.__game.round?.phase === 'post-shot' && shooter?.action?.released &&
          shooter.airborne && shooter.vy < 0 && shooter.y < 0.25) return true;
    }
    return false;
  });
  assert(landingWindow, 'first contest jumper never entered its landing input window');
  // Press for the next jumper before the previous one has landed. Holding this
  // one key-down must start charging the next rack ball without a re-press.
  await deterministic.page.keyboard.down('Space');
  await tick(deterministic.page, 1);
  const buffered = JSON.parse(await deterministic.page.evaluate(() => window.render_game_to_text()));
  assert(buffered.shotQueued, `landing input was not buffered: ${JSON.stringify(buffered)}`);
  const autoStarted = await deterministic.page.evaluate(() => {
    for (let index = 0; index < 60; index++) {
      window.__game.update(1 / 60);
      const game = window.__game;
      if (game.round?.activeAttempt?.index === 1 && game.round.shooter.action?.name === 'shot') {
        return {
          variant: game.round.shooter.action.variant,
          actionT: game.round.shooter.action.t,
          buffer: game.round.shotBufferT,
        };
      }
    }
    return null;
  });
  assert(
    autoStarted?.variant === 'jumpshot' && autoStarted.actionT > 0 && autoStarted.buffer === 0,
    `held landing input did not auto-start the next jumper: ${JSON.stringify(autoStarted)}`,
  );
  await tick(deterministic.page, 41);
  await deterministic.page.keyboard.up('Space');
  await tick(deterministic.page, 2);
  const live = JSON.parse(await deterministic.page.evaluate(() => window.render_game_to_text()));
  assert(live.attempts.filter((attempt) => attempt.releasedAt != null).length >= 2, 'player hold/release did not create two attempts');
  assert(live.ballsInFlight.length >= 2, 'ball pool did not keep overlapping attempts alive');
  await deterministic.page.screenshot({ path: path.join(outDir, 'player-round.png') });
  await finishUser(deterministic.page, 40);
  await simToUser(deterministic.page);
  assert(await deterministic.page.evaluate(() => window.__game.state === 'money-select' && window.__game.stage === 'final'), '40-point first round must reach final money-rack selection');
  await chooseRack(deterministic.page, 'right-wing');
  await simToUser(deterministic.page);
  await finishUser(deterministic.page, 40);
  await simToUser(deterministic.page);
  const champion = JSON.parse(await deterministic.page.evaluate(() => window.render_game_to_text()));
  assert(champion.state === 'results' && champion.winner === 'VOLT', 'perfect final route must crown VOLT');
  assert(champion.roadmap.champion?.name === 'VOLT', 'tournament road must end on the crowned champion');
  assert(await deterministic.page.locator('#contest-roadmap-finalists li.champion').count() === 1, 'final road must highlight exactly one champion');
  assert(await deterministic.page.locator('#contest-roadmap-finalists li.eliminated').count() === 2, 'final road must cross out both non-champions');
  await deterministic.page.screenshot({ path: path.join(outDir, 'champion.png') });
  assert(deterministic.errors.length === 0, `contest console errors: ${deterministic.errors.join(' | ')}`);
  await deterministic.page.close();

  // Watched CPU -> mid-round skip must still commit the same immutable plan,
  // now that P1 correctly takes the first Round 1 turn.
  const cpuDeterminism = await openContest(browser, 'watch-0');
  await setupPlayers(cpuDeterminism.page);
  assert(
    await cpuDeterminism.page.evaluate(() => window.__game.state === 'money-select' && window.__game.currentProfile?.playerLabel === 'P1'),
    'one-player contest must open on P1 before any CPU prompt',
  );
  await chooseRack(cpuDeterminism.page, 'top');
  await finishUser(cpuDeterminism.page, 10);
  assert(
    await cpuDeterminism.page.evaluate(() => window.__game.state === 'cpu-prompt' && window.__game.currentProfile?.id === 'nova'),
    'the first CPU prompt must follow P1 in fixed card order',
  );
  const locked = await cpuDeterminism.page.evaluate(() => ({
    entrantId: window.__game.currentPlan.entrantId,
    score: window.__game.currentPlan.score,
    attempts: window.__game.currentPlan.attempts.map((attempt) => attempt.made),
  }));
  await cpuDeterminism.page.evaluate(() => window.__game.watchCpu());
  await tick(cpuDeterminism.page, 280);
  const watched = await cpuDeterminism.page.evaluate(() => ({
    released: window.__game.round.released,
    state: window.__game.state,
    phase: window.__game.round.phase,
    clock: window.__game.round.clock,
    hasBall: window.__game.round.shooter.hasBall,
    action: window.__game.round.shooter.action?.name ?? null,
  }));
  assert(watched.released > 0, `CPU WATCH must play real shot attempts before a skip: ${JSON.stringify(watched)}`);
  const watchedEntrant = await cpuDeterminism.page.evaluate(() => window.__game.round.profile.id);
  await cpuDeterminism.page.keyboard.press('Space');
  await tick(cpuDeterminism.page, 1);
  assert(
    await cpuDeterminism.page.evaluate((entrantId) => window.__game.round?.profile.id === entrantId, watchedEntrant),
    'keyboard shoot key must not skip a watched CPU round',
  );
  await cpuDeterminism.page.screenshot({ path: path.join(outDir, 'cpu-watch.png') });
  await cpuDeterminism.page.keyboard.press('Enter');
  await tick(cpuDeterminism.page, 1);
  const committed = await cpuDeterminism.page.evaluate((entrantId) => {
    const record = window.__game.firstRecords.find((entry) => entry.entrantId === entrantId)
      ?? window.__game.stageRecords.find((entry) => entry.entrantId === entrantId);
    return { score: record.score, attempts: record.attempts.map((attempt) => attempt.made) };
  }, locked.entrantId);
  assert(committed.score === locked.score, 'mid-round CPU skip changed the locked score');
  assert(JSON.stringify(committed.attempts) === JSON.stringify(locked.attempts), 'mid-round CPU skip changed the ball-by-ball plan');
  assert(cpuDeterminism.errors.length === 0, `CPU determinism console errors: ${cpuDeterminism.errors.join(' | ')}`);
  await cpuDeterminism.page.close();

  // Rack delivery starts directly in triple-threat, uses a set jumper, keeps
  // the shooter's feet behind the line, and transfers the money-ball look to
  // the live physical ball.
  const visualContract = await openContest(browser, 'visual-11');
  await setupPlayers(visualContract.page);
  await chooseRack(visualContract.page, 'top');
  await tick(visualContract.page, 205);
  const initialStance = await visualContract.page.evaluate(() => ({
    userUp: window.__game.round?.profile.user,
    catchT: window.__game.round?.shooter.catchT,
    x: window.__game.round?.shooter.pos.x,
  }));
  assert(initialStance.userUp && initialStance.catchT === 0, `rack ball must start in triple-threat without a catch pose: ${JSON.stringify(initialStance)}`);
  assert(Math.abs(initialStance.x) >= 7.04, `corner shooter must stand clearly behind the line: ${initialStance.x}`);
  await visualContract.page.evaluate(() => {
    const game = window.__game;
    if (game.activeBall) game.parkBall(game.activeBall);
    game.round.shooter.hasBall = false;
    game.activeBall = null;
    game.round.activeAttempt = null;
    game.round.attemptIndex = 4;
    game.round.phase = 'moving';
    game.round.stationReadyT = 0;
  });
  await tick(visualContract.page, 20);
  const moneyBall = JSON.parse(await visualContract.page.evaluate(() => window.render_game_to_text()));
  assert(moneyBall.heldBall?.kind === 'money', `live rack delivery must preserve money-ball color: ${JSON.stringify(moneyBall.heldBall)}`);
  await visualContract.page.waitForTimeout(600);
  await visualContract.page.screenshot({ path: path.join(outDir, 'money-ball-triple-threat.png') });
  await visualContract.page.keyboard.down('Space');
  await tick(visualContract.page, 1);
  const shotVariant = await visualContract.page.evaluate(() => window.__game.round.shooter.action?.variant);
  assert(shotVariant === 'jumpshot', `contest must use the standing set jumper, not catch-and-shoot: ${shotVariant}`);
  await tick(visualContract.page, 41);
  await visualContract.page.keyboard.up('Space');
  await tick(visualContract.page, 2);
  const moneyFlight = JSON.parse(await visualContract.page.evaluate(() => window.render_game_to_text()));
  assert(moneyFlight.ballsInFlight.some((ball) => ball.kind === 'money'), 'released money ball must keep its distinct flight color');
  await visualContract.page.screenshot({ path: path.join(outDir, 'money-ball-flight.png') });
  assert(visualContract.errors.length === 0, `visual contract console errors: ${visualContract.errors.join(' | ')}`);
  await visualContract.page.close();

  // Player count maps directly to the first fixed slots. Three players leave
  // slot four on CPU; four players make all four cards P1-P4. Each local person
  // chooses a rack only when their physical turn comes up.
  const localFour = await openContest(browser, 'local-four');
  await localFour.page.keyboard.press('ArrowRight');
  await localFour.page.keyboard.press('ArrowRight');
  await tick(localFour.page, 1);
  const threePreview = JSON.parse(await localFour.page.evaluate(() => window.render_game_to_text()));
  assert(
    threePreview.setup.playerCount === 3 &&
      JSON.stringify(threePreview.setup.assignments) === JSON.stringify(['P1', 'P2', 'P3', 'CPU']),
    `three-player preview must leave only the fourth fixed slot on CPU: ${JSON.stringify(threePreview.setup)}`,
  );
  await localFour.page.keyboard.press('ArrowRight');
  await tick(localFour.page, 1);
  const fourPreview = JSON.parse(await localFour.page.evaluate(() => window.render_game_to_text()));
  assert(
    fourPreview.state === 'player-count' && fourPreview.setup.playerCount === 4 &&
      JSON.stringify(fourPreview.setup.assignments) === JSON.stringify(['P1', 'P2', 'P3', 'P4']),
    `four-player preview must fill all four fixed slots automatically: ${JSON.stringify(fourPreview.setup)}`,
  );
  await localFour.page.waitForTimeout(650);
  await localFour.page.screenshot({ path: path.join(outDir, 'local-four-preview.png') });
  await localFour.page.keyboard.press('Enter');
  await tick(localFour.page, 1);
  const fourRoster = await localFour.page.evaluate(() => ({
    local: window.__game.localProfiles.map((profile) => ({
      label: profile.playerLabel,
      id: profile.id,
      characterIndex: profile.characterIndex,
    })),
    humans: window.__game.contestRoster.filter((profile) => profile.user).length,
    cpus: window.__game.contestRoster.filter((profile) => !profile.user).length,
    field: window.__game.contestRoster.length,
    firstOrder: window.__game.firstEntrants.map((profile) => profile.playerLabel),
    jerseyColors: window.__game.localPlayers.map((player) => player.rig.meshJersey?.material.color.getHexString()),
    state: window.__game.state,
  }));
  assert(
    fourRoster.humans === 4 && fourRoster.cpus === 0 && fourRoster.field === 4 &&
      !['player-count', 'player-select', 'cpu-prompt'].includes(fourRoster.state),
    `four-player setup must contain only P1-P4 with no CPU wait: ${JSON.stringify(fourRoster)}`,
  );
  assert(
    JSON.stringify(fourRoster.local.map((entry) => entry.label)) === JSON.stringify(['P1', 'P2', 'P3', 'P4']),
    `local players lost their P1-P4 identities: ${JSON.stringify(fourRoster.local)}`,
  );
  assert(
    JSON.stringify(fourRoster.firstOrder) === JSON.stringify(['P1', 'P2', 'P3', 'P4']),
    `Round 1 must schedule P1-P4 in order: ${JSON.stringify(fourRoster.firstOrder)}`,
  );
  assert(new Set(fourRoster.jerseyColors).size === 4, `local kit colours must be visibly distinct: ${JSON.stringify(fourRoster.jerseyColors)}`);
  const localTurns = [];
  const selectedRacks = ['left-corner', 'left-wing', 'top', 'right-wing'];
  for (let guard = 0; guard < 16 && localTurns.length < 4; guard++) {
    if (!await localFour.page.evaluate(() => window.__game.state === 'money-select')) await simToUser(localFour.page);
    const setup = await localFour.page.evaluate(() => ({
      state: window.__game.state,
      label: window.__game.currentProfile?.playerLabel ?? null,
      hasRound: !!window.__game.round,
      configured: window.__game.moneyRacks.size,
    }));
    assert(setup.state === 'money-select' && !setup.hasRound, `local turn must stop for that player's rack before shooting: ${JSON.stringify(setup)}`);
    assert(setup.configured === localTurns.length, `money racks were configured before their owners' turns: ${JSON.stringify(setup)}`);
    await chooseRack(localFour.page, selectedRacks[localTurns.length]);
    const current = await localFour.page.evaluate(() => ({
      user: !!window.__game.round?.profile.user,
      label: window.__game.round?.profile.playerLabel ?? null,
      characterIndex: window.__game.round?.profile.characterIndex ?? null,
      shooterIndex: window.__game.localPlayers.indexOf(window.__game.round?.shooter),
    }));
    assert(current.user && current.label === setup.label, `rack setup did not pass control to the same local player: ${JSON.stringify({ setup, current })}`);
    localTurns.push(current);
    await finishUser(localFour.page, 8 + localTurns.length);
  }
  assert(
    JSON.stringify(localTurns.map((turn) => turn.label)) === JSON.stringify(['P1', 'P2', 'P3', 'P4']) &&
      localTurns.every((turn) => turn.characterIndex === turn.shooterIndex),
    `four local players did not receive ordered pass-and-play turns: ${JSON.stringify(localTurns)}`,
  );
  assert(localFour.errors.length === 0, `four-player console errors: ${localFour.errors.join(' | ')}`);
  await localFour.page.close();

  // Elimination route.
  const eliminated = await openContest(browser, 'vibe-2026');
  await setupPlayers(eliminated.page);
  await chooseRack(eliminated.page, 'top');
  await simToUser(eliminated.page);
  await finishUser(eliminated.page, 0);
  await simToUser(eliminated.page);
  const eliminatedState = JSON.parse(await eliminated.page.evaluate(() => window.render_game_to_text()));
  assert(eliminatedState.state === 'eliminated' && eliminatedState.userStatus === 'eliminated', '0-point first round must stop on an explicit elimination result');
  assert(await eliminated.page.locator('#contest-elimination-panel').isVisible(), 'round-one elimination panel must be visible');
  assert(await eliminated.page.locator('#contest-ranking li.advanced').count() === 3, 'roadmap must promote exactly three round-one finalists');
  assert(await eliminated.page.locator('#contest-ranking li.eliminated').count() === 1, 'four-shooter roadmap must cross out only the one round-one elimination');
  assert(await eliminated.page.locator('#contest-roadmap-finalists li:not(.placeholder)').count() === 3, 'roadmap must name all three finalists');
  assert((await eliminated.page.locator('#contest-elimination-copy').innerText()).includes('top three advance'), 'elimination panel must explain the cutoff');
  await eliminated.page.waitForTimeout(600);
  await eliminated.page.screenshot({ path: path.join(outDir, 'eliminated-round-one.png') });
  await eliminated.page.locator('#contest-watch-final').click();
  await tick(eliminated.page, 1);
  assert(
    await eliminated.page.evaluate(() => window.__game.stage === 'final' && window.__game.round?.cpu),
    'WATCH FINAL must enter the CPU championship round instead of ending after round one',
  );
  await simToUser(eliminated.page);
  const postFinal = JSON.parse(await eliminated.page.evaluate(() => window.render_game_to_text()));
  assert(postFinal.state === 'results' && postFinal.winner !== 'VOLT', 'CPU-only final must finish after VOLT is eliminated');
  assert(eliminated.errors.length === 0, `elimination route console errors: ${eliminated.errors.join(' | ')}`);
  await eliminated.page.close();

  // Exact cutoff tie -> official 30-second repeated advancement tiebreak.
  const cutoffTie = await openContest(browser, 'vibe-2026');
  await setupPlayers(cutoffTie.page);
  await chooseRack(cutoffTie.page, 'top');
  const cutoff = await cutoffTie.page.evaluate(() => {
    const scores = window.__game.stageEntrants
      .filter((profile) => !profile.user)
      .map((profile) => window.__game.planFor(profile).score)
      .sort((a, b) => b - a);
    return scores[2];
  });
  await simToUser(cutoffTie.page);
  await finishUser(cutoffTie.page, cutoff);
  await simToUser(cutoffTie.page);
  const tiebreak = await cutoffTie.page.evaluate(() => ({
    stage: window.__game.stage,
    limit: window.__game.timeLimit,
    userUp: !!window.__game.round?.profile.user,
  }));
  assert(tiebreak.stage === 'advance-tiebreak' && tiebreak.limit === 30 && tiebreak.userUp, 'cutoff tie must create a 30-second user tiebreak');
  await finishUser(cutoffTie.page, 40);
  await simToUser(cutoffTie.page);
  assert(await cutoffTie.page.evaluate(() => window.__game.stage === 'final'), 'winning the advancement tiebreak must reach the final');
  assert(cutoffTie.errors.length === 0, `cutoff tie route console errors: ${cutoffTie.errors.join(' | ')}`);
  await cutoffTie.page.close();

  // Final tie -> 70-second championship replay; win that replay.
  const finalTie = await openContest(browser, 'vibe-final-tie');
  await setupPlayers(finalTie.page);
  await chooseRack(finalTie.page, 'top');
  await simToUser(finalTie.page);
  await finishUser(finalTie.page, 40);
  await simToUser(finalTie.page);
  assert(await finalTie.page.evaluate(() => window.__game.state === 'money-select'), 'final setup did not request a money rack');
  await chooseRack(finalTie.page, 'right-corner');
  await simToUser(finalTie.page);
  const finalCpuHigh = await finalTie.page.evaluate(() => Math.max(...window.__game.stageRecords.map((entry) => entry.score)));
  await finishUser(finalTie.page, finalCpuHigh);
  await simToUser(finalTie.page);
  const finalReplay = await finalTie.page.evaluate(() => ({
    stage: window.__game.stage,
    limit: window.__game.timeLimit,
    userUp: !!window.__game.round?.profile.user,
  }));
  assert(
    finalReplay.stage === 'championship-tiebreak' && finalReplay.limit === 70 && finalReplay.userUp,
    `final tie must create a 70-second championship replay: ${JSON.stringify({ finalCpuHigh, finalReplay })}`,
  );
  await finishUser(finalTie.page, 40);
  await simToUser(finalTie.page);
  assert(await finalTie.page.evaluate(() => window.__game.state === 'results' && window.__game.winner.name === 'VOLT'), 'winning the championship replay must crown VOLT');
  const finalTextState = JSON.parse(await finalTie.page.evaluate(() => window.render_game_to_text()));
  assert(finalTextState.final[0]?.tiebreakScore === 40, 'automation text must expose the deciding tiebreak score');
  const resultText = await finalTie.page.locator('#contest-final-ranking').innerText();
  assert(resultText.includes('TB 40'), 'championship result must expose the deciding tiebreak score');
  assert(finalTie.errors.length === 0, `final tie route console errors: ${finalTie.errors.join(' | ')}`);
  await finalTie.page.close();

  console.log('PASS three-point contest: menu, watch/skip determinism, physical ball pool, qualify/eliminate, 30s and 70s tiebreaks, champion');
} finally {
  await browser.close();
}
