import assert from 'node:assert/strict';
import {
  THREE_POINT_FORMAT,
  RACK_IDS,
  CONTEST_ROSTER,
  buildAttemptSequence,
  buildCpuRoundPlan,
  scoreAttempts,
  advancementDecision,
  championshipDecision,
  orderFinalists,
} from '../src/game/threePointRules.js';
import { COURT } from '../src/world/court.js';
import { CONTEST_SPOTS, SHOOTER_LINE_CLEARANCE } from '../src/world/contestRacks.js';

assert.deepEqual(
  [THREE_POINT_FORMAT.roundSeconds, THREE_POINT_FORMAT.advanceTiebreakSeconds, THREE_POINT_FORMAT.championshipTiebreakSeconds],
  [70, 30, 70],
);
assert.equal(THREE_POINT_FORMAT.fieldSize, 4, 'local contest must use exactly the four setup cards');

for (const rack of RACK_IDS) {
  const attempts = buildAttemptSequence(rack);
  assert.equal(attempts.length, 27, `${rack} should contain 27 attempts`);
  assert.equal(attempts.reduce((sum, attempt) => sum + attempt.value, 0), THREE_POINT_FORMAT.maxScore);
  assert.equal(attempts.filter((attempt) => attempt.kind === 'logo').length, 2);
  assert.deepEqual(
    attempts.filter((attempt) => attempt.stationId === rack).map((attempt) => attempt.value),
    [2, 2, 2, 2, 2],
  );
  assert.equal(scoreAttempts(attempts.map((attempt) => ({ ...attempt, made: true }))), 40);
}

for (const spot of CONTEST_SPOTS.filter((entry) => entry.kind === 'rack')) {
  const clearance = spot.id.includes('corner')
    ? Math.abs(spot.position.x) - COURT.cornerX
    : Math.hypot(
      spot.position.x - COURT.rimCenter.x,
      spot.position.z - COURT.rimCenter.z,
    ) - COURT.threeR;
  assert(clearance >= SHOOTER_LINE_CLEARANCE - 0.01,
    `${spot.id} shooter root must stay visibly behind the three-point line: ${clearance}`);
}

const profile = CONTEST_ROSTER.find((entry) => entry.id === 'nova');
const planA = buildCpuRoundPlan(profile, 'top', 'determinism');
const planB = buildCpuRoundPlan(profile, 'top', 'determinism');
assert.deepEqual(planA, planB, 'same seed must produce the same watched/skipped result plan');
assert(planA.score >= 0 && planA.score <= 40);

const calibratedScores = CONTEST_ROSTER.filter((entry) => !entry.user).map((entry) =>
  buildCpuRoundPlan(entry, entry.moneyRack, `vibe-2026:first:${entry.id}:1`).score);
assert(calibratedScores.every((score) => score >= 15 && score <= 30),
  `default field should sit in the calibrated 15-30 range: ${calibratedScores.join(', ')}`);

const advanceTie = advancementDecision([
  { id: 'a', score: 27, order: 0 },
  { id: 'b', score: 24, order: 1 },
  { id: 'c', score: 20, order: 2 },
  { id: 'd', score: 20, order: 3 },
  { id: 'e', score: 18, order: 4 },
]);
assert.deepEqual(advanceTie.qualifiers.map((entry) => entry.id), ['a', 'b']);
assert.deepEqual(advanceTie.tied.map((entry) => entry.id), ['c', 'd']);
assert.equal(advanceTie.openSlots, 1);

const championTie = championshipDecision([
  { id: 'a', score: 28, order: 0 },
  { id: 'b', score: 28, order: 1 },
  { id: 'c', score: 24, order: 2 },
]);
assert.equal(championTie.winner, null);
assert.deepEqual(championTie.tied.map((entry) => entry.id), ['a', 'b']);

const finalOrder = orderFinalists([
  { entrantId: 'safe-first', score: 25, order: 0 },
  { entrantId: 'safe-second', score: 23, order: 1 },
  { entrantId: 'tiebreak-winner', score: 40, order: 0 },
], [
  { entrantId: 'safe-first', score: 25, order: 0 },
  { entrantId: 'safe-second', score: 23, order: 1 },
  { entrantId: 'tiebreak-winner', score: 20, order: 2 },
]);
assert.deepEqual(
  finalOrder.map((entry) => entry.entrantId),
  ['tiebreak-winner', 'safe-second', 'safe-first'],
  'final order must use inverse first-round scores, never the 30-second tiebreak score',
);

console.log(`PASS three-point rules: ${RACK_IDS.length} money-rack placements, 27 balls, 40 max, deterministic CPU plans, official ties`);
