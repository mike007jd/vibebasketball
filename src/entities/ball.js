import * as THREE from 'three';
import { COURT } from '../world/court.js';
import { clamp } from '../utils.js';

const G = 9.81;
const R = 0.121; // radius m (size 7)

/**
 * The basketball: hybrid sim — physics-driven for dribble bounces, shots,
 * rebounds; attachment-driven while held.
 *
 * states:
 *  'held'    — attached to a holder's anchor (spring follow)
 *  'dribble' — player-driven bounce cycle (physics between pushes/catches)
 *  'shot'    — ballistic at rim, full collision + scoring
 *  'pass'    — ballistic to a target (check ball)
 *  'loose'   — free physics
 */
export class Ball {
  constructor(scene) {
    this.radius = R;
    this.state = 'loose';
    this.holder = null;

    this.pos = new THREE.Vector3(0, R, 4);
    this.vel = new THREE.Vector3();
    this.spin = new THREE.Vector3(); // angular velocity axis*rads

    // attach spring
    this.attachTarget = new THREE.Vector3();

    // dribble cycle data
    this.dribble = null; // { hand, phase: 'down'|'up', bouncePoint, catchTime }

    // shot data
    this.shot = null;   // { shooter, quality, points, releasePos, scored }
    this.lastTouch = null;
    // Possession context survives after `shot` is cleared on a floor bounce.
    // It lets the game distinguish an offensive recovery from a defensive
    // rebound, and a live-ball steal from an ordinary change of possession.
    this.lastShotTeam = null;
    this.possessionCause = null;
    this.clearExemptTeam = null;

    // scoring detection
    this._prevY = 0;

    const textures = getBallTextures();
    const tex = textures.standard;
    this.ballTextures = textures;
    this.visualKind = 'standard';
    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(R, 28, 22),
      new THREE.MeshStandardMaterial({
        map: tex,
        bumpMap: tex,
        bumpScale: 0.35,
        roughness: 0.62,
        metalness: 0.0,
      })
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    // trail
    this.trail = [];
    this.trailLine = null;

    this.events = []; // consumed by game: [{type:'score'|'board'|'rim'|'floor'|'bounce'...}]
  }

  setContestKind(kind = 'standard') {
    const next = kind === 'money' || kind === 'logo' ? kind : 'standard';
    const material = this.mesh.material;
    const texture = this.ballTextures[next];
    material.map = texture;
    material.bumpMap = texture;
    material.emissive.set(next === 'money' ? 0x07383e : next === 'logo' ? 0x0b1d58 : 0x000000);
    material.emissiveIntensity = next === 'standard' ? 0 : 0.42;
    material.needsUpdate = true;
    this.visualKind = next;
  }

  isLive() {
    return this.state === 'shot' || this.state === 'loose' || this.state === 'pass' ||
      (this.state === 'dribble' && this.dribble?.phase === 'down');
  }

  attach(player, target) {
    this.state = 'held';
    this.holder = player;
    this.attachTarget.copy(target);
    this.vel.set(0, 0, 0);
  }

  updateAttach(target, dt) {
    this.attachTarget.copy(target);
    // The ball is IN the hand, so any lag is the ball floating behind it. The
    // spring this used to be trails a moving anchor by v/k, which at a sprint
    // is most of a ball radius and reads as the ball being dragged rather than
    // carried. Track the anchor exactly, and rate-limit only so that an anchor
    // that jumps — a hand swap, a gather, a spin — does not whip the ball
    // through the body to get there.
    const d = _attachD.subVectors(target, this.pos);
    const len = d.length();
    // a hand in a dribble genuinely travels ~10 m/s and a shooting arm more, so
    // the limit is set well above that: it exists to catch teleports, not to
    // slow the ball down
    const maxStep = 20 * dt + 0.02;
    if (len > 0.8) this.pos.copy(target);          // a real hand-off, not a lag
    else if (len > maxStep) this.pos.addScaledVector(d, maxStep / len);
    else this.pos.copy(target);
  }

  launchShot(shooter, quality, target, apex, points, intendedMake = null) {
    this.state = 'shot';
    this.holder = null;
    this.dribble = null;
    this.shot = {
      shooter, quality, points,
      releasePos: this.pos.clone(),
      scored: false, scoreCandidate: false,
      rimHits: 0, boardHits: 0, intendedMake,
    };
    this.lastShotTeam = shooter.team;
    this.possessionCause = 'shot';
    this.clearExemptTeam = null;
    const origin = this.pos;
    const dy = target.y - origin.y;
    const dxz = Math.hypot(target.x - origin.x, target.z - origin.z);
    // choose arc: apex above the higher point
    const yMax = Math.max(origin.y, target.y) + apex;
    const vUp = Math.sqrt(2 * G * (yMax - origin.y));
    const tUp = vUp / G;
    const tDown = Math.sqrt(2 * Math.max(0.01, yMax - target.y) / G);
    const t = Math.max(0.1, tUp + tDown);
    this.vel.set((target.x - origin.x) / t, vUp, (target.z - origin.z) / t);
    // backspin
    const dirH = new THREE.Vector3(target.x - origin.x, 0, target.z - origin.z).normalize();
    this.spin.copy(dirH).cross(new THREE.Vector3(0, 1, 0)).multiplyScalar(-14);
    void dy; void dxz;
  }

  /**
   * Launch a real glass finish. The trajectory is solved in two ballistic
   * legs around the same restitution values used by the backboard collider,
   * so a directional layup visibly touches the board and then arrives at the
   * requested rim target. This is not a scripted mid-flight redirect: if the
   * board collision is removed or blocked, the second leg cannot happen.
   */
  launchBankShot(shooter, quality, target, points, intendedMake = null) {
    this.state = 'shot';
    this.holder = null;
    this.dribble = null;
    this.shot = {
      shooter, quality, points,
      releasePos: this.pos.clone(),
      scored: false, scoreCandidate: false,
      rimHits: 0, boardHits: 0, intendedMake,
      bank: true,
    };
    this.lastShotTeam = shooter.team;
    this.possessionCause = 'shot';
    this.clearExemptTeam = null;

    const origin = this.pos;
    const boardZ = COURT.boardFaceZ + R;
    const beforeZ = Math.max(0.22, origin.z - boardZ);
    const afterZ = Math.max(0.08, target.z - boardZ);
    // Choose a downward velocity through the rim, then solve the time before
    // board contact. A low-arc solution reaches the glass while still rising
    // and hits the front of the rim from below; the high-arc root peaks first,
    // descends into the square, and leaves the glass descending through the
    // hoop like a real bank layup.
    const zRatio = afterZ / (0.68 * beforeZ);
    const rimVy = -2.6;
    const yRestitution = 0.92;
    const A = G * (zRatio / yRestitution + 0.5 + 0.5 * zRatio * zRatio);
    const B = rimVy * (1 / yRestitution + zRatio);
    const C = origin.y - target.y;
    const disc = Math.max(0.001, B * B - 4 * A * C);
    const t1 = clamp((-B + Math.sqrt(disc)) / (2 * A), 0.20, 0.72);
    const incomingZ = -beforeZ / t1;
    const outgoingZ = Math.abs(incomingZ) * 0.68;
    const t2 = afterZ / Math.max(0.1, outgoingZ);

    // Solve board contact x so the 0.85 tangential restitution lands exactly
    // at target.x after the bounce.
    const xRatio = 0.85 * t2 / t1;
    const boardX = (target.x + xRatio * origin.x) / (1 + xRatio);

    // Back-solve the launch velocity from the requested downward rim velocity
    // and the collider's vertical restitution.
    const incomingBoardVy = (rimVy + G * t2) / yRestitution;
    const vUp = incomingBoardVy + G * t1;

    this.vel.set((boardX - origin.x) / t1, vUp, incomingZ);
    const dirH = new THREE.Vector3(boardX - origin.x, 0, boardZ - origin.z).normalize();
    this.spin.copy(dirH).cross(new THREE.Vector3(0, 1, 0)).multiplyScalar(-11);
  }

  launchPass(target, speed = 9) {
    this.state = 'pass';
    this.holder = null;
    this.dribble = null;
    const d = new THREE.Vector3().subVectors(target, this.pos);
    const dist = d.length();
    const t = dist / speed;
    this.vel.set(d.x / t, d.y / t + 0.5 * G * t, d.z / t);
  }

  pushDribble(holder, hand, from, bouncePoint, catchHeight, T) {
    // hand → floor push. A dribble is *driven* down, not dropped, so T is
    // allowed below the free-fall time; the only limit is how hard a wrist can
    // actually push, which is what DOWN_MAX stands for.
    this.state = 'dribble';
    this.holder = null;
    this.lastTouch = holder;
    this.pos.copy(from);
    const h0 = Math.max(0.25, from.y);
    const DOWN_MAX = 5.4;
    T = Math.max(T, 0.06);
    let vy = (R - h0 + 0.5 * G * T * T) / T;
    if (vy < -DOWN_MAX) vy = -DOWN_MAX;
    this.vel.set((bouncePoint.x - from.x) / T, vy, (bouncePoint.z - from.z) / T);
    this.dribble = {
      hand,
      releaseHand: holder.dribbleHand,
      phase: 'down',
      bouncePoint: bouncePoint.clone(),
      catchH: catchHeight,
      contactT: 0,
      holder,
      catchAnchor: null,
      catchVelocity: null,
      guideAnchor: null,
      guideVelocity: null,
    };
  }

  update(dt, players) {
    // Sample the receiving palm once per rendered simulation frame. Its world
    // velocity includes body translation *and* a sudden turn, unlike p.vel,
    // which only describes the root. The two physics substeps below then use a
    // stable target instead of seeing one moving sample and one zero delta.
    const d = this.state === 'dribble' ? this.dribble : null;
    if (d?.holder) {
      const hand = d.phase === 'down' ? d.releaseHand : d.hand;
      const anchor = d.holder.dribbleAnchor(_anchor, hand);
      if (d.guideAnchor) {
        (d.guideVelocity ??= new THREE.Vector3())
          .subVectors(anchor, d.guideAnchor)
          .divideScalar(Math.max(dt, 1e-4));
        if (d.guideVelocity.lengthSq() > 100) d.guideVelocity.setLength(10);
        d.guideAnchor.copy(anchor);
      } else {
        d.guideAnchor = anchor.clone();
        d.guideVelocity = d.holder.vel.clone();
      }
      if (d.phase === 'up') {
        d.catchAnchor = d.guideAnchor;
        d.catchVelocity = d.guideVelocity;
      }
      // An immediate handle cancel or gather accelerates the *owned* bounce to
      // its newly selected palm. The ball still hits the floor and still
      // reaches the real receiver; no future command is stored for playback.
      if (d.quickReturn && d.quickReturnArmedPhase !== d.phase) {
        if (d.phase === 'down') {
          this.vel.y = Math.min(this.vel.y, -7.0);
        } else {
          const returnT = 0.15;
          const dy = Math.max(0.03, d.catchAnchor.y - this.pos.y);
          this.vel.y = (dy + 0.5 * G * returnT * returnT) / returnT;
        }
        d.quickReturnArmedPhase = d.phase;
      }
    }
    const sub = 2;
    const h = dt / sub;
    for (let i = 0; i < sub; i++) this.step(h, players);
    // visual spin
    if (this.spin.lengthSq() > 0.01 && this.isLive()) {
      const ang = this.spin.length() * dt;
      _axis.copy(this.spin).normalize();
      _q.setFromAxisAngle(_axis, ang);
      this.mesh.quaternion.premultiply(_q);
    }
    this.mesh.position.copy(this.pos);
    this._prevYSet = true;
  }

  step(dt, players) {
    this._prevY = this.pos.y;

    if (this.state === 'dribble' && this.dribble) this.dribble.contactT += dt;

    if (this.state === 'dribble' && this.dribble?.phase === 'down' && this.dribble.holder) {
      // An owned bounce follows the live dribbling side, just as the reference
      // game keeps the ball on its authored attachment node. The vertical motion
      // is still a real push to the floor, but a hard plant or reversal cannot
      // leave the ball travelling metres along the handler's old heading.
      const d = this.dribble;
      const anchor = d.guideAnchor ?? d.holder.dribbleAnchor(_anchor, d.releaseHand);
      const disc = this.vel.y * this.vel.y + 2 * G * Math.max(0, this.pos.y - R);
      const t = Math.max(0.04, (this.vel.y + Math.sqrt(Math.max(0, disc))) / G);
      const lead = d.guideVelocity ?? d.holder.vel;
      const ax = anchor.x + lead.x * t * 0.85;
      const az = anchor.z + lead.z * t * 0.85;
      const vx = clamp((ax - this.pos.x) / t, -13, 13);
      const vz = clamp((az - this.pos.z) / t, -13, 13);
      const k = Math.min(1, 26 * dt);
      this.vel.x += (vx - this.vel.x) * k;
      this.vel.z += (vz - this.vel.z) * k;
    }

    if (this.state === 'dribble' && this.dribble?.phase === 'up' && this.dribble.holder) {
      // Re-aim the rising ball at the palm that is actually moving through the
      // baked take. A one-time floor target misses when the authored hand path
      // travels across the body during the half-second return flight.
      const p = this.dribble.holder;
      const anchor = this.dribble.catchAnchor ?? p.dribbleAnchor(_anchor, this.dribble.hand);
      const dy = anchor.y - this.pos.y;
      const disc = this.vel.y * this.vel.y - 2 * G * dy;
      if (disc >= 0) {
        const root = Math.sqrt(disc);
        const roots = [
          (this.vel.y - root) / G,
          (this.vel.y + root) / G,
        ].filter((candidate) => candidate > 0.025);
        // On the way up, use the first palm-height crossing. Guide from the
        // bounce, not only during the last 24 cm: a hard reversal can happen
        // while the ball is still low, and waiting until it is already at the
        // hand leaves too little flight time to cancel the old trajectory.
        // Just after the apex only the descending crossing remains.
        const t = Math.max(0.05, roots.length ? Math.min(...roots) : 0.05);
        // Aim at where the palm will be at contact, not where it is now. The
        // old chase target was always one player-velocity * flight-time behind
        // a sprinting handler and missed completely on a sudden turn.
        // Linear lead is stable through a damped reversal. Extrapolating the
        // instantaneous yaw rate over the whole flight over-rotates the hand
        // after the turn has already eased and throws the ball sideways.
        const lead = this.dribble.catchVelocity ?? p.vel;
        const ax = anchor.x + lead.x * t;
        const az = anchor.z + lead.z * t;
        const vx = clamp((ax - this.pos.x) / t, -12, 12);
        const vz = clamp((az - this.pos.z) / t, -12, 12);
        const k = Math.min(1, 30 * dt);
        this.vel.x += (vx - this.vel.x) * k;
        this.vel.z += (vz - this.vel.z) * k;
      }
    }

    if (this.state === 'held') {
      // handled via updateAttach by the holder; just copy
      return;
    }

    // integrate
    this.vel.y -= G * dt;
    // The launch solver is vacuum ballistic. Applying drag only during free
    // loose-ball play keeps rolling rebounds lively without making every
    // authored shot land short of the result it was solved for.
    if (this.state === 'loose') this.vel.multiplyScalar(1 - 0.06 * dt);
    this.pos.addScaledVector(this.vel, dt);

    // ---- floor ----
    if (this.pos.y < R) {
      this.pos.y = R;
      if (this.state === 'dribble' && this.dribble && this.dribble.holder) {
        // player-driven bounce: rise to the hand with enough energy, aimed at the moving hand
        const p = this.dribble.holder;
        const catchH = Math.max(0.45, this.dribble.catchH);
        // Reach the palm close to the top of the bounce. The previous formula
        // treated the floor as y=0 instead of the ball centre at y=R and added
        // another 4.5% velocity, so the ball sailed through the hand at more
        // than the catch gate allowed and spent half a second floating above it.
        const quickT = this.dribble.quickReturn ? 0.15 : null;
        const vy = quickT
          ? (Math.max(0.12, catchH - R) + 0.5 * G * quickT * quickT) / quickT
          : Math.sqrt(2 * G * Math.max(0.18, catchH - R)) * 1.065;
        this.vel.y = vy;
        const tc = vy / G;
        // Come back up to where the hand will actually be. This used to be a
        // formula off the holder's position and facing, which is why the ball
        // could rise a hand's width away from the hand that was dribbling it.
        const anchor = p.dribbleAnchor(_anchor, this.dribble.hand);
        this.dribble.catchAnchor = anchor.clone();
        this.dribble.catchVelocity = p.vel.clone();
        this.dribble.bouncePoint.copy(this.pos);
        const ax = anchor.x + this.dribble.catchVelocity.x * tc;
        const az = anchor.z + this.dribble.catchVelocity.z * tc;
        this.vel.x = (ax - this.pos.x) / Math.max(tc, 0.05);
        this.vel.z = (az - this.pos.z) / Math.max(tc, 0.05);
        this.dribble.phase = 'up';
        this.events.push({ type: 'dribble-bounce' });
      } else if (this.vel.y < -0.4) {
        const impact = Math.abs(this.vel.y);
        this.vel.y = impact * 0.78;
        this.vel.x *= 0.94;
        this.vel.z *= 0.94;
        // a shot/pass that hits the floor becomes a live loose ball
        if (this.state === 'shot' || this.state === 'pass') {
          if (this.state === 'shot' && this.shot && !this.shot.scored) {
            this.events.push({ type: 'miss', shooter: this.shot.shooter });
          }
          this.state = 'loose';
          this.shot = null;
          this.dribble = null;
        }
        this.events.push({ type: 'floor-bounce', impact });
      } else {
        this.vel.y = 0;
        // rolling friction
        this.vel.x *= (1 - 2.2 * dt);
        this.vel.z *= (1 - 2.2 * dt);
        if (this.vel.lengthSq() < 0.04) this.vel.set(0, 0, 0);
      }
    }

    if (this.state === 'dribble' && this.dribble?.phase === 'up' && this.dribble.holder) {
      // The owned return travels from the real floor contact to the live catch
      // palm. Keeping the horizontal part kinematic is the crucial reference
      // behavior: turning a character rotates its socket immediately instead of
      // asking a free projectile to chase a hand that has crossed the body.
      const d = this.dribble;
      const anchor = d.guideAnchor ?? d.holder.dribbleAnchor(_anchor, d.hand);
      const u0 = clamp((this.pos.y - R) / Math.max(0.12, d.catchH - R), 0, 1);
      const u = u0 * u0 * (3 - 2 * u0);
      this.pos.x = THREE.MathUtils.lerp(d.bouncePoint.x, anchor.x, u);
      this.pos.z = THREE.MathUtils.lerp(d.bouncePoint.z, anchor.z, u);
    }

    // ---- rim (torus) ----
    {
      const rc = COURT.rimCenter;
      const px = this.pos.x - rc.x, pz = this.pos.z - rc.z;
      const rxz = Math.hypot(px, pz);
      if (Math.abs(this.pos.y - rc.y) < 0.6 && rxz < COURT.rimRadius + 0.35 && rxz > 1e-4) {
        const nx = px / rxz, nz = pz / rxz;
        // closest point on rim circle
        const cpx = rc.x + nx * COURT.rimRadius;
        const cpz = rc.z + nz * COURT.rimRadius;
        const cpy = rc.y;
        let dx = this.pos.x - cpx, dy = this.pos.y - cpy, dz = this.pos.z - cpz;
        const d = Math.hypot(dx, dy, dz);
        const minD = R + COURT.rimTube;
        if (d < minD && d > 1e-5) {
          dx /= d; dy /= d; dz /= d;
          const push = minD - d;
          this.pos.x += dx * push; this.pos.y += dy * push; this.pos.z += dz * push;
          const vn = this.vel.x * dx + this.vel.y * dy + this.vel.z * dz;
          if (vn < 0) {
            const e = 0.52;
            this.vel.x -= (1 + e) * vn * dx;
            this.vel.y -= (1 + e) * vn * dy;
            this.vel.z -= (1 + e) * vn * dz;
            // tangential slow + randomness (rattle)
            this.vel.x += (Math.random() - 0.5) * 0.5;
            this.vel.z += (Math.random() - 0.5) * 0.5;
            this.spin.multiplyScalar(0.4);
            if (this.shot) this.shot.rimHits++;
            this.events.push({ type: 'rim-hit', speed: Math.abs(vn) });
          }
        }
      }

      // ---- score detection: a complete downward cylinder traversal ----
      // Crossing the centre plane is not enough: at that instant half the ball
      // can still be above the iron and a subsequent rim bounce can spit it out.
      // Arm a make at the upper gate, cancel it on an upward/outward rejection,
      // and award only after the whole ball clears the lower gate.
      const shot = this.state === 'shot' ? this.shot : null;
      if (shot && !shot.scored) {
        const r = Math.hypot(this.pos.x - rc.x, this.pos.z - rc.z);
        const clearR = Math.max(0.04, COURT.rimRadius - R * 0.52);
        const upper = rc.y + R * 0.58;
        const lower = rc.y - R * 0.72;
        if (!shot.scoreCandidate && this._prevY > upper && this.pos.y <= upper &&
            this.vel.y < 0 && r < clearR) {
          shot.scoreCandidate = true;
        }
        if (shot.scoreCandidate && (this.vel.y >= 0 || r > clearR + 0.025)) {
          shot.scoreCandidate = false;
        }
        if (shot.scoreCandidate && this._prevY > lower && this.pos.y <= lower && this.vel.y < 0) {
          const clean = !shot.rimHits && !shot.boardHits;
          shot.scored = true;
          shot.scoreCandidate = false;
          this.events.push({ type: 'score', clean, speed: Math.abs(this.vel.y) });
          // A net takes energy out of the ball; without this the make shoots
          // through like an invisible hoop and barely moves the cloth.
          this.vel.x *= 0.72;
          this.vel.y *= 0.76;
          this.vel.z *= 0.72;
        }
      }
    }

    // ---- backboard ----
    {
      const faceZ = COURT.boardFaceZ;
      const halfW = COURT.boardWidth / 2 + R * 0.7;
      if (Math.abs(this.pos.x) < halfW &&
          this.pos.y > COURT.boardBottomY - R * 0.6 && this.pos.y < COURT.boardTopY + R * 0.6 &&
          this.pos.z < faceZ + R && this.pos.z > faceZ - R - 0.12) {
        if (this.vel.z < 0 && this.pos.z > faceZ - 0.05) {
          // hit front face coming from court side
          this.pos.z = faceZ + R;
          this.vel.z = Math.abs(this.vel.z) * 0.68;
          this.vel.x *= 0.85;
          this.vel.y *= 0.92;
          if (this.shot) this.shot.boardHits = (this.shot.boardHits ?? 0) + 1;
          this.events.push({ type: 'board-hit', speed: Math.abs(this.vel.z) });
        }
      }
      // board edge/top
      if (Math.abs(this.pos.x) < halfW + 0.1 && this.pos.z < faceZ + R && this.pos.z > faceZ - R - 0.1) {
        if (this.pos.y > COURT.boardTopY - R * 0.5 && this.pos.y < COURT.boardTopY + R && this.vel.y > 0) {
          this.pos.y = COURT.boardTopY + R;
          this.vel.y *= -0.5;
        }
      }
    }

    // ---- ground out-of-play guard (fence) ----
    {
      const limX = 8.95, limZn = -2.15, limZp = 16.15;
      if (this.pos.x < -limX || this.pos.x > limX || this.pos.z < limZn || this.pos.z > limZp) {
        // clamp inside + weak bounce back
        this.pos.x = clamp(this.pos.x, -limX, limX);
        this.pos.z = clamp(this.pos.z, limZn, limZp);
        this.vel.x *= -0.25;
        this.vel.z *= -0.25;
      }
    }

    // ---- players (loose ball body collision) ----
    if (this.state === 'loose' || this.state === 'shot') {
      for (const p of players) {
        if (!p.active) continue;
        // The pickup action is already resolving hand contact. Treating that
        // same body as a generic collider kicks the ball away from the reaching
        // hand every substep.
        if (p.action?.name === 'pickup') continue;
        const dx = this.pos.x - p.pos.x;
        const dz = this.pos.z - p.pos.z;
        const dy = this.pos.y - (0.5 + p.pos.y * 0);
        const d = Math.hypot(dx, dy, dz);
        if (d < 0.34 && d > 1e-5) {
          const push = (0.34 - d) / d;
          this.pos.x += dx * push * 0.4;
          this.pos.z += dz * push * 0.4;
          this.vel.x *= 0.7; this.vel.z *= 0.7;
        }
      }
    }
  }

  consumeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _anchor = new THREE.Vector3();
const _attachD = new THREE.Vector3();

let sharedBallTextures = null;

function getBallTextures() {
  if (!sharedBallTextures) {
    sharedBallTextures = {
      standard: makeBallTexture({
        base: '#c25a1e', dark: '60,20,5', light: '255,190,130', pebble: '80,30,8', seam: '#1a0e06',
      }),
      money: makeBallTexture({
        base: '#45dce8', dark: '4,52,61', light: '190,255,255', pebble: '7,70,77', seam: '#062a30',
      }),
      logo: makeBallTexture({
        base: '#3e70ff', dark: '8,20,74', light: '190,207,255', pebble: '12,30,92', seam: '#071337',
      }),
    };
  }
  return sharedBallTextures;
}

function makeBallTexture(palette) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  // base leather orange with noise
  ctx.fillStyle = palette.base;
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 9000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const v = Math.random();
    ctx.fillStyle = v < 0.5
      ? `rgba(${palette.dark},${0.05 + Math.random() * 0.12})`
      : `rgba(${palette.light},${0.03 + Math.random() * 0.07})`;
    ctx.fillRect(x, y, 2, 2);
  }
  // pebble dots
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = `rgba(${palette.pebble},${0.1 + Math.random() * 0.15})`;
    ctx.beginPath();
    ctx.arc(Math.random() * S, Math.random() * S, 1.2 + Math.random() * 1.2, 0, 7);
    ctx.fill();
  }
  // seams
  ctx.strokeStyle = palette.seam;
  ctx.lineWidth = 7;
  ctx.beginPath(); ctx.moveTo(S * 0.25, 0); ctx.lineTo(S * 0.25, S); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(S * 0.75, 0); ctx.lineTo(S * 0.75, S); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, S * 0.5); ctx.lineTo(S, S * 0.5); ctx.stroke();
  // curved seams
  ctx.lineWidth = 6;
  ctx.beginPath();
  for (let x = 0; x <= S; x += 4) {
    const y = S * 0.5 + Math.sin((x / S) * Math.PI * 2) * S * 0.18;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.beginPath();
  for (let x = 0; x <= S; x += 4) {
    const y = S * 0.5 - Math.sin((x / S) * Math.PI * 2) * S * 0.18;
    x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
