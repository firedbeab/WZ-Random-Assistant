const assert = require('node:assert/strict');
const { newRound, nextRoll, unlockTapCount } = require('../../utils/dice-easter-egg');
function rng(seed) { let state = seed; return () => ((state = Math.imul(state, 1664525) + 1013904223 >>> 0) / 4294967296); }
function run(scenario, count) { let r = newRound({ scenario }); const result = []; for (let i = 0; i < count; i++) { r = nextRoll(r, true); result.push(r); } return result; }
assert.equal(unlockTapCount(true), 5);
assert.equal(unlockTapCount(false, () => 0), 5);
assert.equal(unlockTapCount(false, () => .999999), 20);
assert.equal(newRound({}, () => 0).pityAfter, 50);
assert.equal(newRound({}, () => .999999).pityAfter, 96);
const pairs = run('pairs', 16);
assert.equal(pairs[6].dots, 0); assert.equal(pairs[7].dots, 1);
assert.equal(pairs[14].won, false); assert.equal(pairs[15].winReason, 'pairs'); assert.equal(pairs[15].pairCount, 8);
const triples = run('triples', 6);
assert.equal(triples[2].dots, 1); assert.equal(triples[2].pairCount, 1); assert.equal(triples[2].tripleCount, 1);
assert.equal(triples[5].winReason, 'triples');
const mixed = run('mixed', 12);
assert.equal(mixed[8].pairCount, 4); assert.equal(mixed[8].tripleCount, 1); assert.equal(mixed[8].dots, 1); assert.equal(mixed[8].won, false);
assert.equal(mixed[11].winReason, 'triples');
for (const pity of [50, 96]) {
  let r = { ...newRound({ scenario: 'normal', pityAfter: pity }), rolls: pity, lastFace: 6, streak: 1, pairCount: 1 };
  for (let i = 0; i < 4; i++) r = nextRoll(r, false, () => 0);
  assert.equal(r.rolls, pity + 4); assert.equal(r.winReason, 'four'); assert.equal(r.forcedFace, 1);
  assert.equal(nextRoll(r, false), r);
}
const results = { rounds: 100000, reasons: {}, rolls: [] };
for (let seed = 1; seed <= results.rounds; seed++) {
  const random = rng(seed);
  let r = newRound({ scenario: 'normal' }, random), early = false;
  while (!r.won) {
    r = nextRoll(r, false, random);
    if (r.rolls <= 5 && r.pairCount) early = true;
    assert.ok(r.rolls <= r.pityAfter + 4);
  }
  assert.ok(early, `first-five pair: ${seed}`);
  results.reasons[r.winReason] = (results.reasons[r.winReason] || 0) + 1;
  results.rolls.push(r.rolls);
  let test = newRound({ scenario: 'quick' }, random);
  while (!test.won) test = nextRoll(test, true, random);
  assert.ok(test.rolls <= 10);
  assert.equal(test.winReason, 'four');
}
results.rolls.sort((a, b) => a - b);
console.log(JSON.stringify({ passed: true, rounds: results.rounds, winReasons: results.reasons, medianRolls: results.rolls[49999], p90Rolls: results.rolls[89999], maxRolls: results.rolls[99999] }, null, 2));
