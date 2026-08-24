import * as THREE from 'three';

const TRAIL_MAX = 30;
const BURST_MAX = 48;

/** Small pooled basketball feedback: one shot trail, one impact burst, one flash. */
export class FeedbackFx {
  constructor(scene) {
    this.lastKind = null;

    this.trailPos = new Float32Array(TRAIL_MAX * 3);
    this.trailGeo = new THREE.BufferGeometry();
    this.trailGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3));
    this.trailGeo.setDrawRange(0, 0);
    this.trailMat = new THREE.PointsMaterial({
      color: 0x66ff8a, size: 0.085, map: glowTexture(), transparent: true,
      opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.trailPoints = new THREE.Points(this.trailGeo, this.trailMat);
    this.trailPoints.frustumCulled = false;
    scene.add(this.trailPoints);
    this.trail = [];
    this.trailLife = 0;
    this.trailDuration = 0;
    this.trailBall = null;

    this.burstPos = new Float32Array(BURST_MAX * 3);
    this.burstColor = new Float32Array(BURST_MAX * 3);
    this.burstGeo = new THREE.BufferGeometry();
    this.burstGeo.setAttribute('position', new THREE.BufferAttribute(this.burstPos, 3));
    this.burstGeo.setAttribute('color', new THREE.BufferAttribute(this.burstColor, 3));
    this.burstGeo.setDrawRange(0, 0);
    this.burstMat = new THREE.PointsMaterial({
      size: 0.17, map: glowTexture(), vertexColors: true, transparent: true,
      opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.burstPoints = new THREE.Points(this.burstGeo, this.burstMat);
    this.burstPoints.frustumCulled = false;
    scene.add(this.burstPoints);
    this.burstVelocity = Array.from({ length: BURST_MAX }, () => new THREE.Vector3());
    this.burstLife = 0;
    this.burstDuration = 0;
    this.burstCount = 0;

    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.flash.visible = false;
    scene.add(this.flash);
    this.flashLife = 0;
    this.flashDuration = 0;
  }

  perfectRelease(ball) {
    this.lastKind = 'perfect-release';
    this.trailBall = ball;
    this.trailLife = this.trailDuration = 1.15;
    this.trail.length = 0;
    this.trailMat.color.setHex(0x64ff89);
    this.spark(ball.pos, 16, 0x70ff96, 0xffffff, 0.42, 1.5);
  }

  dunk(rim) {
    this.lastKind = 'dunk-impact';
    this.spark(rim, 48, 0xff7b32, 0xffffff, 0.62, 5.2);
    this.rimFlash(rim, 0xff8d3c, 0.38);
  }

  score(rim, clean = false, dunk = false) {
    this.lastKind = dunk ? 'dunk-score' : (clean ? 'clean-score' : 'score');
    this.spark(rim, dunk ? 40 : 28, clean ? 0x70ff9a : 0xffd36a, 0xffffff,
      dunk ? 0.58 : 0.44, dunk ? 4.0 : 2.7);
    this.rimFlash(rim, clean ? 0x72ff9a : 0xffdf87, dunk ? 0.36 : 0.25);
  }

  spark(origin, count, colorA, colorB, duration, speed) {
    this.burstCount = Math.min(BURST_MAX, count);
    this.burstLife = this.burstDuration = duration;
    const a = new THREE.Color(colorA), b = new THREE.Color(colorB), c = new THREE.Color();
    for (let i = 0; i < this.burstCount; i++) {
      const j = i * 3;
      this.burstPos[j] = origin.x; this.burstPos[j + 1] = origin.y; this.burstPos[j + 2] = origin.z;
      c.copy(a).lerp(b, Math.random());
      this.burstColor[j] = c.r; this.burstColor[j + 1] = c.g; this.burstColor[j + 2] = c.b;
      const ang = Math.random() * Math.PI * 2;
      const radial = speed * (0.35 + Math.random() * 0.65);
      this.burstVelocity[i].set(
        Math.cos(ang) * radial,
        (Math.random() - 0.12) * speed * 0.8,
        Math.sin(ang) * radial,
      );
    }
    this.burstGeo.setDrawRange(0, this.burstCount);
    this.burstGeo.attributes.position.needsUpdate = true;
    this.burstGeo.attributes.color.needsUpdate = true;
    this.burstMat.opacity = 1;
  }

  rimFlash(origin, color, duration) {
    this.flash.position.copy(origin);
    this.flash.material.color.setHex(color);
    this.flashLife = this.flashDuration = duration;
    this.flash.scale.setScalar(0.18);
    this.flash.material.opacity = 1;
    this.flash.visible = true;
  }

  update(dt, ball) {
    if (this.trailLife > 0 && this.trailBall === ball && ball.state === 'shot') {
      this.trailLife = Math.max(0, this.trailLife - dt);
      if (!this.trail.length || this.trail[0].distanceToSquared(ball.pos) > 0.0016) {
        this.trail.unshift(ball.pos.clone());
        if (this.trail.length > TRAIL_MAX) this.trail.length = TRAIL_MAX;
      }
      for (let i = 0; i < this.trail.length; i++) {
        const p = this.trail[i], j = i * 3;
        this.trailPos[j] = p.x; this.trailPos[j + 1] = p.y; this.trailPos[j + 2] = p.z;
      }
      this.trailGeo.setDrawRange(0, this.trail.length);
      this.trailGeo.attributes.position.needsUpdate = true;
      this.trailMat.opacity = 0.9 * Math.min(1, this.trailLife / 0.28);
    } else if (this.trailLife > 0) {
      this.trailLife = Math.max(0, this.trailLife - dt * 2.5);
      this.trailMat.opacity = 0.9 * Math.min(1, this.trailLife / 0.28);
    } else {
      this.trailGeo.setDrawRange(0, 0);
      this.trailMat.opacity = 0;
    }

    if (this.burstLife > 0) {
      this.burstLife = Math.max(0, this.burstLife - dt);
      for (let i = 0; i < this.burstCount; i++) {
        const j = i * 3, v = this.burstVelocity[i];
        this.burstPos[j] += v.x * dt;
        this.burstPos[j + 1] += v.y * dt;
        this.burstPos[j + 2] += v.z * dt;
        v.y -= 5.8 * dt;
        v.multiplyScalar(1 - 1.8 * dt);
      }
      this.burstGeo.attributes.position.needsUpdate = true;
      this.burstMat.opacity = Math.min(1, this.burstLife / 0.16);
    } else {
      this.burstGeo.setDrawRange(0, 0);
      this.burstMat.opacity = 0;
    }

    if (this.flashLife > 0) {
      this.flashLife = Math.max(0, this.flashLife - dt);
      const u = 1 - this.flashLife / this.flashDuration;
      this.flash.scale.setScalar(0.24 + u * 1.55);
      this.flash.material.opacity = (1 - u) * 0.9;
    } else {
      this.flash.visible = false;
    }
  }

  state() {
    return {
      kind: this.lastKind,
      trail: this.trailLife > 0,
      particles: this.burstLife > 0 ? this.burstCount : 0,
      flash: this.flashLife > 0,
    };
  }
}

let _glow = null;
function glowTexture() {
  if (_glow) return _glow;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,255,255,.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
  _glow = new THREE.CanvasTexture(canvas);
  return _glow;
}
