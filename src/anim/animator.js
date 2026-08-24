import * as THREE from 'three';
import { clamp, lerp, damp } from '../utils.js';

const D2R = Math.PI / 180;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * Procedural animator.
 *
 * Pass order per frame:
 *   1. reset to bind
 *   2. base gait (run / slide / idle / air)
 *   3. crouch + accel lean
 *   4. upper-body overlay poses (shot / layup / dunk / contest / defense arms / sizeup)
 *   5. arm IK to ball / hand targets
 *   6. head look-at
 *
 * Sign conventions (limbs hang -Y at bind):
 *   rotX negative = limb swings FORWARD (+Z), positive = backward
 *   knee/elbow bend = positive rotX for knee (foot back), negative rotX for elbow (hand forward)
 *   left arm out = rotZ negative; right arm out = rotZ positive
 */
export class Animator {
  constructor(rig) {
    this.rig = rig;
    this.phase = 0;          // gait cycle phase
    this.t = 0;
    this.lookWeight = 0;
  }

  // All pose writing goes through the rig. Values below are relative to bind.
  rot(name, x, y, z, w = 1) {
    this.rig.setBoneEuler(name, x, y, z, w);
  }

  addRot(name, x, y, z) {
    this.rig.addBoneEuler(name, x, y, z);
  }

  /** hips displacement from bind, in metres */
  hips(dy, dx = 0) {
    this.rig.setHipsOffset(dy, dx);
  }

  addHips(dy, dx = 0) {
    this.rig.addHipsOffset(dy, dx);
  }

  update(dt, ctx) {
    this.t += dt;
    const rig = this.rig;
    rig.resetPose();

    const speed = ctx.speed ?? 0;
    const style = ctx.gait ?? 'idle';
    const crouch = ctx.crouch ?? 0;

    // ---------------- base gait ----------------
    if (style === 'run') {
      const stride = clamp(0.42 + speed * 0.24, 0.5, 1.5);
      const hz = Math.max(0.6, speed / (2 * stride));
      this.phase = (this.phase + dt * hz * Math.PI * 2) % (Math.PI * 2);
      const φ = this.phase;
      const sp = clamp(speed / 7.2, 0, 1);
      const A = lerp(0.30, 0.95, sp);
      const armAmp = lerp(0.25, 0.85, sp);

      const fx = ctx.moveLocal ? ctx.moveLocal.z : 1;   // forward component -1..1
      const sx = ctx.moveLocal ? ctx.moveLocal.x : 0;   // strafe
      const mag = Math.hypot(fx, sx) || 1;
      const fn = fx / mag, sn = sx / mag;

      const swing = Math.sin(φ);
      const swing2 = Math.sin(φ + Math.PI);

      // legs (forward/back swing scaled by forward component; lateral by strafe)
      this.rot('LeftUpLeg', -A * swing * fn, 0, -0.10 * sn, 1);
      this.rot('RightUpLeg', -A * swing2 * fn, 0, -0.10 * sn, 1);
      const kneeA = lerp(0.9, 1.9, sp);
      const kneeL = 0.25 + 0.45 * crouch + kneeA * Math.max(0, -Math.sin(φ - 0.35)) * Math.abs(fn);
      const kneeR = 0.25 + 0.45 * crouch + kneeA * Math.max(0, -Math.sin(φ - 0.35 + Math.PI)) * Math.abs(fn);
      this.rot('LeftLeg', kneeL, 0, 0);
      this.rot('RightLeg', kneeR, 0, 0);
      this.rot('LeftFoot', clamp(-0.15 * swing * fn, -0.4, 0.3) + 0.1, 0, 0);
      this.rot('RightFoot', clamp(-0.15 * swing2 * fn, -0.4, 0.3) + 0.1, 0, 0);

      // arms free (overridden later by IK / poses)
      if (!ctx.armOverride) {
        this.rot('LeftArm', -armAmp * swing * fn - 0.05, 0, -0.10, 1);
        this.rot('RightArm', -armAmp * swing2 * fn - 0.05, 0, 0.10, 1);
        this.rot('LeftForeArm', 0, 0, 0);
        this.rot('LeftForeArm', -lerp(0.5, 1.15, sp), 0, 0);
        this.rot('RightForeArm', -lerp(0.5, 1.15, sp), 0, 0);
      }

      // hips bob & sway
      const bob = 0.018 + speed * 0.0045;
      this.hips(-bob * (0.5 + 0.5 * Math.cos(2 * φ)) - 0.16 * crouch, Math.sin(φ) * 0.012 * Math.abs(fn));
      this.rot('Hips', 0, Math.sin(φ) * 0.10 * fn, 0);
      this.rot('Spine', 0.04 + sp * 0.1 + crouch * 0.12, -Math.sin(φ) * 0.06 * fn, 0);
      this.rot('Spine1', 0.02 + sp * 0.06, 0, 0);
      this.rot('Spine2', 0.02, -Math.sin(φ) * 0.04 * fn, 0);

    } else if (style === 'slide') {
      // lateral defensive shuffle
      const stride = 0.62;
      const hz = Math.max(0.8, speed / (2 * stride));
      this.phase = (this.phase + dt * hz * Math.PI * 2) % (Math.PI * 2);
      const φ = this.phase;
      const sp = clamp(speed / 5, 0, 1);
      const fx = ctx.moveLocal ? ctx.moveLocal.z : 0;
      const sx = ctx.moveLocal ? ctx.moveLocal.x : 0;

      const step = Math.sin(φ) * (0.16 + 0.3 * sp);
      const step2 = Math.sin(φ + Math.PI) * (0.16 + 0.3 * sp);
      this.rot('LeftUpLeg', -0.42 - 0.2 * sp - step * fx, 0, -0.34 - step * sx * 0.9, 1);
      this.rot('RightUpLeg', -0.42 - 0.2 * sp - step2 * fx, 0, 0.34 + step2 * sx * 0.9, 1);
      this.rot('LeftLeg', 0.72 + 0.5 * sp + Math.abs(step) * 0.8, 0, 0);
      this.rot('RightLeg', 0.72 + 0.5 * sp + Math.abs(step2) * 0.8, 0, 0);
      this.rot('LeftFoot', 0.05, 0, 0);
      this.rot('RightFoot', 0.05, 0, 0);

      this.hips(-0.13 - 0.08 * sp - 0.1 * crouch - Math.abs(Math.sin(φ)) * 0.02);
      this.rot('Hips', 0.12, sx * 0.12, 0);
      this.rot('Spine', 0.16 + 0.08 * sp, -sx * 0.1, 0);
      this.rot('Spine1', 0.08, 0, 0);

    } else if (style === 'air') {
      // airborne: tuck based on ctx.airTuck 0..1
      const tuck = ctx.airTuck ?? 0.5;
      this.rot('LeftUpLeg', -0.5 - 0.8 * tuck, 0, -0.12);
      this.rot('RightUpLeg', -0.2 - 0.5 * tuck, 0, 0.12);
      this.rot('LeftLeg', 0.7 + 1.3 * tuck, 0, 0);
      this.rot('RightLeg', 0.4 + 0.7 * tuck, 0, 0);
      this.hips(-0.03);
      this.rot('Spine', 0.06, 0, 0);

    } else {
      // idle — athletic ready stance, subtle sway
      this.phase += dt * 2.1;
      const φ = this.phase;
      const breathe = Math.sin(φ) * 0.5 + 0.5;
      this.rot('LeftUpLeg', -0.1 - 0.25 * crouch, 0, -0.06 - 0.14 * crouch);
      this.rot('RightUpLeg', -0.08 - 0.25 * crouch, 0, 0.06 + 0.14 * crouch);
      this.rot('LeftLeg', 0.2 + 0.5 * crouch + breathe * 0.03, 0, 0);
      this.rot('RightLeg', 0.2 + 0.5 * crouch - breathe * 0.03, 0, 0);
      this.hips(-0.02 - 0.14 * crouch + Math.sin(φ * 0.5) * 0.004);
      this.rot('Spine', 0.05 + 0.1 * crouch + breathe * 0.012, Math.sin(φ * 0.35) * 0.03, 0);
      this.rot('Spine1', 0.03, Math.sin(φ * 0.3) * 0.025, 0);
      if (!ctx.armOverride) {
        this.rot('LeftArm', -0.12 - breathe * 0.02, 0, -0.16 - 0.2 * crouch);
        this.rot('RightArm', -0.12 - breathe * 0.02, 0, 0.16 + 0.2 * crouch);
        this.rot('LeftForeArm', -0.45, 0, 0);
        this.rot('RightForeArm', -0.45, 0, 0);
      }
    }

    // ---------------- accel lean ----------------
    if (ctx.lean && !ctx.pose) {
      this.addRot('Spine', ctx.lean.x * 0.5, 0, ctx.lean.z * 0.5);
      this.addRot('Spine1', ctx.lean.x * 0.35, 0, ctx.lean.z * 0.35);
    }

    // ---------------- upper-body overlay poses ----------------
    if (ctx.pose) this.applyPose(ctx.pose, ctx);

    // ---------------- arm IK to ball / explicit targets ----------------
    rig.armature.updateMatrixWorld(true);
    if (ctx.handTargets) {
      for (const side of ['Left', 'Right']) {
        const ht = ctx.handTargets[side];
        if (!ht || ht.weight <= 0) continue;
        rig.solveArmIK(side, ht.target, ht.pole, ht.weight);
        if (ht.aim) rig.aimHand(side, ht.aim, ht.weight);
      }
    }

    // ---------------- head look ----------------
    if (ctx.lookTarget && !ctx.pose) {
      this.applyLook(ctx.lookTarget, dt, ctx.lookWeight ?? 1);
    } else {
      this.lookWeight = damp(this.lookWeight, 0, 6, dt);
    }

    rig.armature.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- poses

  applyPose(pose, ctx) {
    const t = clamp(pose.t ?? 0, 0, 1);
    const w = pose.weight ?? 1;
    switch (pose.name) {
      case 'shot': this.poseShot(t, w, ctx); break;
      case 'layup': this.poseLayup(t, w, ctx); break;
      case 'dunk': this.poseDunk(t, w, ctx); break;
      case 'contest': this.poseContest(t, w, ctx); break;
      case 'defenseArms': this.poseDefenseArms(w, ctx); break;
      case 'sizeup': this.poseSizeup(t, w, ctx); break;
      case 'rebound': this.poseRebound(t, w, ctx); break;
      case 'pickup': this.posePickup(t, w, ctx); break;
      case 'steal': this.poseSteal(t, w, ctx); break;
      case 'stumble': this.poseStumble(t, w, ctx); break;
      case 'celebrate': this.poseCelebrate(t, w); break;
      case 'checkball': this.poseCheckBall(t, w, ctx); break;
      case 'dribbleMove': this.poseDribbleMove(t, w, ctx); break;
      case 'land': this.poseLand(t, w, ctx); break;
    }
  }

  /** Jump shot. Arms driven by IK targets from ball system; here legs/torso + wrist. */
  poseShot(t, w, ctx) {
    // t: 0 dip → 0.35 rise → 0.5 release → 0.85 follow → 1 recover
    const dip = smooth01(t / 0.32);
    const rise = smooth01((t - 0.32) / 0.2);
    const follow = smooth01((t - 0.52) / 0.3);
    const recover = smooth01((t - 0.8) / 0.2);

    const crouchAmt = dip * (1 - rise) * 0.5;
    this.addRot('LeftUpLeg', -0.55 * crouchAmt - 0.15 * follow, 0, -0.06);
    this.addRot('RightUpLeg', -0.5 * crouchAmt - 0.1 * follow, 0, 0.06);
    this.addRot('LeftLeg', 1.0 * crouchAmt + 0.25 * follow, 0, 0);
    this.addRot('RightLeg', 0.9 * crouchAmt + 0.2 * follow, 0, 0);
    this.addHips(-0.14 * crouchAmt);
    this.addRot('Spine', -0.12 * rise + 0.06 * dip - 0.1 * follow, 0, 0);
    this.addRot('Spine1', -0.06 * rise, 0, 0);

    // non-shooting arm posture & wrist handled via IK targets; feet
    this.addRot('LeftFoot', 0.35 * crouchAmt, 0, 0);
    this.addRot('RightFoot', 0.35 * crouchAmt, 0, 0);
    void recover; void w;
  }

  /** Layup: drive knee up, ball hand IK target does the arm. */
  poseLayup(t, w, ctx) {
    const side = ctx.layupHand === 'Left' ? 'Left' : 'Right';
    const opp = side === 'Left' ? 'Right' : 'Left';
    const lift = smooth01(t / 0.4);
    const extend = smooth01((t - 0.4) / 0.35);
    const land = smooth01((t - 0.75) / 0.25);

    // drive knee (same side as hand) up, trail leg back
    this.addRot(`${side}UpLeg`, -1.35 * lift + 0.55 * extend * (1 - land) + 0.3 * land, 0, 0);
    this.addRot(`${side}Leg`, 1.5 * lift * (1 - extend) + 1.9 * extend + 1.0 * land, 0, 0);
    this.addRot(`${opp}UpLeg`, -0.25 * lift - 0.2 * extend + 0.25 * land, 0, 0);
    this.addRot(`${opp}Leg`, 0.5 * lift + 0.9 * extend * (1 - land) + 0.7 * land, 0, 0);
    this.addRot('Spine', -0.1 * lift + 0.15 * extend - 0.1 * land, 0, side === 'Left' ? 0.1 * lift : -0.1 * lift);
    // balance arm
    this.addRot(`${opp}Arm`, -1.2 * lift * (1 - land), 0, side === 'Left' ? -0.5 : 0.5);
    void w;
  }

  /** Dunk: full extension, power. */
  poseDunk(t, w, ctx) {
    const side = ctx.dunkHand === 'Left' ? 'Left' : 'Right';
    const opp = side === 'Left' ? 'Right' : 'Left';
    const coil = smooth01(t / 0.35);
    const slam = smooth01((t - 0.35) / 0.3);
    const land = smooth01((t - 0.68) / 0.32);

    this.addRot(`${side}UpLeg`, -1.15 * coil * (1 - slam) - 0.45 * slam + 0.35 * land, 0, 0);
    this.addRot(`${side}Leg`, 1.8 * coil * (1 - slam) + 0.6 * slam + 1.1 * land, 0, 0);
    this.addRot(`${opp}UpLeg`, -0.6 * coil - 0.3 * slam + 0.4 * land, 0, 0);
    this.addRot(`${opp}Leg`, 1.2 * coil + 0.8 * slam * (1 - land) + 1.0 * land, 0, 0);
    this.addRot('Spine', 0.18 * coil - 0.12 * slam + 0.12 * land, 0, 0);
    this.addHips(-0.08 * coil);
    // off arm guards
    this.addRot(`${opp}Arm`, -0.8 * coil * (1 - land), 0, opp === 'Left' ? -0.7 : 0.7);
    void w;
  }

  /** Defensive jump contest: both arms high. */
  poseContest(t, w, ctx) {
    const up = smooth01(t / 0.35);
    const down = smooth01((t - 0.55) / 0.45);
    const ext = up * (1 - down);
    this.rot('LeftArm', -2.75 * ext - 0.1, 0, -0.35 * ext, w);
    this.rot('RightArm', -2.75 * ext - 0.1, 0, 0.35 * ext, w);
    this.rot('LeftForeArm', -0.15 * ext, 0, 0, w);
    this.rot('RightForeArm', -0.15 * ext, 0, 0, w);
    void ctx;
  }

  /** Defensive stance arms (active hands). */
  poseDefenseArms(w, ctx) {
    const hand = ctx.defHand ?? 0.5; // 0..1 readiness
    this.rot('LeftArm', -0.85 - 0.3 * hand, 0, -0.55 - 0.25 * hand, w);
    this.rot('RightArm', -0.85 - 0.3 * hand, 0, 0.55 + 0.25 * hand, w);
    this.rot('LeftForeArm', -1.15 - 0.35 * hand, 0, 0, w);
    this.rot('RightForeArm', -1.15 - 0.35 * hand, 0, 0, w);
  }

  /** Size-up rhythm: shoulder swagger toward ball hand. */
  poseSizeup(t, w, ctx) {
    const hand = ctx.dribbleHand === 'Left' ? -1 : 1;
    const sway = Math.sin(t * Math.PI * 2);
    this.addRot('Spine', 0.04, -sway * 0.10 * hand * w, sway * 0.06 * hand * w);
    this.addRot('Hips', 0, sway * 0.07 * hand * w, 0);
    this.addRot('Spine1', 0.02, -sway * 0.06 * hand * w, 0);
  }

  /**
   * Body pose for a dribble move. Until now every move was ball-only motion —
   * these make the move readable without watching the ball, which is the whole
   * point of a move.
   *
   * ctx.moveName selects the shape; ctx.moveDir is +1 for a move resolving to
   * the player's right, -1 to the left.
   */
  poseDribbleMove(t, w, ctx) {
    const d = ctx.moveDir || 1;
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);          // rise-and-settle
    const kk = smooth01(t / 0.45) * (1 - smooth01((t - 0.5) / 0.5));

    switch (ctx.moveName) {
      case 'cross': {
        // drop the OPPOSITE shoulder and swing the torso across the new hand
        this.addRot('Spine', 0.30 * k, -0.30 * d * k, 0.26 * d * k);
        this.addRot('Spine1', 0.10 * k, -0.14 * d * k, 0.12 * d * k);
        this.addRot('Hips', 0.06 * k, 0.16 * d * k, 0);
        this.addHips(-0.10 * k);
        this.addRot('Neck', -0.08 * k, -0.18 * d * k, 0);
        // trail arm sweeps low across the body
        const off = d > 0 ? 'Left' : 'Right';
        this.addRot(`${off}Arm`, -0.55 * k, 0, (off === 'Left' ? 1 : -1) * 0.5 * k);
        break;
      }
      case 'hesitation': {
        // stand tall, ball pulled up, head fake
        this.addRot('Spine', -0.34 * kk, 0, 0);
        this.addRot('Spine1', -0.16 * kk, 0, 0);
        this.addHips(0.075 * kk);
        this.addRot('Neck', -0.14 * kk, 0.34 * Math.sin(t * Math.PI * 2), 0);
        this.addRot('Head', -0.10 * kk, 0.26 * Math.sin(t * Math.PI * 2), 0);
        this.addRot('LeftUpLeg', 0.18 * kk, 0, 0);
        this.addRot('RightUpLeg', 0.18 * kk, 0, 0);
        break;
      }
      case 'btl': {
        // stride opens, deep sit, hand threads under the pelvis
        const lead = d > 0 ? 'Right' : 'Left';
        const trail = lead === 'Right' ? 'Left' : 'Right';
        this.addRot(`${lead}UpLeg`, -0.70 * k, 0, (lead === 'Left' ? -1 : 1) * 0.34 * k);
        this.addRot(`${lead}Leg`, 0.55 * k, 0, 0);
        this.addRot(`${trail}UpLeg`, 0.26 * k, 0, (trail === 'Left' ? -1 : 1) * 0.18 * k);
        this.addRot('Spine', 0.42 * k, 0, 0);
        this.addRot('Spine1', 0.16 * k, 0, 0);
        this.addHips(-0.155 * k);
        this.addRot('Neck', -0.22 * k, 0, 0);
        break;
      }
      case 'behind': {
        // hips slide away, arm wraps around the back
        this.addRot('Hips', 0.04 * k, -0.40 * d * k, 0);
        this.addRot('Spine', 0.20 * k, 0.34 * d * k, -0.10 * d * k);
        this.addRot('Spine1', 0.08 * k, 0.16 * d * k, 0);
        this.addHips(-0.07 * k);
        const arm = d > 0 ? 'Right' : 'Left';
        this.addRot(`${arm}Arm`, 0.72 * k, 0, (arm === 'Left' ? -1 : 1) * 0.42 * k);
        this.addRot(`${arm}ForeArm`, -0.5 * k, 0, 0);
        break;
      }
      case 'spin': {
        // the body yaw is driven by the player; add the head whip that sells it
        const whip = Math.sin(clamp(t, 0, 1) * Math.PI * 1.15);
        this.addRot('Neck', -0.10 * k, -0.62 * d * whip, 0);
        this.addRot('Head', -0.06 * k, -0.45 * d * whip, 0);
        this.addRot('Spine', 0.24 * k, -0.16 * d * k, 0);
        this.addHips(-0.09 * k);
        break;
      }
    }
    void w;
  }

  /** landing absorb: knees swallow the impact, torso folds, then recovers */
  poseLand(t, w, ctx) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    this.addRot('LeftUpLeg', -0.42 * k, 0, -0.10 * k);
    this.addRot('RightUpLeg', -0.40 * k, 0, 0.10 * k);
    this.addRot('LeftLeg', 0.85 * k, 0, 0);
    this.addRot('RightLeg', 0.82 * k, 0, 0);
    this.addRot('LeftFoot', 0.28 * k, 0, 0);
    this.addRot('RightFoot', 0.28 * k, 0, 0);
    this.addRot('Spine', 0.22 * k, 0, 0);
    this.addHips(-0.17 * k);
    void w; void ctx;
  }

  poseRebound(t, w, ctx) {
    const up = smooth01(t / 0.4);
    const down = smooth01((t - 0.6) / 0.4);
    const ext = up * (1 - down);
    this.rot('LeftArm', -2.6 * ext, 0, -0.5 * ext, w);
    this.rot('RightArm', -2.6 * ext, 0, 0.5 * ext, w);
    this.rot('LeftForeArm', -0.2, 0, 0, w);
    this.rot('RightForeArm', -0.2, 0, 0, w);
    void ctx;
  }

  /** Ground pickup: feet stay planted while the body takes one hand to the ball. */
  posePickup(t, w, ctx) {
    const down = smooth01(t / 0.42);
    const up = smooth01((t - 0.56) / 0.44);
    const k = down * (1 - up);
    this.rot('LeftUpLeg', -0.78 * k, 0, -0.14 * k, w);
    this.rot('RightUpLeg', -0.75 * k, 0, 0.14 * k, w);
    this.rot('LeftLeg', 1.42 * k, 0, 0, w);
    this.rot('RightLeg', 1.38 * k, 0, 0, w);
    this.addRot('Spine', 0.94 * k, 0, 0);
    this.addRot('Spine1', 0.38 * k, 0, 0);
    this.addHips(-0.58 * k);
    const off = ctx.pickupHand === 'Left' ? 'Right' : 'Left';
    this.rot(`${off}Arm`, -0.38 * k, 0, off === 'Left' ? -0.5 * k : 0.5 * k, w);
  }

  /** steal reach: quick swipe with near hand */
  poseSteal(t, w, ctx) {
    const reach = Math.sin(clamp(t, 0, 1) * Math.PI);
    const hand = (ctx.stealHand === 'Left') ? 'Left' : 'Right';
    const sgn = hand === 'Left' ? -1 : 1;
    this.rot(`${hand}Arm`, -1.5 * reach, 0.3 * reach * sgn, -0.8 * reach * sgn, w);
    this.rot(`${hand}ForeArm`, -0.4, 0, 0, w);
    this.addRot('Spine', 0.25 * reach, 0.2 * reach * sgn, 0);
  }

  poseStumble(t, w, ctx) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    this.addRot('Spine', 0.35 * k, 0, 0);
    this.addRot('LeftArm', -0.8 * k, 0, -0.4 * k);
    this.addRot('RightArm', -0.8 * k, 0, 0.4 * k);
    this.addHips(-0.06 * k);
    void ctx;
  }

  poseCelebrate(t, w) {
    const k = Math.sin(clamp(t, 0, 1) * Math.PI);
    this.rot('LeftArm', -2.4 * k, 0, -0.6, w);
    this.rot('RightArm', -2.9 * k, 0, 0.5, w);
    this.rot('LeftForeArm', -0.5, 0, -0.4, w);
    this.rot('RightForeArm', -0.3, 0, 0, w);
    this.addRot('Spine', -0.12 * k, 0, 0);
  }

  poseCheckBall(t, w, ctx) {
    // facing passer, ball held at hip, relaxed
    this.rot('LeftArm', -0.55, 0.25, -0.32, w);
    this.rot('RightArm', -0.55, -0.25, 0.32, w);
    this.rot('LeftForeArm', -0.85, 0, 0, w);
    this.rot('RightForeArm', -0.85, 0, 0, w);
    void t; void ctx;
  }

  // ---------------------------------------------------------------- look

  applyLook(target, dt, weight) {
    const rig = this.rig;
    this.lookWeight = damp(this.lookWeight, weight, 8, dt);
    const w = this.lookWeight;
    if (w < 0.01) return;

    const headBone = rig.bones.Head;
    headBone.getWorldPosition(_v);
    _v2.copy(target).sub(_v);
    const dist = _v2.length();
    if (dist < 0.3) return;
    _v2.normalize();

    // transform into neck-parent local space
    const neck = rig.bones.Neck;
    neck.parent.getWorldQuaternion(_q1);
    _v2.applyQuaternion(_q1.clone().invert());

    const yaw = Math.atan2(_v2.x, -_v2.z);  // 0 = facing forward (+Z local)
    const pitch = Math.asin(clamp(_v2.y, -1, 1));

    const yawC = clamp(yaw, -1.0, 1.0);
    const pitchC = clamp(pitch, -0.6, 0.75);

    this.addRot('Neck', -pitchC * 0.45 * w, yawC * 0.4 * w, 0);
    this.addRot('Head', -pitchC * 0.55 * w, yawC * 0.6 * w, 0);
  }
}

function smooth01(x) {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
}

const _e = new THREE.Euler();
const _q1 = new THREE.Quaternion();
