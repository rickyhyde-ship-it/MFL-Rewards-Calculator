// === UTILITIES ===

function roundUpToNearest005(value) {
  return Math.ceil(value * 20) / 20;
}

function parseRewardAmount(lines) {
  if (!lines || lines.length === 0) return 0;
  const match = String(lines[0]).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

// === API ===

// === CALCULATIONS ===

function getOwnershipType(title, contractsData) {
  if (title !== 'MFL_OWNER') return 'Staff';
  const hasManager = contractsData.items.some(
    c => c.type === 'MANAGER' && c.status === 'ACTIVE'
  );
  return hasManager ? 'Owned | Hired Manager' : 'Owned';
}

function getOwnerDeductions(contractsData) {
  const active = contractsData.items.filter(c => c.status === 'ACTIVE');
  const playerMultiplier = active
    .filter(c => c.type === 'PLAYER')
    .reduce((sum, c) => sum + c.revenueShare, 0) / 10000;
  const managerMultiplier = active
    .filter(c => c.type === 'MANAGER')
    .reduce((sum, c) => sum + c.revenueShare, 0) / 10000;
  return { playerMultiplier, managerMultiplier };
}

function getStaffEarningsMultiplier(contractsData, walletAddress) {
  const contract = contractsData.items.find(
    c => c.type === 'MANAGER' && c.status === 'ACTIVE' && c.manager === walletAddress
  );
  return contract ? contract.revenueShare / 10000 : 0;
}

function sortLeagueMembers(members) {
  return [...members].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const gdA = a.goals - a.goalsAgainst;
    const gdB = b.goals - b.goalsAgainst;
    if (gdB !== gdA) return gdB - gdA;
    return b.goals - a.goals;
  });
}

function getLeagueRank(members, clubId) {
  const sorted = sortLeagueMembers(members);
  const idx = sorted.findIndex(m => m.clubId === clubId);
  if (idx === -1) return null;

  const club = sorted[idx];
  const clubGD = club.goals - club.goalsAgainst;

  // Find all clubs tied with this one (same points, GD, goals)
  const tiedIndices = sorted
    .map((m, i) => ({ m, i }))
    .filter(({ m }) =>
      m.points === club.points &&
      (m.goals - m.goalsAgainst) === clubGD &&
      m.goals === club.goals
    )
    .map(({ i }) => i);

  // Assign the lower (worst) position among all tied clubs
  return Math.max(...tiedIndices) + 1;
}

function rankMatchesReward(rewardRanks, rank) {
  if (String(rewardRanks).includes('-')) {
    const [min, max] = String(rewardRanks).split('-').map(Number);
    return rank >= min && rank <= max;
  }
  const n = parseInt(rewardRanks, 10);
  return !isNaN(n) && n === rank;
}

function getLeagueReward(competition, clubId) {
  const members = competition.schedule.stages[0].groups[0].members;
  const rank = getLeagueRank(members, clubId);
  if (rank === null) return 0;

  for (const reward of competition.rewards) {
    if (rankMatchesReward(reward.ranks, rank)) {
      return parseRewardAmount(reward.lines);
    }
  }
  return 0;
}

function getCupGroupWins(competition, clubId) {
  for (const group of competition.schedule.stages[0].groups) {
    const member = group.members.find(m => m.clubId === clubId);
    if (member) return member.wins;
  }
  return 0;
}

function getCupGroupWinPrize(competition) {
  const reward = competition.rewards.find(r => r.ranks === 'Group Stage Win');
  return reward ? parseRewardAmount(reward.lines) : 0;
}

function getCupPlacementReward(competition, clubId) {
  for (const reward of competition.rewards) {
    if (!reward.participants || !Array.isArray(reward.participants)) continue;
    if (reward.participants.includes(clubId)) {
      return parseRewardAmount(reward.lines);
    }
  }
  return 0;
}

function getCupReward(competition, clubId) {
  const placementReward = getCupPlacementReward(competition, clubId);
  const winPrize = getCupGroupWinPrize(competition);
  const wins = getCupGroupWins(competition, clubId);
  return placementReward + (wins * winPrize);
}

function getCupStageLabel(competition, clubId) {
  for (const reward of competition.rewards) {
    if (!reward.participants || !Array.isArray(reward.participants)) continue;
    if (reward.participants.includes(clubId)) return reward.ranks;
  }
  const wins = getCupGroupWins(competition, clubId);
  return `Group Stage, ${wins} win${wins !== 1 ? 's' : ''}`;
}

function calculateClub(clubEntry, contractsData, leagueComp, cupComp, walletAddress) {
  const clubId = clubEntry.club.id;
  const title = clubEntry.title;
  const ownershipType = getOwnershipType(title, contractsData);

  const leagueMembers = leagueComp.schedule.stages[0].groups[0].members;
  const leagueRank = getLeagueRank(leagueMembers, clubId);
  const leagueReward = getLeagueReward(leagueComp, clubId);
  const cupReward = getCupReward(cupComp, clubId);
  const gross = leagueReward + cupReward;

  const base = {
    clubId,
    clubName: clubEntry.club.name,
    ownershipType,
    leagueName: leagueComp.name,
    leagueRank,
    leagueReward,
    cupName: cupComp.name,
    cupStage: getCupStageLabel(cupComp, clubId),
    cupReward,
    gross,
  };

  if (ownershipType === 'Staff') {
    const multiplier = getStaffEarningsMultiplier(contractsData, walletAddress);
    return {
      ...base,
      staffMultiplier: multiplier,
      staffEarnings: roundUpToNearest005(gross * multiplier),
    };
  }

  const { playerMultiplier, managerMultiplier } = getOwnerDeductions(contractsData);
  const playerLoanCost = roundUpToNearest005(gross * playerMultiplier);
  const managerFeeCost = roundUpToNearest005(gross * managerMultiplier);
  const net = roundUpToNearest005(gross - gross * playerMultiplier - gross * managerMultiplier);

  return {
    ...base,
    playerMultiplier,
    managerMultiplier,
    playerLoanCost,
    managerFeeCost,
    net,
  };
}

function calculateAll(clubResults) {
  return [...clubResults].sort((a, b) => b.gross - a.gross);
}

// === RENDERING ===

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('calculate-btn').addEventListener('click', handleCalculate);
});

async function handleCalculate() {
  // wired up in Task 9
}
