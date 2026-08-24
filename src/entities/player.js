import * as THREE from 'three';
import { clamp, lerp, damp, dampAngle, angleDelta, rand } from '../utils.js';
import { COURT, isBeyondArc } from '../world/court.js';
import { Animator } from '../anim/animator.js';
import { Rig } from './rig.js';
import { releaseTiming, releaseMakeMultiplier } from '../game/shotTiming.js';

const G = 9.81;

function makeUserMarker() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const x = 8, y = 8, w = 240, h = 96, r = 44;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = 'rgba(5, 15, 22, 0.92)';
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#42e7ff';
  ctx.stroke();
  ctx.font = '900 58px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('YOU', 128, 59);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const marker = new THREE.Sprite(new THREE.SpriteMaterial({
    map, transparent: true, depthTest: false, depthWrite: false,
  }));
  marker.scale.set(0.94, 0.42, 1);
  marker.renderOrder = 1000;
  marker.visible = false;
  marker.userData.label = 'YOU';
  return marker;
}

// movement tuning (m/s)
const WALK = 2.5, RUN = 5.0, SPRINT = 6.8;
const ACCEL = 24, DECEL = 32, TURN_ACCEL = 47;

/**
 * A handle take is committed until the ball has crossed the body, then its
 * recovery may branch into a drive. These are gameplay phases, not guesses at
 * animation blending: each window begins after the visible plant/release and
 * closes before the authored recovery has finished.
 */
const DRIBBLE_BURST = {
  cross:       { open: 0.44, close: 0.78, speed: 7.55 },
  doublecross: { open: 0.58, close: 0.84, speed: 7.35 },
  btl:         { open: 0.46, close: 0.78, speed: 7.75 },
  behind:      { open: 0.50, close: 0.80, speed: 7.45 },
  hesitation:  { open: 0.34, close: 0.76, speed: 7.65 },
  spin:        { open: 0.62, close: 0.84, speed: 7.25 },
  halfspin:    { open: 0.52, close: 0.80, speed: 7.15 },
};

// One source of truth for the physical beat of every chained handle. Durations
// are deliberately short enough for successive palm contacts to read as a
// combination, while the ball still reaches the floor and the receiving hand
// before another move may consume it.
const HANDLE_MOVE = {
  sidedrive:   { dur: 0.48, bounceT: 0.18, lateral: 0.74, forward: 0.34, pathDur: 0.44 },
  cross:       { dur: 0.46, bounceT: 0.17, catchH: 0.54, lateral: 0.48, forward: 0.08, feint: 0.10 },
  doublecross: { dur: 0.48, bounceT: 0.16, catchH: 0.54, lateral: 0.56, forward: 0.08, feint: 0 },
  btl:         { dur: 0.48, bounceT: 0.18, catchH: 0.58, lateral: 0.18, forward: 0.04, feint: 0 },
  // A behind-the-back wrap is the biggest lateral change of the basic set and
  // travels behind the hips, not toward the rim.
  behind:      { dur: 0.50, bounceT: 0.14, catchH: 0.54, lateral: 0.82, forward: -0.20, feint: 0.12 },
};

/**
 * Jump-shot variants.
 *
 * `perfectT` is where in the action the ball leaves the hand. The procedural
 * pose and scoring window share this value so full extension and release stay
 * on the same simulation frame.
 *
 * The leap is derived rather than declared — see `jumpFrac` — so the athlete
 * leaves the ground late enough that the apex lands on the release.
 */
const SHOT = {
  jumpshot:   { dur: 0.95, perfectT: 0.68, jump: 0.50 },
  pullup:     { dur: 1.00, perfectT: 0.77, jump: 0.52 },
  stepback:   { dur: 1.05, perfectT: 0.74, jump: 0.46, drift: 2.2 },
  fadeaway:   { dur: 0.95, perfectT: 0.50, jump: 0.46, drift: 1.9 },
  turnaround: { dur: 1.10, perfectT: 0.79, jump: 0.46 },
  catchshoot: { dur: 0.85, perfectT: 0.78, jump: 0.50 },
  hook:       { dur: 0.85, perfectT: 0.55, jump: 0.34 },
  floater:    { dur: 0.90, perfectT: 0.66, jump: 0.56 },
  sidestep:   { dur: 0.94, perfectT: 0.69, jump: 0.48 },
};

// Root travel for the four Pro Stick hop-jumper directions. These distances
// create actual separation before the authored shot takes over: a lateral hop
// clears a defender's combined body width, while the dedicated step-back keeps
// the largest retreat silhouette.
const SHOT_HOP_TRAVEL = {
  lateral: 1.48,
  stepback: 1.62,
  pullup: 0.56,
  settle: 0.05,
};

/** rim finishes, same contract as SHOT */
const FINISH = {
  layup:      { dur: 0.95, perfectT: 0.73, jump: 0.58 },
  fingerroll: { dur: 1.00, perfectT: 0.73, jump: 0.56 },
  floater:    { dur: 0.90, perfectT: 0.66, jump: 0.56 },
  eurostep:   { dur: 1.05, perfectT: 0.67, jump: 0.52 },
  tipin:      { dur: 0.70, perfectT: 0.63, jump: 0.62 },
  dunk1:      { dur: 1.05, perfectT: 0.71, jump: 1.45 },
  dunk2:      { dur: 1.00, perfectT: 0.68, jump: 1.30 },
};

/**
 * When to leave the ground so the apex of the jump lands on the release.
 * Everything before this fraction of the action is the plant and the gather,
 * which is exactly what the first part of every take shows.
 */
function jumpFrac(spec) {
  return clamp(spec.perfectT - Math.sqrt(2 * spec.jump / G) / spec.dur, 0, spec.perfectT * 0.92);
}

/**
 * Player: locomotion + ball handling + action state machine.
 * The Player owns *intent*; the Game feeds intents (from Input or AI).
 */
export class Player {
  constructor(scene, config) {
    this.name = config.name ?? 'PLAYER';
    this.team = config.team ?? 0;
    this.skill = config.skill ?? 0.8;
    this.color = config.jersey;
    this.rig = new Rig(config);
    this.animator = new Animator(this.rig);
    // These two silhouettes have very different mass. A single 0.31 m radius
    // lets the large body swallow the small one before collision even starts.
    this.bodyRadius = config.bodyRadius ?? (this.team === 0 ? 0.54 : 0.40);
    scene.add(this.rig.group);
    scene.add(this.rig.shadow);
    scene.add(this.rig.ring);
    this.userMarker = makeUserMarker();
    scene.add(this.userMarker);

    this.pos = new THREE.Vector3(config.pos?.x ?? 0, 0, config.pos?.z ?? 8);
    this.vel = new THREE.Vector3();
    this.facing = config.facing ?? 0; // yaw, 0 = facing +z... convention: 0 = facing -z (toward hoop)
    this.facing = config.facing ?? Math.PI; // default face hoop (hoop at low z from start pos)

    this.state = 'idle';
    this.stateTime = 0;
    this.active = true;
    this.stamina = 1;

    // jump
    this.y = 0;
    this.vy = 0;
    this.airborne = false;
    this.jumpTargetH = 0;

    // ball handling
    this.hasBall = false;
    this.dribbleHand = 'Right';
    // A catch starts in triple-threat. Possession is not the same thing as a
    // live dribble: the first movement/skill input has to put the ball down.
    this.dribbleStarted = false;
    this.dribbleTimer = 0;       // dwell timer in hand
    this.dribbleRhythm = 0.42;
    this.catchHeight = 0.78;
    this.moveLock = 0;           // seconds of locked movement (during moves)
    this.skillPath = null;       // exact root path, phase-locked to a dribble move
    this.spinDir = 0;
    this.moveAnim = null;        // {name, t, dur, dir} body animation for a dribble move
    this.burstDrive = null;       // recovery-cancel branch into a short directional launch
    this.landRecover = 0;        // seconds of landing absorb after coming down
    this.hangT = 0;              // rim-hang hold after a power dunk
    this.followT = 0;            // seconds of shot follow-through (wrist snap)

    // action data
    this.action = null;          // {name, t, dur, hand, quality, released, chargeT, ...}
    this.stealCooldown = 0;
    this.stumbleT = 0;
    this.celebrateT = 0;
    this.celebrateAlt = false;
    this.defReadiness = 0.5;

    // physicality — held stances rather than timed actions, because that is
    // what they are: posting up and boxing out are things you *hold* against
    // another body until someone gives ground
    this.posting = false;        // backing the defender down, back to the rim
    this.postT = 0;
    this.stance = false;         // low defensive stance (the physicality key)
    this.shielding = false;      // same key with the ball: protect the handle
    this.boxingOut = false;      // sealing the rebound
    this.braceT = 0;             // absorbing a collision
    this.catchT = 0;             // just gathered it in
    this.sinceCatch = 99;
    this.sizeupT = 0;
    this.lastMove = null;
    this.sinceMove = 99;
    this._crossT = 0;            // window for a double crossover
    this._crossDir = 0;
    this._heldFor = 0;
    // A gather requested during an owned bounce is a visible current action,
    // not a command stored for future playback. The action begins on the input
    // frame while the physical ball completes its short return to the palm.
    this.gatherAction = null;    // {kind:'shot'|'directionalShot'|'pumpfake', ...}
    this.dribbleEnded = false;
    this._prevFacing = 0;
    this.turnRate = 0;
    this._prevSpeed = 0;

    // shot charge
    this.charging = false;
    this.chargeT = 0;

    // clear rule
    this.clearedBall = false;

    // AI debug
    this.aiIntent = null;

    // anim smoothing
    this._moveLocal = { x: 0, z: 1 };
    this._lean = { x: 0, z: 0 };
    this._prevVel = new THREE.Vector3();
    this._handTargetL = new THREE.Vector3();
    this._handTargetR = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._tmp2 = new THREE.Vector3();
  }

  /** show the breathing team-colour ring under this player (user only) */
  setIndicator(on) {
    this.rig.ring.visible = !!on;
    this.userMarker.visible = !!on;
    if (on) this.rig.ring.material.color.set(0x42e7ff);
  }

  get isShooting() {
    return this.action && (this.action.name === 'shot' || this.action.name === 'layup' || this.action.name === 'dunk');
  }

  get isPumpFaking() {
    return this.moveAnim?.name === 'pumpfake';
  }

  get height() { return 1.92; }

  /** the hand a shot leaves from */
  get shootHand() { return this.dribbleHand === 'Left' ? 'Left' : 'Right'; }

  // ------------------------------------------------------------ helpers

  /**
   * Local -> world, where local +x is the athlete's RIGHT.
   *
   * It used to be their left. Every lateral offset in the file is written as
   * `s = hand === 'Left' ? -1 : 1`, so the whole game was placing right-hand
   * things on the left side of the body and mirroring every sideways
   * animation. One sign, and it is the only place the axis is defined.
   */
  localToWorld(x, y, z, out = new THREE.Vector3()) {
    const s = Math.sin(this.facing), c = Math.cos(this.facing);
    // yaw 0 faces +z; right is then -x, hence the negated x column
    out.set(
      this.pos.x - x * c + z * s,
      this.y + y,
      this.pos.z + x * s + z * c
    );
    return out;
  }

  forward(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.facing), 0, Math.cos(this.facing));
  }

  /** the athlete's right in world space, given their facing */
  rightVec(out = new THREE.Vector3()) {
    return out.set(-Math.cos(this.facing), 0, Math.sin(this.facing));
  }

  distToRim() {
    return Math.hypot(this.pos.x - COURT.rimCenter.x, this.pos.z - COURT.rimCenter.z);
  }

  // ------------------------------------------------------------ main update

  update(dt, ball, world) {
    this.stateTime += dt;
    this.stealCooldown = Math.max(0, this.stealCooldown - dt);
    this.moveLock = Math.max(0, this.moveLock - dt);
    this.stumbleT = Math.max(0, this.stumbleT - dt);
    if (this.stumbleT <= 0) this.stumbleKind = null;
    this.landRecover = Math.max(0, this.landRecover - dt);
    this.followT = Math.max(0, this.followT - dt);
    this.braceT = Math.max(0, this.braceT - dt);
    this.catchT = Math.max(0, this.catchT - dt);
    this.sizeupT = Math.max(0, this.sizeupT - dt);
    this._crossT = Math.max(0, this._crossT - dt);
    if (this.gatherAction) this.gatherAction.t = (this.gatherAction.t ?? 0) + dt;
    this.sinceCatch += dt;
    this.sinceMove += dt;
    // Keep the completed take alive through this frame's animation sample.
    // Clearing here used to retire cross/BTL/behind at 97-99%, so an isolated
    // move could never show its authored catch and recovery even with no new
    // input. A new live input can still replace this exact object below.
    let completedMove = null;
    if (this.moveAnim) {
      this.moveAnim.t = Math.min(this.moveAnim.dur, this.moveAnim.t + dt);
      if (this.moveAnim.t >= this.moveAnim.dur) completedMove = this.moveAnim;
    }
    if (this.burstDrive) {
      this.burstDrive.t += dt;
      if (this.burstDrive.t >= this.burstDrive.dur) this.burstDrive = null;
    }

    const intent = this.hasBall ? this.intentOffense : this.intentDefense;
    const it = intent ?? { move: { x: 0, z: 0 }, mag: 0, sprint: false };
    this.tryDribbleBurst(it);
    this.tryHandleLocomotionCancel(it);

    // A check-ball/pass catch is a legal two-hand triple threat. The first
    // actual movement input starts the dribble; standing still never does.
    if (this.hasBall && !this.dribbleStarted && !this.dribbleEnded && !this.action && !this.moveAnim &&
        this.gameRef?.state === 'live' && it.mag > 0.08) {
      this.beginDribble();
    }

    // stamina
    const speedNow = Math.hypot(this.vel.x, this.vel.z);
    if (it.sprint && speedNow > 4) this.stamina = Math.max(0, this.stamina - dt * 0.07);
    else this.stamina = Math.min(1, this.stamina + dt * (speedNow < 2 ? 0.11 : 0.05));

    // ---------------- physicality ----------------
    // Both of these are contests over ground rather than animations: whoever
    // has position and legs moves the other body. They run before locomotion
    // so the speed clamps below see the right stance.
    // the defensive stance: slower and squared to the man, but the body counts
    this.stance = !!(this.intentDefense?.physical) && this.state === 'defense' &&
      !this.airborne && !this.action;
    this.updatePost(dt, world);
    this.updateBoxout(dt, ball, world);

    // ---------------- action state machine ----------------
    if (this.action) {
      this.updateAction(dt, ball, world);
    } else {
      // stumble overrides locomotion briefly
      if (this.stumbleT > 0) {
        this.vel.multiplyScalar(1 - 6 * dt);
      }
    }

    // ---------------- locomotion ----------------
    const activeFinishDrive = this.action && ['layup', 'dunk'].includes(this.action.name) &&
      !this.action.released && !this.action.awaitingHold;
    if (activeFinishDrive) {
      // Finish roots are continuous velocities. The old absolute interpolation
      // overwrote Player.pos every frame, visibly pulling the athlete onto a
      // precomputed layup point regardless of the speed they entered with.
      this.steerFinishVelocity(dt, this.action);
    } else if (!this.airborne) {
      // Once the ball has been gathered, ordinary locomotion is a travel. The
      // player may still pass or begin a stationary shot, but WASD cannot move
      // the root and existing momentum is killed on the gather frame.
      const gatheredBall = this.hasBall && this.dribbleEnded;
      const plantedFake = this.moveAnim?.name === 'pumpfake';
      if (gatheredBall || plantedFake) {
        this.vel.x = 0;
        this.vel.z = 0;
      }
      let maxSpeed = it.sprint ? SPRINT : RUN;
      if (it.mag < 0.45) maxSpeed = WALK * Math.max(1, it.mag / 0.45);
      else maxSpeed *= lerp(0.55, 1, (it.mag - 0.45) / 0.55);
      if (this.hasBall) maxSpeed *= 0.96;
      if (gatheredBall || plantedFake) maxSpeed = 0;
      // A directional hold has already frozen its drive snapshot and begun a
      // gather. Ordinary sprint locomotion must decelerate here; otherwise the
      // handler can cover the entire paint while the owned bounce returns,
      // then start the finish from behind the backboard. The committed finish
      // root resumes continuous travel as soon as the palm owns the ball.
      if (this.gatherAction?.kind === 'directionalShot') maxSpeed = 0;
      maxSpeed *= lerp(0.86, 1, this.stamina);
      // A committed handle take owns its own small root path. Letting ordinary
      // locomotion run underneath it made the feet play in place while the
      // athlete slid across the floor. Directional movement becomes legal only
      // through the explicit burst/cancel window below.
      if (this.moveAnim && !this.burstDrive) maxSpeed = 0;
      else if (this.moveLock > 0) maxSpeed *= this.spinDir !== 0 ? 0.28 : 0.58;
      if (this.action && this.action.name !== 'drive') maxSpeed *= this.action.moveScale ?? 0.15;
      // you do not run while you are leaning on someone
      if (this.posting) maxSpeed = Math.min(maxSpeed, 1.35);
      if (this.boxingOut) maxSpeed = Math.min(maxSpeed, 2.0);
      if (this.braceT > 0) maxSpeed *= 0.55;
      if (this.stumbleT > 0) maxSpeed *= this.stumbleKind === 'fall' ? 0.06 : 0.3;
      // The stance is a trade, not a free upgrade: it buys contact and costs
      // top speed, which is what makes releasing it to recover a real decision.
      if (this.stance) maxSpeed = Math.min(maxSpeed, RUN * 0.62);
      if (this.shielding && !this.posting) maxSpeed = Math.min(maxSpeed, RUN * 0.72);

      const desired = this._tmp.set(it.move.x, 0, it.move.z);
      if (desired.lengthSq() > 1) desired.normalize();
      if (this.burstDrive) {
        const b = this.burstDrive;
        const u = clamp(b.t / b.dur, 0, 1);
        // The launch is sharp at the branch frame, then settles onto normal
        // sprint pace. Root integration below stays continuous; no position is
        // snapped to a drive point.
        const burstSpeed = lerp(b.speed, SPRINT, u * u);
        desired.set(b.dirX, 0, b.dirZ).multiplyScalar(burstSpeed);
      } else {
        desired.multiplyScalar(it.mag > 0 ? maxSpeed : 0);
      }

      const dvx = desired.x - this.vel.x;
      const dvz = desired.z - this.vel.z;
      const dl = Math.hypot(dvx, dvz);
      const currentSpeed = Math.hypot(this.vel.x, this.vel.z);
      const desiredSpeed = Math.hypot(desired.x, desired.z);
      const alignment = currentSpeed > 0.05 && desiredSpeed > 0.05
        ? (this.vel.x * desired.x + this.vel.z * desired.z) / (currentSpeed * desiredSpeed)
        : 1;
      const rate = this.burstDrive ? 72
        : desiredSpeed < 0.05 ? DECEL : (alignment < 0.65 ? TURN_ACCEL : ACCEL);
      const maxD = rate * dt;
      if (dl > maxD && dl > 1e-6) {
        this.vel.x += dvx / dl * maxD;
        this.vel.z += dvz / dl * maxD;
      } else {
        this.vel.x = desired.x; this.vel.z = desired.z;
      }
    } else {
      // Airborne momentum is committed, not an extra movement mode. Stronger
      // damping removes the old moon-glide while the authored finish root path
      // below still carries a layup/dunk through its short flight corridor.
      this.vel.x *= Math.max(0, 1 - 1.8 * dt);
      this.vel.z *= Math.max(0, 1 - 1.8 * dt);
    }

    // integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.updateSkillPath(dt);

    // A rebound/contest is a jump and a short catch step, not a flying homing
    // move. Finish actions use an explicit ground-approach/air-corridor path.
    // Cap total horizontal travel for the action, including carried momentum,
    // and cancel only the outward component once that boundary is reached.
    if (this.action?.maxRootTravel != null && this.action.rootStart &&
        !['layup', 'dunk'].includes(this.action.name)) {
      const a = this.action;
      const dx = this.pos.x - a.rootStart.x, dz = this.pos.z - a.rootStart.z;
      const travel = Math.hypot(dx, dz);
      const maxTravel = a.maxRootTravel ?? 0.78;
      if (travel > maxTravel && travel > 1e-5) {
        const nx = dx / travel, nz = dz / travel;
        this.pos.x = a.rootStart.x + nx * maxTravel;
        this.pos.z = a.rootStart.z + nz * maxTravel;
        const outward = this.vel.x * nx + this.vel.z * nz;
        if (outward > 0) {
          this.vel.x -= nx * outward;
          this.vel.z -= nz * outward;
        }
      }
    }

    // jump physics
    if (this.airborne && this.hangT > 0) {
      // hanging on the rim: hold altitude
      this.hangT -= dt;
      this.vy = 0;
    } else if (this.airborne) {
      this.vy -= G * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) {
        this.y = 0;
        this.airborne = false;
        this.vy = 0;
        this.onLand(ball, world);
      }
    }

    // court clamp
    this.pos.x = clamp(this.pos.x, -8.7, 8.7);
    this.pos.z = clamp(this.pos.z, -1.7, 15.7);
    // hoop pole collision (keep players out from behind the board)
    if (this.pos.z < 0.35 && Math.abs(this.pos.x) < 0.85) {
      this.pos.z = Math.max(this.pos.z, 0.35);
      if (this.pos.y > 0.1 && this.pos.z < 1.4) this.pos.z = 1.4; // no jumping over via back area
    }

    // facing
    this.updateFacing(dt, it, ball, world);

    // Dribble contact is world-space. Move the skeleton root to this
    // frame's simulation pose before reading either palm; doing this after the
    // catch test made a turning handler chase a hand from the previous frame.
    this.rig.group.position.set(this.pos.x, this.y, this.pos.z);
    this.rig.group.rotation.y = this.facing;
    // A successful ankle break is a gameplay root reaction, never a second
    // limb pose. It tilts the complete athlete as one rigid rig, so joints
    // cannot stretch or separate.
    const isFallReaction = this.stumbleKind === 'fall' ||
      this.stumbleKind === 'blocked-fall' || this.stumbleKind === 'blocked-back-fall';
    if (isFallReaction && this.stumbleT > 0) {
      const reactionDur = this.stumbleKind === 'blocked-back-fall' ? 1.28 : 1.05;
      const p = 1 - this.stumbleT / reactionDur;
      const lean = Math.sin(clamp(p, 0, 1) * Math.PI);
      const backFall = this.stumbleKind === 'blocked-back-fall';
      this.rig.group.rotation.x = (backFall ? 0.92 : -0.68) * lean;
      this.rig.group.rotation.z = (this.stumbleDir || 1) * 0.22 * lean;
      this.rig.group.position.y += 0.05 * lean;
    } else {
      this.rig.group.rotation.x = 0;
      this.rig.group.rotation.z = 0;
    }
    this.rig.group.updateMatrixWorld(true);

    // ---------------- dribble ----------------
    if (this.hasBall && !this.isShooting && !this.action) {
      this.updateDribble(dt, ball, world);
    }

    // street clear rule: clearing the ball beyond the arc makes you live
    if (this.hasBall && !this.clearedBall && !this.airborne &&
        isBeyondArc(this.pos.x, this.pos.z)) {
      this.clearedBall = true;
    }

    // ---------------- animate ----------------
    this.animate(dt, ball, world);
    if (this.moveAnim === completedMove) this.moveAnim = null;

    // ground props live in world space so they stay planted on jumps
    this.rig.updateGround(dt, this.pos.x, this.pos.z, this.y);
    if (this.userMarker.visible) this.userMarker.position.set(this.pos.x, 0.22, this.pos.z);
  }

  updateFacing(dt, it, ball, world) {
    let target = this.facing;
    let rate = 11;
    const speed = Math.hypot(this.vel.x, this.vel.z);

    if (this.spinDir !== 0) {
      // yaw grows toward the athlete's left, so spinning right subtracts
      const dth = -this.spinDir * 13 * dt;
      this.facing += dth;
      this.spinTotal = (this.spinTotal || 0) + Math.abs(dth);
      if (this.spinTotal >= Math.PI * 1.98) {
        this.spinDir = 0;
        // resume dribble after spin
        this.dribbleTimer = 0.1;
      }
      return;
    }

    if (this.gameRef?.state === 'checkball') {
      // A check-ball is a pass between the two athletes. Keep both torsos and
      // the authored pass/catch takes aimed at the actual partner until the
      // receiver owns the ball; the normal has-ball branch points at the rim.
      const other = world.otherPlayer(this);
      if (other) {
        target = Math.atan2(other.pos.x - this.pos.x, other.pos.z - this.pos.z);
        this.facing = dampAngle(this.facing, target, 18, dt);
      }
      return;
    }

    if (this.posting) {
      // back to the basket — the whole point of the position
      target = Math.atan2(this.pos.x - COURT.rimCenter.x, this.pos.z - COURT.rimCenter.z);
      rate = 8;
      this.facing = dampAngle(this.facing, target, rate, dt);
      return;
    }

    if (this.boxingOut) {
      // chest to the opponent, rim at your back
      const opp = world.otherPlayer(this);
      if (opp) {
        target = Math.atan2(opp.pos.x - this.pos.x, opp.pos.z - this.pos.z);
        this.facing = dampAngle(this.facing, target, 9, dt);
        return;
      }
    }

    if (this.state === 'defense') {
      const opp = world.offense === this ? world.defensePlayer() : world.offense;
      if (this.stance) {
        // Ctrl/L2 is the explicit lockdown commitment: square the chest to the
        // handler/ball and trade top speed for contact.
        const t = ball.isLive() ? ball.pos : opp.pos;
        target = Math.atan2(t.x - this.pos.x, t.z - this.pos.z);
        rate = 12;
      } else if (speed > 0.35 || it.mag > 0.1) {
        // Outside lockdown, defence is free-running. Facing travel keeps the
        // gait under the root instead of forcing a sideways look-at slide.
        target = speed > 0.55
          ? Math.atan2(this.vel.x, this.vel.z)
          : Math.atan2(it.move.x, it.move.z);
        rate = 18;
      }
    } else if (this.isShooting) {
      // a turnaround pivots off the post; everything else already faces the rim
      target = Math.atan2(COURT.rimCenter.x - this.pos.x, COURT.rimCenter.z - this.pos.z);
      rate = this.action?.variant === 'turnaround' ? 7 : 13;
    } else if (this.hasBall) {
      // At speed, the run cycle has to face its root travel or the planted
      // foot is dragged sideways. At low speed the handler can still square up
      // to the hoop for triple-threat and standing dribbles.
      const toRim = Math.atan2(COURT.rimCenter.x - this.pos.x, COURT.rimCenter.z - this.pos.z);
      if (speed > 1.45 || it.mag > 0.45) {
        // During a hard reversal the root necessarily crosses near-zero speed.
        // Do not use that instant to turn back toward the hoop and then turn a
        // second time. When input opposes current momentum, begin the plant and
        // body turn immediately instead of waiting for velocity to cross zero.
        const inputLen = Math.hypot(it.move.x, it.move.z);
        const opposing = inputLen > 0.1 && speed > 0.1 &&
          (this.vel.x * it.move.x + this.vel.z * it.move.z) / (speed * inputLen) < 0;
        target = speed > 0.65 && !opposing
          ? Math.atan2(this.vel.x, this.vel.z)
          : Math.atan2(it.move.x, it.move.z);
        target += angleDelta(target, toRim) * 0.08;
        rate = 20;
      } else {
        target = toRim;
        rate = 9;
      }
    } else if (speed > 1.2) {
      target = Math.atan2(this.vel.x, this.vel.z);
      rate = 14;
    } else if (!this.hasBall && world.offense && world.offense !== this) {
      target = Math.atan2(COURT.rimCenter.x - this.pos.x, COURT.rimCenter.z - this.pos.z);
      rate = 4;
    }

    this.facing = dampAngle(this.facing, target, rate, dt);
  }

  /**
   * Start a root path in the athlete's local ground plane. The source game
   * gives dribble moves explicit displacement sections; a velocity impulse
   * cannot reproduce those sections after acceleration and movement locks are
   * applied. Keeping one small path beside the body pose gives the move its
   * designed cut without layering another locomotion system onto the skeleton.
   */
  startSkillPath(kind, side, dur, lateral, forward, feint = 0) {
    const facing = this.facing;
    this.skillPath = {
      kind, side: Math.sign(side) || 1, dur, t: 0,
      lateral, forward, feint,
      rightX: -Math.cos(facing), rightZ: Math.sin(facing),
      forwardX: Math.sin(facing), forwardZ: Math.cos(facing),
      prevLateral: 0, prevForward: 0,
    };
  }

  /** Branch the recovery of a handle move into a directional speed launch. */
  tryDribbleBurst(intent) {
    const move = this.moveAnim;
    const spec = move ? DRIBBLE_BURST[move.name] : null;
    if (!move || !spec || move.burstUsed || this.burstDrive || !this.hasBall) return false;
    const phase = move.t / Math.max(move.dur, 1e-4);
    if (phase < spec.open || phase > spec.close || !intent?.sprint || intent.mag < 0.52) return false;
    const len = Math.hypot(intent.move.x, intent.move.z);
    if (len < 0.2) return false;

    move.burstUsed = true;
    const source = move.name;
    const dirX = intent.move.x / len;
    const dirZ = intent.move.z / len;
    this.burstDrive = {
      source, t: 0, dur: 0.27, dirX, dirZ,
      speed: spec.speed * lerp(0.90, 1, this.stamina),
    };
    // This is a recovery cancel, so the committed take/path ends on its current
    // frame and the locomotion take starts from the same world position.
    this.moveAnim = null;
    this.skillPath = null;
    this.moveLock = 0;
    this.spinDir = 0;
    this.vel.set(dirX * this.burstDrive.speed, 0, dirZ * this.burstDrive.speed);
    this.stamina = Math.max(0, this.stamina - 0.075);
    this.lastMove = `${source}_burst`;
    this.sinceMove = 0;
    return true;
  }

  /**
   * A new locomotion edge after a handle began is an explicit interruption.
   * Movement already held before the move does not cancel it; that distinction
   * preserves authored running crossovers while making a later WASD press
   * answer on the same frame. The owned ball flight remains physical and keeps
   * tracking its selected receiving palm.
   */
  tryHandleLocomotionCancel(intent) {
    const move = this.moveAnim;
    if (!move || move.name === 'pumpfake' || !this.hasBall || (intent?.mag ?? 0) < 0.08) return false;
    const serial = intent?.moveSerial ?? 0;
    if (serial === (move.moveSerial ?? serial)) return false;

    const source = move.name;
    this.moveAnim = null;
    this.skillPath = null;
    this.moveLock = 0;
    this.spinDir = 0;
    this.lastMove = `${source}_move_cancel`;
    this.sinceMove = 0;
    return true;
  }

  /** Exact incremental displacement for the active dribble move. */
  updateSkillPath(dt) {
    const path = this.skillPath;
    if (!path) return;
    path.t = Math.min(path.dur, path.t + dt);
    const u = clamp(path.t / Math.max(path.dur, 1e-4), 0, 1);
    const ease = (x) => {
      x = clamp(x, 0, 1);
      return x * x * (3 - 2 * x);
    };
    let lateral = 0;
    let forward = path.forward * ease(u);

    if (path.kind === 'cross') {
      // Sell a short step opposite the receiving hand, then cut hard across.
      if (u < 0.24) lateral = -path.side * path.feint * ease(u / 0.24);
      else lateral = lerp(-path.side * path.feint, path.side * path.lateral,
        ease((u - 0.24) / 0.76));
      forward = path.forward * ease(Math.max(0, (u - 0.08) / 0.92));
    } else if (path.kind === 'sidedrive') {
      // One committed same-hand lane step. The ball stays outside the hips
      // while the planted foot drives the root toward that same side.
      lateral = path.side * path.lateral * ease(u);
      forward = path.forward * ease(Math.max(0, (u - 0.10) / 0.90));
    } else if (path.kind === 'doublecross') {
      // Two readable plants: away, back through the defender's hips, then go.
      if (u < 0.30) lateral = -path.side * path.lateral * 0.56 * ease(u / 0.30);
      else if (u < 0.62) lateral = lerp(-path.side * path.lateral * 0.56,
        path.side * path.lateral * 0.22, ease((u - 0.30) / 0.32));
      else lateral = lerp(path.side * path.lateral * 0.22,
        path.side * path.lateral, ease((u - 0.62) / 0.38));
    } else if (path.kind === 'btl') {
      lateral = path.side * path.lateral * ease(u);
      // The through-the-legs plant delays the forward launch by one beat.
      forward = path.forward * ease(Math.max(0, (u - 0.16) / 0.84));
    } else if (path.kind === 'behind') {
      if (u < 0.20) lateral = -path.side * path.feint * ease(u / 0.20);
      else lateral = lerp(-path.side * path.feint, path.side * path.lateral,
        ease((u - 0.20) / 0.80));
      forward = path.forward * ease(Math.max(0, (u - 0.12) / 0.88));
    } else if (path.kind === 'shotHop') {
      // Gather step for side-hop / step-back / forward hop jumpers. The root
      // path is complete before takeoff; the authored shot owns the air phase.
      lateral = path.side * path.lateral * ease(u);
      forward = path.forward * ease(u);
    } else if (path.kind === 'spin') {
      // Arc around the defender while the full-body take supplies the pivot.
      lateral = path.side * (path.lateral * Math.sin(Math.PI * u) + 0.18 * u);
    } else if (path.kind === 'halfspin') {
      lateral = path.side * path.lateral * ease(u);
    }

    const dl = lateral - path.prevLateral;
    const df = forward - path.prevForward;
    this.pos.x += path.rightX * dl + path.forwardX * df;
    this.pos.z += path.rightZ * dl + path.forwardZ * df;
    path.prevLateral = lateral;
    path.prevForward = forward;
    if (path.t >= path.dur) this.skillPath = null;
  }

  // ------------------------------------------------------------ dribble

  /** Leave triple-threat and put the ball down on the first real input. */
  beginDribble() {
    if (!this.hasBall || this.dribbleStarted || this.dribbleEnded || this.action) return false;
    this.dribbleStarted = true;
    this.catchT = 0;
    // A tiny dwell prevents the triple-threat -> dribble transition from
    // releasing in the same frame that the receiving pose begins.
    this.dribbleTimer = Math.max(this.dribbleTimer, 0.035);
    return true;
  }

  updateDribble(dt, ball, world) {
    if (this.spinDir !== 0) {
      // ball held at chest during spin
      const anchor = this.holdPoint(this._tmp);
      ball.state = 'held';
      ball.holder = this;
      ball.updateAttach(anchor, dt);
      return;
    }
    // during check ball the checking player just holds it
    if (this.gameRef?.state === 'checkball') {
      ball.state = 'held';
      ball.holder = this;
      ball.updateAttach(this.holdPoint(this._tmp), dt);
      return;
    }
    if (this.dribbleEnded) {
      ball.state = 'held';
      ball.holder = this;
      ball.updateAttach(this.holdPoint(this._tmp), dt);
      return;
    }
    if (!this.dribbleStarted) {
      ball.state = 'held';
      ball.holder = this;
      ball.updateAttach(this.holdPoint(this._tmp), dt);
      return;
    }
    if (ball.state === 'held' && ball.holder === this) {
      this.dribbleTimer -= dt;
      this._heldFor += dt;
      if (this.dribbleTimer <= 0) {
        this.pushBall(ball);
      } else {
        const anchor = this.dribbleAnchor(this._tmp);
        ball.updateAttach(anchor, dt);
      }
    } else if (ball.state === 'dribble') {
      const d = ball.dribble;
      if (d.phase === 'up') {
        // check catch
        const anchor = this.dribbleAnchor(this._tmp2, d.hand);
        const dist = ball.pos.distanceTo(anchor);
        const missed = ball.pos.y < anchor.y - 0.3 && ball.vel.y < -0.5;
        // Possession changes only on palm contact. Height alone used to snap a
        // ball back from empty space and made every dribble look telekinetic.
        // A hand-sized contact window, not a broad proximity trigger. 0.18 m
        // is roughly ball radius plus palm thickness; the old 0.28 m accepted
        // the catch while daylight was still visible between hand and ball.
        // An explicitly requested gather closes the fingers around the rising
        // ball; allow the ball radius + palm depth, while ordinary dribbling
        // keeps the stricter visible-contact window.
        const catchWindow = this.gatherAction ? 0.21 : 0.18;
        if (dist < catchWindow || missed) {
          // Normal dribbling does not turn into a live-ball turnover because a
          // fixed take missed a moving palm. The reference game keeps ownership
          // through its dribble state and only releases it from a steal/contact
          // result. The flight guide should make this correction invisible; the
          // fallback preserves that ownership invariant on an extreme turn.
          if (missed) ball.pos.copy(anchor);
          this.lastBallContact = {
            kind: missed ? 'dribble-catch-corrected' : 'dribble-catch', gap: dist,
          };
          ball.state = 'held';
          ball.holder = this;
          ball.dribble = null;
          this.dribbleHand = d.hand;
          this.dribbleTimer = this.dribbleRhythm * rand(0.12, 0.3);
          this._heldFor = 0;
          if (this.hesitation > 0) this.dribbleTimer += 0.14;
          this.resolveGatherAction();
        }
      }
      void world;
    }
  }

  /** Where a held ball sits between the two procedural palms. */
  holdPoint(out) {
    if (this.rig.palmPosition) {
      const left = this.rig.palmPosition('Left', out);
      const right = this.rig.palmPosition('Right', this._tmp2);
      return left.add(right).multiplyScalar(0.5);
    }
    return this.localToWorld(this.holdAnchor?.x ?? 0, this.holdAnchor?.y ?? 1.10,
      this.holdAnchor?.z ?? 0.30, out);
  }

  dribbleAnchor(out, hand = this.dribbleHand) {
    // Read the palm off the bones. No floor clamp: clamping would hide a bad
    // wrist pose instead of keeping the hand and ball causally aligned.
    if (this.rig.palmPosition) {
      return this.rig.palmPosition(hand, out);
    }
    const s = hand === 'Left' ? -1 : 1;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const fwd = clamp(speed * 0.16, 0.05, 0.55);
    const h = this.catchHeight - (this.state === 'defense' ? 0.18 : 0) - clamp(speed * 0.02, 0, 0.12);
    return this.localToWorld(s * 0.30, Math.max(0.42, h), fwd + 0.10, out);
  }

  pushBall(ball) {
    const hand = this.dribbleHand;
    const anchor = this.dribbleAnchor(this._tmp, hand);
    const speed = Math.hypot(this.vel.x, this.vel.z);
    let catchH = this.catchHeight;

    if (this.hesitation > 0) {
      catchH = Math.max(catchH, 1.02);
    }

    // NBA-speed handle: stationary bounces sit around two beats per second and
    // compress further on a sprint. The old 0.30-0.40 s downward leg alone was
    // slower than a full game dribble and read like a yo-yo.
    const T = clamp(0.20 + (catchH - 0.5) * 0.045 - speed * 0.008, 0.14, 0.25);
    // A running handler travels well over a metre during the downward flight.
    // Aim the push ahead by that flight time; the previous fixed 80 ms lead
    // left the ball two metres behind the hand at sprint speed.
    const leadT = T * 0.42;
    const bounce = new THREE.Vector3(
      anchor.x + this.vel.x * leadT,
      0,
      anchor.z + this.vel.z * leadT,
    );
    ball.pushDribble(this, hand, anchor, bounce, catchH, T);
  }

  /**
   * Execute a dribble move. name: 'cross' | 'sidedrive' | 'btl' | 'behind' | 'hesitation' | 'sizeup' | 'spin'
   * dir: relative lateral direction (+1 right / -1 left in local space)
   */
  projectedHandleHand() {
    if (this.moveAnim?.toHand) return this.moveAnim.toHand;
    const d = this.gameRef?.ball?.dribble;
    if (d?.holder === this && d.hand) return d.hand;
    return this.dribbleHand;
  }

  /** Horizontal stick input is relative to the ball side, not a hard-coded cross. */
  doHorizontalHandle(dir) {
    const desiredSide = dir < 0 ? -1 : 1;
    const hand = this.projectedHandleHand();
    const handSide = hand === 'Left' ? -1 : 1;
    return this.doDribbleMove(desiredSide === handSide ? 'sidedrive' : 'cross', desiredSide);
  }

  doDribbleMove(name, dir = 0) {
    if (!this.hasBall || this.dribbleEnded || this.isShooting || this.action) return false;
    const ball = this.gameRef.ball;
    // A handle flick is a new current choice. If a gather was still returning
    // the owned bounce, cancel that choice now instead of letting it fire later.
    this.gatherAction = null;
    this.beginDribble();
    // Every accepted handle input is the current action on this frame. There
    // is no combo FIFO and no recovery-window pre-input. When a physical bounce
    // is already airborne, keep that ball flight alive but retarget its return
    // palm to the newly requested take.
    const chainable = ['cross', 'sidedrive', 'btl', 'behind', 'hesitation', 'spin'].includes(name);
    const ownedBounce = ball.state === 'dribble' && ball.dribble?.holder === this;
    if ((this.moveAnim || this.moveLock > 0 || ownedBounce) && !chainable) return false;
    const fromHand = this.projectedHandleHand();
    if (chainable) {
      // Cancel the old body/root take now. `ownedBounce` below keeps the ball
      // physical, so this does not snap it back to the new pose's first frame.
      this.moveAnim = null;
      this.skillPath = null;
      this.burstDrive = null;
      this.moveLock = 0;
    }
    const cur = fromHand === 'Left' ? -1 : 1;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    this.stamina = Math.max(0, this.stamina - 0.045);
    const useBounce = (toHand, anchor, bounce, catchH, bounceT) => {
      if (ownedBounce) {
        const live = ball.dribble;
        live.hand = toHand;
        live.catchH = catchH;
        live.catchAnchor = null;
        live.catchVelocity = null;
        live.quickReturn = true;
        live.quickReturnArmedPhase = null;
        return;
      }
      ball.pushDribble(this, toHand, anchor, bounce, catchH, bounceT);
    };
    // every move now drives a body pose, not just the ball: the animator reads
    // moveAnim so a move is readable without watching the ball.
    const anim = (n, dur, d = 0, toHand = null) => {
      this.moveAnim = {
        name: n, t: 0, dur, dir: d,
        fromHand,
        toHand: toHand ?? fromHand,
        entrySpeed: speed,
        moveSerial: this.intentOffense?.moveSerial ?? 0,
      };
      this.lastMove = n;
      this.sinceMove = 0;
    };

    // A second real crossover inside the live combo window upgrades to the
    // authored double-cross take immediately; it is never deferred until the
    // current ball flight or clip finishes.
    if (name === 'cross') {
      // Only the away-from-hand gesture reaches this branch. A crossover must
      // cross the body and finish in the opposite hand.
      const d = -cur;
      if (this._crossT > 0) name = 'doublecross';
      this._crossT = 0.72;
      this._crossDir = d;
    }
    // half-spin out of the post rather than a full spin into traffic
    if (name === 'spin' && this.posting) name = 'halfspin';

    switch (name) {
      case 'sidedrive': {
        const cfg = HANDLE_MOVE.sidedrive;
        const hand = fromHand;
        const s = hand === 'Left' ? -1 : 1;
        const anchor = this.dribbleAnchor(this._tmp, hand);
        const bounce = this.localToWorld(s * 0.38, 0, 0.34, this._tmp2);
        const catchH = Math.max(0.62, this.catchHeight);
        useBounce(hand, anchor, bounce, catchH, cfg.bounceT);
        this.catchHeight = catchH;
        const dur = cfg.dur;
        this.moveLock = dur;
        this.startSkillPath('sidedrive', s, cfg.pathDur, cfg.lateral, cfg.forward);
        this.hesitation = 0;
        anim('sidedrive', dur, s, hand);
        return true;
      }
      case 'cross': {
        const cfg = HANDLE_MOVE.cross;
        // Release from the hand that owns the ball; the hand changes only when
        // the rising ball reaches the receiver. The previous implementation
        // switched first and appeared to throw the ball out of empty space.
        const newHand = cur > 0 ? 'Left' : 'Right';
        const s = newHand === 'Left' ? -1 : 1;
        const anchor = this.dribbleAnchor(this._tmp, fromHand);
        const receive = this.dribbleAnchor(this._tmp2, newHand);
        const bounce = anchor.clone().lerp(receive, 0.52).setY(0);
        useBounce(newHand, anchor, bounce, cfg.catchH, cfg.bounceT);
        this.catchHeight = cfg.catchH;
        const dur = cfg.dur;
        this.moveLock = dur;
        // The take sells the hand exchange and one lateral plant. Forward drive
        // belongs to the recovery-cancel branch, not to passive root drift.
        this.vel.multiplyScalar(0.12);
        this.startSkillPath('cross', s, dur, cfg.lateral, cfg.forward, cfg.feint);
        this.hesitation = 0;
        anim('cross', dur, s, newHand);
        return true;
      }
      case 'btl': {
        const cfg = HANDLE_MOVE.btl;
        const newHand = cur > 0 ? 'Left' : 'Right';
        const s = newHand === 'Left' ? -1 : 1;
        const anchor = this.dribbleAnchor(this._tmp, fromHand);
        const receive = this.dribbleAnchor(this._tmp2, newHand);
        const bounce = anchor.clone().lerp(receive, 0.55).setY(0);
        useBounce(newHand, anchor, bounce, cfg.catchH, cfg.bounceT);
        this.catchHeight = cfg.catchH;
        const dur = cfg.dur;
        this.moveLock = dur;
        // Between-the-legs is a plant. It changes the ball side inside a tight
        // footprint; acceleration only appears if the player hits the burst
        // window after the ball has passed between the legs.
        this.vel.multiplyScalar(0.08);
        this.startSkillPath('btl', s, dur, cfg.lateral, cfg.forward);
        anim('btl', dur, s, newHand);
        return true;
      }
      case 'behind': {
        const cfg = HANDLE_MOVE.behind;
        const newHand = cur > 0 ? 'Left' : 'Right';
        const s = newHand === 'Left' ? -1 : 1;
        const anchor = this.dribbleAnchor(this._tmp, fromHand);
        const receive = this.dribbleAnchor(this._tmp2, newHand);
        const bounce = anchor.clone().lerp(receive, 0.48)
          .addScaledVector(this.forward(new THREE.Vector3()), -0.30).setY(0);
        useBounce(newHand, anchor, bounce, cfg.catchH, cfg.bounceT);
        this.catchHeight = cfg.catchH;
        const dur = cfg.dur;
        this.moveLock = dur;
        this.vel.multiplyScalar(0.10);
        // A protected wrap and lane plant; a full drive is the cancel branch.
        this.startSkillPath('behind', s, dur, cfg.lateral, cfg.forward, cfg.feint);
        anim('behind', dur, s, newHand);
        return true;
      }
      case 'hesitation': {
        if (ownedBounce) {
          ball.dribble.hand = fromHand;
          ball.dribble.quickReturn = true;
          ball.dribble.quickReturnArmedPhase = null;
        }
        this.hesitation = 0.9;
        this.catchHeight = 1.0;
        this.moveLock = 0.1;
        this.vel.multiplyScalar(0.12);
        anim('hesitation', 0.52, 0);
        return true;
      }
      case 'sizeup': {
        // just a rhythmic wide side dribble
        this.catchHeight = 0.8;
        this.moveLock = 0.05;
        this.sizeupT = 0.7;
        this.lastMove = 'sizeup';
        this.sinceMove = 0;
        return true;
      }
      case 'doublecross': {
        const cfg = HANDLE_MOVE.doublecross;
        // The extra false cross must still finish in the opposite hand, exactly
        // like every other crossover command.
        const newHand = cur > 0 ? 'Left' : 'Right';
        const s = newHand === 'Left' ? -1 : 1;
        const anchor = this.dribbleAnchor(this._tmp, fromHand);
        const receive = this.dribbleAnchor(this._tmp2, newHand);
        const bounce = anchor.clone().lerp(receive, 0.52).setY(0);
        useBounce(newHand, anchor, bounce, cfg.catchH, cfg.bounceT);
        this.catchHeight = cfg.catchH;
        const dur = cfg.dur;
        this.moveLock = dur;
        this.vel.multiplyScalar(0.08);
        this.startSkillPath('doublecross', s, dur, cfg.lateral, cfg.forward);
        this.hesitation = 0;
        anim('doublecross', dur, s, newHand);
        return true;
      }
      case 'jab': {
        // a foot in, nothing committed — buys a lean, costs nothing
        this.catchHeight = 0.86;
        this.moveLock = 0.12;
        anim('jab', 0.44, dir || cur);
        return true;
      }
      case 'halfspin': {
        this.spinDir = dir !== 0 ? Math.sign(dir) : (this.dribbleHand === 'Right' ? 1 : -1);
        this.spinTotal = Math.PI;   // stop the turn at 180 degrees
        const anchor = this.localToWorld(0, 1.05, 0.24, new THREE.Vector3());
        ball.state = 'held';
        ball.holder = this;
        ball.pos.copy(anchor);
        this.holdAnchor = { x: 0, y: 1.05, z: 0.26 };
        const dur = 0.46;
        this.moveLock = dur;
        this.startSkillPath('halfspin', this.spinDir, dur, 0.38, 0.48);
        this.posting = false;
        anim('halfspin', dur, this.spinDir);
        return true;
      }
      case 'spin': {
        // gather ball, spin body
        this.spinDir = dir !== 0 ? Math.sign(dir) : (this.dribbleHand === 'Right' ? 1 : -1);
        this.spinTotal = 0;
        const anchor = this.localToWorld(0, 1.05, 0.28, new THREE.Vector3());
        this.gameRef.ball.state = 'held';
        this.gameRef.ball.holder = this;
        this.gameRef.ball.pos.copy(anchor);
        this.holdAnchor = { x: 0, y: 1.05, z: 0.30 };
        const dur = 0.50;
        this.moveLock = dur;
        this.startSkillPath('spin', this.spinDir, dur, 0.32, 0.95);
        anim('spin', dur, this.spinDir);
        return true;
      }
    }
    return false;
  }

  // -------------------------------------------------------- physicality

  /** is there anybody to back down, and are we close enough for it to matter */
  canPostUp() {
    if (!this.hasBall || this.action || this.airborne || this.spinDir !== 0) return false;
    if (this.distToRim() > 5.6) return false;
    const def = this.gameRef?.otherPlayer(this);
    return !!def && def.pos.distanceTo(this.pos) < 2.1;
  }

  /**
   * Back-to-the-basket post-up. Holding it turns the athlete away from the rim
   * and leans on whoever is behind them; ground is won or lost on stamina, so
   * posting a fresh defender goes nowhere and posting a tired one walks them
   * under the rim.
   */
  updatePost(dt, world) {
    // one key: with your back to the rim and a body behind you it posts up,
    // anywhere else it just protects the handle
    const held = !!this.intentOffense?.physical;
    this.shielding = held && this.hasBall && !this.action;
    const want = held && this.canPostUp();
    if (want !== this.posting) { this.posting = want; this.postT = 0; }
    if (!this.posting) return;
    this.postT += dt;
    this.stamina = Math.max(0, this.stamina - dt * 0.11);

    const def = world.otherPlayer(this);
    if (!def) return;
    const toRim = this._tmp.set(COURT.rimCenter.x - this.pos.x, 0, COURT.rimCenter.z - this.pos.z);
    const len = toRim.length();
    if (len < 1e-3) return;
    toRim.divideScalar(len);
    const toDef = this._tmp2.set(def.pos.x - this.pos.x, 0, def.pos.z - this.pos.z);
    if (toDef.dot(toRim) > 0 && toDef.length() < 1.1) {
      const push = clamp(0.95 * this.stamina - 0.4 * def.stamina, 0, 0.9) * dt;
      def.pos.x += toRim.x * push; def.pos.z += toRim.z * push;
      this.pos.x += toRim.x * push * 0.6; this.pos.z += toRim.z * push * 0.6;
      def.braceT = 0.2;
      def.stamina = Math.max(0, def.stamina - dt * 0.06);
    }
  }

  /**
   * Box-out. Automatic, because a defender who has inside position and does not
   * use it is not a decision the player wanted to make. Holding the seal keeps
   * the shooter out of the paint while the ball is up.
   */
  updateBoxout(dt, ball, world) {
    const opp = world.otherPlayer(this);
    const live = ball.state === 'shot' || (ball.state === 'loose' && ball.pos.y > 1.3);
    // held, like everything else on this key. A box-out that happens on its own
    // is a decision taken away from the player, and it is the decision that
    // wins the possession.
    this.boxingOut = !!(this.stance && opp && live && !this.hasBall && !this.airborne && !this.action &&
      this.distToRim() < 4.0 && this.distToRim() < opp.distToRim() &&
      this.pos.distanceTo(opp.pos) < 2.2);
    if (!this.boxingOut) return;
    const away = this._tmp.set(this.pos.x - COURT.rimCenter.x, 0, this.pos.z - COURT.rimCenter.z);
    if (away.lengthSq() < 1e-6) return;
    away.normalize();
    if (this.pos.distanceTo(opp.pos) < 1.0) {
      const push = 0.75 * dt;
      opp.pos.x += away.x * push; opp.pos.z += away.z * push;
      opp.braceT = 0.18;
    }
  }

  // ------------------------------------------------------------ shooting

  /** start a jumper. Called on shoot press (with ball). */
  startShot(chargeMode = true, driveSnapshot = null, gatherSnapshot = null, requireHoldCommit = false) {
    if (!this.hasBall || this.isShooting || this.action) return false;
    // street clear rule
    if (this.gameRef && this.gameRef.state === 'live' && !this.clearedBall &&
        !isBeyondArc(this.pos.x, this.pos.z)) {
      this.gameRef.onTakeBackNeeded(this);
      return false;
    }
    const preGatherDribbleStarted = gatherSnapshot?.preGatherDribbleStarted ?? this.dribbleStarted;
    const liveDRim = this.distToRim();
    const liveSpeed = Math.hypot(this.vel.x, this.vel.z);
    const liveTowardRim = this.forward(this._tmp)
      .dot(this._tmp2.subVectors(COURT.rimCenter, this.pos).setY(0).normalize());
    const drive = {
      dRim: driveSnapshot?.dRim ?? liveDRim,
      speed: driveSnapshot?.speed ?? liveSpeed,
      towardRim: driveSnapshot?.towardRim ?? liveTowardRim,
      sprinting: driveSnapshot?.sprinting ?? !!this.intentOffense?.sprint,
    };
    const wantsFinish = !this.posting && drive.dRim < 5.25 && drive.speed > 1.35 &&
      drive.towardRim > 0.28;
    const preview = wantsFinish
      ? this.chooseFinish(drive)
      : { name: 'shot', variant: this.pickShotVariant(), spec: SHOT[this.pickShotVariant()] };
    const ball = this.gameRef?.ball;
    if (ball?.state === 'dribble' && ball.dribble?.holder === this) {
      // This is the current action immediately. Preserve the drive that existed
      // on the button frame while the physical ball completes its short return
      // to a palm; releasing sprint cannot change the chosen finish afterward.
      this.moveAnim = null;
      this.skillPath = null;
      this.burstDrive = null;
      this.moveLock = 0;
      this.gatherAction = {
        kind: 'shot', chargeMode,
        requireHoldCommit,
        drive,
        preview,
        preGatherDribbleStarted,
        t: 0,
      };
      ball.dribble.quickReturn = true;
      ball.dribble.quickReturnArmedPhase = null;
      return true;
    }
    this.gatherAction = null;
    this.dribbleEnded = true;
    const dRim = drive.dRim;
    const speed = drive.speed;
    const towardRim = drive.towardRim;

    // Contextual finish. The old gates (layup needed >2.6 m/s AND <3.8 m; dunk
    // needed <2.5 m and a 0.8 coin flip) almost never fired in normal play, so
    // drives ended in fadeaway jumpers. Attacking the rim at all is enough now.
    // Posting up is the exception: you finish over your shoulder, not by
    // turning and driving through the man you are leaning on.
    // A finish requires an actual drive. The previous distance-only rule turned
    // a stationary tap near the paint into an unsolicited layup or dunk.
    if (wantsFinish) {
      const started = this.startLayupOrDunk(drive, chargeMode, gatherSnapshot, preview, requireHoldCommit);
      if (started && this.action) this.action.preGatherDribbleStarted = preGatherDribbleStarted;
      return started;
    }

    // No separate gather action any more: `jumpAt` already holds the athlete on
    // the floor through the dip, which is what a gather is. One action means
    // one uninterrupted scrub of one take.
    const variant = this.pickShotVariant();
    const spec = SHOT[variant];
    const jumpH = spec.jump * lerp(0.82, 1, this.stamina) * (dRim > 6.5 ? 0.85 : 1);
    this.action = {
      name: 'shot', t: 0, dur: spec.dur + (speed > 4 ? 0.04 : 0), variant,
      released: false, chargeMode, perfectT: spec.perfectT, releasedAt: null,
      moveScale: 0.1, jumpAt: jumpFrac(spec), jumped: false, jumpH,
      drift: spec.drift ?? 0,
      preGatherDribbleStarted,
    };
    if (gatherSnapshot?.t) {
      this.action.t = Math.min(gatherSnapshot.t, this.action.dur * Math.max(0.05, this.action.jumpAt - 0.035));
    }
    this.posting = false;
    this.moveLock = spec.dur * 0.9;
    return true;
  }

  /** Snapshot the drive on the input frame; later palm contact must not change intent. */
  directionalDriveSnapshot() {
    const toRim = this._tmp.subVectors(COURT.rimCenter, this.pos).setY(0).normalize();
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const velocityToward = speed > 0.15 ? this.vel.dot(toRim) / speed : -1;
    const facingToward = this.forward(this._tmp2).dot(toRim);
    return {
      dRim: this.distToRim(),
      speed,
      towardRim: Math.max(velocityToward, facingToward),
      sprinting: !!this.intentOffense?.sprint,
    };
  }

  /**
   * Hold a skill-stick direction: hop jumper in space, directional finish on a
   * live rim attack. A returning owned bounce may delay the gather, never the
   * input decision; direction and drive speed are frozen on this frame.
   */
  startDirectionalShot(direction) {
    if (!this.hasBall || this.isShooting || this.action || !['left', 'right', 'up', 'down'].includes(direction)) {
      return false;
    }
    const drive = this.directionalDriveSnapshot();
    const preview = this.directionalShotPlan(direction, drive);
    const ball = this.gameRef?.ball;
    if (ball?.state === 'dribble' && ball.dribble?.holder === this) {
      this.moveAnim = null;
      this.skillPath = null;
      this.burstDrive = null;
      this.moveLock = 0;
      this.gatherAction = {
        kind: 'directionalShot', direction, drive, preview,
        chargeMode: true, preGatherDribbleStarted: this.dribbleStarted, t: 0,
      };
      ball.dribble.quickReturn = true;
      ball.dribble.quickReturnArmedPhase = null;
      return true;
    }
    return this.commitDirectionalShot(direction, drive, preview);
  }

  releaseDirectionalShot() {
    if (this.gatherAction?.kind === 'directionalShot') {
      this.gatherAction.chargeMode = false;
      return true;
    }
    if (this.action && ['shot', 'layup'].includes(this.action.name) && this.action.skillDir) {
      this.action.releaseRequested = true;
      return true;
    }
    return false;
  }

  directionalShotPlan(direction, drive) {
    const rimAttack = !this.posting && drive.dRim < 6.25 && drive.speed > 0.85 && drive.towardRim > 0.12;
    if (!rimAttack) {
      const variant = direction === 'down' ? 'stepback'
        : direction === 'up' ? 'pullup' : 'sidestep';
      return { name: 'shot', variant, spec: SHOT[variant], direction };
    }

    const sideHand = direction === 'left' ? 'Left'
      : direction === 'right' ? 'Right' : this.dribbleHand;
    const canDunk = drive.sprinting && drive.speed > 3.05 && drive.dRim < 5.25 && this.stamina > 0.20;
    if (canDunk) {
      return {
        name: 'dunk', variant: direction === 'down' ? 'dunk2' : 'dunk1',
        spec: FINISH[direction === 'down' ? 'dunk2' : 'dunk1'],
        hand: sideHand, requestedHand: sideHand,
        power: drive.dRim < 2.5 && this.stamina > 0.5,
        blocked: this.lanePathBlocked(this.gameRef?.otherPlayer(this), 0.82),
        direction,
      };
    }

    const variant = direction === 'down' ? 'floater'
      : direction === 'up' ? 'fingerroll' : 'layup';
    return {
      name: 'layup', variant, spec: FINISH[variant], hand: sideHand,
      requestedHand: sideHand, power: false,
      blocked: this.lanePathBlocked(this.gameRef?.otherPlayer(this), 0.92),
      direction,
    };
  }

  commitDirectionalShot(direction, drive, chosen = null) {
    if (!this.hasBall || this.action) return false;
    this.moveAnim = null;
    this.skillPath = null;
    this.moveLock = 0;
    this.burstDrive = null;
    this.gatherAction = null;
    this.dribbleEnded = true;
    const plan = chosen ?? this.directionalShotPlan(direction, drive);
    if (plan.name !== 'shot') {
      return this.startLayupOrDunk(drive, true, null, plan, false);
    }

    const spec = plan.spec;
    const side = direction === 'left' ? -1 : direction === 'right' ? 1 : 0;
    const lateral = side * (direction === 'left' || direction === 'right'
      ? SHOT_HOP_TRAVEL.lateral : 0);
    const forward = direction === 'down' ? -SHOT_HOP_TRAVEL.stepback
      : direction === 'up' ? SHOT_HOP_TRAVEL.pullup : SHOT_HOP_TRAVEL.settle;
    const hopDur = Math.max(0.18, jumpFrac(spec) * spec.dur * 0.92);
    this.startSkillPath('shotHop', side || 1, hopDur, Math.abs(lateral), forward);
    this.vel.set(0, 0, 0);
    this.action = {
      name: 'shot', t: 0, dur: spec.dur, variant: plan.variant,
      skillDir: direction, released: false, chargeMode: true,
      perfectT: spec.perfectT, releasedAt: null,
      moveScale: 0, jumpAt: jumpFrac(spec), jumped: false,
      jumpH: spec.jump * lerp(0.82, 1, this.stamina),
      drift: 0, preGatherDribbleStarted: this.dribbleStarted,
    };
    this.posting = false;
    this.moveLock = spec.dur * 0.9;
    return true;
  }

  /**
   * Which jumper this is. Every branch here is a situation a viewer can read
   * off the screen before the animation plays — that is the test for whether
   * the choice is worth making.
   */
  pickShotVariant() {
    const dRim = this.distToRim();
    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (this.posting) return dRim < 3.8 ? 'hook' : 'turnaround';
    if (this.sinceCatch < 0.55 && speed < 2.0) return 'catchshoot';
    if (speed > 2.4) return 'pullup';
    return 'jumpshot';
  }

  /** true if the defender is standing in the driving lane to the rim */
  lanePathBlocked(def, clearance = 1.0) {
    if (!def) return false;
    const toRim = this._tmp.subVectors(COURT.rimCenter, this.pos).setY(0);
    const len = toRim.length();
    if (len < 1e-3) return false;
    toRim.divideScalar(len);
    const toDef = this._tmp2.subVectors(def.pos, this.pos).setY(0);
    const along = toDef.dot(toRim);
    if (along < -0.3 || along > len + 0.5) return false;
    const lateral = Math.hypot(toDef.x - toRim.x * along, toDef.z - toRim.z * along);
    return lateral < clearance;
  }

  chooseFinish(drive) {
    const dRim = drive?.dRim ?? this.distToRim();
    const game = this.gameRef;
    const def = game.otherPlayer(this);
    const blocked = this.lanePathBlocked(def, 1.0);
    const speed = drive?.speed ?? Math.hypot(this.vel.x, this.vel.z);
    const sprinting = drive?.sprinting ?? !!this.intentOffense?.sprint;
    // A dunk is an explicit sprinting attack, never an automatic reward for
    // merely standing near the rim.
    if (dRim < 4.35 && speed > 3.15 && sprinting && this.stamina > 0.22 && !blocked) {
      const power = dRim < 2.3 && this.stamina > 0.55;
      // Use the long one-foot pose for a fast break and the compact pose for a
      // lower-speed finish.
      const variant = speed > 3.7 ? 'dunk1' : 'dunk2';
      const spec = FINISH[variant];
      return { name: 'dunk', variant, spec, power, hand: this.dribbleHand, blocked };
    }

    const variant = blocked && speed > 3.2 ? 'eurostep'
      : (!blocked && dRim < 2.6 ? 'fingerroll' : 'layup');
    return {
      name: 'layup', variant, spec: FINISH[variant], power: false,
      hand: this.dribbleHand, blocked,
    };
  }

  finishRootPlan(plan, drive) {
    const rim = COURT.rimCenter;
    const away = this._tmp.set(this.pos.x - rim.x, 0, this.pos.z - rim.z);
    if (away.lengthSq() < 1e-5) away.set(0, 0, 1);
    away.normalize();
    const side = plan.direction === 'left' ? -1 : plan.direction === 'right' ? 1
      : plan.variant === 'eurostep' ? (this.dribbleHand === 'Left' ? -1 : 1) : 0;
    const lateral = this.rightVec(this._tmp2).multiplyScalar(side * (plan.direction ? 0.42 : 0.34));
    const takeoffDist = plan.name === 'dunk' ? 1.30 : 1.24;
    const releaseDist = plan.name === 'dunk' ? 0.36 : 0.54;
    const rootStart = this.pos.clone();
    const takeoffTarget = drive.dRim > takeoffDist
      ? new THREE.Vector3(rim.x, 0, rim.z).addScaledVector(away, takeoffDist).add(lateral)
      : rootStart.clone();
    const rootTarget = new THREE.Vector3(rim.x, 0, rim.z)
      .addScaledVector(away, releaseDist).addScaledVector(lateral, 0.35);
    const groundDist = rootStart.distanceTo(takeoffTarget);
    const approachSpeed = Math.max(drive.speed, drive.sprinting ? 5.8 : 4.6);
    const approachDur = clamp(groundDist / approachSpeed, 0.18, 0.62);
    const jumpH = plan.spec.jump * (plan.name === 'dunk' ? lerp(0.8, 1, this.stamina) : 1);
    const airToApex = Math.sqrt(2 * jumpH / G);
    const dur = Math.max(plan.spec.dur, (approachDur + airToApex) / plan.spec.perfectT);
    return {
      rootStart, takeoffTarget, rootTarget, jumpH, dur,
      jumpAt: approachDur / dur,
      entrySpeed: drive.speed,
    };
  }

  startLayupOrDunk(driveSnapshot = null, chargeMode = true, gatherSnapshot = null, chosen = null,
      requireHoldCommit = false) {
    const drive = {
      dRim: driveSnapshot?.dRim ?? this.distToRim(),
      speed: driveSnapshot?.speed ?? Math.hypot(this.vel.x, this.vel.z),
      towardRim: driveSnapshot?.towardRim ?? 1,
      sprinting: driveSnapshot?.sprinting ?? !!this.intentOffense?.sprint,
    };
    const plan = chosen ?? this.chooseFinish(drive);
    const root = this.finishRootPlan(plan, drive);

    if (plan.name === 'dunk') {
      const { variant, spec, power } = plan;
      const dunkHand = plan.hand ?? this.dribbleHand;
      this.action = {
        name: 'dunk', t: 0, dur: root.dur, variant,
        hand: dunkHand,
        requestedHand: plan.requestedHand ?? dunkHand,
        skillDir: plan.direction ?? null,
        released: false, power,
        // Takeoff timing is derived from the release phase and jump height so
        // the plant stays grounded and the palm reaches the rim at the apex.
        perfectT: spec.perfectT,
        jumpAt: root.jumpAt,
        jumped: false, jumpH: root.jumpH,
        moveScale: 0,
        rootStart: root.rootStart,
        takeoffTarget: root.takeoffTarget,
        rootTarget: root.rootTarget,
        awaitingHold: requireHoldCommit,
        previewT: 0,
        entrySpeed: root.entrySpeed,
      };
      if (gatherSnapshot?.t) {
        this.action.t = Math.min(gatherSnapshot.t, this.action.dur * Math.max(0.05, this.action.jumpAt - 0.025));
      }
      this.moveLock = root.dur + (requireHoldCommit ? 0.18 : 0);
      if (requireHoldCommit) this.vel.set(0, 0, 0);
      return true;
    }

    const { variant, spec } = plan;
    this.action = {
      name: 'layup', t: 0, dur: root.dur, variant,
      hand: plan.hand, requestedHand: plan.requestedHand ?? plan.hand,
      skillDir: plan.direction ?? null,
      released: false, chargeMode,
      perfectT: spec.perfectT, releasedAt: null,
      jumpAt: root.jumpAt, jumped: false, jumpH: root.jumpH,
      moveScale: 0,
      rootStart: root.rootStart,
      takeoffTarget: root.takeoffTarget,
      rootTarget: root.rootTarget,
      awaitingHold: requireHoldCommit,
      previewT: 0,
      entrySpeed: root.entrySpeed,
    };
    if (gatherSnapshot?.t) {
      this.action.t = Math.min(gatherSnapshot.t, this.action.dur * Math.max(0.05, this.action.jumpAt - 0.025));
    }
    this.moveLock = root.dur + (requireHoldCommit ? 0.18 : 0);
    if (requireHoldCommit) this.vel.set(0, 0, 0);
    return true;
  }

  /** put-back: an offensive rebound taken straight back up */
  startTipIn() {
    const spec = FINISH.tipin;
    this.action = {
      name: 'layup', t: 0, dur: spec.dur, variant: 'tipin',
      hand: this.dribbleHand, released: false,
      jumpAt: 0, jumped: false, jumpH: spec.jump,
    };
    this.moveLock = spec.dur;
    return true;
  }

  /**
   * Defence: jump contest. Reaching across for the swat and going straight up
   * are different bets — the swat can block the ball, the vertical cannot but
   * cannot foul either — so the choice is made here and shown on screen.
   */
  startContest() {
    if (this.airborne || this.action) return false;
    const opp = this.gameRef?.otherPlayer(this);
    const ball = this.gameRef?.ball;
    const targetAction = opp?.action?.name;
    const liveAttempt = ['shot', 'layup', 'dunk'].includes(targetAction) || ball?.state === 'shot';
    const behind = !!opp && this.distToRim() > opp.distToRim() + 0.12;
    const style = targetAction === 'dunk' ? 'dunk'
      : behind && ['layup', 'dunk'].includes(targetAction) ? 'chase'
        : targetAction === 'layup' ? 'layup' : 'front';
    const swat = liveAttempt || (!!opp && opp.pos.distanceTo(this.pos) < 1.75);
    const jumpBase = style === 'dunk' ? 1.42 : style === 'chase' ? 1.34 : 1.18;
    const jumpH = jumpBase * lerp(0.85, 1, this.stamina);
    // Match the source game's time-to-shot scheduling: plant early enough that
    // the blocking hand reaches its apex at the attacker's release, rather than
    // jumping immediately and descending before a long layup gather finishes.
    const targetReleaseIn = opp?.action
      ? Math.max(0, (opp.action.perfectT ?? 0.68) * opp.action.dur - opp.action.t)
      : 0;
    const airToApex = Math.sqrt(2 * jumpH / G);
    const jumpDelay = liveAttempt
      ? clamp(targetReleaseIn - airToApex * 0.96, 0.055, 0.30)
      : 0.07;
    const jumpPhase = jumpDelay / 0.92;
    let hand = 'Right';
    if (ball && this.rig.palmPosition) {
      const left = this.rig.palmPosition('Left', this._tmp);
      const right = this.rig.palmPosition('Right', this._tmp2);
      hand = left.distanceTo(ball.pos) < right.distanceTo(ball.pos) ? 'Left' : 'Right';
    }
    this.action = {
      name: 'contest', t: 0, dur: 0.92, swat, hand, style,
      blockWindow: [Math.max(0.16, jumpPhase + 0.06), Math.min(0.96, jumpPhase + 0.78)],
      jumpAt: jumpPhase, jumped: false, jumpH,
      rootStart: this.pos.clone(), assistUsed: 0,
      assistMax: style === 'chase' ? 1.65 : style === 'dunk' ? 1.40 : 0.62,
      // A chase-down inherits a real sprint and may follow the finish corridor.
      // The short cap used by a stationary front contest would stop that
      // momentum in mid-air a metre behind the ball.
      maxRootTravel: style === 'chase' ? 3.60 : style === 'dunk' ? 3.20 : 0.82,
    };
    this.moveLock = 0.55;
    this.stamina = Math.max(0, this.stamina - 0.1);
    return true;
  }

  startSteal(hand) {
    if (this.stealCooldown > 0 || this.action) return false;
    this.action = { name: 'steal', t: 0, dur: 0.42, hand: hand ?? (Math.random() < 0.5 ? 'Left' : 'Right') };
    this.stealCooldown = 1.6;
    this.moveLock = 0.3;
    return true;
  }

  startRebound() {
    if (this.airborne || this.action) return false;
    // Rebounding is a maximum vertical effort. At the previous 1.24 m target
    // the animated palm peaked only 5 cm above the rim, then dropped before the
    // body's apex. Keep even a tired jump competitive and give a fresh player
    // a clearly readable high-board leap.
    const jumpH = 1.78 * lerp(0.91, 1, this.stamina);
    const opp = this.gameRef?.otherPlayer(this);
    // a rebound with a body on you is a different animation from a clean one
    const contested = !!opp && opp.pos.distanceTo(this.pos) < 1.4;
    const ball = this.gameRef?.ball;
    const left = this.rig.palmPosition?.('Left', this._tmp);
    const right = this.rig.palmPosition?.('Right', this._tmp2);
    const catchHand = ball && left && right && left.distanceTo(ball.pos) < right.distanceTo(ball.pos)
      ? 'Left' : 'Right';
    const dur = 1.28;
    this.action = {
      name: 'rebound', t: 0, dur, contested,
      sealed: this.boxingOut, catchHand,
      rootStart: this.pos.clone(),
      assistUsed: 0,
      assistMax: contested ? 0.65 : 0.85,
      maxRootTravel: contested ? 0.92 : 1.12,
      // Preserve a short visible plant, then leave the floor within five input
      // frames. `dur` covers the complete higher flight so the full-body take
      // cannot disappear into an idle pose before landing.
      jumpAt: 0.08 / dur, jumped: false, jumpH,
      prevCatchPalm: null,
      prevCatchBall: null,
    };
    this.moveLock = 0.3;
    return true;
  }

  /** shot fake: the defender's problem, not an animation flourish */
  startPumpFake(allowDribbleAfter = !this.dribbleStarted) {
    if (!this.hasBall || this.action || this.airborne || this.moveLock > 0) return false;
    const ball = this.gameRef?.ball;
    if (ball?.state === 'dribble' && ball.dribble?.holder === this) {
      this.moveAnim = null;
      this.skillPath = null;
      this.burstDrive = null;
      this.moveLock = 0;
      this.gatherAction = { kind: 'pumpfake', t: 0, allowDribbleAfter };
      ball.dribble.quickReturn = true;
      ball.dribble.quickReturnArmedPhase = null;
      return true;
    }
    this.gatherAction = null;
    // A fake from triple threat does not consume the dribble. A fake after a
    // live dribble is a gather and therefore does. Those are different rule
    // states even though they use the same authored pump-fake take.
    this.dribbleEnded = !allowDribbleAfter;
    if (allowDribbleAfter) this.dribbleStarted = false;
    const dur = 0.62;
    this.moveAnim = {
      name: 'pumpfake', t: 0, dur, dir: 0, baitResolved: false,
      allowDribbleAfter,
    };
    this.lastMove = 'pumpfake';
    this.sinceMove = 0;
    this.moveLock = dur;
    this.vel.x = 0;
    this.vel.z = 0;
    this.stamina = Math.max(0, this.stamina - 0.02);
    return true;
  }

  /** Release the current shot gather while its owned bounce returns. */
  releaseGatherShot() {
    if (this.gatherAction?.kind !== 'shot') return false;
    this.gatherAction.chargeMode = false;
    return true;
  }

  resolveGatherAction() {
    const q = this.gatherAction;
    if (!q) return;
    this.gatherAction = null;
    if (q.kind === 'pumpfake') {
      this.startPumpFake(!!q.allowDribbleAfter);
      if (this.moveAnim?.name === 'pumpfake') {
        this.moveAnim.t = Math.min(q.t ?? 0, this.moveAnim.dur * 0.32);
      }
    } else if (q.kind === 'directionalShot') {
      this.commitDirectionalShot(q.direction, q.drive, q.preview);
      if (q.chargeMode === false) this.releaseDirectionalShot();
    } else {
      this.startShot(q.chargeMode !== false, q.drive, q, !!q.requireHoldCommit);
    }
  }

  startPass(target) {
    if (!this.hasBall || this.action || !target) return false;
    this.dribbleEnded = true;
    this.gatherAction = null;
    this.action = { name: 'pass', t: 0, dur: 0.72, target, released: false };
    this.moveLock = 0.5;
    return true;
  }

  /** Turn the first instant of a shot gather into a pump fake on a light tap. */
  cancelGatherToPumpFake() {
    const a = this.action;
    if (!a || !['shot', 'layup', 'dunk'].includes(a.name) || a.released || a.jumped) return false;
    this.action = null;
    this.moveLock = 0;
    return this.startPumpFake(!a.preGatherDribbleStarted);
  }

  updateAction(dt, ball, world) {
    const a = this.action;
    // A finish reacts visually on key-down, but its travelling root path does
    // not become legal until the same 160 ms input gate that distinguishes a
    // held shot from a tap. A tap can therefore turn into a planted pump fake
    // without first receiving a free step toward the basket.
    if (a.awaitingHold) {
      a.previewT = (a.previewT ?? 0) + dt;
      if (this.intentOffense?.shootCommitted || this.intentOffense?.shootReleasedCommitted) {
        a.awaitingHold = false;
      }
    }
    if (!a.awaitingHold) a.t += dt;
    const t01 = clamp(a.t / a.dur, 0, 1);

    switch (a.name) {
      case 'shot': {
        this.jumpWhenDue(a, t01);
        // The ball rides the animated hands: two of them through the gather,
        // the shooting hand alone once the set point is reached. Driving it
        // from a computed anchor instead would only re-create, worse, the
        // thing the take already does.
        if (!a.released) {
          ball.state = 'held';
          ball.holder = this;
          const grip = t01 < a.perfectT * 0.6
            ? this.holdPoint(this._tmp)
            : this.shotSetPoint(this._tmp);
          ball.updateAttach(grip, dt);
        }

        // charge / release timing
        const it = this.intentOffense;
        if (it?.shootReleased) a.releaseRequested = true;
        const wantRelease = a.chargeMode
          ? (a.releaseRequested && t01 >= 0.38) || a.t > a.dur * Math.min(0.94, a.perfectT + 0.14)
          : a.t >= a.dur * a.perfectT;

        if (!a.released && wantRelease) {
          // RELEASE
          const timingErr = Math.abs(a.t / a.dur - a.perfectT / 1.0) * this.shotWindowScale();
          const relT = a.t / a.dur;
          const err = Math.abs(relT - a.perfectT);
          const timingQ = releaseTiming(err, 'jump').quality;
          a.timingQ = timingQ;
          a.releasedAt = relT;
          a.released = true;
          this.releaseShot(ball, world, timingQ, relT < a.perfectT ? 'EARLY' : 'LATE');
          void timingErr;
        }
        if (a.t >= a.dur) {
          this.action = null;
        }
        break;
      }

      case 'layup': {
        this.jumpWhenDue(a, t01);
        if (!a.released) {
          ball.state = 'held';
          ball.holder = this;
          ball.updateAttach(this.finishBallPoint(a, t01, this._tmp), dt);
        }
        const it = this.intentOffense;
        if (it?.shootReleased) a.releaseRequested = true;
        const perfectT = a.perfectT ?? (FINISH[a.variant] ?? FINISH.layup).perfectT;
        const wantRelease = a.chargeMode
          ? (a.releaseRequested && t01 >= 0.38) || t01 >= Math.min(0.95, perfectT + 0.14)
          : t01 >= perfectT;
        if (!a.released && wantRelease) {
          const err = Math.abs(t01 - perfectT);
          const timingQ = releaseTiming(err, 'layup').quality;
          a.released = true;
          a.timingQ = timingQ;
          a.releasedAt = t01;
          this.releaseLayup(ball, world, timingQ);
        }
        if (a.t >= a.dur + 0.1) this.action = null;
        break;
      }

      case 'dunk': {
        this.jumpWhenDue(a, t01);
        if (!a.released) {
          ball.state = 'held';
          ball.holder = this;
          ball.updateAttach(this.finishBallPoint(a, t01, this._tmp), dt);
        }
        if (!a.released && t01 >= (FINISH[a.variant] ?? FINISH.dunk2).perfectT) {
          a.released = true;
          this.releaseDunk(ball, world);
          // big one: hang on the rim for a beat before dropping
          if (a.power) this.hangT = 0.2;
        }
        if (a.t >= a.dur + 0.1) this.action = null;
        break;
      }

      case 'contest': {
        this.jumpWhenDue(a, t01);
        const approachAt = Math.max(0.04, (a.jumpAt ?? 0.08) - 0.10);
        if (a.swat && !a.blocked && t01 >= approachAt && t01 <= a.blockWindow[1]) {
          // A chase/front block travels only through the active reach. It can
          // close the final gap, but cannot home across the paint.
          const palm = this.rig.palmPosition?.(a.hand, this._tmp);
          const rootGap = Math.hypot(ball.pos.x - this.pos.x, ball.pos.z - this.pos.z);
          const dx = palm ? ball.pos.x - palm.x : 0;
          const dz = palm ? ball.pos.z - palm.z : 0;
          const gap = Math.hypot(dx, dz);
          const remaining = Math.max(0, a.assistMax - a.assistUsed);
          const chase = a.style === 'chase' || a.style === 'dunk';
          const approachSpeed = a.style === 'chase' ? 8.2 : a.style === 'dunk' ? 7.4 : 5.2;
          const step = rootGap < (chase ? 2.85 : 1.92)
            ? Math.min(gap, approachSpeed * dt, remaining) : 0;
          if (gap > 1e-4 && step > 0) {
            this.pos.x += dx * step / gap;
            this.pos.z += dz * step / gap;
            a.assistUsed += step;
          }
        }
        if (a.t >= a.dur) this.action = null;
        break;
      }
      case 'steal': {
        if (a.t >= a.dur) this.action = null;
        break;
      }
      case 'rebound': {
        this.jumpWhenDue(a, t01);
        if (!this.hasBall) {
          // The take decides the arm pose. Move the athlete so its authored
          // catching hands intercept the live ball instead of waving a metre
          // in front of it. This is root positioning, not a limb overlay.
          const palm = this.reboundCatchPoint(this._tmp);
          const dx = ball.pos.x - palm.x, dz = ball.pos.z - palm.z;
          const dist = Math.hypot(dx, dz);
          const hitBasket = ball.state === 'shot' && ball.shot &&
            (ball.shot.rimHits ?? 0) + (ball.shot.boardHits ?? 0) > 0;
          const liveBoard = (hitBasket && ball.vel.y < 0) || ball.state === 'loose';
          const rootGap = Math.hypot(ball.pos.x - this.pos.x, ball.pos.z - this.pos.z);
          const remaining = Math.max(0, (a.assistMax ?? 0) - (a.assistUsed ?? 0));
          // A small catch step closes the last hand-width near a live board.
          // It cannot chase a remote ball: the old unbounded 6 m/s correction
          // could drag an athlete several metres through the air.
          // Do not spend the whole catch budget while the source take is still
          // planting its feet. Follow only through the authored reach window.
          const inReachWindow = t01 >= 0.10 && t01 <= 0.62;
          const step = liveBoard && inReachWindow && rootGap < 1.42
            ? Math.min(dist, 4.0 * dt, remaining) : 0;
          if (dist > 1e-4 && step > 0) {
            this.pos.x += dx * step / dist;
            this.pos.z += dz * step / dist;
            a.assistUsed += step;
          }
        }
        if (this.hasBall) ball.updateAttach(this.reboundCatchPoint(this._tmp), dt);
        if (a.t >= a.dur) this.action = null;
        break;
      }
      case 'pickup': {
        if (this.hasBall) {
          ball.updateAttach(this.pickupContactPoint(this._tmp), dt);
        } else {
          // Follow a rolling loose ball through the reach instead of planting
          // the feet and waving at where it used to be.
          const to = this._tmp.subVectors(ball.pos, this.pos).setY(0);
          const dist = to.length();
          if (dist > 0.22) {
            const step = Math.min(dist - 0.22, 3.6 * dt);
            this.pos.addScaledVector(to, step / Math.max(dist, 1e-4));
          }
        }
        if (a.t >= a.dur) this.action = null;
        break;
      }
      case 'pass': {
        if (!a.released) {
          ball.state = 'held';
          ball.holder = this;
          ball.updateAttach(this.passContactPoint(this._tmp), dt);
        }
        if (!a.released && t01 >= 0.42) {
          a.released = true;
          this.hasBall = false;
          ball.launchPass(a.target.holdPoint(this._tmp2).clone(), 9.2);
          world.passed = true;
          world.hud.msg('', '', 0.01);
        }
        if (a.t >= a.dur) this.action = null;
        break;
      }
    }
  }

  shotWindowScale() { return 1; }

  /** Steer through the authored finish corridor without overwriting world position. */
  steerFinishVelocity(dt, a) {
    if (!a.takeoffTarget || !a.rootTarget || a.released) return;
    const t01 = clamp(a.t / Math.max(a.dur, 1e-4), 0, 1);
    const jumpAt = Math.max(0.01, a.jumpAt ?? 0.2);
    const releaseAt = Math.max(jumpAt + 0.01, a.perfectT ?? 0.7);
    const inAirCorridor = a.jumped || t01 >= jumpAt;
    const target = inAirCorridor ? a.rootTarget : a.takeoffTarget;
    const phaseEnd = inAirCorridor ? releaseAt : jumpAt;
    const remaining = Math.max(dt, (phaseEnd - t01) * a.dur);
    const desired = this._tmp.subVectors(target, this.pos).setY(0);
    const distance = desired.length();
    if (distance < 0.015) {
      this.vel.x = 0;
      this.vel.z = 0;
      return;
    }
    const requestedSpeed = distance / remaining;
    const speedCap = inAirCorridor ? 7.2 : Math.max(4.8, (a.entrySpeed ?? 4.8) * 1.08);
    desired.multiplyScalar(Math.min(speedCap, requestedSpeed) / distance);
    const dvx = desired.x - this.vel.x;
    const dvz = desired.z - this.vel.z;
    const delta = Math.hypot(dvx, dvz);
    const maxDelta = (inAirCorridor ? 24 : 30) * dt;
    if (delta > maxDelta) {
      this.vel.x += dvx / delta * maxDelta;
      this.vel.z += dvz / delta * maxDelta;
    } else {
      this.vel.x = desired.x;
      this.vel.z = desired.z;
    }
  }

  /**
   * Leave the ground when the take does, not when the button was pressed.
   * `jumpAt` is set so the apex of the leap arrives on the release, which is
   * the only way the ball can go up out of a hand that is at full extension.
   */
  jumpWhenDue(a, t01) {
    if (a.jumped || a.jumpAt == null || t01 < a.jumpAt) return;
    a.jumped = true;
    this.vy = Math.sqrt(2 * G * (a.jumpH ?? 0.5));
    this.airborne = true;
    this.jumpTargetH = a.jumpH ?? 0.5;
    // a step-back or a fade buys its separation on the push-off
    if (a.drift) {
      const away = this.forward(this._tmp).multiplyScalar(-a.drift);
      this.vel.x += away.x; this.vel.z += away.z;
    }
  }

  /** The procedural shooting hand's release point. */
  shotSetPoint(out) {
    if (this.rig.palmPosition) return this.rig.palmPosition(this.shootHand, out);
    const s = this.dribbleHand === 'Left' ? -1 : 1;
    return this.localToWorld(s * 0.16, 1.98 + this.y * 0, 0.16, out);
  }

  /** where the ball sits through a layup or a dunk */
  finishBallPoint(a, t01, out) {
    if (this.rig.palmPosition) {
      if (a.name === 'dunk') return this.rig.palmPosition(a.hand, out);
      // two hands until the gather is done, then the finishing hand
      if (t01 < 0.3) return this.holdPoint(out);
      return this.rig.palmPosition(a.hand === 'Left' ? 'Left' : 'Right', out);
    }
    const s = a.hand === 'Left' ? -1 : 1;
    const rise = a.name === 'dunk' ? 1.1 + t01 * 1.2 : 1.0 + t01 * 1.1;
    return this.localToWorld(s * 0.21, rise + this.y, 0.27, out);
  }

  releaseShot(ball, world, timingQ, missLabel) {
    const dRim = this.distToRim();
    const three = isBeyondArc(this.pos.x, this.pos.z);
    const points = three ? 3 : 2;

    // contest
    const def = world.otherPlayer(this);
    let contest = 0;
    if (def) {
      const d = def.pos.distanceTo(this.pos);
      const toRim = this._tmp.subVectors(COURT.rimCenter, this.pos).setY(0).normalize();
      const toDef = this._tmp2.subVectors(def.pos, this.pos).setY(0).normalize();
      const between = toDef.dot(toRim);
      const defJump = def.airborne && def.action?.name === 'contest' ? 1 : 0.55;
      if (d < 2.4 && between > 0.35) {
        contest = clamp((2.4 - d) / 2.4, 0, 1) * 0.75 * defJump;
      }
    }

    // Fresh legs must not be a penalty. The previous inverse multiplier gave a
    // fully rested shooter 0.75x accuracy and an exhausted one 1.0x.
    const fatigue = lerp(0.78, 1, this.stamina);
    const base = clamp(1.02 - dRim * 0.052, 0.36, 0.94);
    const moving = Math.hypot(this.vel.x, this.vel.z) > 3 ? 0.9 : 1;
    let q = base * releaseMakeMultiplier(timingQ) * (1 - contest * 0.55) * fatigue * moving;
    q = clamp(q, 0.005, 0.96);

    // PERFECT is a gameplay contract, not green-coloured probability. A real
    // block can still cancel the shot in Game.resolveBlock(), but an unblocked
    // release in the exact window must follow a make trajectory every time.
    const made = timingQ >= 1 || Math.random() < q;
    const rc = COURT.rimCenter;
    let target = new THREE.Vector3(rc.x, rc.y, rc.z);
    if (!made) {
      // pick a miss point
      const ang = rand(0, Math.PI * 2);
      const redRelease = timingQ < 0.55;
      // A red release is a front-iron/short brick. Sending a known miss behind
      // the cylinder let the backboard return roughly one fifth of them into
      // the hoop, contradicting the timing result players had just earned.
      if (redRelease) {
        const rr = rand(COURT.rimRadius * 0.92, COURT.rimRadius * 1.28);
        target = new THREE.Vector3(
          rc.x + rand(-COURT.rimRadius * 0.42, COURT.rimRadius * 0.42),
          rc.y + 0.03,
          rc.z + rr + 0.055,
        );
      } else {
        // Non-red misses stay near the iron so decent timing can still produce
        // believable rattles and occasional physical bounces.
        const rr = rand(COURT.rimRadius * 0.96, COURT.rimRadius * 1.32);
        const bias = Math.random();
        if (bias < 0.45) {
        // short
          target = new THREE.Vector3(rc.x + rand(-0.08, 0.08), rc.y + 0.05, rc.z + rr + 0.05);
        } else if (bias < 0.8) {
          target = new THREE.Vector3(rc.x + Math.cos(ang) * rr, rc.y + 0.03, rc.z + Math.sin(ang) * rr);
        } else {
          // long — off back iron
          target = new THREE.Vector3(rc.x + rand(-0.1, 0.1), rc.y + 0.25, rc.z - rr - 0.02);
        }
      }
    }

    // release from set point
    const sp = this.shotSetPoint(this._tmp);
    ball.pos.copy(sp);
    ball.launchShot(this, q, target, clamp(1.05 + dRim * 0.09, 1.1, 1.9), points, made);
    ball.lastTouch = this;
    this.hasBall = false;
    this.followT = 0.3;
    world.onShotReleased(this, q, timingQ, missLabel, points, made);
  }

  releaseLayup(ball, world, timingQ = 1) {
    const rc = COURT.rimCenter;
    const def = world.otherPlayer(this);
    let contest = 0;
    if (def) {
      const d = def.pos.distanceTo(this.pos);
      contest = clamp((1.8 - d) / 1.8, 0, 1) * (def.airborne ? 1 : 0.4);
    }
    const q = clamp((0.82 - contest * 0.5 - Math.max(0, this.distToRim() - 2.5) * 0.1) *
      (0.58 + 0.42 * timingQ), 0.12, 0.94);
    const made = timingQ >= 1 || Math.random() < q;
    const hand = this.action.hand === 'Left' ? 'Left' : 'Right';
    const s = hand === 'Left' ? -1 : 1;
    const target = new THREE.Vector3(rc.x, rc.y, rc.z);
    if (!made) {
      const ang = rand(0, Math.PI * 2);
      const rr = rand(0.14, 0.26);
      target.x += Math.cos(ang) * rr;
      target.z += Math.sin(ang) * rr;
    } else {
      target.x += s * 0.04;
    }
    const rel = this.localToWorld(s * 0.22, 1.65 + this.y, 0.30, this._tmp);
    ball.pos.copy(rel);
    const glassFinish = ['left', 'right'].includes(this.action.skillDir);
    if (glassFinish) ball.launchBankShot(this, q, target, 2, made);
    else ball.launchShot(this, q, target, 0.55, 2, made);
    ball.lastTouch = this;
    this.hasBall = false;
    world.onShotReleased(this, q, timingQ, '', 2, made, true);
  }

  releaseDunk(ball, world) {
    const rc = COURT.rimCenter;
    const hand = this.action.hand === 'Left' ? 'Left' : 'Right';
    const s = hand === 'Left' ? -1 : 1;
    // Release from the real finishing palm. The gather has already carried the
    // player's root into the rim corridor; moving the ball to an absolute rim
    // coordinate here was the visible teleport that made a dunk look ball-less.
    const rel = this.localToWorld(s * 0.18, 1.92 + this.y, 0.26, new THREE.Vector3());
    ball.pos.copy(rel);
    ball.state = 'shot';
    ball.holder = null;
    // Solve the below-rim target from the real (offset) palm so the ball centre
    // crosses the rim plane at the rim centre. Reusing the hand-side offset
    // below the hoop left the centre 13-14 cm off axis — enough for a size-7
    // ball to hit the inner iron and turn a visual dunk into a miss.
    const throughY = rc.y - 0.34;
    const planeT = clamp((rel.y - rc.y) / Math.max(0.05, rel.y - throughY), 0.25, 0.9);
    const through = new THREE.Vector3(
      rel.x + (rc.x - rel.x) / planeT,
      throughY,
      rel.z + (rc.z - rel.z) / planeT,
    );
    const slamT = 0.13;
    ball.vel.subVectors(through, rel).divideScalar(slamT);
    ball.spin.set(0, 0, 0);
    ball.shot = {
      shooter: this, quality: 1, points: 2, releasePos: rel.clone(),
      scored: false, scoreCandidate: false, dunk: true, rimHits: 0, boardHits: 0,
      intendedMake: true,
    };
    ball.lastShotTeam = this.team;
    ball.possessionCause = 'shot';
    ball.clearExemptTeam = null;
    ball.lastTouch = this;
    this.hasBall = false;
    world.onShotReleased(this, 1, 1, '', 2, true, true);
    world.onDunk(this);
  }

  onLand(ball, world) {
    // Let the defensive stance take over on the exact landing frame so the
    // recovery pose cannot drive either foot through the court.
    if (this.action?.name === 'contest') this.action = null;
    // landing recovery
    if (this.action && ['shot', 'layup', 'dunk', 'contest', 'rebound'].includes(this.action.name)) {
      this.action.t = Math.max(this.action.t, this.action.dur * 0.78);
    }
    this.moveLock = Math.max(this.moveLock, 0.12);
    // 0.25 s absorb step on every landing
    this.landRecover = 0.25;
    void ball; void world;
  }

  // ------------------------------------------------------------ possession

  gainPossession(ball) {
    const wasAirborne = this.airborne;
    this.hasBall = true;
    this.clearedBall = this.distToRim() > COURT.threeR + 0.3;
    this.dribbleHand = Math.random() < 0.5 ? 'Left' : 'Right';
    this.dribbleStarted = false;
    this.dribbleTimer = 0.24;
    this._heldFor = 0;
    this.gatherAction = null;
    this.dribbleEnded = false;
    this.catchHeight = 0.8;
    this.hesitation = 0;
    this.posting = false;
    this.skillPath = null;
    this.burstDrive = null;
    // the gather itself is worth showing; it is also what a catch-and-shoot
    // keys off, so the timer outlives the pose
    this.catchT = 0.34;
    this.sinceCatch = 0;
    // an offensive board taken in the air goes straight back up
    if (wasAirborne && this.distToRim() < 2.4 && this.gameRef?.offense === this) {
      this.startTipIn();
    }
    // Possession changes between player updates. Attach immediately so the
    // pickup frame cannot render the loose ball at its old world position.
    ball.attach(this, this.holdPoint(this._tmp));
    ball.lastTouch = this;
    this.state = 'idle';
  }

  losePossession() {
    this.hasBall = false;
    this.hesitation = 0;
    this.gatherAction = null;
    this.dribbleStarted = false;
    this.dribbleEnded = false;
    this.skillPath = null;
    this.burstDrive = null;
  }

  // ------------------------------------------------------------ animation ctx

  animate(dt, ball, world) {
    this._gripDt = dt;
    const speed = Math.hypot(this.vel.x, this.vel.z);

    // move dir in local space
    const f = this.forward(this._tmp);
    const r = this.rightVec(this._tmp2);
    this._moveLocal.z = damp(this._moveLocal.z, this.vel.dot(f), 8, dt);
    this._moveLocal.x = damp(this._moveLocal.x, this.vel.dot(r), 8, dt);

    // lean from accel
    const acc = this._tmp.copy(this.vel).sub(this._prevVel).divideScalar(Math.max(dt, 1e-4));
    this._prevVel.copy(this.vel);
    this._lean.x = damp(this._lean.x, clamp(acc.dot(f) * 0.012, -0.22, 0.3), 6, dt);
    this._lean.z = damp(this._lean.z, clamp(-acc.dot(r) * 0.012, -0.25, 0.25), 6, dt);

    // gait style
    let gait = 'idle';
    if (this.airborne) gait = 'air';
    else if (speed > 0.4) gait = this.state === 'defense' ? 'slide' : 'run';

    // crouch
    let crouch = 0;
    if (this.state === 'defense') crouch = 0.8;
    if (this.hasBall && !this.isShooting && speed < 1.5) crouch = Math.max(crouch, 0.42);
    if (this.hesitation > 0) crouch = Math.max(crouch, 0.5);
    this.hesitation = Math.max(0, (this.hesitation || 0) - dt);

    // A hard stop is momentum the simulation took away, not a plant explicitly
    // owned by a handle/gather/root path. Cross/BTL/behind deliberately kill
    // sprint velocity before their authored plant; classifying that drop as a
    // stumble made the reaction pose override the requested move completely.
    const ownsPlant = !!(this.action || this.moveAnim || this.skillPath ||
      this.burstDrive || this.gatherAction);
    if (!this.airborne && this._prevSpeed > 4.4 && speed < 1.6 && !ownsPlant) {
      this.stumbleKind = 'hard-stop';
      this.stumbleT = Math.max(this.stumbleT, 0.34);
    }
    const facingRate = angleDelta(this._prevFacing, this.facing) / Math.max(dt, 1e-4);
    this.turnRate = facingRate;
    // Ordinary direction reversal stays part of live dribbling; it must not
    // silently become a gathered pivot and change the settled ball hand.
    this._prevSpeed = speed;
    this._prevFacing = this.facing;

    // ---- pose overlay: the timed action, or whatever short beat is running.
    // `t` is always 0..1 across the beat, keeping the procedural release pose
    // and the scoring window on the same simulation frame.
    let pose = null;
    if (this.action) {
      const a = this.action;
      const t01 = a.awaitingHold
        ? Math.min(0.07, (a.previewT ?? 0) / Math.max(a.dur, 1e-4))
        : clamp(a.t / a.dur, 0, 1);
      switch (a.name) {
        case 'shot': pose = {
          name: 'shot', variant: a.variant, skillDir: a.skillDir,
          t: t01, weight: 1,
        }; break;
        case 'layup': pose = {
          name: 'layup', variant: a.variant, hand: a.requestedHand ?? a.hand,
          skillDir: a.skillDir, t: t01, weight: 1,
        }; break;
        case 'dunk': pose = {
          name: 'dunk', variant: a.variant, hand: a.requestedHand ?? a.hand,
          skillDir: a.skillDir, t: t01, weight: 1,
        }; break;
        case 'contest': pose = {
          name: 'contest', swat: a.swat, hand: a.hand, style: a.style,
          t: t01, weight: 1,
        }; break;
        case 'rebound': {
          // Hold the reach pose for the last few rising frames so the hands and
          // the physics jump crest together.
          const poseT = a.jumped && this.airborne && this.vy > 0
            ? Math.min(t01, 0.46) : t01;
          pose = { name: 'rebound', contested: a.contested, hand: a.catchHand, t: poseT, weight: 1 };
          break;
        }
        case 'pickup': pose = { name: 'pickup', hand: a.hand, t: t01, weight: 1 }; break;
        case 'pass': pose = { name: 'pass', t: t01, weight: 1 }; break;
        case 'steal': pose = { name: 'steal', hand: a.hand, t: t01, weight: 1 }; break;
        default: break;
      }
    } else if (this.celebrateT > 0) {
      this.celebrateT -= dt;
      pose = { name: 'celebrate', alt: this.celebrateAlt, t: 1 - this.celebrateT / 1.2, weight: 1 };
    } else if (this.stumbleT > 0) {
      const reactionDur = this.stumbleKind === 'blocked-back-fall' ? 1.28
        : (this.stumbleKind === 'fall' || this.stumbleKind === 'blocked-fall') ? 1.05 : 0.52;
      pose = {
        name: 'stumble', variant: this.stumbleKind,
        t: 1 - this.stumbleT / reactionDur, weight: 1,
      };
    } else if (this.moveAnim) {
      pose = {
        name: 'dribbleMove', variant: this.moveAnim.name,
        t: this.moveAnim.t / this.moveAnim.dur, weight: 1,
      };
    } else if (['shot', 'directionalShot'].includes(this.gatherAction?.kind) &&
        this.gatherAction.preview?.name === 'shot') {
      const q = this.gatherAction;
      const preview = q.preview;
      // The planted gather begins visibly on the input frame while the owned
      // bounce returns; an airborne finish still waits for palm contact.
      const maxT = 0.16;
      pose = {
        name: preview.name,
        variant: preview.variant,
        hand: preview.requestedHand ?? preview.hand,
        skillDir: q.direction,
        t: Math.min(maxT, (q.t ?? 0) / Math.max(0.8, preview.spec?.dur ?? 1)),
        weight: 1,
      };
    } else if (this.gatherAction?.kind === 'pumpfake') {
      pose = {
        name: 'dribbleMove', variant: 'pumpfake',
        t: Math.min(0.28, (this.gatherAction.t ?? 0) / 0.62), weight: 1,
      };
    } else if (this.catchT > 0) {
      pose = { name: 'catch', t: 1 - this.catchT / 0.34, weight: 1 };
    }

    // hand IK targets
    const handTargets = {};
    const setHand = (side, target, poleLocal, weight = 1, aim = null) => {
      handTargets[side] = {
        target,
        pole: this.localToWorld(poleLocal.x, poleLocal.y, poleLocal.z, new THREE.Vector3()),
        aim, weight,
      };
    };

    if (this.hasBall && !this.isShooting &&
        (!this.action || this.action.name === 'steal' || this.action.name === 'rebound')) {
      const hand = this.dribbleHand;
      const anchor = this.dribbleAnchor(this._tmp, hand);
      let target = this._handTargetR.copy(anchor);

      let contactPress = false;
      if (ball.state === 'dribble' && ball.dribble && ball.pos.distanceTo(this.pos) < 1.8) {
        const pushing = ball.dribble.phase === 'down';
        contactPress = pushing && ball.dribble.contactT < 0.11;
        if (contactPress) {
          // Palm stays on the ball through the downward push, then releases.
          target.copy(ball.pos).add(new THREE.Vector3(0, ball.radius * 0.72, 0));
        } else if (!pushing && ball.pos.distanceTo(anchor) < 0.48) {
          // Receiving hand meets the rising ball instead of waiting at a fixed
          // height for possession to snap on.
          target.copy(ball.pos).add(new THREE.Vector3(0, ball.radius * 0.62, 0));
        }
      }

      // during a move the hand rides the move's own arc
      const mt = this.moveHandTarget();
      let useHand = mt ? mt.hand : hand;
      if (contactPress) useHand = ball.dribble.releaseHand ?? hand;
      else if (ball.state === 'dribble' && ball.dribble?.phase === 'up') useHand = ball.dribble.hand;
      const catching = ball.state === 'dribble' && ball.dribble?.phase === 'up' && ball.pos.distanceTo(anchor) < 0.48;
      if (mt && !contactPress && !catching) target = this._handTargetR.copy(mt.target);

      const s = useHand === 'Left' ? -1 : 1;
      const aim = this._tmp2.copy(ball.pos).sub(target);
      setHand(useHand, target, { x: s * 0.55, y: 1.0, z: -0.3 }, 1,
        aim.lengthSq() > 1e-4 ? aim.normalize().clone() : null);
    }
    if (this.action) {
      const a = this.action;
      if (a.name === 'shot') {
        const t01 = clamp(a.t / a.dur, 0, 1);
        if (!a.released) {
          const p = t01 < 0.42
            ? this.localToWorld(0.1, 1.4, 0.36, new THREE.Vector3())
            : this.shotSetPoint(new THREE.Vector3());
          setHand('Right', p, { x: 0.5, y: 1.5, z: -0.2 });
          setHand('Left', p.clone().add(new THREE.Vector3(-0.14, 0, 0.02)), { x: -0.45, y: 1.5, z: -0.2 });
        } else {
          // Follow-through: the arm stays extended while the wrist snaps down
          // over 0.3 s — the shooter's signature that the ball has gone.
          const s = this.dribbleHand === 'Left' ? -1 : 1;
          const side = this.dribbleHand;
          const k = clamp(1 - this.followT / 0.3, 0, 1);
          const ft = this.localToWorld(s * 0.14, 2.26 - 0.11 * k, 0.34 + 0.07 * k, new THREE.Vector3());
          const below = this.localToWorld(s * 0.16, 1.68 - 0.11 * k, 0.62 + 0.07 * k, new THREE.Vector3());
          setHand(side, ft, { x: s * 0.4, y: 1.9, z: -0.1 }, 1, below.sub(ft).normalize());
        }
      }
      if (a.name === 'dunk' || a.name === 'layup') {
        const hand = (a.hand === 'Left') ? 'Left' : 'Right';
        const s = hand === 'Left' ? -1 : 1;
        const t01 = clamp(a.t / a.dur, 0, 1);
        // ball follows until release, then extend to rim
        let target;
        if (!a.released) {
          target = ball.holder === this
            ? ball.pos.clone()
            : this.localToWorld(s * 0.2, 0.9 + this.y + t01 * 0.9, 0.3, new THREE.Vector3());
        } else {
          const rc = COURT.rimCenter;
          target = new THREE.Vector3(rc.x + s * 0.06, rc.y + 0.1, rc.z + 0.08);
        }
        setHand(hand, target, { x: s * 0.5, y: 1.4, z: -0.3 });
      }
      if (a.name === 'rebound' && !this.hasBall) {
        const hand = a.catchHand === 'Left' ? 'Left' : 'Right';
        const s = hand === 'Left' ? -1 : 1;
        const target = ball.pos.clone().add(new THREE.Vector3(0, -0.07, 0));
        setHand(hand, target, { x: s * 0.48, y: 1.8, z: -0.18 }, 1,
          new THREE.Vector3(0, 1, 0));
      }
      if (a.name === 'pickup' && !this.hasBall) {
        const hand = a.hand === 'Left' ? 'Left' : 'Right';
        const s = hand === 'Left' ? -1 : 1;
        const target = ball.pos.clone().add(new THREE.Vector3(0, ball.radius * 0.35, 0));
        setHand(hand, target, { x: s * 0.55, y: 0.72, z: -0.18 }, 1,
          new THREE.Vector3(0, -1, 0));
      }
    }

    // look target
    let lookTarget = null;
    if (this.isShooting) lookTarget = COURT.rimCenter;
    else if (this.hasBall) lookTarget = this._tmp.set(COURT.rimCenter.x, 2.6, COURT.rimCenter.z);
    else lookTarget = ball.pos;

    // ---- situation the animator needs to pick a stance.
    const opp = world.otherPlayer?.(this) ?? null;
    const dOpp = opp ? opp.pos.distanceTo(this.pos) : 99;
    const ballLive = ball.state === 'dribble' || ball.state === 'held';
    const stance = this.posting ? 'postup'
      : this.boxingOut ? 'boxout'
      // `braceT` is also a short collision speed penalty for the ball-handler.
      // It is not an offensive action; a live handler must not suddenly raise
      // both arms like a screener.
      : (this.braceT > 0 && !this.action && !this.hasBall ? 'brace' : null);
    const lockdown = this.stance && !stance;

    // During a hand change, the player's settled hand intentionally remains
    // the releasing hand until physical catch. Animation must instead follow
    // the hand that owns the current phase of the bounce, or the move ends in
    // a right-hand gait while the ball is already returning to the left.
    const animationBallHand = ball.state === 'dribble' && ball.dribble?.holder === this
      ? (ball.dribble.phase === 'down'
        ? (ball.dribble.releaseHand ?? this.dribbleHand)
        : ball.dribble.hand)
      : this.dribbleHand;

    const ctx = {
      speed, gait, stance, lockdown,
      moveEntrySpeed: this.moveAnim?.entrySpeed ?? speed,
      moveLocal: { x: clamp(this._moveLocal.x / 5, -1, 1), z: clamp(this._moveLocal.z / 5, -1, 1) },
      crouch,
      lean: this._lean,
      pose,
      handTargets,
      lookTarget,
      lookWeight: 1,
      dribbleHand: animationBallHand,
      hasBall: this.hasBall,
      defense: this.state === 'defense',
      // Is the ball still being DRIBBLED, or has it been picked up?
      //
      // Read off the ball, not off the player's action list. Showing a
      // two-hand hold while the ball is still bouncing is a travel on screen,
      // and it is the single easiest way to make a basketball game look like it
      // does not know the rules. `dribbleTimer > 0` is the dwell between
      // bounces — the ball is in the hand but the dribble is not over.
      liveDribble: this.hasBall && this.dribbleStarted && !this.dribbleEnded && this.spinDir === 0 && !this.action &&
        this.gameRef?.state !== 'checkball' &&
        (ball.state === 'dribble' ||
          (ball.state === 'held' && ball.holder === this && this.dribbleTimer > 0)),
      dribbleAirborne: ball.state === 'dribble',
      pressured: this.hasBall && (dOpp < 1.25 || this.shielding),
      sizeup: this.sizeupT > 0,
      tired: this.stamina < 0.28,
      // defence: how the athlete is guarding, which is the whole read on that side
      onBall: !this.hasBall && dOpp < 1.7 && ballLive && !!opp?.hasBall,
      handsUp: this.stance && dOpp >= 1.7,
      reaching: !this.hasBall && dOpp < 1.15 && ball.state === 'dribble' &&
        ball.dribble?.phase === 'down' && this.stealCooldown < 0.6,
      ballInAir: ball.state === 'shot',
      // How closed each hand is, driven by physical ball proximity.
      grip: this.handGrip(ball),
      moveName: this.moveAnim?.name,
      moveDir: this.moveAnim?.dir,
      moveToHand: this.moveAnim?.toHand,
      layupHand: this.action?.hand,
      dunkHand: this.action?.hand,
      stealHand: this.action?.hand,
      pickupHand: this.action?.hand,
      defHand: this.defReadiness,
      armOverride: !!handTargets.Right || !!handTargets.Left || pose?.name === 'contest' || pose?.name === 'rebound',
      airTuck: this.action?.name === 'layup' ? 0.8 : (this.action?.name === 'dunk' ? 0.95 : 0.45),
    };
    this.animator.update(dt, ctx);

    // The animator has just advanced the bones. Re-sample the live palm now so
    // a carried ball cannot trail a fast gait or pose transition.
    if (ball.state === 'held' && ball.holder === this && this.rig.palmPosition) {
      const a = this.action;
      const t01 = a?.awaitingHold
        ? Math.min(0.07, (a.previewT ?? 0) / Math.max(a.dur, 1e-4))
        : (a ? clamp(a.t / a.dur, 0, 1) : 0);
      let anchor;
      if (this.spinDir !== 0 || this.gameRef?.state === 'checkball') {
        anchor = this.holdPoint(this._tmp);
      } else if (a?.name === 'shot' && !a.released) {
        anchor = t01 < a.perfectT * 0.6
          ? this.holdPoint(this._tmp) : this.shotSetPoint(this._tmp);
      } else if ((a?.name === 'layup' || a?.name === 'dunk') && !a.released) {
        anchor = this.finishBallPoint(a, t01, this._tmp);
      } else if (a?.name === 'rebound') {
        anchor = this.reboundCatchPoint(this._tmp);
      } else if (a?.name === 'pickup') {
        anchor = this.pickupContactPoint(this._tmp);
      } else if (!this.dribbleStarted || this.dribbleEnded) {
        anchor = this.holdPoint(this._tmp);
      } else {
        anchor = this.dribbleAnchor(this._tmp);
      }
      ball.attachTarget.copy(anchor);
      ball.pos.copy(anchor);
    }
    void world;
  }

  /**
   * How closed each hand is, 0..1.
   *
   * Driven by distance to the ball rather than by the animation: a hand that is
   * on the ball closes around it, a hand near it starts to, and a hand doing
   * something else stays relaxed. The one exception is a shot, where the guide
   * hand comes off before the shooting hand does.
   */
  handGrip(ball) {
    const g = this._grip ??= { Left: 0, Right: 0 };
    const a = this.action;
    const bp = ball.pos;
    for (const side of ['Left', 'Right']) {
      let want = 0.12;                                  // relaxed, never flat
      if (this.rig.palmPosition) {
        const d = bp.distanceTo(this.rig.palmPosition(side, this._tmp2));
        want = Math.max(want, clamp(1 - (d - 0.10) / 0.26, 0, 1) * 0.92);
      }
      if (a && (a.name === 'shot' || a.name === 'layup' || a.name === 'dunk') && a.released) {
        want = Math.min(want, 0.2);                     // the ball has gone
      }
      if (this.catchT > 0) want = Math.max(want, 0.75);
      // ease, so a hand does not snap shut between two frames
      g[side] += (want - g[side]) * Math.min(1, 14 * (this._gripDt || 0.016));
    }
    return g;
  }

  /** The actual animated palm designated to secure the rebound. */
  reboundCatchPoint(out) {
    if (this.action?.name === 'rebound' && !this.action.contested) {
      const left = this.rig.palmPosition('Left', out);
      const right = this.rig.palmPosition('Right', this._tmp2);
      // Two hands only cradle a ball once they are about a ball apart. The
      // take spreads them well over a metre on the way up, and the midpoint of
      // that is clear air: the ball would ride between the hands touching
      // neither. Above that span the designated palm is the honest anchor.
      if (left.distanceTo(right) < 0.42) return left.add(right).multiplyScalar(0.5);
    }
    const hand = this.action?.catchHand === 'Left' ? 'Left' : 'Right';
    return this.rig.palmPosition(hand, out);
  }

  /**
   * Continuous palm/ball contact for a rebound. Comparing endpoints alone can
   * miss when a descending ball and rising hand exchange sides in one frame.
   * In relative space both are one segment, so its closest point to the origin
   * is the exact swept contact for the frame.
   */
  reboundCatchContact(ball) {
    const a = this.action;
    if (!a || a.name !== 'rebound' || !this.airborne) return null;
    const phase = a.t / a.dur;
    const palm = this.reboundCatchPoint(new THREE.Vector3()).clone();
    const ballNow = ball.pos.clone();
    let gap = ballNow.distanceTo(palm);
    let swept = false;
    let sweepT = 1;

    if (a.prevCatchPalm && a.prevCatchBall) {
      const r0 = a.prevCatchBall.clone().sub(a.prevCatchPalm);
      const r1 = ballNow.clone().sub(palm);
      const delta = r1.clone().sub(r0);
      const denom = delta.lengthSq();
      if (denom > 1e-8) sweepT = clamp(-r0.dot(delta) / denom, 0, 1);
      const sweptGap = r0.addScaledVector(delta, sweepT).length();
      if (sweptGap < gap) {
        gap = sweptGap;
        swept = sweepT > 0 && sweepT < 1;
      }
    }
    (a.prevCatchPalm ??= new THREE.Vector3()).copy(palm);
    (a.prevCatchBall ??= new THREE.Vector3()).copy(ballNow);

    // Keep the hands live through the jump apex and early descent.
    if (phase < 0.10 || phase > 0.76 || gap > 0.31) return null;
    const timing = Math.abs(phase - 0.44) * 0.14;
    return {
      score: gap + timing - (a.sealed ? 0.08 : 0),
      gap, swept, sweepT, point: palm,
    };
  }

  /** Lower is better; Infinity means this player cannot catch this frame. */
  reboundCatchScore(ball) {
    return this.reboundCatchContact(ball)?.score ?? Infinity;
  }

  /**
   * Hand target for the dribble move currently playing — the arc the ball hand
   * traces. Returns null when no move is running.
   */
  moveHandTarget() {
    const m = this.moveAnim;
    if (!m) return null;
    const t = clamp(m.t / m.dur, 0, 1);
    const k = Math.sin(t * Math.PI);
    const d = m.dir || 1;
    const fromHand = m.fromHand ?? this.dribbleHand;
    const toHand = m.toHand ?? this.dribbleHand;
    const fromS = fromHand === 'Left' ? -1 : 1;
    const toS = toHand === 'Left' ? -1 : 1;
    const hand = t < 0.46 ? fromHand : toHand;
    switch (m.name) {
      case 'cross':
        // low sweep from the old hand across the body to the new one
        return { hand, target: this.localToWorld(
          lerp(fromS * 0.26, toS * 0.30, t), 0.50 + 0.16 * (1 - k), 0.34 + 0.12 * k,
          new THREE.Vector3()) };
      case 'sidedrive':
        // Same palm stays outside the hip throughout the lateral attack.
        return { hand, target: this.localToWorld(
          toS * (0.28 + 0.08 * k), 0.56 + 0.14 * (1 - k), 0.32 + 0.10 * k,
          new THREE.Vector3()) };
      case 'btl':
        // threads under the pelvis
        return { hand, target: this.localToWorld(
          lerp(fromS * 0.20, toS * 0.22, t), 0.44 + 0.10 * (1 - k), -0.02 + 0.14 * t,
          new THREE.Vector3()) };
      case 'behind':
        // wraps around the hip
        return { hand, target: this.localToWorld(
          lerp(fromS * 0.30, toS * 0.28, t), 0.58 + 0.08 * (1 - k), -0.16 - 0.16 * k,
          new THREE.Vector3()) };
      case 'hesitation':
        // ball pulled high on the rise
        return { hand, target: this.localToWorld(
          toS * 0.26, 0.80 + 0.30 * k, 0.26, new THREE.Vector3()) };
      default:
        return null;
    }
    void d;
  }

  pickupContactPoint(out) {
    const hand = this.action?.hand === 'Left' ? 'Left' : 'Right';
    return this.rig.palmPosition(hand, out);
  }

  /** Begin a deliberate floor-ball scoop without turning Space into a jump. */
  startPickup(ball) {
    if (!ball || ball.holder || this.airborne || this.action) return false;
    const near = Math.hypot(ball.pos.x - this.pos.x, ball.pos.z - this.pos.z);
    if (near > 1.35 || ball.pos.y >= 0.9) return false;
    const left = ball.pos.distanceTo(this.rig.palmPosition('Left', this._tmp));
    const right = ball.pos.distanceTo(this.rig.palmPosition('Right', this._tmp2));
    const hand = left < right ? 'Left' : 'Right';
    this.dribbleHand = hand;
    this.action = { name: 'pickup', t: 0, dur: 0.44, hand, contacted: false };
    this.moveLock = 0.28;
    return true;
  }

  passContactPoint(out) {
    const left = this.rig.palmPosition('Left', out);
    const right = this.rig.palmPosition('Right', this._tmp2);
    return left.add(right).multiplyScalar(0.5);
  }

  /** Start/resolve a visible ground pickup. Returns true only on palm contact. */
  tryPickupLooseBall(ball) {
    if (ball.holder) return false;

    if (this.action?.name === 'pickup') {
      const a = this.action;
      if (Math.hypot(ball.pos.x - this.pos.x, ball.pos.z - this.pos.z) > 1.55) {
        this.action = null;
        return false;
      }
      const contact = this.pickupContactPoint(this._tmp);
      const t01 = a.t / a.dur;
      // Type04 is a low authored catch, not a literal floor scrape. During its
      // final scoop, bring the loose ball the remaining few centimetres into
      // that real palm; the arm itself remains 100% the baked source take.
      if (t01 >= 0.68) ball.pos.lerp(contact, Math.min(1, 0.55 + (t01 - 0.68) * 3.0));
      const gap = ball.pos.distanceTo(contact);
      if (!a.contacted && t01 >= 0.68 && gap <= 0.18) {
        a.contacted = true;
        a.contactGap = gap;
        this.gainPossession(ball);
        this.dribbleHand = a.hand;
        ball.attach(this, this.pickupContactPoint(this._tmp));
        this.lastBallContact = { kind: 'pickup', gap };
        return true;
      }
      return false;
    }
    if (this.action) return false;

    if (ball.state === 'pass') {
      const gap = ball.pos.distanceTo(this.holdPoint(this._tmp));
      if (gap <= 0.32) {
        this.gainPossession(ball);
        this.lastBallContact = { kind: 'catch', gap };
        return true;
      }
      return false;
    }

    // A pass may be caught in the air, but a loose ball below the knees is a
    // floor pickup. Never start that full-body scoop while airborne.
    if (this.airborne) return false;

    this.startPickup(ball);
    return false;
  }
}
