import { clamp } from '../utils.js';
import { releaseMakeMultiplier } from './shotTiming.js';

/**
 * Pure jump-shot probability shared by live gameplay and deterministic
 * three-point-contest simulation. Keeping the formula here prevents the CPU
 * skip path from using a cheaper scoring model than a watched shot.
 */
export function jumpShotProbability({
  distance,
  timingQuality,
  contest = 0,
  stamina = 1,
  moving = false,
}) {
  const fatigue = 0.78 + (1 - 0.78) * clamp(stamina, 0, 1);
  const base = clamp(1.02 - distance * 0.052, 0.36, 0.94);
  const movingMultiplier = moving ? 0.9 : 1;
  return clamp(
    base * releaseMakeMultiplier(timingQuality) *
      (1 - clamp(contest, 0, 1) * 0.55) * fatigue * movingMultiplier,
    0.005,
    0.96,
  );
}

export function decideJumpShot(params, rng = Math.random) {
  const probability = jumpShotProbability(params);
  return {
    probability,
    made: params.timingQuality >= 1 || rng() < probability,
  };
}
