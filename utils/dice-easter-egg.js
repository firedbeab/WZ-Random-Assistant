// 彩蛋规则与界面分离：只统计动画完成的投掷，关闭中途动画不消耗次数。
function randomFace(random = Math.random) {
  return Math.floor(random() * 6) + 1;
}

function unlockTapCount(testMode, random = Math.random) {
  return testMode ? 5 : Math.floor(random() * 16) + 5;
}

const SCENARIOS = {
  pairs: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 1, 1, 2, 2],
  triples: [1, 1, 1, 2, 2, 2],
  mixed: [1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 5]
};

function newRound(options = {}, random = Math.random) {
  const scenario = options.scenario || (options.testMode ? 'quick' : 'normal');
  const pityAfter = scenario === 'quick' ? 6 : (options.pityAfter || Math.floor(random() * 47) + 50);
  return {
    rolls: scenario === 'pity' ? pityAfter - 2 : 0,
    lastFace: 0, streak: 0, pairCount: 0, tripleCount: 0,
    forcedFace: 0, won: false, winReason: '', scenario, pityAfter,
    earlyPairAt: Math.floor(random() * 4) + 2
  };
}

function nextRoll(round, testMode, random = Math.random) {
  if (round.won) return round;
  const forcedFace = round.forcedFace || (round.rolls >= round.pityAfter ? randomFace(random) : 0);
  const script = SCENARIOS[round.scenario];
  let face = script ? script[round.rolls % script.length] : (forcedFace || randomFace(random));
  // 自然二连已出现时不再干预；只强制一次重复，不制造额外三连。
  if (!script && !forcedFace && !round.pairCount && round.lastFace && round.rolls + 1 === round.earlyPairAt) face = round.lastFace;
  const streak = face === round.lastFace ? round.streak + 1 : 1;
  const pairCount = round.pairCount + (streak === 2 ? 1 : 0);
  const tripleCount = round.tripleCount + (streak === 3 ? 1 : 0);
  // 快速测试专门覆盖四连；累计路径由各自场景和正式随机场景覆盖。
  const winReason = streak >= 4 ? 'four' : round.scenario === 'quick' ? '' : tripleCount >= 2 ? 'triples' : pairCount >= 8 ? 'pairs' : '';
  return {
    ...round,
    rolls: round.rolls + 1,
    lastFace: face,
    streak,
    forcedFace,
    pairCount, tripleCount, winReason,
    dots: winReason === 'four' ? 2 : Math.min(round.scenario === 'quick' ? 1 : 2, Math.max(Math.floor(pairCount / 4), tripleCount)),
    won: Boolean(winReason)
  };
}

module.exports = { unlockTapCount, newRound, nextRoll, SCENARIOS };
