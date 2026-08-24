import * as THREE from 'three';
import { clamp, rand, randSign } from '../utils.js';
import { COURT, isBeyondArc } from '../world/court.js';

/**
 * 1v1 street AI. Shares the same action system as the human player.
 */
export class AIBrain {
  constructor(player, game, skill = 0.8) {
    this.p = player;
    this.game = game;
    this.skill = skill;
    this.mode = 'probe';
    this.modeT = 0;
    this.thinkT = 0;
    this.driveDir = new THREE.Vector3();
    this.moveDir = new THREE.Vector3();
    this.mag = 0;
    this.sprint = false;
    this.reactT = 0;
    this.stealTryT = rand(2, 5);
    this.shotIntent = null;
    this.postIntent = false;
    this.stanceIntent = false;
    this.fakeT = 0;
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
  }

  reset() {
    this.mode = 'probe';
    this.modeT = 0;
    this.thinkT = 0;
    this.moveDir.set(0, 0, 0);
    this.mag = 0;
    this.sprint = false;
    this.reactT = 0;
    this.shotIntent = null;
    this.postIntent = false;
    this.stanceIntent = false;
    this.fakeT = 0;
  }

  update(dt) {
    const p = this.p;
    const g = this.game;
    const ball = g.ball;
    const opp = g.otherPlayer(p);
    if (!opp) return;

    // The check is a dead-ball exchange, not an AI possession. Inheriting the
    // previous drive/defence intent made the passer slide away while the pass
    // take played, so the ball was aimed at someone the chest no longer faced.
    if (g.state === 'checkball') {
      this.moveDir.set(0, 0, 0);
      this.mag = 0;
      this.sprint = false;
      this.shotIntent = null;
      this.postIntent = false;
      this.stanceIntent = false;
      p.intentOffense = { move: { x: 0, z: 0 }, mag: 0, sprint: false, shoot: false, shootReleased: false, physical: false };
      p.intentDefense = { move: { x: 0, z: 0 }, mag: 0, sprint: false, shoot: false, shootReleased: false, physical: false };
      return;
    }

    if (p.hasBall) this.offense(dt, ball, opp);
    else this.defense(dt, ball, opp);

    // build intent
    const intent = p.hasBall ? 'intentOffense' : 'intentDefense';
    p[intent] = {
      move: { x: this.moveDir.x, z: this.moveDir.z },
      mag: this.mag,
      sprint: this.sprint,
      shoot: this.shotIntent === 'hold',
      shootReleased: this.shotIntent === 'release',
      physical: p.hasBall ? this.postIntent : this.stanceIntent,
    };
    if (this.shotIntent === 'release') this.shotIntent = null;
  }

  // ---------------------------------------------------------------- offense

  offense(dt, ball, opp) {
    const p = this.p;
    const g = this.game;
    this.modeT += dt;
    this.thinkT -= dt;

    this.fakeT = Math.max(0, this.fakeT - dt);
    this.postIntent = this.mode === 'post';
    const dRim = p.distToRim();
    const dOpp = p.pos.distanceTo(opp.pos);
    const shotClock = g.shotClock;
    const cleared = p.clearedBall;
    const beyond = isBeyondArc(p.pos.x, p.pos.z);

    // ---- street clear rule: must take it back beyond the arc first ----
    if (!cleared && !p.isShooting && this.mode !== 'clear' && this.mode !== 'shooting') {
      this.mode = 'clear';
      this.modeT = 0;
    }
    if (cleared && this.mode === 'clear') {
      this.mode = 'probe';
      this.modeT = 0;
    }

    // finish at rim if driving close
    if (this.mode === 'drive' && dRim < 3.6) {
      const toRim = this._v.subVectors(COURT.rimCenter, p.pos).setY(0).normalize();
      if (this._v2.copy(toRim).dot(p.vel) > 1.5 || dRim < 2.2) {
        p.startShot(false);
        this.mode = 'probe';
        return;
      }
    }

    // decide
    if (this.thinkT <= 0 && !p.isShooting && !p.action && cleared) {
      this.thinkT = rand(0.5, 1.0);
      // cache probe home so we don't jitter
      this.homeX = rand(-1.6, 1.6);
      this.homeZ = 8.6 + rand(-0.8, 1.2);
      const mustShoot = shotClock < 5.5 || (g.scoreNeeds(p.team) <= 2 && shotClock < 12 && dRim < 7.5);

      if (mustShoot) {
        this.mode = 'shoot';
        this.modeT = 0;
      } else if (this.mode === 'probe' && this.modeT > rand(0.8, 2.0)) {
        const r = Math.random();
        // Backing a defender down is the right answer when you are already
        // close, they are on you, and you have legs left — so that is the gate.
        if (dRim < 5.2 && dOpp < 2.1 && p.stamina > 0.45 && Math.random() < 0.34) {
          this.mode = 'post';
          this.modeT = 0;
          this.postHold = rand(1.1, 2.3);
        } else if (r < 0.46) {
          this.mode = 'drive';
          this.modeT = 0;
          const side = Math.random() < 0.5 ? -1 : 1;
          this.driveDir.set(COURT.rimCenter.x + side * 1.3 - p.pos.x, 0, COURT.rimCenter.z + 0.4 - p.pos.z).normalize();
          if (Math.random() < 0.55) p.doDribbleMove('cross', side);
          else if (Math.random() < 0.4) p.doDribbleMove('btl');
        } else if (r < 0.62) {
          this.mode = 'shoot';
          this.modeT = 0;
        } else {
          if (Math.random() < 0.5) p.doDribbleMove(Math.random() < 0.3 ? 'hesitation' : 'sizeup');
          if (Math.random() < 0.25) p.doDribbleMove('behind');
          this.modeT = 0;
        }
      }
    }

    switch (this.mode) {
      case 'clear': {
        const to = this._v.set(this.homeX ?? 0, 0, 9.6).sub(p.pos); to.y = 0;
        const d = to.length();
        if (d > 0.6) {
          to.normalize();
          this.moveDir.copy(to);
          this.mag = clamp(d * 0.6, 0, 0.9);
        } else {
          this.mag = 0;
        }
        this.sprint = false;
        break;
      }
      case 'probe': {
        const to = this._v2.set(this.homeX ?? 0, 0, this.homeZ ?? 8.8).sub(p.pos); to.y = 0;
        const d = to.length();
        if (d > 0.7) {
          to.normalize();
          this.moveDir.copy(to);
          this.mag = clamp(d * 0.5, 0, 0.55);
        } else {
          this.mag = 0;
        }
        this.sprint = false;
        break;
      }
      case 'drive': {
        const toRim = this._v.subVectors(COURT.rimCenter, p.pos).setY(0).normalize();
        const away = this._v2.subVectors(p.pos, opp.pos).setY(0).normalize();
        const dir = toRim.clone().addScaledVector(away, 0.3).normalize();
        this.moveDir.copy(dir);
        this.mag = 1;
        this.sprint = dOpp > 1.2 || dRim > 4;
        if (dRim < 1.9) {
          p.startShot(false);
          this.mode = 'probe';
        }
        break;
      }
      case 'post': {
        // drive the shoulder into them; the player code decides who gives ground
        const toRim = this._v.subVectors(COURT.rimCenter, p.pos).setY(0).normalize();
        this.moveDir.copy(toRim);
        this.mag = 0.7;
        this.sprint = false;
        if (Math.random() < 0.012 && this.modeT > 0.6) {
          // spin off the shoulder instead of finishing over it
          p.doDribbleMove('spin');
          this.mode = 'drive';
          this.modeT = 0;
          break;
        }
        if (this.modeT > this.postHold || dRim < 2.4 || p.stamina < 0.25) {
          p.startShot(false);
          this.mode = 'probe';
          this.modeT = 0;
        }
        break;
      }
      case 'shoot': {
        this.mag = 0.15;
        this.sprint = false;
        // sell it first: a fake only pays when someone is close enough to bite
        if (!p.isShooting && !p.action && !p.moveAnim && this.fakeT <= 0 &&
            dOpp < 1.9 && Math.random() < 0.35 * this.skill) {
          p.startPumpFake();
          this.fakeT = 1.6;
          break;
        }
        if (!p.isShooting && !p.action) {
          p.startShot(true);
          this.shotIntent = 'hold';
          const err = (1 - this.skill) * rand(0.05, 0.16) * (Math.random() < 0.5 ? -1 : 1);
          this.releaseAt = performance.now() / 1000 + 0.42 + 0.42 * err * 2.2;
          this.mode = 'shooting';
        }
        break;
      }
      case 'shooting': {
        this.mag = 0;
        if (this.shotIntent === 'hold' && performance.now() / 1000 >= this.releaseAt) {
          this.shotIntent = 'release';
          this.mode = 'probe';
        }
        break;
      }
    }
    void dOpp; void beyond;
  }

  // ---------------------------------------------------------------- defense

  defense(dt, ball, opp) {
    const p = this.p;
    this.modeT += dt;
    // Every early-return branch below describes a fresh defensive situation.
    // Do not carry a low stance or sprint decision over from the previous one.
    this.stanceIntent = false;
    this.sprint = false;

    // shot in the air → rebound, and seal while it is up
    if (ball.state === 'shot' || (ball.state === 'loose' && ball.pos.y > 1.2)) {
      this.stanceIntent = p.pos.distanceTo(opp.pos) < 2.2 && p.distToRim() < 4.2;
      this.rebound(ball);
      return;
    }

    // loose ball → chase
    if (ball.state === 'loose') {
      const to = this._v.subVectors(ball.pos, p.pos); to.y = 0;
      const d = to.length();
      if (d > 0.4) { to.normalize(); this.moveDir.copy(to); this.mag = 1; this.sprint = d > 2; }
      else this.mag = 0;
      return;
    }

    // pass in flight → hold position
    if (ball.state === 'pass') {
      this.mag = 0;
      return;
    }

    const oppHas = ball.holder === opp ||
      (ball.state === 'dribble' && ball.dribble?.holder === opp);
    if (!oppHas) { this.mag = 0.2; return; }

    // Get low when you are actually guarding somebody, stand up when you are
    // chasing. Holding the stance while recovering is the classic mistake and
    // the AI should not make it either — it costs the speed it needs.
    const dGuard = p.pos.distanceTo(opp.pos);
    this.stanceIntent = dGuard < 4.2 && !p.action;

    // ---- guard the ball carrier ----
    const toRim = this._v.subVectors(COURT.rimCenter, opp.pos).setY(0).normalize();
    const gap = 1.25;
    const spot = this._v2.copy(opp.pos).addScaledVector(toRim, gap);
    const to = spot.sub(p.pos); to.y = 0;
    const d = to.length();

    // beaten? sprint recover toward rim
    const oppSpeed = Math.hypot(opp.vel.x, opp.vel.z);
    const towardRimSpeed = this._v.copy(toRim).dot(opp.vel);
    const beaten = towardRimSpeed > 4 && d > 2.2 &&
      p.distToRim() > opp.distToRim() + 0.4;
    if (beaten) {
      this.stanceIntent = false;                 // beaten: stand up and run
      const recover = this._v.set(COURT.rimCenter.x - p.pos.x, 0, COURT.rimCenter.z - p.pos.z);
      recover.normalize();
      this.moveDir.copy(recover);
      this.mag = 1;
      this.sprint = true;
    } else if (d > 0.15) {
      to.normalize();
      this.moveDir.copy(to);
      this.mag = clamp(d * 1.6, 0, 1);
      this.sprint = d > 1.8 && oppSpeed > 5;
    } else {
      this.mag = 0;
    }

    // A pump fake is sold through the same set-point read as a shot. One bite
    // decision per fake keeps a disciplined defender down and makes the input a
    // real gameplay tool instead of a clip that nobody reacts to.
    if (opp.isPumpFaking && !p.action) {
      const fake = opp.moveAnim;
      if (!fake.baitResolved && fake.t > 0.12) {
        fake.baitResolved = true;
        const dOpp = p.pos.distanceTo(opp.pos);
        const bite = clamp(0.58 - this.skill * 0.34 + Math.max(0, 1.4 - dOpp) * 0.12, 0.12, 0.62);
        if (dOpp < 2.4 && Math.random() < bite) p.startContest();
      }
      this.reactT = 0;
    } else if (opp.isShooting && !p.action) {
      this.reactT += dt;
      const dOpp = p.pos.distanceTo(opp.pos);
      if (this.reactT > lerpK(0.28, 0.1, this.skill) && dOpp < 2.6) {
        p.startContest();
        this.reactT = 0;
      }
    } else {
      this.reactT = 0;
    }

    // opportunistic steal
    this.stealTryT -= dt;
    if (this.stealTryT <= 0) {
      this.stealTryT = rand(3.5, 7);
      const dOpp = p.pos.distanceTo(opp.pos);
      const exposed = ball.state === 'dribble' && ball.dribble?.phase === 'down';
      if (dOpp < 1.15 && exposed && Math.random() < 0.35 * this.skill) {
        p.startSteal();
      }
    }
  }

  rebound(ball) {
    const p = this.p;
    // predict landing
    const t = timeToLand(ball);
    const lx = ball.pos.x + ball.vel.x * t;
    const lz = ball.pos.z + ball.vel.z * t;
    const to = this._v.set(lx - p.pos.x, 0, lz - p.pos.z);
    const d = to.length();
    if (d > 0.5) {
      to.normalize();
      this.moveDir.copy(to);
      this.mag = 1;
      this.sprint = d > 2;
    } else {
      this.mag = 0;
      // Jump only for a live board. Before rim/glass contact this same airborne
      // object is still a shot to contest, not a rebound to magnetise toward.
      const reach = 2.55;
      const hitBasket = ball.state === 'shot' && ball.shot &&
        (ball.shot.rimHits ?? 0) + (ball.shot.boardHits ?? 0) > 0;
      const liveBoard = hitBasket || ball.state === 'loose';
      if (!p.airborne && !p.action && ball.pos.y > 1.6 && ball.vel.y < 0 &&
          Math.hypot(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z) < 1.0 &&
          ball.pos.y < reach + 0.4 && liveBoard) {
        p.startRebound();
      }
    }
  }
}

function timeToLand(ball) {
  const h = ball.pos.y - 0.12;
  const v = ball.vel.y;
  const disc = v * v + 2 * 9.81 * Math.max(0, h);
  return Math.max(0, (v + Math.sqrt(Math.max(0, disc))) / 9.81);
}

function lerpK(a, b, t) {
  return a + (b - a) * t;
}
