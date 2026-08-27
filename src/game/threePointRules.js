import { releaseTiming } from './shotTiming.js';
import { decideJumpShot } from './shotOutcome.js';

export const THREE_POINT_FORMAT = Object.freeze({
  roundSeconds: 70,
  advanceTiebreakSeconds: 30,
  championshipTiebreakSeconds: 70,
  fieldSize: 4,
  finalists: 3,
  maxScore: 40,
});

export const RACK_IDS = Object.freeze([
  'left-corner', 'left-wing', 'top', 'right-wing', 'right-corner',
]);

export const STATIONS = Object.freeze([
  Object.freeze({ id: 'left-corner', label: 'LEFT CORNER', kind: 'rack', distance: 6.75 }),
  Object.freeze({ id: 'left-wing', label: 'LEFT WING', kind: 'rack', distance: 6.75 }),
  Object.freeze({ id: 'left-logo', label: 'FROM THE LOGO', kind: 'logo', distance: 8.58 }),
  Object.freeze({ id: 'top', label: 'TOP', kind: 'rack', distance: 6.75 }),
  Object.freeze({ id: 'right-logo', label: 'FROM THE LOGO', kind: 'logo', distance: 8.58 }),
  Object.freeze({ id: 'right-wing', label: 'RIGHT WING', kind: 'rack', distance: 6.75 }),
  Object.freeze({ id: 'right-corner', label: 'RIGHT CORNER', kind: 'rack', distance: 6.75 }),
]);

export const CONTEST_ROSTER = Object.freeze([
  Object.freeze({ id: 'volt', name: 'VOLT', user: true, timingSpread: 0, pace: 1.42, accent: '#ff9a3c', moneyRack: 'right-wing' }),
  Object.freeze({ id: 'nova', name: 'NOVA', timingSpread: 0.26, pace: 1.42, accent: '#f55cff', moneyRack: 'top' }),
  Object.freeze({ id: 'mira', name: 'MIRA', timingSpread: 0.32, pace: 1.45, accent: '#72ff98', moneyRack: 'left-wing' }),
  Object.freeze({ id: 'jett', name: 'JETT', timingSpread: 0.34, pace: 1.38, accent: '#ff665e', moneyRack: 'right-wing' }),
]);

export function buildAttemptSequence(moneyRack = 'top') {
  if (!RACK_IDS.includes(moneyRack)) throw new Error(`Unknown money rack: ${moneyRack}`);
  const attempts = [];
  let index = 0;
  for (let stationIndex = 0; stationIndex < STATIONS.length; stationIndex++) {
    const station = STATIONS[stationIndex];
    const values = station.kind === 'logo'
      ? [3]
      : station.id === moneyRack ? [2, 2, 2, 2, 2] : [1, 1, 1, 1, 2];
    for (let ballIndex = 0; ballIndex < values.length; ballIndex++) {
      attempts.push(Object.freeze({
        id: `attempt-${index + 1}`,
        index,
        stationIndex,
        stationId: station.id,
        stationLabel: station.label,
        kind: station.kind === 'logo' ? 'logo' : (station.id === moneyRack || ballIndex === 4 ? 'money' : 'standard'),
        ballIndex,
        value: values[ballIndex],
        distance: station.distance,
      }));
      index++;
    }
  }
  return attempts;
}

export function scoreAttempts(attempts) {
  return attempts.reduce((score, attempt) => score + (attempt.made && attempt.timely !== false ? attempt.value : 0), 0);
}

export function hashSeed(value) {
  const text = String(value ?? 'vibe-basketball');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRandom(seed) {
  let a = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bellish(rng) {
  return (rng() + rng() + rng() + rng() - 2) / 2;
}

/** Build the immutable result plan used by both watched and skipped CPU turns. */
export function buildCpuRoundPlan(profile, moneyRack, seed, timeLimit = THREE_POINT_FORMAT.roundSeconds) {
  const rng = seededRandom(`${seed}:${profile.id}:${moneyRack}:${timeLimit}`);
  const source = buildAttemptSequence(moneyRack);
  let releasedAt = 1.15;
  let priorStation = -1;
  const attempts = source.map((attempt) => {
    if (attempt.stationIndex !== priorStation) {
      if (priorStation >= 0) releasedAt += 1.65 + rng() * 0.55;
      priorStation = attempt.stationIndex;
    }
    releasedAt += profile.pace * (0.88 + rng() * 0.22);
    const offset = bellish(rng) * profile.timingSpread;
    const timingQuality = releaseTiming(Math.abs(offset), 'jump').quality;
    const outcome = decideJumpShot({
      distance: attempt.distance,
      timingQuality,
      contest: 0,
      stamina: 0.92,
      moving: false,
    }, rng);
    const timely = releasedAt <= timeLimit + 1e-6;
    return Object.freeze({
      ...attempt,
      releaseOffset: offset,
      timingQuality,
      probability: outcome.probability,
      made: timely && outcome.made,
      timely,
      releasedAt: +releasedAt.toFixed(3),
    });
  });
  return Object.freeze({
    entrantId: profile.id,
    moneyRack,
    timeLimit,
    attempts: Object.freeze(attempts),
    score: scoreAttempts(attempts),
  });
}

export function sortStandings(entries) {
  return [...entries].sort((a, b) => b.score - a.score || a.order - b.order);
}

/** Seed the final from first-round results; tiebreak scores decide advancement only. */
export function orderFinalists(qualifierRecords, firstRoundRecords) {
  const firstByEntrant = new Map(firstRoundRecords.map((record) => [record.entrantId, record]));
  return [...qualifierRecords].sort((a, b) => {
    const firstA = firstByEntrant.get(a.entrantId) ?? a;
    const firstB = firstByEntrant.get(b.entrantId) ?? b;
    return firstA.score - firstB.score || firstB.order - firstA.order;
  });
}

export function advancementDecision(entries, slots = THREE_POINT_FORMAT.finalists) {
  const sorted = sortStandings(entries);
  if (sorted.length <= slots) return { qualifiers: sorted, tied: [], cutoff: sorted.at(-1)?.score ?? 0 };
  const cutoff = sorted[slots - 1].score;
  const safe = sorted.filter((entry) => entry.score > cutoff);
  const tied = sorted.filter((entry) => entry.score === cutoff);
  const openSlots = slots - safe.length;
  return tied.length > openSlots
    ? { qualifiers: safe, tied, cutoff, openSlots }
    : { qualifiers: sorted.slice(0, slots), tied: [], cutoff, openSlots: 0 };
}

export function championshipDecision(entries) {
  const sorted = sortStandings(entries);
  const topScore = sorted[0]?.score ?? 0;
  const tied = sorted.filter((entry) => entry.score === topScore);
  return tied.length === 1 ? { winner: tied[0], tied: [] } : { winner: null, tied };
}
