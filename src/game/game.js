import * as THREE from 'three';
import { clamp, rand } from '../utils.js';
import { COURT, isInBounds, isBeyondArc } from '../world/court.js';
import { Ball } from '../entities/ball.js';
import { Player } from '../entities/player.js';
import { AIBrain } from './ai.js';
import { CourtSfx } from './courtSfx.js';
import { FeedbackFx } from './feedbackFx.js';
import { input } from '../input.js';
import { SHOT_TIMING } from './shotTiming.js';

function pointSegmentDistance(point, a, b, tmp) {
  tmp.subVectors(b, a);
  const len2 = tmp.lengthSq();
  const apx = point.x - a.x, apy = point.y - a.y, apz = point.z - a.z;
  const t = len2 > 1e-8
    ? clamp((apx * tmp.x + apy * tmp.y + apz * tmp.z) / len2, 0, 1)
    : 0;
  return tmp.multiplyScalar(t).add(a).distanceTo(point);
}

export const PLAYER_CONFIGS = [
  {
    name: 'VOLT', team: 0, skill: 0.85,
    skin: 0x6e4a30, jersey: 0x23262c, shorts: 0x1d5a5e, shoes: 0xd8551f,
    hair: 0x120d08, number: 7, numberColor: '#ff9a3c',
  },
  {
    name: 'REYES', team: 1, skill: 0.82,
    skin: 0x9c6b4a, jersey: 0xe8dcc8, shorts: 0x23262c, shoes: 0x2f6f8f,
    hair: 0x2a1f14, number: 23, numberColor: '#1d5a5e',
  },
];

export class Game {
  constructor(scene, hud, opts = {}) {
    this.mode = '1v1';
    this.scene = scene;
    this.hud = hud;
    this.opts = opts;

    this.config = {
      target: 11, winBy: 2, cap: 15,
      makeItTakeIt: opts.makeItTakeIt ?? true,
      shotClock: 24,
    };

    this.ball = new Ball(scene);
    this.sfx = new CourtSfx();
    this.feedback = new FeedbackFx(scene);
    this.players = PLAYER_CONFIGS.map((c) => {
      const p = new Player(scene, c);
      p.gameRef = this;
      return p;
    });
    this.userPlayer = this.players[0];
    this.attract = opts.attract ?? false;
    this.userPlayer.setIndicator(!this.attract);

    this.brains = this.players.map((p, i) => new AIBrain(p, this, PLAYER_CONFIGS[i].skill));

    this.score = [0, 0];
    this.state = 'idle';
    this.stateT = 0;
    this.shotClock = this.config.shotClock;
    // A playable session starts with the user on offence. Random opening
    // possession is useful in attract mode, but in the actual game it made the
    // first interaction an AI-controlled check pass instead of the player's
    // first basketball decision.
    this.offenseIdx = this.attract ? (Math.random() < 0.5 ? 0 : 1) : this.userPlayer.team;
    this.lastMsgAt = 0;
    this.rimShake = 0;
    this.rimShakeVel = 0;
    this._userNeededClear = false;
    this.stats = { shots: 0, makes: 0, steals: 0, blocks: 0, rebounds: [0, 0] };

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();

    this.hud.setNames('VOLT', 'REYES');
    this.hud.setTarget(this.config.target);
    if (this.attract) this.setupCheckBall(this.offenseIdx);
    else this.startOpeningPossession();

    window.__game = this; // automation hook
  }

  get offense() { return this.players[this.offenseIdx]; }
  get defense() { return this.players[1 - this.offenseIdx]; }
  defensePlayer() { return this.defense; }
  otherPlayer(p) { return p === this.players[0] ? this.players[1] : this.players[0]; }

  scoreNeeds(team) { return Math.max(0, this.config.target - this.score[team]); }

  // ------------------------------------------------------------ flow

  setupCheckBall(offenseIdx, msg = 'CHECK BALL') {
    this.offenseIdx = offenseIdx;
    this.state = 'checkball';
    this.stateT = 0;
    this.shotClock = this.config.shotClock;
    this.passed = false;

    const off = this.offense, def = this.defense;
    off.pos.set(rand(-0.5, 0.5), 0, 9.4);
    off.vel.set(0, 0, 0);
    off.facing = Math.atan2(COURT.rimCenter.x - off.pos.x, COURT.rimCenter.z - off.pos.z);
    def.pos.set(rand(-0.3, 0.3), 0, 8.1);
    def.vel.set(0, 0, 0);
    def.facing = Math.atan2(off.pos.x - def.pos.x, off.pos.z - def.pos.z);
    for (const p of this.players) {
      p.action = null; p.airborne = false; p.y = 0; p.vy = 0;
      p.spinDir = 0; p.moveLock = 0; p.stumbleT = 0; p.celebrateT = 0;
      p.moveAnim = null; p.skillPath = null; p.burstDrive = null;
      p.state = 'idle'; p.hasBall = false;
      p.gatherAction = null;
      p.dribbleStarted = false; p.dribbleEnded = false; p.stumbleKind = null;
    }
    def.hasBall = true;
    def.dribbleEnded = true;
    def.state = 'checkball';
    off.state = 'idle';
    // setupCheckBall can run after the players have already updated this frame.
    // Move both visible rigs immediately, then attach to the checking player's
    // real palm so neither the athlete nor the ball spends a rendered frame at
    // the old possession position.
    for (const p of this.players) {
      p.rig.group.position.set(p.pos.x, p.y, p.pos.z);
      p.rig.group.rotation.y = p.facing;
      p.rig.group.updateMatrixWorld(true);
    }
    this.ball.state = 'held';
    this.ball.holder = def;
    this.ball.lastShotTeam = null;
    this.ball.possessionCause = null;
    this.ball.clearExemptTeam = null;
    this.ball.pos.copy(def.holdPoint(this._v));
    this.ball.attachTarget.copy(this.ball.pos);
    this.hud.setPossession(offenseIdx);
    this.hud.msg(msg);
    for (const b of this.brains) b.reset();
  }

  /** Give the user the opening check directly in a legal triple-threat stance. */
  startOpeningPossession(msg = 'YOUR BALL') {
    this.setupCheckBall(this.userPlayer.team, msg);
    const off = this.userPlayer;
    const def = this.otherPlayer(off);
    def.hasBall = false;
    def.dribbleEnded = false;
    def.state = 'defense';
    off.gainPossession(this.ball);
    off.clearedBall = true;
    this.state = 'live';
    this.stateT = 0;
    this.passed = true;
    this.shotClock = this.config.shotClock;
    this.hud.setPossession(off.team);
    this.hud.msg(msg, 'TRIPLE THREAT', 1.1);
  }

  startLive() {
    this.state = 'live';
    this.stateT = 0;
    this.shotClock = this.config.shotClock;
    this.defense.state = 'defense';
    this.offense.state = 'idle';
    this.hud.msg('BALL IN', '', 0.9);
  }

  onScore(event = null) {
    const shot = this.ball.shot;
    const shooter = shot?.shooter ?? this.offense;
    const points = shot?.dunk ? 2 : (shot?.points ?? 2);
    this.score[shooter.team] += points;
    this.stats.shots++; if (shot) this.stats.makes += shot.scored ? 1 : 0;

    this.hud.setScore(this.score[0], this.score[1]);
    this.hud.scorePop(shooter.team);
    this.sfx.swish(event?.clean ?? false);
    this.court?.net.kick?.(this.ball);
    this.feedback.score(COURT.rimCenter, event?.clean ?? false, !!shot?.dunk);
    this.camShake = Math.max(this.camShake ?? 0, event?.clean ? 0.085 : 0.105);
    const win = this.checkWin();
    if (win >= 0) {
      this.state = 'gameover';
      this.stateT = 0;
      this.hud.msg(`${this.players[win].name} WINS`, `${this.score[0]} — ${this.score[1]}`, 8);
      this.players[win].celebrateT = 3;
      this.players[win].celebrateAlt = Math.random() < 0.45;
      this.ball.state = 'loose';
      this.ball.holder = null;
      this.ball.vel.set(rand(-2, 2), 4, rand(-1, 2));
      return;
    }
    this.state = 'score_break';
    this.stateT = 0;
    shooter.celebrateT = 1.1;
    shooter.celebrateAlt = Math.random() < 0.45;
    const gamePoint = this.scoreNeeds(1 - shooter.team) <= this.config.winBy && this.score[1 - shooter.team] >= this.config.target - this.config.winBy;
    this.hud.msg(
      shot?.dunk ? 'SLAM!' : (points === 3 ? 'FROM DEEP! +3' : 'BUCKET +2'),
      gamePoint ? 'GAME POINT' : '',
      1.7
    );
    // possession next
    this.nextOffense = this.config.makeItTakeIt ? shooter.team : 1 - shooter.team;
  }

  checkWin() {
    const [a, b] = this.score;
    const t = this.config.target, w = this.config.winBy, cap = this.config.cap;
    if (a >= cap || b >= cap) return a >= b ? 0 : 1;
    if (a >= t && a - b >= w) return 0;
    if (b >= t && b - a >= w) return 1;
    return -1;
  }

  turnover(reason) {
    this.hud.msg(reason, '', 1.4);
    (this.log ||= []).push({ t: +(performance.now() / 1000).toFixed(1), ev: 'turnover', reason });
    this.setupCheckBall(1 - this.offenseIdx, 'CHECK BALL');
  }

  // ------------------------------------------------------------ callbacks from players

  onShotReleased(shooter, quality, timingQ, missLabel, points, made, isFinish = false) {
    const grade = timingQ >= 1 ? 'perfect' : timingQ >= 0.78 ? 'good' :
      timingQ >= 0.55 ? 'ok' : 'bad';
    this.lastShot = { shooter, quality, timingQ, points, made, grade };
    if (!isFinish && shooter === this.userPlayer && !this.attract) {
      const side = missLabel === 'EARLY' ? 'EARLY' : 'LATE';
      const result = timingQ >= 1 ? ['PERFECT', 'perfect', 'GREEN RELEASE'] :
        timingQ >= 0.78 ? ['GOOD', 'good', `SLIGHTLY ${side}`] :
        timingQ >= 0.55 ? ['OK', 'ok', side] : ['BAD', 'bad', `VERY ${side}`];
      this.hud.shotFeedback(result[0], result[1], result[2]);
      if (timingQ >= 1) {
        this.feedback.perfectRelease(this.ball);
        this.sfx.perfect();
      }
    }
    this.hud.setShotClock(this.shotClock);
  }

  onDunk(shooter) {
    this.rimShakeVel = -24;
    this.sfx.dunk();
    this.feedback.dunk(COURT.rimCenter);
    this.court?.net.kick?.(this.ball);
    if (shooter === this.userPlayer && !this.attract) {
      this.hud.shotFeedback('SLAM', 'dunk', 'RIM IMPACT');
    }
    // camera shake via rig set in main
    this.camShake = 0.46;
  }

  onTakeBackNeeded(p) {
    const now = performance.now() / 1000;
    if (now - this.lastMsgAt > 1.2) {
      this.lastMsgAt = now;
      this.hud.msg('TAKE IT BACK', '', 0.9);
    }
  }

  // ------------------------------------------------------------ per-frame

  /**
   * 2K-style release bar next to the shooter: fills through the gather+rise,
   * green band marks the perfect-release window, and it locks with a coloured
   * marker at the moment of release.
   */
  updateShotMeter(dt) {
    const cam = this.cameraRig?.camera;
    if (!cam) return;
    // in attract mode follow whoever is shooting so the feature is visible
    const shooter = this.attract
      ? this.players.find((p) => p.action && (p.action.name === 'shot' || p.action.name === 'gather'))
      : this.userPlayer;
    const a = shooter?.action;
    const live = a && (a.name === 'shot' || a.name === 'gather' || a.name === 'layup');

    if (!live) {
      this._meterHold = Math.max(0, (this._meterHold ?? 0) - dt);
      if (this._meterHold <= 0) this.hud.hideShotMeter();
      return;
    }
    this._meterHold = 0.5;

    const timingBand = a?.name === 'layup' ? SHOT_TIMING.layup : SHOT_TIMING.jump;
    const SPAN = timingBand.span;
    const perfectT = a.perfectT ?? 0.46;
    const progress = a.name === 'gather' ? 0 : (a.t / a.dur) / SPAN;
    const release = a.releasedAt != null ? a.releasedAt / SPAN : null;
    let color = null;
    if (a.timingQ != null) {
      color = a.timingQ >= 1 ? '#7dff9b' : a.timingQ >= 0.78 ? '#d9f77d' : '#ff8f66';
    }

    this._v.set(shooter.pos.x, 1.55 + shooter.y, shooter.pos.z);
    this._v.project(cam);
    const w = window.innerWidth, h = window.innerHeight;
    this.hud.shotMeter({
      x: (this._v.x * 0.5 + 0.5) * w + 46,
      y: (-this._v.y * 0.5 + 0.5) * h,
      progress,
      stable0: (perfectT - timingBand.stable) / SPAN,
      stable1: (perfectT + timingBand.stable) / SPAN,
      green0: (perfectT - timingBand.perfect) / SPAN,
      green1: (perfectT + timingBand.perfect) / SPAN,
      release,
      color,
    });
  }

  update(dt) {
    this.stateT += dt;

    // ---- input mapping ----
    const it = input.poll(this.cameraRig?.camera, dt);
    for (const key of input.camKeys) {
      if (key === 'C') this.cameraRig?.cyclePreset();
      if (key === 'H') this.hud.toggleHelp();
      if (key === 'F3') this.hud.toggleDebug();
      if (key === 'P') this.attract = !this.attract;
      if (key === 'R' && this.state === 'gameover') this.rematch();
    }
    if (!this.attract) this.mapUserInput(this.userPlayer, it);
    void it;

    // ---- AI ----
    if (this.attract || true) {
      for (let i = 0; i < this.players.length; i++) {
        if (this.attract || this.players[i] !== this.userPlayer) {
          this.brains[i].update(dt);
        }
      }
    }

    // ---- state flow ----
    if (this.state === 'checkball') {
      const def = this.defense;
      const off = this.offense;
      if (!this.passed && !def.action && this.stateT > 0.55) def.startPass(off);
      if (this.passed && this.ball.state === 'pass') {
        // Receive at the baked take's live palm. The old chest-height proxy
        // could sit 40 cm above a low ready hand, so a fast check-ball pass
        // crossed the player without ever entering its catch sphere and then
        // bounced loose. A hand-sized gate is both more reliable and more
        // honest visually because possession changes where contact is shown.
        const d = this.ball.pos.distanceTo(off.holdPoint(this._v));
        if (d < 0.38) {
          off.gainPossession(this.ball);
          this.startLive();
        }
      }
    } else if (this.state === 'live') {
      // shot clock
      const holderTeam = this.ball.holder ? this.ball.holder.team : (this.ball.state === 'dribble' ? this.offenseIdx : null);
      if (holderTeam === this.offenseIdx) {
        this.shotClock -= dt;
        if (this.shotClock <= 0) {
          this.turnover('SHOT CLOCK');
        }
      }
    } else if (this.state === 'score_break') {
      if (this.stateT > 1.7) {
        this.setupCheckBall(this.nextOffense, 'CHECK BALL');
      }
    } else if (this.state === 'gameover') {
      // ball physics only
    }

    // Resolve possession before animation so the new ball-handler cannot spend
    // one rendered frame in the old defensive gait with the ball already held.
    if (this.state === 'live') this.resolvePickups();

    // ---- players ----
    for (const p of this.players) {
      p.update(dt, this.ball, this);
    }

    // ---- contact resolution ----
    this.resolveContact(dt);

    // A miss stays a shot while it is in the air. Rebounds are resolved from
    // the airborne grab animation, before the generic floor pickup path.
    if (this.state === 'live') this.resolveRebound();

    // ---- steal / block resolution ----
    if (this.state === 'live') {
      this.resolveHandleReaction();
      this.resolveSteal();
      this.resolveBlock();
    }

    // ---- ball ----
    this.ball.update(dt, this.players);

    const needsClear = this.state === 'live' && this.userPlayer.hasBall && !this.userPlayer.clearedBall;
    if (this._userNeededClear && !needsClear && this.userPlayer.hasBall) {
      this.hud.msg('CLEARED', 'ATTACK THE BASKET', 0.9);
    }
    this._userNeededClear = needsClear;
    this.court?.setClearGuide?.(needsClear, this.stateT);
    this.hud.setClearTask?.(needsClear);
    this.hud.setControlContext?.(this.userPlayer.hasBall ? 'offense' : 'defense');

    // ---- ball events ----
    for (const ev of this.ball.consumeEvents()) {
      if (ev.type === 'score') {
        if (this.state === 'live' || this.state === 'checkball') this.onScore(ev);
      } else if (ev.type === 'rim-hit') {
        if (ev.speed > 3) this.rimShakeVel -= ev.speed * 0.35;
        this.sfx.rim(ev.speed);
        this.shotClock = Math.max(this.shotClock, this.config.shotClock * 0.66);
      } else if (ev.type === 'board-hit') {
        this.sfx.board(ev.speed);
        this.camShake = Math.max(this.camShake ?? 0, 0.035);
        this.shotClock = Math.max(this.shotClock, this.config.shotClock * 0.66);
      } else if (ev.type === 'dribble-bounce') {
        this.sfx.dribble(3.8);
      } else if (ev.type === 'floor-bounce') {
        this.sfx.dribble(ev.impact);
      } else if (ev.type === 'block') {
        this.hud.msg('BLOCKED!', '', 1.1);
        this.stats.blocks++;
      } else if (ev.type === 'steal') {
        this.hud.msg('STEAL!', '', 1.1);
        this.stats.steals++;
      }
    }

    // ---- out of bounds ----
    if (this.state === 'live' && (this.ball.state === 'loose' || this.ball.state === 'dribble') &&
        !isInBounds(this.ball.pos.x, this.ball.pos.z) && this.ball.pos.y < 2.2) {
      (this.log ||= []).push({
        t: +(performance.now() / 1000).toFixed(1), ev: 'oob',
        ball: [this.ball.pos.x.toFixed(1), this.ball.pos.z.toFixed(1)], st: this.ball.state,
      });
      const lastTeam = this.ball.lastTouch?.team ?? this.offenseIdx;
      this.turnover('OUT OF BOUNDS');
      void lastTeam;
    }

    // ---- rim shake spring ----
    this.rimShakeVel += -this.rimShake * 240 * dt - this.rimShakeVel * 8 * dt;
    this.rimShake += this.rimShakeVel * dt;
    if (this.court?.hoop) {
      this.court.hoop.rotation.x = clamp(this.rimShake, -0.085, 0.085);
    }

    // ---- net ----
    this.court?.net.update(dt, this.ball);
    this.feedback.update(dt, this.ball);

    this.updateShotMeter(dt);
    this.hud.setShotClock(this.shotClock);
    this.hud.update(dt);
  }

  rematch() {
    this.score = [0, 0];
    this.hud.setScore(0, 0);
    this.stats = { shots: 0, makes: 0, steals: 0, blocks: 0, rebounds: [0, 0] };
    if (this.attract) this.setupCheckBall(Math.random() < 0.5 ? 0 : 1, 'REMATCH');
    else this.startOpeningPossession('REMATCH — YOUR BALL');
  }

  /** debug/test hook */
  forcePossession(team) {
    this.setupCheckBall(team, 'CHECK BALL');
  }

  // ------------------------------------------------------------ user input

  mapUserInput(p, it) {
    if (this.state === 'gameover') {
      p.intentOffense = p.intentDefense = { move: { x: 0, z: 0 }, mag: 0 };
      return;
    }
    const mag = it.moveMag ?? Math.hypot(it.move.x, it.move.z);
    const base = {
      move: { x: it.move.x, z: it.move.z },
      mag, sprint: it.sprint, moveSerial: it.moveSerial ?? 0,
    };

    if (this.state === 'checkball') {
      p.intentOffense = p.intentDefense = { ...base, mag: this.offense === p ? mag * 0.3 : 0 };
      return;
    }

    if (p.hasBall) {
      p.intentOffense = {
        ...base,
        shoot: it.shoot,
        shootCommitted: it.shootCommitted,
        shootReleasedCommitted: it.shootReleasedCommitted,
        shootReleased: it.shootReleased,
        physical: it.physical,
      };
      p.intentDefense = null;
      // A light tap is a fake; holding through the short gather threshold starts
      // the real shot. Starting on key-down made every tap release a bad jumper.
      // Input must answer on key-down. A short release converts this initial
      // gather into the fake; waiting 160 ms before showing anything was the
      // largest single source of perceived latency.
      if (it.shootPressed) p._spaceShotActive = p.startShot(true, null, null, true);
      if (it.shootReleased) {
        if (!it.shootReleasedCommitted) {
          if (!p._spaceShotActive || !p.cancelGatherToPumpFake()) p.startPumpFake();
        } else {
          p.releaseGatherShot();
        }
        p._spaceShotActive = false;
      }

      if (it.skillCommitted && it.skillDirection) {
        p.startDirectionalShot(it.skillDirection);
      } else if (it.dribbleMove === 'horizontal') {
        p.doHorizontalHandle(it.dribbleDir);
      } else if (it.dribbleMove === 'btl') {
        p.doDribbleMove('btl');
      } else if (it.dribbleMove === 'behind') {
        p.doDribbleMove('behind');
      } else if (it.dribbleMove === 'hesitation') {
        // standing still there is nothing to pull back from — that is a jab
        p.doDribbleMove('hesitation');
      } else if (it.dribbleMove === 'spin') {
        p.doDribbleMove('spin');
      }
      if (it.skillReleased && it.skillReleaseCommitted) p.releaseDirectionalShot();
    } else {
      p.intentDefense = { ...base, physical: it.physical };
      p.intentOffense = null;
      // One key, two defensive reads. A released shot is still a block/contest
      // until it has actually hit rim or glass. Routing every airborne ball to
      // rebound made the block takes unreachable from the keyboard and showed
      // a catch pose while the shot was still rising.
      if (it.shootPressed) {
        const ball = this.ball;
        const groundPickup = ball.state === 'loose' && ball.pos.y < 0.9;
        const hitBasket = ball.state === 'shot' && ball.shot &&
          (ball.shot.rimHits ?? 0) + (ball.shot.boardHits ?? 0) > 0;
        // Once a shot is descending toward the basket, Space means establish
        // rebound position. Waiting until after rim contact made an on-time
        // anticipatory press become a block jump and locked the player out of
        // the actual catch window.
        const descendingShot = ball.state === 'shot' && ball.vel.y < 0.35;
        const reboundable = descendingShot || (hitBasket && ball.vel.y < 0) ||
          (ball.state === 'loose' && ball.pos.y > 1.3);
        // A floor ball is never a shot contest. Starting contest here also made
        // resolvePickups skip this player, which is why repeated Space presses
        // produced jumps without a single pickup attempt.
        if (groundPickup) p.startPickup(ball);
        else if (reboundable) p.startRebound();
        else p.startContest();
      }
      if (it.stealPressed) p.startSteal();
    }
  }

  // ------------------------------------------------------------ interactions

  resolveContact(dt) {
    const [a, b] = this.players;
    const dx = b.pos.x - a.pos.x;
    const dz = b.pos.z - a.pos.z;
    const d = Math.hypot(dx, dz);
    const minD = (a.bodyRadius ?? 0.4) + (b.bodyRadius ?? 0.4);
    if (d < minD && d > 1e-5) {
      const nx = dx / d, nz = dz / d;
      const push = (minD - d) * 0.5;
      a.pos.x -= nx * push; a.pos.z -= nz * push;
      b.pos.x += nx * push; b.pos.z += nz * push;

      // relative velocity along normal
      const rvn = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (rvn < 0) {
        const imp = -rvn * 0.55;
        a.vel.x -= nx * imp; a.vel.z -= nz * imp;
        b.vel.x += nx * imp; b.vel.z += nz * imp;
      }

      // A defender in the stance takes contact instead of absorbing it: the
      // bump costs the ball handler ground and stamina, which is how on-ball
      // defence is supposed to pay for the speed it gives up.
      const stanced = a.stance ? a : (b.stance ? b : null);
      if (stanced) {
        const other = stanced === a ? b : a;
        if (other.hasBall) {
          const push = 0.55 * dt;
          other.pos.x += nx * (stanced === a ? push : -push);
          other.pos.z += nz * (stanced === a ? push : -push);
          other.stamina = Math.max(0, other.stamina - dt * 0.09);
          other.braceT = Math.max(other.braceT, 0.16);
        }
      }

      // Every collision that carries any real closing speed shows on both
      // bodies. Without this the two athletes pass through each other in
      // silence and the whole 1v1 reads as non-contact.
      if (Math.abs(rvn) > 2.6) {
        const bump = clamp((Math.abs(rvn) - 2.6) / 3.5, 0.12, 1) * 0.28;
        a.braceT = Math.max(a.braceT, bump);
        b.braceT = Math.max(b.braceT, bump);
      }

      // charge impact: fast offense into set defender
      const offense = this.offense;
      const defense = this.defense;
      const offenseSpeed = Math.hypot(offense.vel.x, offense.vel.z);
      if (offenseSpeed > 4.5 && defense.state === 'defense' && defense.stumbleT <= 0) {
        const toward = (offense.vel.x * nx + offense.vel.z * nz);
        if (toward > 3 && Math.random() < 0.02) {
          offense.stumbleT = 0.45;
          offense.vel.multiplyScalar(0.4);
        }
      }
    }
    void dt;
  }

  resolveSteal() {
    const def = this.defense;
    const off = this.offense;
    const a = def.action;
    if (!a || a.name !== 'steal' || a.t < 0.08 || a.t > 0.3) return;
    if (this.ball.state !== 'dribble' || this.ball.dribble?.phase !== 'down') return;
    const hand = a.hand === 'Left' ? 'Left' : 'Right';
    const palm = def.rig.palmPosition(hand, this._v);
    const prev = a.prevPalm ?? palm.clone();
    const d = pointSegmentDistance(this.ball.pos, prev, palm, this._v3);
    (a.prevPalm ??= palm.clone()).copy(palm);
    if (d < this.ball.radius + 0.14 && !a.resolved) {
      a.resolved = true;
      // squared up and in their chest is a better place to swipe from
      const success = Math.random() < 0.55 * def.skill * (def.stance ? 1.35 : 0.8);
      if (success) {
        off.losePossession();
        this.ball.state = 'loose';
        this.ball.holder = null;
        this.ball.shot = null;
        this.ball.possessionCause = 'steal';
        this.ball.clearExemptTeam = def.team;
        this.ball.lastShotTeam = null;
        const dir = new THREE.Vector3(def.pos.x - this.ball.pos.x, 0, def.pos.z - this.ball.pos.z).normalize();
        this.ball.vel.set(dir.x * 3.5 + rand(-1, 1), 2.5, dir.z * 3.5 + rand(-1, 1));
        this.ball.events.push({ type: 'steal' });
        def.stealCooldown = 2.2;
      } else {
        def.stumbleT = 0.4;
      }
    }
  }

  /**
   * The reference source resolves a breakthrough against the defender, then
   * chooses a separate reaction state. A crossover animation alone never
   * magically knocks somebody down; distance, wrong-foot momentum and stance
   * decide whether the defender stays home, stumbles, or falls.
   */
  resolveHandleReaction() {
    const off = this.offense;
    const def = this.defense;
    const move = off.moveAnim;
    if (!move || move.reactionResolved || def.action || def.airborne || def.stumbleT > 0) return;
    if (!['cross', 'doublecross', 'spin', 'halfspin', 'behind'].includes(move.name)) return;
    const phase = move.t / move.dur;
    if (phase < 0.28 || phase > 0.68) return;
    move.reactionResolved = true;

    const distance = off.pos.distanceTo(def.pos);
    if (distance < 0.58 || distance > 1.75) return;
    const side = move.dir || (off.dribbleHand === 'Right' ? 1 : -1);
    const attackRight = off.rightVec(this._v).multiplyScalar(side);
    const wrongFoot = -def.vel.dot(attackRight);
    const handlerSpeed = Math.hypot(off.vel.x, off.vel.z);
    let beat = move.name === 'doublecross' ? 0.4 : (move.name.includes('spin') ? 0.22 : 0.18);
    beat += clamp(wrongFoot / 3.2, 0, 0.42);
    beat += clamp((handlerSpeed - 3.2) / 12, 0, 0.16);
    beat += clamp((1 - def.stamina) * 0.18, 0, 0.18);
    if (def.stance) beat -= 0.23;
    if (Math.random() >= clamp(beat, 0.04, 0.82)) return;

    const fall = move.name === 'doublecross' && wrongFoot > 0.75 && !def.stance && Math.random() < 0.58;
    def.stumbleT = fall ? 1.05 : 0.52;
    def.stumbleKind = fall ? 'fall' : 'stagger';
    def.stumbleDir = side;
    def.moveLock = Math.max(def.moveLock, fall ? 0.9 : 0.36);
    def.vel.addScaledVector(attackRight, -1.6);
    this.hud.msg(fall ? 'ANKLE BREAKER' : 'SHIFTED', fall ? 'DEFENDER DOWN' : '', fall ? 1.1 : 0.6);
    (this.log ||= []).push({
      t: +(performance.now() / 1000).toFixed(1), ev: fall ? 'ankle-break' : 'stagger',
      move: move.name, wrongFoot: +wrongFoot.toFixed(2), distance: +distance.toFixed(2),
    });
  }

  resolveBlock() {
    const def = this.defense;
    const a = def.action;
    if (!a || a.name !== 'contest' || !a.swat || a.blocked || !a.jumped) return;
    const phase = a.t / Math.max(a.dur, 1e-4);
    if (phase < a.blockWindow[0] || phase > a.blockWindow[1]) return;

    const off = this.offense;
    const ball = this.ball;
    const attack = off.action;
    const attackName = attack?.name;
    const heldAttempt = ['shot', 'layup', 'dunk'].includes(attackName) &&
      !attack.released && ball.holder === off;
    const releasedAttempt = ball.state === 'shot' && ball.shot?.shooter === off &&
      (ball.shot.rimHits ?? 0) + (ball.shot.boardHits ?? 0) === 0 &&
      (ball.vel.y > -1.25 || ball.shot.dunk);
    if (!heldAttempt && !releasedAttempt) return;

    // The block has to win before release. Once the game has shown PERFECT,
    // the player has already earned a deterministic make and the ball owns
    // that result through `intendedMake`; a late contest must not silently
    // rewrite the green release into a miss.
    if (releasedAttempt && ball.shot?.intendedMake === true) return;

    if (heldAttempt) {
      const attackPhase = attack.t / Math.max(attack.dur, 1e-4);
      const vulnerableAt = attackName === 'shot'
        ? Math.max(attack.jumpAt ?? 0.2, (attack.perfectT ?? 0.68) - 0.28)
        : Math.max(attack.jumpAt ?? 0.18, attackName === 'dunk' ? 0.30 : 0.24);
      if (attack.awaitingHold || attackPhase < vulnerableAt) return;
    }

    const hand = a.hand === 'Left' ? 'Left' : 'Right';
    const palm = def.rig.palmPosition(hand, this._v);
    const prev = a.prevBlockPalm ?? palm.clone();
    const contactGap = pointSegmentDistance(ball.pos, prev, palm, this._v3);
    (a.prevBlockPalm ??= palm.clone()).copy(palm);
    const rootGap = Math.hypot(off.pos.x - def.pos.x, off.pos.z - def.pos.z);
    // The reference game resolves the result on its scheduled `block_at` event,
    // not from one zero-radius palm point. The front take still needs direct
    // hand/ball contact. A chase/dunk take gets the swept hand+forearm volume,
    // but only while both athletes share the same tight finish corridor.
    const reach = a.style === 'chase' ? 1.10
      : a.style === 'dunk' ? 1.05
        : ball.radius + (heldAttempt ? 0.25 : 0.23);
    const corridor = a.style === 'chase' ? 1.75 : a.style === 'dunk' ? 1.50 : 1.50;
    if (rootGap > corridor || contactGap >= reach) return;

    const victimType = attackName ?? (ball.shot?.dunk ? 'dunk' : 'shot');
    const shootingTeam = ball.shot?.shooter?.team ?? off.team;
    off.losePossession();
    off.action = null;
    off.hangT = 0;
    off.stumbleKind = victimType === 'dunk' ? 'blocked-back-fall'
      : victimType === 'layup' ? 'blocked-fall' : 'blocked-upset';
    off.stumbleT = victimType === 'dunk' ? 1.28 : victimType === 'layup' ? 1.05 : 0.58;
    off.stumbleDir = Math.sign(off.pos.x - def.pos.x) || 1;
    off.moveLock = Math.max(off.moveLock, off.stumbleT * 0.82);
    const knock = this._v2.subVectors(off.pos, def.pos).setY(0);
    if (knock.lengthSq() < 1e-4) def.rightVec(knock);
    knock.normalize();
    off.vel.addScaledVector(knock, victimType === 'dunk' ? 2.6 : 1.35);

    ball.state = 'loose';
    ball.holder = null;
    ball.dribble = null;
    ball.shot = null;
    ball.lastShotTeam = shootingTeam;
    ball.possessionCause = 'block';
    ball.clearExemptTeam = null;
    ball.lastTouch = def;
    const swat = this._v3.subVectors(ball.pos, def.pos).setY(0);
    if (swat.lengthSq() < 1e-4) def.rightVec(swat);
    swat.normalize();
    const side = def.rightVec(this._v).multiplyScalar(hand === 'Left' ? -0.45 : 0.45);
    swat.add(side).normalize();
    const force = victimType === 'dunk' ? 6.8 : 5.4;
    ball.vel.set(swat.x * force, victimType === 'dunk' ? 1.5 : 2.7, swat.z * force);
    ball.events.push({ type: 'block', style: a.style, victim: victimType });
    a.blocked = true;
    (this.log ||= []).push({
      t: +(performance.now() / 1000).toFixed(1), ev: 'block',
      style: a.style, victim: victimType, gap: +contactGap.toFixed(3),
    });
  }

  resolvePickups() {
    const ball = this.ball;
    if (ball.state !== 'loose' && ball.state !== 'pass') return;
    if (ball.state === 'pass' && this.state === 'checkball') return;
    // don't insta-grab right after a release
    if (ball.lastReleaseT == null) ball.lastReleaseT = 0;
    for (const p of this.players) {
      if (p.action && p.action.name === 'contest') continue;
      if (p.tryPickupLooseBall(ball)) {
        const stealExempt = ball.possessionCause === 'steal' && ball.clearExemptTeam === p.team;
        const offensiveRecovery = ball.lastShotTeam === p.team && p === this.offense;
        // possession change logic
        if (this.state === 'live') {
          if (p !== this.offense) {
            // Product rule: a clean live-ball steal is immediately attackable.
            // A defensive rebound still has to be cleared unless it was already
            // secured beyond the arc.
            this.offenseIdx = p.team;
            this.players.forEach(pp => pp.state = pp === p ? 'idle' : 'defense');
            p.clearedBall = stealExempt || isBeyondArc(p.pos.x, p.pos.z);
            if (stealExempt) {
              this.hud.msg('STEAL — ATTACK', '', 0.9);
            } else if (!p.clearedBall) {
              this.hud.msg('TAKE IT BACK', '', 1.0);
            }
            this.shotClock = this.config.shotClock;
          } else if (offensiveRecovery) {
            // The possession was already cleared before the shot. A same-team
            // board or loose-ball recovery is a continuous second chance.
            p.clearedBall = true;
            this.hud.msg('SECOND CHANCE', 'ATTACK THE BASKET', 0.8);
          }
        }
        ball.possessionCause = null;
        ball.clearExemptTeam = null;
        ball.lastShotTeam = null;
        break;
      }
    }
  }

  resolveRebound() {
    const ball = this.ball;
    const shot = ball.shot;
    if (ball.state !== 'shot' || !shot || shot.scored || ball.vel.y >= 0) return;
    if ((shot.rimHits ?? 0) + (shot.boardHits ?? 0) <= 0) return;

    const candidates = this.players
      .map((p) => ({ p, contact: p.reboundCatchContact(ball) }))
      .filter((c) => c.contact && Number.isFinite(c.contact.score))
      .map((c) => ({ ...c, score: c.contact.score }))
      .sort((a, b) => a.score - b.score);
    if (!candidates.length) return;

    const winner = candidates[0].p;
    const contact = candidates[0].contact;
    const contactPoint = contact.point.clone();
    const contactGap = contact.gap;
    const shootingTeam = shot.shooter?.team ?? this.offenseIdx;
    const defensiveBoard = winner.team !== shootingTeam;
    winner.gainPossession(ball);
    ball.attach(winner, contactPoint);
    winner.lastBallContact = { kind: 'rebound', gap: contactGap, swept: contact.swept };
    this.stats.rebounds[winner.team]++;
    (this.log ||= []).push({
      t: +(performance.now() / 1000).toFixed(1), ev: 'rebound',
      player: winner.name, defensive: defensiveBoard,
    });

    if (defensiveBoard) {
      this.offenseIdx = winner.team;
      this.players.forEach((p) => { p.state = p === winner ? 'idle' : 'defense'; });
      winner.clearedBall = isBeyondArc(winner.pos.x, winner.pos.z);
      if (!winner.clearedBall) this.hud.msg('REBOUND — TAKE IT BACK', '', 1.0);
      this.shotClock = this.config.shotClock;
    } else {
      // The shot came from a cleared possession; its offensive rebound remains
      // cleared and may go straight back up.
      winner.clearedBall = true;
      this.hud.msg('OFFENSIVE BOARD', '', 0.8);
    }
    ball.possessionCause = null;
    ball.clearExemptTeam = null;
    ball.lastShotTeam = null;

    // Rebound contact is resolved after the normal player animation pass so
    // the catch can use the freshly sampled palms. Refresh only the winner at
    // dt=0 after ownership/state change; otherwise the scored frame renders
    // the old defensive base while the ball is already attached to that hand.
    winner.animate(0, ball, this);
  }
}
