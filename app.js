// === UTILITIES ===

function roundUpToNearest005(value) {
  return Math.ceil(value * 20) / 20;
}

function parseRewardAmount(lines) {
  if (!lines || lines.length === 0) return 0;
  const match = String(lines[0]).match(/[\d.]+/);
  return match ? parseFloat(match[0]) : 0;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// === API ===

const API_BASE = 'https://z519wdyajg.execute-api.us-east-1.amazonaws.com/prod';

async function fetchClubs(walletAddress) {
  const res = await fetch(`${API_BASE}/clubs?walletAddress=${encodeURIComponent(walletAddress)}`);
  if (!res.ok) throw new Error(`Failed to fetch clubs (${res.status})`);
  return res.json();
}

async function fetchContracts(clubId) {
  const res = await fetch(`${API_BASE}/contracts?period=currentSeason&clubId=${clubId}&limit=25`);
  if (!res.ok) throw new Error(`Failed to fetch contracts for club ${clubId} (${res.status})`);
  return res.json();
}

async function fetchCompetition(competitionId) {
  const res = await fetch(`${API_BASE}/competitions/${competitionId}`);
  if (!res.ok) throw new Error(`Failed to fetch competition ${competitionId} (${res.status})`);
  return res.json();
}

async function fetchAllForWallet(walletAddress) {
  const clubs = await fetchClubs(walletAddress);

  if (!clubs || clubs.length === 0) return [];

  const clubData = await Promise.all(
    clubs.map(async (clubEntry) => {
      const leagueEntry = clubEntry.competitions.find(c => c.type === 'LEAGUE');
      const cupEntry = clubEntry.competitions.find(c => c.type === 'CUP');

      const [contractsData, leagueComp, cupComp] = await Promise.all([
        fetchContracts(clubEntry.club.id),
        leagueEntry ? fetchCompetition(leagueEntry.id) : Promise.resolve(null),
        cupEntry ? fetchCompetition(cupEntry.id) : Promise.resolve(null),
      ]);

      return { clubEntry, contractsData, leagueComp, cupComp };
    })
  );

  return clubData;
}

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

function formatMFL(amount) {
  return `${amount.toFixed(2)} $MFL`;
}

function formatPct(multiplier) {
  const pct = multiplier * 100;
  return (pct % 1 === 0 ? pct.toString() : pct.toFixed(1)) + '%';
}

function renderSummaryBar(results) {
  const owned = results.filter(r => r.ownershipType !== 'Staff');
  const staff = results.filter(r => r.ownershipType === 'Staff');

  const totalGross = owned.reduce((sum, r) => sum + r.gross, 0);
  const totalPlayerLoans = owned.reduce((sum, r) => sum + r.playerLoanCost, 0);
  const totalManagerFees = owned.reduce((sum, r) => sum + r.managerFeeCost, 0);
  const totalStaffEarnings = staff.reduce((sum, r) => sum + r.staffEarnings, 0);
  const net = roundUpToNearest005(
    totalGross - totalPlayerLoans - totalManagerFees + totalStaffEarnings
  );

  return `
    <div class="summary-bar">
      <div class="summary-item">
        <span class="label">Club Gains</span>
        <span class="value positive">+${formatMFL(totalGross)}</span>
      </div>
      <div class="summary-item">
        <span class="label">Player Loans Out</span>
        <span class="value negative">-${formatMFL(totalPlayerLoans)}</span>
      </div>
      <div class="summary-item">
        <span class="label">Manager Fees Out</span>
        <span class="value negative">-${formatMFL(totalManagerFees)}</span>
      </div>
      ${totalStaffEarnings > 0 ? `
      <div class="summary-item">
        <span class="label">Staff Earnings</span>
        <span class="value positive">+${formatMFL(totalStaffEarnings)}</span>
      </div>` : ''}
      <div class="summary-item net">
        <span class="label">Net</span>
        <span class="value">${net >= 0 ? '+' : ''}${formatMFL(net)}</span>
      </div>
    </div>
  `;
}

function renderClubCard(result) {
  const isStaff = result.ownershipType === 'Staff';

  const totalsRow = isStaff
    ? `
      <div class="totals-row">
        <span>Gross: ${formatMFL(result.gross)}</span>
        <span>Your Cut: ${formatPct(result.staffMultiplier)} = ${formatMFL(result.staffEarnings)}</span>
      </div>`
    : `
      <div class="totals-row">
        <span>Gross: ${formatMFL(result.gross)}</span>
        <span>Player Loans: ${formatPct(result.playerMultiplier)} = -${formatMFL(result.playerLoanCost)}</span>
        ${result.managerMultiplier > 0 ? `<span>Manager Fee: ${formatPct(result.managerMultiplier)} = -${formatMFL(result.managerFeeCost)}</span>` : ''}
        <span>Net: ${formatMFL(result.net)}</span>
      </div>`;

  return `
    <div class="club-card">
      <div class="club-header">
        <span class="club-name">${escapeHtml(result.clubName)}</span>
        <span class="ownership-label ${isStaff ? 'staff' : 'owner'}">${escapeHtml(result.ownershipType)}</span>
      </div>
      <div class="comp-row">
        <span class="comp-name">${escapeHtml(result.leagueName)}</span>
        <span class="comp-detail">Rank ${result.leagueRank}</span>
        <span class="comp-reward">${formatMFL(result.leagueReward)}</span>
      </div>
      <div class="comp-row">
        <span class="comp-name">${escapeHtml(result.cupName)}</span>
        <span class="comp-detail">${escapeHtml(result.cupStage)}</span>
        <span class="comp-reward">${formatMFL(result.cupReward)}</span>
      </div>
      ${totalsRow}
    </div>
  `;
}

function renderResults(results) {
  const sorted = calculateAll(results);
  document.getElementById('summary-bar').innerHTML = renderSummaryBar(sorted);
  document.getElementById('club-cards').innerHTML = sorted.map(renderClubCard).join('');
  document.getElementById('results').hidden = false;
}

// === INIT ===

function setStatus(message, isError = false) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.style.color = isError ? 'red' : 'inherit';
}

async function handleCalculate() {
  const walletAddress = document.getElementById('wallet-input').value.trim();
  if (!walletAddress) {
    setStatus('Please enter a wallet address.', true);
    return;
  }

  document.getElementById('results').hidden = true;
  document.getElementById('calculate-btn').disabled = true;
  setStatus('Loading...');

  try {
    const rawData = await fetchAllForWallet(walletAddress);

    if (rawData.length === 0) {
      setStatus('No clubs found for this wallet address.', true);
      return;
    }

    const results = rawData
      .filter(({ leagueComp, cupComp }) => leagueComp && cupComp)
      .map(({ clubEntry, contractsData, leagueComp, cupComp }) =>
        calculateClub(clubEntry, contractsData, leagueComp, cupComp, walletAddress)
      );

    setStatus('');
    renderResults(results);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    console.error(err);
  } finally {
    document.getElementById('calculate-btn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('calculate-btn').addEventListener('click', handleCalculate);
});
