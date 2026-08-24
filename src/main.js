import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { buildEnvironment } from './world/environment.js';
import { buildCourt } from './world/court.js';
import { Game } from './game/game.js';
import { CameraRig } from './game/cameraRig.js';
import { HUD } from './ui/hud.js';
import { input } from './input.js';

const params = new URLSearchParams(location.search);
const ATTRACT = params.has('attract');
const LITE = params.has('lite');
const SIL = params.has('sil');
const SLOW = params.has('slow') ? Math.max(0.05, parseFloat(params.get('slow')) || 0.35) : 1;

// ---------------------------------------------------------------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = !LITE;
// PCF, not PCF_SOFT: only the plain PCF kernel honours SpotLight.shadow.radius
// (PCF_SOFT hardcodes a one-texel blur). The floodlight banks are metre-wide
// fixtures seven metres up — their shadows need a penumbra we can dial per
// light, which is what environment.js's `blur` sets.
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// 1.22 was parking the court paint at 204/255, up on the shoulder of the ACES
// curve where it compresses everything: a shadow could not darken the floor
// enough to be seen even when one was being cast. Dropping the exposure puts
// the lit floor back in the middle of the curve where there is room for one.
renderer.toneMappingExposure = 0.92;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 500);
camera.position.set(0, 7.4, 19.2);

// ---------------------------------------------------------------- world
const env = buildEnvironment(scene, renderer);
const court = buildCourt(scene);

// ---------------------------------------------------------------- post
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.26,   // strength (restrained)
  0.5,    // radius
  0.88    // threshold
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------------------------------------------------------------- game
const hud = new HUD();
if (params.has('debug')) hud.toggleDebug();
if (params.has('clean')) hud.toggleHelp();
// Athletes and animation are generated at runtime from project-owned source.
// The public build does not fetch character models or animation packs.
const game = new Game(scene, hud, { attract: ATTRACT });
game.court = court;
game.env = env;
const cameraRig = new CameraRig(camera);
game.cameraRig = cameraRig;
if (params.has('cam')) cameraRig.presetIdx = parseInt(params.get('cam'), 10) || 0;
window.__input = input;

// ---------------------------------------------------------------- silhouette test (?sil=1)
// Renders athletes as pure black against a flat field: the broadcast-distance
// readability check ("is that a human athlete?") with no shading to hide behind.
if (SIL) {
  scene.background = new THREE.Color(0xdfe4ea);
  scene.fog = null;
  const black = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const keep = new Set();
  for (const p of game.players) p.rig.group.traverse((o) => keep.add(o));
  keep.add(game.ball.mesh);
  scene.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh && !o.isPoints && !o.isLine) return;
    if (keep.has(o)) { o.material = black; return; }
    o.visible = false;
  });
  game.ball.mesh.material = new THREE.MeshBasicMaterial({ color: 0x3a3a3a });
  document.getElementById('hud').style.display = 'none';
}

// ---------------------------------------------------------------- resize
window.addEventListener('resize', () => {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
});

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
let fpsAcc = 0, fpsN = 0, fps = 60, dbgT = 0, frameCount = 0;
let lastNow = performance.now(); const prof = {};
let manualTime = false;
let manualFrames = 0;

window.render_game_to_text = () => JSON.stringify({
  coordinates: 'metres; court centre x=0, floor y=0, hoop is toward decreasing z',
  state: game.state,
  score: game.score,
  shotClock: +game.shotClock.toFixed(2),
  offense: game.offenseIdx,
  players: game.players.map((p) => ({
    name: p.name, team: p.team, controlled: p === game.userPlayer, hasBall: p.hasBall,
    position: [+p.pos.x.toFixed(2), +p.y.toFixed(2), +p.pos.z.toFixed(2)],
    velocity: [+p.vel.x.toFixed(2), +p.vy.toFixed(2), +p.vel.z.toFixed(2)],
    action: p.action?.name ?? p.gatherAction?.kind ?? p.moveAnim?.name ??
      (p.burstDrive ? 'burst' : p.state),
    actionVariant: p.action?.variant ?? p.gatherAction?.preview?.variant ?? null,
    gatherPhase: p.gatherAction
      ? +Math.min(1, (p.gatherAction.t ?? 0) / 0.3).toFixed(2) : null,
    movePhase: p.moveAnim ? +Math.min(1, p.moveAnim.t / p.moveAnim.dur).toFixed(2) : null,
    rootMove: p.skillPath?.kind ?? null,
    burst: p.burstDrive ? {
      source: p.burstDrive.source,
      phase: +Math.min(1, p.burstDrive.t / p.burstDrive.dur).toFixed(2),
      direction: [+p.burstDrive.dirX.toFixed(2), +p.burstDrive.dirZ.toFixed(2)],
    } : null,
    moveFromHand: p.moveAnim?.fromHand ?? null,
    moveToHand: p.moveAnim?.toHand ?? null,
    dribbleHand: p.dribbleHand, airborne: p.airborne,
    dribbleStarted: p.dribbleStarted,
    dribbleEnded: p.dribbleEnded, clearedBall: p.clearedBall,
  })),
  ball: {
    state: game.ball.state,
    position: [+game.ball.pos.x.toFixed(2), +game.ball.pos.y.toFixed(2), +game.ball.pos.z.toFixed(2)],
    velocity: [+game.ball.vel.x.toFixed(2), +game.ball.vel.y.toFixed(2), +game.ball.vel.z.toFixed(2)],
    holder: game.ball.holder?.name ?? null,
    dribblePhase: game.ball.dribble?.phase ?? null,
  },
  rebounds: game.stats.rebounds,
  feedback: game.feedback?.state() ?? null,
  clearRequired: game.state === 'live' && game.userPlayer.hasBall && !game.userPlayer.clearedBall,
});

// Deterministic stepping for the game QA client. Normal players never call it,
// so rAF remains the production clock; the first automated step simply takes
// ownership of time for that page instance.
window.advanceTime = (ms) => {
  manualTime = true;
  const steps = Math.max(1, Math.round(ms / (1000 / 60)));
  for (let i = 0; i < steps; i++) {
    game.update(1 / 60);
    cameraRig.update(1 / 60, game);
    if (game.camShake) { cameraRig.addShake(game.camShake); game.camShake = 0; }
  }
  manualFrames += steps;
  // SwiftShader browser QA is dominated by drawing this detailed park. Four
  // fixed simulation samples per image is still visually current and keeps an
  // input burst from rendering the same pose dozens of times.
  if (manualFrames % 4 < steps) {
    if (LITE) renderer.render(scene, camera);
    else composer.render();
  }
};

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyF' || e.repeat) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else renderer.domElement.requestFullscreen();
});

function frame() {
  requestAnimationFrame(frame);
  if (manualTime) return;
  const now = performance.now();
  // robust dt: rAF callbacks can arrive with identical timestamps under
  // throttling/virtual time; fall back to wall-clock gap
  let dt = clock.getDelta();
  if (dt <= 1e-6) dt = Math.min((now - lastNow) / 1000, 1 / 15);
  lastNow = now;
  dt = Math.min(dt, 1 / 15) * SLOW;
  const t = clock.elapsedTime;
  frameCount++;
  if (frameCount <= 12) hud.debug(`frame ${frameCount} dt=${dt.toFixed(4)} t=${t.toFixed(2)}`);
  if (params.has('prof')) {
    const a = performance.now();
    game.update(dt);
    const b = performance.now();
    cameraRig.update(dt, game);
    const c = performance.now();
    if (game.camShake) { cameraRig.addShake(game.camShake); game.camShake = 0; }
    if (LITE) renderer.render(scene, camera);
    else composer.render();
    const d = performance.now();
    prof.update = Math.max(prof.update ?? 0, b - a);
    prof.cam = Math.max(prof.cam ?? 0, c - b);
    prof.render = Math.max(prof.render ?? 0, d - c);
    hud.debug(`update ${prof.update.toFixed(1)}ms cam ${prof.cam.toFixed(1)}ms render ${prof.render.toFixed(1)}ms frames ${frameCount}`);
    return;
  }

  game.update(dt);
  cameraRig.update(dt, game);
  if (game.camShake) {
    cameraRig.addShake(game.camShake);
    game.camShake = 0;
  }

  // near-side cage: hidden while the 2K rig is live (it would cross the court)
  if (env.nearFence) {
    const showCage = cameraRig.preset.name !== '2k';
    for (const o of env.nearFence) if (o.visible !== showCage) o.visible = showCage;
  }

  // beacon blink
  if (env.beacons) {
    const on = (t * 1.2) % 2 < 1;
    for (const b of env.beacons) b.visible = on;
  }

  if (LITE) renderer.render(scene, camera);
  else composer.render();

  // fps + debug
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) {
    fps = fpsN / fpsAcc;
    fpsAcc = 0; fpsN = 0;
  }
  dbgT += dt;
  if (dbgT > 0.25) {
    dbgT = 0;
    const b = game.ball;
    const off = game.offense, def = game.defense;
    const pl = game.players.map((p, i) => {
      const br = game.brains[i];
      return `${p.name}${p.hasBall ? '*' : ''} ${p.action?.name ?? p.state} @${p.pos.x.toFixed(1)},${p.pos.z.toFixed(1)} y${p.y.toFixed(1)} v${Math.hypot(p.vel.x, p.vel.z).toFixed(1)} [${br.mode} th${(br.thinkT ?? 0).toFixed(1)} mT${(br.modeT ?? 0).toFixed(1)} cl${p.clearedBall ? 1 : 0}]`;
    }).join('\n');
    hud.debug(
      `FPS ${fps.toFixed(0)}  draws ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1000).toFixed(0)}k\n` +
      `state ${game.state} t${game.stateT.toFixed(1)} passed=${game.passed} clock ${game.shotClock.toFixed(1)}\n` +
      `ball ${b.state}${b.dribble ? ':' + b.dribble.phase : ''} hold=${b.holder?.name ?? '-'} @${b.pos.x.toFixed(1)},${b.pos.y.toFixed(1)},${b.pos.z.toFixed(1)}\n` +
      `user ${game.userPlayer.name} io=${JSON.stringify(game.userPlayer.intentOffense?.move)} mag=${game.userPlayer.intentOffense?.mag}\n` +
      pl +
      `\nscore ${game.score.join('-')} cam ${cameraRig['presetIdx']}${game.log ? '\n' + game.log.slice(-6).map(l => JSON.stringify(l)).join('\n') : ''}`
    );
  }
}

hud.doneLoading();
frame();

// error surface for automation
window.addEventListener('error', (e) => {
  const el = document.getElementById('loading');
  el.classList.remove('done');
  el.style.letterSpacing = '0.05em';
  el.style.fontSize = '13px';
  el.textContent = `ERROR: ${e.message} @ ${e.filename}:${e.lineno}`;
});
