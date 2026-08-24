/**
 * One high-risk/reward release profile shared by gameplay and the meter.
 *
 * The error values are normalized action time around the authored release
 * frame. `perfect` is intentionally narrow and deterministic. `stable` is the
 * readable amber timing band; outside `playable` the meter is red and a make
 * is exceptional rather than a routine dice roll.
 */
export const SHOT_TIMING = Object.freeze({
  jump: Object.freeze({ perfect: 0.025, stable: 0.095, playable: 0.16, span: 0.72 }),
  layup: Object.freeze({ perfect: 0.035, stable: 0.105, playable: 0.18, span: 0.92 }),
});

export function releaseTiming(error, kind = 'jump') {
  const band = SHOT_TIMING[kind] ?? SHOT_TIMING.jump;
  const e = Math.abs(error);
  if (e <= band.perfect) return { quality: 1, grade: 'perfect' };
  if (e <= band.stable) return { quality: 0.78, grade: 'good' };
  if (e <= band.playable) return { quality: 0.55, grade: 'ok' };
  return { quality: 0.32, grade: 'bad' };
}

/** Probability multiplier applied after distance, fatigue and contest. */
export function releaseMakeMultiplier(timingQuality) {
  if (timingQuality >= 1) return 1;
  if (timingQuality >= 0.78) return 0.88;
  if (timingQuality >= 0.55) return 0.46;
  return 0.018;
}
