import * as THREE from 'three';
import { Ball } from '../entities/ball.js';
import { Player } from '../entities/player.js';
import { input } from '../input.js';
import { CourtSfx } from './courtSfx.js';
import { FeedbackFx } from './feedbackFx.js';
import { PLAYER_CONFIGS } from './game.js';
import { SHOT_TIMING } from './shotTiming.js';
import {
  THREE_POINT_FORMAT,
  CONTEST_ROSTER,
  buildAttemptSequence,
  buildCpuRoundPlan,
  sortStandings,
  advancementDecision,
  championshipDecision,
  orderFinalists,
} from './threePointRules.js';
import { COURT } from '../world/court.js';
import { contestSpot } from '../world/contestRacks.js';

const ZERO_INTENT = Object.freeze({ move: Object.freeze({ x: 0, z: 0 }), mag: 0, sprint: false });
const NEXT_SHOT_BUFFER_SECONDS = 0.6;
const SAME_RACK_FEED_DELAY = 0.1;
const LOCAL_CHARACTER_IDS = Object.freeze(['volt', 'nova', 'mira', 'jett']);
const LOCAL_CHARACTER_KITS = Object.freeze([
  Object.freeze({ jersey: 0xf06a2b, shorts: 0x202734, shoes: 0xffb15d, numberColor: '#fff4dd' }),
  Object.freeze({ jersey: 0xc83dda, shorts: 0x2a1834, shoes: 0xff8df4, numberColor: '#fff1ff' }),
  Object.freeze({ jersey: 0x39c97a, shorts: 0x17352b, shoes: 0x9dffbd, numberColor: '#effff4' }),
  Object.freeze({ jersey: 0xe44843, shorts: 0x2f1b23, shoes: 0xff8b75, numberColor: '#fff0e8' }),
]);

function roundSeed(base, stage, entrantId, iteration) {
  return `${base}:${stage}:${entrantId}:${iteration}`;
}

function publicAttempt(attempt) {
  return {
    index: attempt.index,
    station: attempt.stationId,
    kind: attempt.kind,
    value: attempt.value,
    timely: attempt.timely ?? null,
    made: attempt.made ?? null,
    releasedAt: attempt.releasedAt ?? null,
  };
}

/**
 * A self-contained 3-Point Contest session. It shares the authored Player shot
 * and Ball physics with 1v1 while owning a separate tournament and HUD state.
 */
export class ThreePointContest {
  constructor(scene, hud, opts = {}) {
    this.mode = 'three-point';
    this.scene = scene;
    this.hud = hud;
    this.opts = opts;
    this.seed = opts.seed ?? new URLSearchParams(location.search).get('seed') ?? 'vibe-2026';
    this.rackSet = opts.rackSet;
    this.court = opts.court;
    this.env = opts.env;
    this.sfx = new CourtSfx();
    this.feedback = new FeedbackFx(scene);
    this._v = new THREE.Vector3();

    this.characterOptions = LOCAL_CHARACTER_IDS.map((id, index) => ({
      ...CONTEST_ROSTER.find((profile) => profile.id === id),
      ...LOCAL_CHARACTER_KITS[index],
      characterIndex: index,
    }));
    this.localPlayers = this.characterOptions.map((option, index) => {
      const player = new Player(scene, {
        ...PLAYER_CONFIGS[1],
        ...option,
        team: index + 10,
        bodyRadius: 0.4,
        number: index + 1,
      });
      player.gameRef = this;
      return player;
    });
    this.cpuPlayer = new Player(scene, { ...PLAYER_CONFIGS[1] });
    this.cpuPlayer.gameRef = this;
    this.players = [...this.localPlayers, this.cpuPlayer];
    this.userPlayer = this.localPlayers[0];
    for (const player of this.localPlayers) player.setIndicator(false);
    this.cpuPlayer.setIndicator(false);
    this.layoutSetupPlayers();

    this.balls = Array.from({ length: 8 }, () => new Ball(scene));
    this.balls.forEach((ball) => this.parkBall(ball));
    this.activeBall = null;
    this.flightBalls = [];
    this.ball = this.balls[0];

    this.stage = 'first';
    this.stageIteration = 0;
    this.stageEntrants = [];
    this.stageRecords = [];
    this.firstRecords = [];
    this.finalRecords = [];
    this.firstEntrants = [];
    this.finalEntrants = [];
    this.tiebreakHistory = [];
    this.pendingQualifiers = [];
    this.pendingFinalEntrants = [];
    this.openQualifierSlots = THREE_POINT_FORMAT.finalists;
    this.currentIndex = 0;
    this.currentProfile = null;
    this.currentPlan = null;
    this.contestRoster = [];
    this.localProfiles = [];
    this.playerCount = 1;
    this.moneyRacks = new Map();
    this.promptMoneyForStage = false;
    this.userMoneyRack = 'top';
    this.finalMoneyRack = 'top';
    this.state = 'player-count';
    this.stateT = 0;
    this.round = null;
    this.winner = null;
    this.canSkipCpu = false;
    this._meterHold = 0;

    this.rackSet?.setVisible(false);
    this.hud.setMode?.('three-point');
    this.refreshSetupHud();
    window.__game = this;
  }

  get offense() { return this.round?.shooter ?? this.userPlayer; }
  get offenseIdx() { return Math.max(0, this.players.indexOf(this.offense)); }
  get defense() { return null; }
  defensePlayer() { return null; }
  otherPlayer() { return null; }

  profileFor(entrantId) {
    return this.contestRoster.find((profile) => profile.id === entrantId)
      ?? CONTEST_ROSTER.find((profile) => profile.id === entrantId);
  }

  playerForProfile(profile) {
    return profile?.user
      ? this.localPlayers[profile.characterIndex ?? profile.localSlot ?? 0]
      : this.cpuPlayer;
  }

  layoutSetupPlayers() {
    const xs = [-3.15, -1.05, 1.05, 3.15];
    this.localPlayers.forEach((player, index) => {
      this.setAthleteVisible(player, true);
      player.pos.set(xs[index], 0, 7.0);
      player.facing = 0;
      this.applySetupPose(player);
      player.rig.group.position.set(player.pos.x, 0, player.pos.z);
      player.rig.group.rotation.y = 0;
    });
    this.setAthleteVisible(this.cpuPlayer, false);
  }

  applySetupPose(player) {
    player.hasBall = false;
    player.dribbleStarted = false;
    player.dribbleEnded = false;
    player.action = null;
    player.gatherAction = null;
    player.moveAnim = null;
    player.vel.set(0, 0, 0);
    player.state = 'idle';
    // Character select is a showroom, not a gameplay beat. Freeze the clean
    // procedural rest pose with both arms naturally at the player's sides.
    player.rig.resetPose();
    player.rig.group.position.set(player.pos.x, 0, player.pos.z);
    player.rig.group.rotation.set(0, 0, 0);
    player.rig.armature.updateMatrixWorld(true);
    player.rig.group.updateMatrixWorld(true);
    player.rig.updateGround(0, player.pos.x, player.pos.z, 0);
  }

  setupState() {
    return {
      phase: this.state,
      pose: 'neutral-static',
      playerCount: this.playerCount,
      assignments: this.characterOptions.map((_, index) => index < this.playerCount ? `P${index + 1}` : 'CPU'),
      options: this.characterOptions.map((option) => ({
        id: option.id, name: option.name, accent: option.accent,
      })),
    };
  }

  refreshSetupHud() {
    this.layoutSetupPlayers();
    this.hud.showContestSetup?.(this.setupState());
  }

  moveSetupSelection(direction) {
    if (this.state !== 'player-count') return false;
    this.playerCount = ((this.playerCount - 1 + direction + 4) % 4) + 1;
    this.refreshSetupHud();
    return true;
  }

  choosePlayerCount(count) {
    if (this.state !== 'player-count') return false;
    this.playerCount = Math.max(1, Math.min(4, Number(count) || 1));
    return this.confirmSetupSelection();
  }

  confirmSetupSelection() {
    if (this.state !== 'player-count') return false;
    this.completePlayerSetup();
    return true;
  }

  completePlayerSetup() {
    this.localProfiles = this.characterOptions.slice(0, this.playerCount).map((character, localSlot) => {
      const characterIndex = localSlot;
      return {
        ...character,
        user: true,
        localSlot,
        characterIndex,
        playerLabel: `P${localSlot + 1}`,
      };
    });
    const selectedIds = new Set(this.localProfiles.map((profile) => profile.id));
    const cpuProfiles = this.characterOptions
      .filter((profile) => !selectedIds.has(profile.id))
      .slice(0, THREE_POINT_FORMAT.fieldSize - this.localProfiles.length)
      .map((profile) => ({ ...profile, user: false }));
    this.contestRoster = [...this.localProfiles, ...cpuProfiles];
    this.localProfiles.forEach((profile) => {
      const player = this.playerForProfile(profile);
      player.name = profile.name;
      player.setIndicatorLabel(profile.playerLabel, profile.accent);
    });
    this.hud.hideContestOverlay?.();
    this.rackSet?.setVisible(true);
    for (const player of this.players) this.setAthleteVisible(player, false);
    this.startStage(
      'first',
      this.contestRoster,
      THREE_POINT_FORMAT.roundSeconds,
      true,
    );
  }

  setAthleteVisible(player, visible) {
    const show = !!visible;
    player.rig.group.visible = show;
    player.rig.shadow.visible = show;
    if (!show) player.setIndicator(false);
  }

  parkBall(ball) {
    ball.state = 'loose';
    ball.holder = null;
    ball.shot = null;
    ball.vel.set(0, 0, 0);
    ball.pos.set(0, -10, 0);
    ball.mesh.position.copy(ball.pos);
    ball.mesh.visible = false;
    ball.contestAttempt = null;
    ball.contestAge = 0;
  }

  resetPhysicalRound() {
    this.activeBall = null;
    this.flightBalls.length = 0;
    for (const ball of this.balls) this.parkBall(ball);
    for (const player of this.players) {
      player.setIndicator(false);
      player.hasBall = false;
      player.action = null;
      player.gatherAction = null;
      player.moveAnim = null;
      player.airborne = false;
      player.y = 0;
      player.vy = 0;
      player.vel.set(0, 0, 0);
      player.intentOffense = null;
      player.intentDefense = ZERO_INTENT;
    }
    this.hud.hideShotMeter?.();
  }

  startStage(stage, entrants, timeLimit, promptMoney = false) {
    this.resetPhysicalRound();
    this.stage = stage;
    this.stageIteration += 1;
    this.stageEntrants = [...entrants];
    if (stage === 'first') this.firstEntrants = [...entrants];
    this.stageRecords = [];
    this.currentIndex = 0;
    this.timeLimit = timeLimit;
    this.currentProfile = null;
    this.currentPlan = null;
    this.canSkipCpu = false;
    this.promptMoneyForStage = promptMoney;
    this.prepareCurrentEntrant();
  }

  selectMoneyRack(rackId) {
    if (this.state !== 'money-select' || !this.currentProfile?.user) return false;
    const profile = this.currentProfile;
    this.moneyRacks.set(`${this.moneyStageKey()}:${profile.id}`, rackId);
    if (profile.localSlot === 0) {
      if (this.moneyStageKey() === 'final') this.finalMoneyRack = rackId;
      else this.userMoneyRack = rackId;
    }
    this.hud.hideContestOverlay?.();
    this.beginPhysicalRound(profile, null);
    return true;
  }

  moneyStageKey(stage = this.stage) {
    return stage === 'final' || stage === 'championship-tiebreak' ? 'final' : 'first';
  }

  moneyRackFor(profile) {
    if (!profile.user) return profile.moneyRack;
    return this.moneyRacks.get(`${this.moneyStageKey()}:${profile.id}`) ?? profile.moneyRack ?? 'top';
  }

  prepareCurrentEntrant() {
    if (this.currentIndex >= this.stageEntrants.length) {
      this.resolveStage();
      return;
    }
    this.currentProfile = this.stageEntrants[this.currentIndex];
    this.stateT = 0;
    if (this.currentProfile.user) {
      const moneyKey = `${this.moneyStageKey()}:${this.currentProfile.id}`;
      if (this.promptMoneyForStage && !this.moneyRacks.has(moneyKey)) {
        this.state = 'money-select';
        this.canSkipCpu = false;
        this.hud.showMoneyRack?.(this.moneyRackFor(this.currentProfile), this.stage, this.currentProfile);
        this.syncHud();
        return;
      }
      this.beginPhysicalRound(this.currentProfile, null);
      return;
    }
    this.currentPlan = this.planFor(this.currentProfile);
    this.state = 'cpu-prompt';
    this.canSkipCpu = true;
    this.hud.showCpuPrompt?.(this.currentProfile, this.stageLabel());
    this.syncHud();
  }

  planFor(profile) {
    return buildCpuRoundPlan(
      profile,
      this.moneyRackFor(profile),
      roundSeed(this.seed, this.stage, profile.id, this.stageIteration),
      this.timeLimit,
    );
  }

  watchCpu() {
    if (this.state !== 'cpu-prompt') return;
    this.hud.hideContestOverlay?.();
    this.beginPhysicalRound(this.currentProfile, this.currentPlan ?? this.planFor(this.currentProfile));
  }

  simToMyTurn() {
    if (this.state === 'results' || this.state === 'eliminated') return;
    if (this.round?.cpu) {
      const plan = this.round.plan;
      this.resetPhysicalRound();
      this.commitRecord(this.recordFromPlan(plan));
    }
    this.canSkipCpu = false;
    this.hud.hideContestOverlay?.();

    let guard = 0;
    while (!['results', 'money-select', 'eliminated'].includes(this.state) && guard++ < 64) {
      if (this.currentIndex >= this.stageEntrants.length) {
        this.resolveStage(true);
        if (['results', 'money-select', 'eliminated'].includes(this.state)) break;
        continue;
      }
      const profile = this.stageEntrants[this.currentIndex];
      this.currentProfile = profile;
      if (profile.user) {
        // Stopping on a local entrant means stopping before their setup. Each
        // person chooses a rack at the moment the controller passes to them;
        // nobody has to configure P2-P4 before P1 can shoot.
        this.prepareCurrentEntrant();
        break;
      }
      const plan = this.planFor(profile);
      this.commitRecord(this.recordFromPlan(plan), false);
    }
    this.syncHud();
  }

  recordFromPlan(plan) {
    const profile = this.profileFor(plan.entrantId);
    return {
      entrantId: plan.entrantId,
      name: profile?.name ?? plan.entrantId,
      playerLabel: profile?.playerLabel ?? null,
      score: plan.score,
      attempts: plan.attempts.map((attempt) => ({ ...attempt })),
      order: this.currentIndex,
      stage: this.stage,
      simulated: true,
    };
  }

  beginPhysicalRound(profile, plan) {
    this.resetPhysicalRound();
    this.currentProfile = profile;
    this.currentPlan = plan;
    const shooter = this.playerForProfile(profile);
    shooter.name = profile.name;
    shooter.stamina = 1;
    for (const player of this.players) this.setAthleteVisible(player, player === shooter);
    const moneyRack = this.moneyRackFor(profile);
    const sourceAttempts = plan?.attempts ?? buildAttemptSequence(moneyRack);
    const attempts = sourceAttempts.map((attempt) => ({
      ...attempt,
      made: null,
      timely: null,
      releasedAt: null,
      resolved: false,
    }));
    const firstSpot = contestSpot(attempts[0].stationId);
    shooter.pos.copy(firstSpot.position);
    shooter.facing = firstSpot.facing;
    shooter.rig.group.position.set(shooter.pos.x, 0, shooter.pos.z);
    shooter.rig.group.rotation.y = shooter.facing;
    this.rackSet?.reset(moneyRack);
    this.round = {
      profile,
      shooter,
      cpu: !profile.user,
      plan,
      moneyRack,
      attempts,
      attemptIndex: 0,
      score: 0,
      clock: this.timeLimit,
      countdown: 3,
      phase: 'countdown',
      stationReadyT: 0,
      shotBufferT: 0,
      released: 0,
    };
    shooter.setIndicator(!!profile.user);
    if (profile.user) shooter.setIndicatorLabel(profile.playerLabel, profile.accent);
    this.ball = this.balls[0];
    this.state = 'countdown';
    this.stateT = 0;
    this.canSkipCpu = !profile.user;
    this.hud.hideContestOverlay?.();
    this.hud.msg?.(profile.name, this.stageLabel(), 1.0);
    this.syncHud();
  }

  stageLabel() {
    if (this.stage === 'first') return 'ROUND 1';
    if (this.stage === 'final') return 'FINAL';
    if (this.stage === 'advance-tiebreak') return '30-SECOND TIEBREAK';
    return 'CHAMPIONSHIP TIEBREAK';
  }

  acquireBall() {
    return this.balls.find((ball) => !ball.mesh.visible && ball !== this.activeBall) ?? null;
  }

  giveNextBall() {
    const round = this.round;
    const attempt = round?.attempts[round.attemptIndex];
    if (!attempt || round.clock <= 0) return false;
    const ball = this.acquireBall();
    if (!ball) return false;
    ball.mesh.visible = true;
    ball.setContestKind(attempt.kind);
    ball.contestAttempt = attempt;
    ball.contestAge = 0;
    round.activeAttempt = attempt;
    this.activeBall = ball;
    this.ball = ball;
    round.shooter.gainPossession(ball);
    // The rack feed is already in the player's hands. Start in a squared
    // triple-threat stance instead of replaying a pass-catch pose.
    round.shooter.catchT = 0;
    round.shooter.sinceCatch = 99;
    round.shooter.dribbleEnded = true;
    round.shooter.dribbleStarted = false;
    this.rackSet?.consume(attempt.index);
    round.phase = 'ready';
    round.stationReadyT = 0;
    return true;
  }

  updateMovement(dt) {
    const round = this.round;
    const attempt = round?.attempts[round.attemptIndex];
    if (!round || !attempt) return;
    const shooter = round.shooter;
    const spot = contestSpot(attempt.stationId);
    const dx = spot.position.x - shooter.pos.x;
    const dz = spot.position.z - shooter.pos.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 0.10) {
      const inv = 1 / Math.max(distance, 1e-5);
      shooter.intentDefense = {
        move: { x: dx * inv, z: dz * inv },
        mag: 1,
        sprint: distance > 1.1,
        physical: false,
      };
      shooter.intentOffense = null;
      round.phase = 'moving';
    } else {
      shooter.pos.copy(spot.position);
      shooter.vel.x = 0;
      shooter.vel.z = 0;
      shooter.intentDefense = ZERO_INTENT;
      shooter.facing = spot.facing;
      round.stationReadyT += dt;
      if (round.stationReadyT >= SAME_RACK_FEED_DELAY) this.giveNextBall();
    }
  }

  mapRoundInput(it) {
    const round = this.round;
    const shooter = round?.shooter;
    if (!round || !shooter) return;
    shooter.intentDefense = null;
    shooter.intentOffense = {
      move: { x: 0, z: 0 }, mag: 0, sprint: false,
      shoot: it.shoot,
      shootCommitted: it.shootCommitted,
      shootReleasedCommitted: it.shootReleasedCommitted,
      shootReleased: it.shootReleased,
      physical: false,
    };
    if (round.cpu) {
      if (!shooter.action && round.stationReadyT >= 0.16) shooter.startContestShot(false);
    } else if (round.clock > 0 && (it.shootPressed || (round.shotBufferT > 0 && it.shoot))) {
      if (shooter.startContestShot(true)) round.shotBufferT = 0;
    }
  }

  consumeShotOutcomeOverride(shooter) {
    if (!this.round?.cpu || shooter !== this.round.shooter) return null;
    const planned = this.round.plan?.attempts[this.round.attemptIndex];
    return planned ? { made: planned.made, probability: planned.probability } : null;
  }

  onShotReleased(shooter, probability, timingQuality, missLabel, points, made) {
    const round = this.round;
    const ball = this.activeBall;
    const attempt = round?.activeAttempt;
    if (!round || !ball || !attempt) return;
    const planned = round.plan?.attempts[attempt.index];
    attempt.timely = round.clock > 0;
    attempt.releasedAt = +(this.timeLimit - round.clock).toFixed(3);
    attempt.timingQuality = planned?.timingQuality ?? timingQuality;
    attempt.probability = planned?.probability ?? probability;
    attempt.intendedMake = planned?.made ?? made;
    ball.contestAttempt = attempt;
    ball.contestAge = 0;
    this.flightBalls.push(ball);
    this.activeBall = null;
    round.activeAttempt = null;
    round.attemptIndex += 1;
    round.released += 1;
    round.phase = 'post-shot';
    round.stationReadyT = 0;
    this.ball = ball;

    if (!round.cpu) {
      const side = missLabel === 'EARLY' ? 'EARLY' : 'LATE';
      const result = timingQuality >= 1 ? ['PERFECT', 'perfect', 'GREEN RELEASE']
        : timingQuality >= 0.78 ? ['GOOD', 'good', `SLIGHTLY ${side}`]
          : timingQuality >= 0.55 ? ['OK', 'ok', side] : ['BAD', 'bad', `VERY ${side}`];
      this.hud.shotFeedback?.(result[0], result[1], result[2]);
      if (timingQuality >= 1) {
        this.feedback.perfectRelease(ball);
        this.sfx.perfect();
      }
    }
    void points;
  }

  resolveAttempt(ball, made) {
    const attempt = ball.contestAttempt;
    if (!attempt || attempt.resolved) return;
    attempt.resolved = true;
    attempt.made = !!made && attempt.timely !== false;
    if (attempt.made) {
      this.round.score += attempt.value;
      this.hud.scorePop?.(this.round.cpu ? 1 : 0);
    }
    this.syncHud();
  }

  updateFlightBalls(dt) {
    for (const ball of [...this.flightBalls]) {
      ball.contestAge += dt;
      ball.update(dt, [this.round.shooter]);
      for (const event of ball.consumeEvents()) {
        if (event.type === 'score') {
          this.resolveAttempt(ball, true);
          this.sfx.swish(event.clean ?? false);
          this.court?.net.kick?.(ball);
          this.feedback.score(COURT.rimCenter, event.clean ?? false, false);
        } else if (event.type === 'miss') {
          this.resolveAttempt(ball, false);
        } else if (event.type === 'rim-hit') {
          this.sfx.rim(event.speed);
        } else if (event.type === 'board-hit') {
          this.sfx.board(event.speed);
        } else if (event.type === 'floor-bounce') {
          this.sfx.dribble(event.impact);
        }
      }
      if ((!ball.contestAttempt?.resolved && ball.contestAge > 5.0) ||
          (ball.contestAttempt?.resolved && ball.contestAge > 2.4)) {
        this.resolveAttempt(ball, ball.shot?.scored === true);
        this.flightBalls.splice(this.flightBalls.indexOf(ball), 1);
        this.parkBall(ball);
      }
    }
  }

  finishUnreleasedAttempts() {
    const round = this.round;
    if (!round) return;
    if (this.activeBall) {
      round.shooter.hasBall = false;
      round.shooter.action = null;
      this.parkBall(this.activeBall);
      this.activeBall = null;
      round.activeAttempt = null;
    }
    for (let i = round.attemptIndex; i < round.attempts.length; i++) {
      const attempt = round.attempts[i];
      attempt.timely = false;
      attempt.made = false;
      attempt.resolved = true;
    }
    round.attemptIndex = round.attempts.length;
  }

  updateRound(dt, it) {
    const round = this.round;
    if (!round) return;
    const shooter = round.shooter;
    if (this.state === 'countdown') {
      round.countdown -= dt;
      shooter.intentDefense = ZERO_INTENT;
      shooter.update(dt, this.ball, this);
      if (round.countdown > 0) {
        const number = Math.max(1, Math.ceil(round.countdown));
        if (number !== round.lastCountdown) {
          round.lastCountdown = number;
          this.hud.msg?.(String(number), round.profile.name, 0.75);
        }
      } else {
        this.state = 'running';
        round.phase = 'moving';
        this.hud.msg?.('GO!', this.stageLabel(), 0.7);
      }
      return;
    }

    if (this.state === 'running') {
      // A player naturally presses for the next jumper while the previous one
      // is landing. Preserve that press across the short same-rack handoff so
      // the next meter starts without a second key-down. The short lifetime
      // deliberately expires during a run to another station.
      round.shotBufferT = Math.max(0, round.shotBufferT - dt);
      if (!round.cpu && it.shootPressed && round.clock > 0) {
        round.shotBufferT = NEXT_SHOT_BUFFER_SECONDS;
      } else if (!it.shoot) {
        round.shotBufferT = 0;
      }

      if (round.phase === 'moving') this.updateMovement(dt);
      else if (round.phase === 'ready') {
        round.stationReadyT += dt;
        this.mapRoundInput(it);
      }
      else if (round.phase === 'post-shot' && !shooter.action) {
        round.phase = round.attemptIndex >= round.attempts.length ? 'settling' : 'moving';
      }

      const updateBall = this.activeBall ?? this.flightBalls.at(-1) ?? this.balls[0];
      shooter.update(dt, updateBall, this);
      if (round.phase === 'post-shot' && shooter.action?.contestAttempt &&
          shooter.action.released && !shooter.airborne) {
        // The authored jumper has already landed. Its remaining clip tail is
        // useful in 1v1, but here it only delays the next rack ball.
        shooter.action = null;
        shooter.moveLock = Math.min(shooter.moveLock, 0.06);
        shooter.landRecover = Math.min(shooter.landRecover, 0.08);
        round.phase = round.attemptIndex >= round.attempts.length ? 'settling' : 'moving';
      }
      if (this.activeBall) {
        this.activeBall.update(dt, [shooter]);
        this.ball = this.activeBall;
      }
      round.clock = Math.max(0, round.clock - dt);
      if (round.clock <= 0) {
        this.finishUnreleasedAttempts();
        round.phase = 'settling';
        this.state = 'settling';
        this.hud.msg?.('TIME!', 'WAITING FOR THE LAST BALL', 1.1);
      } else if (round.attemptIndex >= round.attempts.length && !shooter.action) {
        round.phase = 'settling';
        this.state = 'settling';
      }
    } else if (this.state === 'settling') {
      shooter.intentOffense = ZERO_INTENT;
      shooter.intentDefense = ZERO_INTENT;
      shooter.update(dt, this.flightBalls.at(-1) ?? this.balls[0], this);
    }

    this.updateFlightBalls(dt);
    if (this.state === 'settling' && this.flightBalls.length === 0) this.completePhysicalRound();
  }

  completePhysicalRound() {
    const round = this.round;
    if (!round) return;
    const record = round.cpu
      ? this.recordFromPlan(round.plan)
      : {
          entrantId: round.profile.id,
          name: round.profile.name,
          playerLabel: round.profile.playerLabel ?? null,
          score: round.score,
          attempts: round.attempts.map((attempt) => ({ ...attempt })),
          order: this.currentIndex,
          stage: this.stage,
          simulated: false,
        };
    this.resetPhysicalRound();
    this.commitRecord(record);
  }

  commitRecord(record, prepareNext = true) {
    this.stageRecords.push(record);
    this.currentIndex += 1;
    this.round = null;
    this.currentPlan = null;
    this.currentProfile = null;
    this.canSkipCpu = false;
    if (prepareNext) this.prepareCurrentEntrant();
  }

  resolveStage(deferPrepare = false) {
    if (this.stage === 'first') {
      this.firstRecords = [...this.stageRecords];
      const decision = advancementDecision(this.firstRecords);
      if (decision.tied.length) {
        this.pendingQualifiers = [...decision.qualifiers];
        this.openQualifierSlots = decision.openSlots;
        this.tiebreakHistory.push({ stage: this.stage, records: [...this.stageRecords] });
        const profiles = decision.tied.map((record) => this.profileFor(record.entrantId));
        this.startStage('advance-tiebreak', profiles, THREE_POINT_FORMAT.advanceTiebreakSeconds, false);
      } else {
        this.startFinal(decision.qualifiers);
      }
    } else if (this.stage === 'advance-tiebreak') {
      this.tiebreakHistory.push({ stage: this.stage, records: [...this.stageRecords] });
      const decision = advancementDecision(this.stageRecords, this.openQualifierSlots);
      if (decision.tied.length) {
        this.pendingQualifiers.push(...decision.qualifiers);
        this.openQualifierSlots = decision.openSlots;
        const profiles = decision.tied.map((record) => this.profileFor(record.entrantId));
        this.startStage('advance-tiebreak', profiles, THREE_POINT_FORMAT.advanceTiebreakSeconds, false);
      } else {
        this.startFinal([...this.pendingQualifiers, ...decision.qualifiers]);
      }
    } else if (this.stage === 'final') {
      this.finalRecords = [...this.stageRecords];
      const decision = championshipDecision(this.finalRecords);
      if (decision.tied.length) {
        this.tiebreakHistory.push({ stage: this.stage, records: [...this.stageRecords] });
        const profiles = decision.tied.map((record) => this.profileFor(record.entrantId));
        this.startStage('championship-tiebreak', profiles, THREE_POINT_FORMAT.championshipTiebreakSeconds, false);
      } else {
        this.finishTournament(decision.winner);
      }
    } else if (this.stage === 'championship-tiebreak') {
      this.tiebreakHistory.push({ stage: this.stage, records: [...this.stageRecords] });
      const decision = championshipDecision(this.stageRecords);
      if (decision.tied.length) {
        const profiles = decision.tied.map((record) => this.profileFor(record.entrantId));
        this.startStage('championship-tiebreak', profiles, THREE_POINT_FORMAT.championshipTiebreakSeconds, false);
      } else {
        this.finishTournament(decision.winner);
      }
    }
    if (!deferPrepare) this.syncHud();
  }

  startFinal(qualifierRecords) {
    const ordered = orderFinalists(qualifierRecords, this.firstRecords)
      .map((record) => this.profileFor(record.entrantId));
    this.finalEntrants = [...ordered];
    if (!ordered.some((profile) => profile.user)) {
      this.pauseForElimination(ordered);
      return;
    }
    this.startStage('final', ordered, THREE_POINT_FORMAT.roundSeconds, ordered.some((profile) => profile.user));
  }

  pauseForElimination(finalists) {
    this.resetPhysicalRound();
    this.pendingFinalEntrants = [...finalists];
    this.state = 'eliminated';
    this.currentProfile = null;
    this.currentPlan = null;
    this.canSkipCpu = false;
    const standings = sortStandings(this.firstRecords);
    const localIds = new Set(this.localProfiles.map((profile) => profile.id));
    const localResults = standings
      .map((record, index) => ({ ...record, rank: index + 1 }))
      .filter((record) => localIds.has(record.entrantId));
    const bestLocal = localResults[0];
    for (const player of this.players) this.setAthleteVisible(player, false);
    const bestProfile = bestLocal ? this.profileFor(bestLocal.entrantId) : this.localProfiles[0];
    if (bestProfile) this.setAthleteVisible(this.playerForProfile(bestProfile), true);
    this.hud.showContestElimination?.({
      rank: bestLocal?.rank ?? 0,
      score: bestLocal?.score ?? 0,
      localResults,
      standings,
    });
  }

  continueAfterElimination(watchFinal = false) {
    if (this.state !== 'eliminated' || !this.pendingFinalEntrants.length) return false;
    const finalists = [...this.pendingFinalEntrants];
    this.pendingFinalEntrants.length = 0;
    this.hud.hideContestOverlay?.();
    this.startStage('final', finalists, THREE_POINT_FORMAT.roundSeconds, false);
    if (watchFinal) this.watchCpu();
    else this.simToMyTurn();
    return true;
  }

  finishTournament(winner) {
    this.resetPhysicalRound();
    this.state = 'results';
    this.winner = winner;
    this.rackSet?.setVisible(true);
    for (const player of this.players) this.setAthleteVisible(player, false);
    const winnerProfile = this.profileFor(winner?.entrantId);
    if (winnerProfile) this.setAthleteVisible(this.playerForProfile(winnerProfile), true);
    this.hud.showContestResults?.(winner, this.resultStandings());
    this.syncHud();
  }

  resultStandings() {
    if (this.stage !== 'championship-tiebreak') {
      return sortStandings(this.finalRecords.length ? this.finalRecords : this.stageRecords);
    }
    const finalByEntrant = new Map(this.finalRecords.map((record) => [record.entrantId, record]));
    const tiebreakIds = new Set(this.stageRecords.map((record) => record.entrantId));
    const decidingOrder = sortStandings(this.stageRecords).map((record) => ({
      ...(finalByEntrant.get(record.entrantId) ?? record),
      tiebreakScore: record.score,
    }));
    const remainingFinalists = sortStandings(
      this.finalRecords.filter((record) => !tiebreakIds.has(record.entrantId)),
    );
    return [...decidingOrder, ...remainingFinalists];
  }

  liveStandings() {
    const entries = [...this.stageRecords];
    if (this.round) {
      entries.push({
        entrantId: this.round.profile.id,
        name: this.round.profile.name,
        playerLabel: this.round.profile.playerLabel ?? null,
        score: this.round.score,
        order: this.currentIndex,
        live: true,
      });
    }
    return sortStandings(entries);
  }

  tournamentRoadmap() {
    const profileFor = (entrantId) => this.profileFor(entrantId);
    const recordsWithLive = (records, includeRound = true) => {
      const map = new Map(records.map((record) => [record.entrantId, record]));
      if (includeRound && this.round) {
        map.set(this.round.profile.id, {
          entrantId: this.round.profile.id,
          name: this.round.profile.name,
          score: this.round.score,
          live: true,
        });
      }
      return map;
    };

    const firstProfiles = this.firstEntrants.length ? this.firstEntrants : this.contestRoster;
    const firstMap = this.stage === 'first'
      ? recordsWithLive(this.stageRecords)
      : recordsWithLive(this.firstRecords, false);
    const finalistIds = new Set(this.finalEntrants.map((profile) => profile.id));
    const safeQualifierIds = new Set(this.pendingQualifiers.map((record) => record.entrantId));
    const advancementTiebreakIds = new Set(
      this.stage === 'advance-tiebreak' ? this.stageEntrants.map((profile) => profile.id) : [],
    );
    const firstLocked = this.firstRecords.length >= firstProfiles.length;
    const first = firstProfiles.map((profile) => {
      const record = firstMap.get(profile.id);
      let status = 'pending';
      if (!firstLocked) {
        if (this.round?.profile.id === profile.id) status = 'live';
        else if (record) status = 'complete';
      } else if (finalistIds.has(profile.id) || safeQualifierIds.has(profile.id)) {
        status = 'advanced';
      } else if (advancementTiebreakIds.has(profile.id)) {
        status = 'tiebreak';
      } else {
        status = 'eliminated';
      }
      return {
        entrantId: profile.id,
        name: profile.name,
        playerLabel: profile.playerLabel ?? null,
        accent: profile.accent,
        score: record?.score ?? null,
        status,
      };
    });

    const finalBaseRecords = this.stage === 'final'
      ? this.stageRecords
      : this.finalRecords;
    const finalMap = recordsWithLive(finalBaseRecords, this.stage === 'final');
    const titleTiebreakMap = this.stage === 'championship-tiebreak'
      ? recordsWithLive(this.stageRecords)
      : new Map();
    const titleTiebreakIds = new Set(this.stage === 'championship-tiebreak'
      ? this.stageEntrants.map((profile) => profile.id)
      : []);
    const final = Array.from({ length: THREE_POINT_FORMAT.finalists }, (_, index) => {
      const profile = this.finalEntrants[index];
      if (!profile) return { entrantId: null, name: `FINALIST ${index + 1}`, status: 'pending', score: null };
      const record = finalMap.get(profile.id);
      const tiebreak = titleTiebreakMap.get(profile.id);
      let status = 'pending';
      if (this.winner) status = this.winner.entrantId === profile.id ? 'champion' : 'eliminated';
      else if (this.stage === 'championship-tiebreak') {
        status = titleTiebreakIds.has(profile.id) ? 'tiebreak' : 'eliminated';
      } else if (this.round?.profile.id === profile.id) status = 'live';
      else if (record) status = 'complete';
      return {
        entrantId: profile.id,
        name: profile.name,
        playerLabel: profile.playerLabel ?? null,
        accent: profile.accent,
        score: record?.score ?? null,
        tiebreakScore: tiebreak?.score ?? null,
        status,
      };
    });

    const winningProfile = this.winner ? profileFor(this.winner.entrantId) : null;
    const winningFinal = final.find((entry) => entry.entrantId === this.winner?.entrantId);
    const champion = winningProfile ? {
      entrantId: winningProfile.id,
      name: winningProfile.name,
      playerLabel: winningProfile.playerLabel ?? null,
      accent: winningProfile.accent,
      score: winningFinal?.score ?? this.winner.score,
      tiebreakScore: winningFinal?.tiebreakScore ?? null,
    } : null;
    const label = this.state === 'results' ? 'COMPLETE'
      : this.stage === 'advance-tiebreak' ? 'ADVANCEMENT TB'
        : this.stage === 'championship-tiebreak' ? 'TITLE TB'
          : this.stage === 'final' ? '3 FINALISTS' : `${THREE_POINT_FORMAT.fieldSize} SHOOTERS`;
    return { label, first, final, champion };
  }

  syncHud() {
    const round = this.round;
    this.hud.setContestHud?.({
      stage: this.stageLabel(),
      state: this.state,
      entrant: round?.profile?.playerLabel
        ? `${round.profile.playerLabel} · ${round.profile.name}`
        : round?.profile?.name ?? (this.currentProfile?.playerLabel
          ? `${this.currentProfile.playerLabel} · ${this.currentProfile.name}`
          : this.currentProfile?.name) ?? '—',
      clock: round?.clock ?? this.timeLimit ?? THREE_POINT_FORMAT.roundSeconds,
      score: round?.score ?? 0,
      attempt: round ? Math.min(27, round.attemptIndex + (round.activeAttempt ? 1 : 0)) : 0,
      station: round?.activeAttempt?.stationLabel ?? round?.attempts[round?.attemptIndex]?.stationLabel ?? '—',
      attempts: round?.attempts ?? [],
      standings: this.liveStandings(),
      canSkipCpu: this.canSkipCpu,
      cutoff: this.stage === 'first' ? THREE_POINT_FORMAT.finalists : 1,
      roadmap: this.tournamentRoadmap(),
    });
  }

  updateShotMeter(dt) {
    const camera = this.cameraRig?.camera;
    const shooter = this.round?.shooter;
    const action = shooter?.action;
    const live = action?.name === 'shot';
    if (!camera || !live) {
      this._meterHold = Math.max(0, this._meterHold - dt);
      if (this._meterHold <= 0) this.hud.hideShotMeter?.();
      return;
    }
    this._meterHold = 0.5;
    const band = SHOT_TIMING.jump;
    const span = band.span;
    const perfectT = action.perfectT ?? 0.78;
    const progress = (action.t / action.dur) / span;
    const release = action.releasedAt != null ? action.releasedAt / span : null;
    let color = null;
    if (action.timingQ != null) color = action.timingQ >= 1 ? '#7dff9b' : action.timingQ >= 0.78 ? '#d9f77d' : '#ff8f66';
    this._v.set(shooter.pos.x, 1.55 + shooter.y, shooter.pos.z).project(camera);
    this.hud.shotMeter?.({
      x: (this._v.x * 0.5 + 0.5) * innerWidth + 46,
      y: (-this._v.y * 0.5 + 0.5) * innerHeight,
      progress,
      stable0: (perfectT - band.stable) / span,
      stable1: (perfectT + band.stable) / span,
      green0: (perfectT - band.perfect) / span,
      green1: (perfectT + band.perfect) / span,
      release,
      color,
    });
  }

  update(dt) {
    this.stateT += dt;
    const it = input.poll(this.cameraRig?.camera, dt);
    for (const key of input.camKeys) {
      if (key === 'C') this.cameraRig?.cyclePreset();
      if (key === 'H') this.hud.toggleHelp?.();
      if (key === 'F3') this.hud.toggleDebug?.();
    }
    if (this.state === 'player-count') {
      for (const player of this.localPlayers) {
        this.applySetupPose(player);
      }
      this.hud.update(dt);
      return;
    }
    if (this.state === 'eliminated' && (it.confirmPressed || input.uiKeys.includes('ENTER'))) {
      this.continueAfterElimination(false);
      return;
    }
    // A confirm that closes player-count can be observed by the simulation in
    // the same frame. Give a fresh CPU prompt a short debounce so that one
    // Enter/A cannot both start the contest and instantly skip its opener.
    const cpuSkipReady = this.round?.cpu || (this.state === 'cpu-prompt' && this.stateT >= 0.12);
    if (cpuSkipReady && (it.confirmPressed || input.uiKeys.includes('ENTER'))) {
      this.simToMyTurn();
      return;
    }
    if (this.round) this.updateRound(dt, it);
    this.feedback.update(dt, this.ball);
    this.court?.net.update(dt, this.ball);
    this.updateShotMeter(dt);
    this.hud.update(dt);
    this.syncHud();
  }

  serialize() {
    const round = this.round;
    return {
      coordinates: 'metres; court centre x=0, floor y=0, hoop is toward decreasing z',
      mode: this.mode,
      contestProps: this.rackSet?.source ?? 'none',
      state: this.state,
      setup: this.state === 'player-count' ? this.setupState() : null,
      localPlayers: this.localProfiles.map((profile) => ({
        label: profile.playerLabel,
        character: profile.name,
        characterId: profile.id,
        characterIndex: profile.characterIndex,
      })),
      participants: this.contestRoster.map((profile) => ({
        id: profile.id,
        name: profile.name,
        controller: profile.playerLabel ?? 'CPU',
      })),
      round: this.stage,
      roundLabel: this.stageLabel(),
      time: round ? +round.clock.toFixed(2) : null,
      entrant: round?.profile?.name ?? this.currentProfile?.name ?? null,
      moneyRack: round?.moneyRack ?? (this.currentProfile?.user ? this.moneyRackFor(this.currentProfile) : null),
      station: round?.activeAttempt?.stationId ?? round?.attempts[round?.attemptIndex]?.stationId ?? null,
      ballIndex: round?.activeAttempt?.index ?? round?.attemptIndex ?? null,
      shotQueued: !!round && round.shotBufferT > 0,
      shotBuffer: round ? +round.shotBufferT.toFixed(3) : 0,
      heldBall: this.activeBall ? {
        attemptId: this.activeBall.contestAttempt?.id ?? null,
        kind: this.activeBall.visualKind,
      } : null,
      score: round?.score ?? null,
      attempts: round?.attempts.map(publicAttempt) ?? [],
      ballsInFlight: this.flightBalls.map((ball) => ({
        attemptId: ball.contestAttempt?.id ?? null,
        kind: ball.visualKind,
        value: ball.contestAttempt?.value ?? null,
        position: [+ball.pos.x.toFixed(2), +ball.pos.y.toFixed(2), +ball.pos.z.toFixed(2)],
        state: ball.state,
        resolved: !!ball.contestAttempt?.resolved,
      })),
      standings: this.liveStandings().map((entry) => ({ name: entry.name, score: entry.score, live: !!entry.live })),
      roadmap: this.tournamentRoadmap(),
      canSkipCpu: this.canSkipCpu,
      firstRound: sortStandings(this.firstRecords).map((entry) => ({ name: entry.name, score: entry.score })),
      final: (this.state === 'results' ? this.resultStandings() : sortStandings(this.finalRecords))
        .map((entry) => ({ name: entry.name, score: entry.score, tiebreakScore: entry.tiebreakScore ?? null })),
      winner: this.winner?.name ?? null,
      userStatus: this.state === 'eliminated'
        ? 'eliminated'
        : this.stage === 'final' || this.stage === 'championship-tiebreak' ? 'finalist' : 'round-one',
    };
  }

  /** Deterministic browser-test hook; does not participate in ordinary play. */
  debugCompleteUserRound(score) {
    if (!this.round?.profile.user) return false;
    const paths = new Map([[0, []]]);
    this.round.attempts.forEach((attempt, index) => {
      for (const [sum, chosen] of [...paths.entries()].sort((a, b) => b[0] - a[0])) {
        const next = sum + attempt.value;
        if (next <= score && !paths.has(next)) paths.set(next, [...chosen, index]);
      }
    });
    if (!paths.has(score)) return false;
    const chosen = new Set(paths.get(score));
    const madeAttempts = this.round.attempts.map((attempt, index) => ({
      ...attempt,
      timely: true,
      made: chosen.has(index),
      resolved: true,
      releasedAt: 1 + attempt.index,
    }));
    const record = {
      entrantId: this.round.profile.id,
      name: this.round.profile.name,
      playerLabel: this.round.profile.playerLabel ?? null,
      score: madeAttempts.reduce((sum, attempt) => sum + (attempt.made ? attempt.value : 0), 0),
      attempts: madeAttempts,
      order: this.currentIndex,
      stage: this.stage,
      simulated: false,
    };
    this.resetPhysicalRound();
    this.commitRecord(record);
    return true;
  }
}
