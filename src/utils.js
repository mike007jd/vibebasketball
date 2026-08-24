import * as THREE from 'three';

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const rand = (a, b) => a + Math.random() * (b - a);
export const randSign = () => (Math.random() < 0.5 ? -1 : 1);
export const TAU = Math.PI * 2;

/** shortest signed angle from a to b */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** frame-rate independent damp for angles */
export function dampAngle(a, b, lambda, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
}

export function moveTowards(a, b, maxDelta) {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
}

export const dist2D = (ax, az, bx, bz) => Math.hypot(ax - bx, az - bz);

/** horizontal length of a vector3 */
export const lenXZ = (v) => Math.hypot(v.x, v.z);

export function normalizeXZ(v, out = new THREE.Vector3()) {
  const l = Math.hypot(v.x, v.z);
  if (l < 1e-6) { out.set(0, 0, 0); return out; }
  out.set(v.x / l, 0, v.z / l);
  return out;
}

/**
 * Solve ballistic launch velocity to hit target from origin with a given apex height above the higher of the two.
 * Returns velocity vector or null if unreachable.
 */
export function solveBallistic(origin, target, apexAboveMax, g = 9.81) {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  const dxz = Math.hypot(dx, dz);
  const yMax = Math.max(origin.y, target.y) + apexAboveMax;
  const up = yMax - origin.y;
  const down = yMax - target.y;
  if (up <= 0.01 || down <= 0.01) return null;
  const vUp = Math.sqrt(2 * g * up);
  const tUp = vUp / g;
  const tDown = Math.sqrt(2 * down / g);
  const t = tUp + tDown;
  return new THREE.Vector3(dx / t, vUp, dz / t);
}

/** deterministic-ish id */
let _id = 0;
export const nextId = () => ++_id;
