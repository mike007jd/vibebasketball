import * as THREE from 'three';
import { clamp, damp, lerp } from '../utils.js';
import { COURT } from '../world/court.js';

/**
 * Broadcast basketball camera.
 *
 * Preset 0 (`2k`) is the default NBA-2K-style rig: behind the half-court line,
 * high, facing the hoop — offense flows UP-screen, hoop pinned in the upper
 * third of frame. Geometry: cam z=17.6 / y=7.1 / fov 41 — pulled in from the
 * planned 19.2/7.4/46 because at that framing the athletes read at ~15% of
 * frame height, well under broadcast scale. The sightline still clears the
 * 3.7 m fence at z=16.4 with >2 m of headroom.
 *
 * The hoop is pinned by *solving* for the focus height each frame instead of
 * hard-coding a pitch: given the camera position we compute the vertical angle
 * that puts COURT.rimCenter at `RIM_NDC` and aim the look-at point there. That
 * keeps the framing stable no matter where the ball drags the focus.
 *
 * Older side-on presets follow (C cycles, ?cam=N selects).
 */
const D2R = Math.PI / 180;

const PRESETS = [
  { name: '2k',        mode: '2k',       camZ: 17.6, height: 7.1, fov: 41 },
  { name: 'broadcast', mode: 'side',     dist: 10.6, height: 4.4, fov: 43, side: -1 },
  { name: 'courtside', mode: 'side',     dist: 10.6, height: 2.6, fov: 46, side: -1 },
  { name: 'high',      mode: 'side',     dist: 16.5, height: 8.6, fov: 34, side: -1 },
  { name: 'portrait',  mode: 'portrait', dist: 3.6,  height: 1.55, fov: 36, side: -0.55 },
  // debug-only: locked full-body view of the user player for rig inspection.
  // Reachable via ?cam=5; skipped by the C cycle.
  { name: 'inspect',   mode: 'inspect',  dist: 4.4,  height: 1.55, fov: 34, debugOnly: true },
];

// where the rim sits vertically in NDC (+1 = top edge). 0.42 ≈ upper third.
const RIM_NDC = 0.42;

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.presetIdx = 0;
    this.pos = new THREE.Vector3(0, 7.4, 19.2);
    this.focus = new THREE.Vector3(0, 1.4, 5.5);
    this.fov = 46;
    this.shake = 0;
    this.shotHold = 0;
    this._v = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }

  get preset() { return PRESETS[this.presetIdx]; }

  cyclePreset() {
    do {
      this.presetIdx = (this.presetIdx + 1) % PRESETS.length;
    } while (PRESETS[this.presetIdx].debugOnly);
    return PRESETS[this.presetIdx].name;
  }

  addShake(a) {
    this.shake = Math.min(0.5, this.shake + a);
  }

  update(dt, world) {
    if (world.mode === 'three-point') return this.updateContest(dt, world);
    const P = PRESETS[this.presetIdx];
    if (P.mode === '2k') return this.update2K(dt, world, P);
    if (P.mode === 'portrait') return this.updatePortrait(dt, world, P);
    if (P.mode === 'inspect') return this.updateInspect(dt, world, P);
    return this.updateSide(dt, world, P);
  }

  // ------------------------------------------------------------ contest rig

  updateContest(dt, world) {
    if (world.state === 'player-count') {
      this._v.set(0, 3.0, 14.2);
      this.pos.x = damp(this.pos.x, this._v.x, 5.5, dt);
      this.pos.y = damp(this.pos.y, this._v.y, 5.5, dt);
      this.pos.z = damp(this.pos.z, this._v.z, 5.5, dt);
      this.focus.x = damp(this.focus.x, 0, 6.0, dt);
      // Frame the whole four-player lineup above the bottom setup panel rather
      // than centring on their heads and hiding every body behind the UI.
      this.focus.y = damp(this.focus.y, 0.35, 6.0, dt);
      this.focus.z = damp(this.focus.z, 7.0, 6.0, dt);
      this.fov = damp(this.fov, 42, 5.0, dt);
      this.commit(dt, false);
      return;
    }
    const ball = world.ball;
    const shooter = world.offense;
    const liveFlight = ball?.state === 'shot';
    const sx = shooter?.pos.x ?? 0;
    const sz = shooter?.pos.z ?? 7.2;
    let fx = sx * 0.46;
    let fz = lerp(sz, COURT.rimCenter.z, 0.38);
    if (liveFlight) {
      fx = lerp(fx, ball.pos.x, 0.38);
      fz = lerp(fz, ball.pos.z, 0.32);
    }
    this._v.set(
      clamp(sx * 0.18, -1.2, 1.2),
      liveFlight ? 7.75 : 7.35,
      liveFlight ? 18.9 : 18.25,
    );
    this.pos.x = damp(this.pos.x, this._v.x, 2.6, dt);
    this.pos.y = damp(this.pos.y, this._v.y, 3.2, dt);
    this.pos.z = damp(this.pos.z, this._v.z, 3.2, dt);
    this.focus.x = damp(this.focus.x, clamp(fx, -4.8, 4.8), 4.2, dt);
    this.focus.z = damp(this.focus.z, clamp(fz, 2.2, 9.5), 4.0, dt);
    this.focus.y = damp(this.focus.y, liveFlight ? 1.8 : 1.25, 4.0, dt);
    this.fov = damp(this.fov, liveFlight ? 42 : 45, 2.4, dt);
    this.commit(dt);
  }

  // ------------------------------------------------------------ 2K rig

  update2K(dt, world, P) {
    const ball = world.ball;
    const off = world.offense;
    const rim = COURT.rimCenter;

    // ---- focus (xz): ball weighted toward the ball→rim midpoint ----
    // focus = lerp(ball, mid(ball, rim), K)  ==  lerp(ball, rim, K/2)
    const K = 0.55;
    let fx = lerp(ball.pos.x, (ball.pos.x + rim.x) * 0.5, K);
    let fz = lerp(ball.pos.z, (ball.pos.z + rim.z) * 0.5, K);
    if (off) {
      // a touch of the ball handler so an off-ball loose ball doesn't rip framing
      fx = lerp(fx, off.pos.x, 0.18);
      fz = lerp(fz, off.pos.z, 0.18);
    }
    if (ball.state === 'shot') {
      // ride the flight a little more
      fx = lerp(fx, ball.pos.x, 0.25);
      fz = lerp(fz, ball.pos.z, 0.25);
      this.shotHold = 0.9;
    } else {
      this.shotHold = Math.max(0, this.shotHold - dt);
    }
    fx = clamp(fx, -5.4, 5.4);
    fz = clamp(fz, 1.0, 11.2);

    // ---- camera position: fixed depth/height, light lateral tracking ----
    const camXT = fx * 0.55;
    const camYT = P.height + (ball.state === 'shot' ? 0.35 : 0);
    const camZT = P.camZ + (ball.state === 'shot' ? 0.5 : 0);
    this.pos.x = damp(this.pos.x, camXT, 1.9, dt);      // deliberately soft
    this.pos.y = damp(this.pos.y, camYT, 3.0, dt);
    this.pos.z = damp(this.pos.z, camZT, 3.0, dt);

    // ---- focus xz damping ----
    this.focus.x = damp(this.focus.x, fx, 3.6, dt);
    this.focus.z = damp(this.focus.z, fz, 3.2, dt);

    // ---- solve focus height so the rim lands at RIM_NDC ----
    this.focus.y = damp(this.focus.y, this.solveFocusY(P.fov), 5.0, dt);

    let fovT = P.fov;
    if (ball.state === 'shot') fovT = P.fov - 2.5;
    this.fov = damp(this.fov, fovT, 2.2, dt);

    this.commit(dt);
  }

  /**
   * Vertical aim solve: return the focus Y that projects COURT.rimCenter at
   * RIM_NDC given the current camera position and focus xz.
   */
  solveFocusY(fov) {
    const rim = COURT.rimCenter;
    const dRim = Math.hypot(rim.x - this.pos.x, rim.z - this.pos.z);
    const phi = Math.atan2(this.pos.y - rim.y, dRim);           // rim below horizon
    const halfT = Math.tan(fov * 0.5 * D2R);
    const theta = phi + Math.atan(RIM_NDC * halfT);             // camera pitch down
    const dFocus = Math.max(1.0, Math.hypot(this.focus.x - this.pos.x, this.focus.z - this.pos.z));
    return clamp(this.pos.y - dFocus * Math.tan(theta), -2.5, 3.2);
  }

  // ------------------------------------------------------------ legacy side rig

  updateSide(dt, world, P) {
    const ball = world.ball;
    const off = world.offense;
    const def = world.defensePlayer();

    this._f.set(0, 1.3, 7);
    let wBall = 0.4, wPlayer = 0.38, wRim = 0.22;
    if (ball.state === 'shot') { wBall = 0.72; wPlayer = 0.12; wRim = 0.16; }
    else if (ball.state === 'loose') { wBall = 0.62; wPlayer = 0.2; wRim = 0.18; }
    else if (ball.state === 'pass') { wBall = 0.55; wPlayer = 0.3; wRim = 0.15; }
    if (off) {
      this._f.set(0, 0, 0);
      this._f.addScaledVector(ball.pos, wBall);
      this._f.addScaledVector(off.rig.group.position, wPlayer);
      this._f.addScaledVector(COURT.rimCenter, wRim);
      this._f.y = lerp(this._f.y * 0.42, 1.25, 0.5);
      if (def) this._f.lerp(def.pos, 0.05);
    }

    if (ball.state === 'shot') this.shotHold = 0.9;
    else this.shotHold = Math.max(0, this.shotHold - dt);

    const zClamped = clamp(this._f.z + clamp(ball.vel.z * 0.22, -1.2, 1.2), 3.0, 11.6);
    const spread = off && def ? off.pos.distanceTo(def.pos) : 2;
    const distAdj = clamp(spread * 0.14, -0.6, 1.2) + (ball.state === 'shot' ? 0.8 : 0);
    this._v.set(
      P.side * (P.dist + distAdj),
      P.height + (ball.state === 'shot' ? 0.5 : 0),
      zClamped
    );

    const posL = ball.state === 'shot' ? 2.6 : 3.4;
    this.pos.x = damp(this.pos.x, this._v.x, posL, dt);
    this.pos.y = damp(this.pos.y, this._v.y, posL, dt);
    this.pos.z = damp(this.pos.z, this._v.z, posL, dt);
    this.focus.x = damp(this.focus.x, this._f.x, 4.6, dt);
    this.focus.y = damp(this.focus.y, this._f.y, 4.2, dt);
    this.focus.z = damp(this.focus.z, this._f.z, 4.6, dt);

    this.fov = damp(this.fov, ball.state === 'shot' ? P.fov - 4 : P.fov, 2.2, dt);
    this.commit(dt);
  }

  updatePortrait(dt, world, P) {
    const off = world.offense;
    if (off) {
      this._v.set(off.pos.x - 2.0, 1.5, off.pos.z + 2.3);
      this._f.set(off.pos.x, 1.15, off.pos.z);
    } else {
      this._v.set(-3, 1.5, 8); this._f.set(0, 1.2, 8);
    }
    this.pos.x = damp(this.pos.x, this._v.x, 4, dt);
    this.pos.y = damp(this.pos.y, this._v.y, 4, dt);
    this.pos.z = damp(this.pos.z, this._v.z, 4, dt);
    this.focus.x = damp(this.focus.x, this._f.x, 6, dt);
    this.focus.y = damp(this.focus.y, this._f.y, 6, dt);
    this.focus.z = damp(this.focus.z, this._f.z, 6, dt);
    this.fov = damp(this.fov, P.fov, 3, dt);
    this.commit(dt, false);
  }

  /** locked three-quarter full-body view of the user player (rig inspection) */
  updateInspect(dt, world, P) {
    const p = world.userPlayer ?? world.players[0];
    this._v.set(p.pos.x + P.dist * 0.58, P.height, p.pos.z + P.dist * 0.81);
    this._f.set(p.pos.x, 1.02, p.pos.z);
    this.pos.copy(this._v);
    this.focus.copy(this._f);
    this.fov = P.fov;
    this.commit(dt, false);
  }

  // ------------------------------------------------------------ commit

  commit(dt, allowShake = true) {
    let sx = 0, sy = 0;
    if (allowShake && this.shake > 0.001) {
      this.shake = Math.max(0, this.shake - dt * 1.4);
      sx = (Math.random() - 0.5) * this.shake * 0.3;
      sy = (Math.random() - 0.5) * this.shake * 0.2;
    }
    this.camera.position.set(this.pos.x + sx, this.pos.y + sy, this.pos.z);
    this.camera.lookAt(this.focus);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
