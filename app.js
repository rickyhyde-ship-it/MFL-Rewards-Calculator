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
  const [playerRes, managerRes] = await Promise.all([
    fetch(`${API_BASE}/contracts?type=PLAYER&period=currentSeason&clubId=${clubId}&limit=26`),
    fetch(`${API_BASE}/contracts?type=MANAGER&period=currentSeason&clubId=${clubId}&limit=26`),
  ]);
  const [playerData, managerData] = await Promise.all([
    playerRes.ok ? playerRes.json() : { items: [] },
    managerRes.ok ? managerRes.json() : { items: [] },
  ]);
  return { items: [...(playerData.items ?? []), ...(managerData.items ?? [])] };
}

async function fetchCompetition(competitionId) {
  const res = await fetch(`${API_BASE}/competitions/${competitionId}`);
  if (!res.ok) throw new Error(`Failed to fetch competition ${competitionId} (${res.status})`);
  return res.json();
}

async function fetchPlayers(walletAddress) {
  const allPlayers = [];
  let beforePlayerId = null;

  while (true) {
    let url = `${API_BASE}/players?ownerWalletAddress=${encodeURIComponent(walletAddress)}&limit=1500`;
    if (beforePlayerId !== null) url += `&beforePlayerId=${beforePlayerId}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch players (${res.status})`);
    const data = await res.json();
    const page = Array.isArray(data) ? data : (data.players ?? data.data ?? []);

    allPlayers.push(...page);
    if (page.length < 1500) break;

    beforePlayerId = Math.min(...page.map(p => p.id));
  }

  return allPlayers;
}

async function fetchClubCompetitions(clubId) {
  const res = await fetch(`${API_BASE}/clubs/${clubId}/competitions`);
  if (!res.ok) return null;
  const data = await res.json();
  const items = Array.isArray(data) ? data : (data.competitions ?? data.items ?? []);
  const live = items.filter(c => c.status === 'LIVE');
  const league = live.find(c => c.type === 'LEAGUE');
  const cup = live.find(c => c.type === 'CUP');
  return league && cup ? { leagueId: league.id, cupId: cup.id } : null;
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

function getOwnerDeductions(contractsData, ownedPlayerIds) {
  const active = contractsData.items.filter(c => c.status === 'ACTIVE');
  const playerMultiplier = active
    .filter(c => c.type === 'PLAYER' && !ownedPlayerIds.has(String(c.player)))
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

// Walk the knockout bracket to find which rank a club achieved.
// Returns a rank string matching competition.rewards[].ranks, or null if not in knockout.
function getKnockoutRank(stages, clubId) {
  const knockoutStage = stages.find(s => Array.isArray(s.rounds));
  if (!knockoutStage) return null;

  const roundToRank = {
    'Round of 16': 'Round of 16',
    'Quarterfinals': 'Quarterfinalists',
    'Semifinals': 'Semifinalists',
  };

  for (const round of knockoutStage.rounds) {
    const match = round.matches.find(
      m => m.homeClubId === clubId || m.awayClubId === clubId
    );
    if (!match) continue;

    if (match.status !== 'ENDED') {
      // Match not yet played — club has reached this round (projected minimum)
      return round.name === 'Final' ? 'Runner-up' : (roundToRank[round.name] ?? round.name);
    }

    const isHome = match.homeClubId === clubId;
    const homeGoals = match.homeScore ?? 0;
    const awayGoals = match.awayScore ?? 0;
    const homeWon = homeGoals !== awayGoals
      ? homeGoals > awayGoals
      : (match.homePenaltyScore ?? 0) > (match.awayPenaltyScore ?? 0);
    const clubWon = isHome ? homeWon : !homeWon;

    if (!clubWon) {
      return round.name === 'Final' ? 'Runner-up' : (roundToRank[round.name] ?? round.name);
    }
    if (round.name === 'Final') return 'Winner';
    // Club won this round — continue to next
  }

  return null;
}

function getCupPlacementReward(competition, clubId) {
  const rank = getKnockoutRank(competition.schedule.stages, clubId);
  if (!rank) return 0;
  const reward = competition.rewards.find(r => r.ranks === rank);
  return reward ? parseRewardAmount(reward.lines) : 0;
}

function getCupReward(competition, clubId) {
  const placementReward = getCupPlacementReward(competition, clubId);
  const winPrize = getCupGroupWinPrize(competition);
  const wins = getCupGroupWins(competition, clubId);
  return placementReward + (wins * winPrize);
}

function getCupStageLabel(competition, clubId) {
  const rank = getKnockoutRank(competition.schedule.stages, clubId);
  if (rank) return rank;
  const wins = getCupGroupWins(competition, clubId);
  return `Group Stage, ${wins} win${wins !== 1 ? 's' : ''}`;
}

function calculateClub(clubEntry, contractsData, leagueComp, cupComp, walletAddress, ownedPlayerIds) {
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

  const { playerMultiplier, managerMultiplier } = getOwnerDeductions(contractsData, ownedPlayerIds);
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

// Extract players with active loans at clubs NOT owned by this wallet.
// Logs the first player object so field names can be confirmed in DevTools.
function getLoanedOutPlayers(playersList, ownedClubIds) {
  return playersList.reduce((acc, player) => {
    const contract = player.activeContract ?? null;
    if (!contract || contract.status !== 'ACTIVE' || !contract.revenueShare) return acc;

    const clubId = contract.club?.id ?? null;
    if (clubId == null) return acc;

    if (!ownedClubIds.has(clubId) && !ownedClubIds.has(String(clubId))) {
      acc.push({ player, clubId, multiplier: contract.revenueShare / 10000 });
    }
    return acc;
  }, []);
}

function calculatePlayerLoan(player, multiplier, clubEntry, leagueComp, cupComp) {
  const clubId = player.activeContract.club.id;
  const leagueReward = leagueComp ? getLeagueReward(leagueComp, clubId) : 0;
  const cupReward = cupComp ? getCupReward(cupComp, clubId) : 0;
  const gross = leagueReward + cupReward;
  const earnings = roundUpToNearest005(gross * multiplier);
  const playerName = player.metadata?.firstName && player.metadata?.lastName
    ? `${player.metadata.firstName} ${player.metadata.lastName}`
    : (player.metadata?.name ?? `Player #${player.id}`);

  return {
    playerId: player.id,
    playerName,
    clubName: clubEntry?.club?.name ?? clubEntry?.name ?? player.activeContract.club.name,
    multiplier,
    leagueName: leagueComp?.name ?? '—',
    leagueRank: leagueComp
      ? getLeagueRank(leagueComp.schedule.stages[0].groups[0].members, clubId)
      : null,
    leagueReward,
    cupName: cupComp?.name ?? '—',
    cupStage: cupComp ? getCupStageLabel(cupComp, clubId) : '—',
    cupReward,
    gross,
    earnings,
  };
}

// === RENDERING ===

function formatMFL(amount) {
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $MFL`;
}

function formatPct(multiplier) {
  const pct = multiplier * 100;
  return (pct % 1 === 0 ? pct.toString() : pct.toFixed(1)) + '%';
}

function renderSummaryBar(results, playerLoanResults) {
  const owned = results.filter(r => r.ownershipType !== 'Staff');
  const staff = results.filter(r => r.ownershipType === 'Staff');

  const totalGross = owned.reduce((sum, r) => sum + r.gross, 0);
  const totalPlayerLoans = owned.reduce((sum, r) => sum + r.playerLoanCost, 0);
  const totalManagerFees = owned.reduce((sum, r) => sum + r.managerFeeCost, 0);
  const totalStaffEarnings = staff.reduce((sum, r) => sum + r.staffEarnings, 0);
  const totalPlayerLoanRevenue = playerLoanResults.reduce((sum, r) => sum + r.earnings, 0);
  const totalMFLEarnings = roundUpToNearest005(totalGross + totalStaffEarnings + totalPlayerLoanRevenue);
  const net = roundUpToNearest005(
    totalGross - totalPlayerLoans - totalManagerFees + totalStaffEarnings + totalPlayerLoanRevenue
  );

  return `
    <div class="summary-bar">
      <div class="summary-top">
        <div class="summary-label">Total MFL Earnings</div>
        <div class="summary-total">+${formatMFL(totalMFLEarnings)}</div>
        <div class="summary-breakdown">
          <span>Club Gains <span class="bd-value">+${formatMFL(totalGross)}</span></span>
          ${totalStaffEarnings > 0 ? `<span>Staff Earnings <span class="bd-value">+${formatMFL(totalStaffEarnings)}</span></span>` : ''}
          ${totalPlayerLoanRevenue > 0 ? `<span>Player Loans In <span class="bd-value">+${formatMFL(totalPlayerLoanRevenue)}</span></span>` : ''}
        </div>
      </div>
      <div class="summary-bottom">
        <div class="summary-item">
          <div class="si-label">Player Loans Out</div>
          <div class="si-value neg">−${formatMFL(totalPlayerLoans)}</div>
        </div>
        <div class="sep">·</div>
        <div class="summary-item">
          <div class="si-label">Staff Fees Out</div>
          <div class="si-value neg">−${formatMFL(totalManagerFees)}</div>
        </div>
        <div class="sep">·</div>
        <div class="summary-item">
          <div class="si-label">Net</div>
          <div class="si-value net">${net >= 0 ? '+' : ''}${formatMFL(net)}</div>
        </div>
      </div>
    </div>
  `;
}

function renderClubCard(result) {
  const isStaff = result.ownershipType === 'Staff';
  const hasManager = result.ownershipType === 'Owned | Hired Manager';
  const cardClass = isStaff ? 'staff' : 'owned';

  const badges = isStaff
    ? `<span class="badge badge-secondary">Staff</span>`
    : `<span class="badge badge-owned">Owned</span>${hasManager ? ' <span class="badge badge-secondary">Hired Manager</span>' : ''}`;

  const totalsRow = isStaff
    ? `
      <div class="totals-row">
        <span class="total-item"><span class="ti-label">Gross</span> <span class="ti-value">${formatMFL(result.gross)}</span></span>
        <span class="total-item"><span class="ti-label">Your Cut</span> <span class="ti-value pos net">+${formatPct(result.staffMultiplier)} / +${formatMFL(result.staffEarnings)}</span></span>
      </div>`
    : `
      <div class="totals-row">
        <span class="total-item"><span class="ti-label">Gross</span> <span class="ti-value pos">${formatMFL(result.gross)}</span></span>
        ${result.playerMultiplier > 0 ? `<span class="total-item"><span class="ti-label">Loans</span> <span class="ti-value neg">−${formatPct(result.playerMultiplier)} / −${formatMFL(result.playerLoanCost)}</span></span>` : ''}
        ${result.managerMultiplier > 0 ? `<span class="total-item"><span class="ti-label">Manager</span> <span class="ti-value neg">−${formatPct(result.managerMultiplier)} / −${formatMFL(result.managerFeeCost)}</span></span>` : ''}
        <span class="total-item"><span class="ti-label">Net</span> <span class="ti-value pos net">${formatMFL(result.net)}</span></span>
      </div>`;

  return `
    <div class="club-card ${cardClass}">
      <div class="club-header">
        <span class="club-name">${escapeHtml(result.clubName)}</span>
        <div class="badges">${badges}</div>
      </div>
      <div class="comp-grid">
        <span class="comp-left">${escapeHtml(result.leagueName)}</span>
        <span class="comp-right">Rank ${result.leagueRank} &nbsp;·&nbsp; ${formatMFL(result.leagueReward)}</span>
        <span class="comp-left">${escapeHtml(result.cupName)}</span>
        <span class="comp-right">${escapeHtml(result.cupStage)} &nbsp;·&nbsp; ${formatMFL(result.cupReward)}</span>
      </div>
      ${totalsRow}
    </div>
  `;
}

function renderPlayerCard(result) {
  return `
    <div class="club-card player-loan">
      <div class="club-header">
        <span class="club-name">${escapeHtml(result.playerName)}</span>
        <div class="badges">
          <span class="badge badge-player">On Loan</span>
          <span class="badge badge-secondary">${escapeHtml(result.clubName)}</span>
        </div>
      </div>
      <div class="comp-grid">
        <span class="comp-left">${escapeHtml(result.leagueName)}</span>
        <span class="comp-right">${result.leagueRank !== null ? 'Rank ' + result.leagueRank : '-'} &nbsp;·&nbsp; ${formatMFL(result.leagueReward)}</span>
        <span class="comp-left">${escapeHtml(result.cupName)}</span>
        <span class="comp-right">${escapeHtml(result.cupStage)} &nbsp;·&nbsp; ${formatMFL(result.cupReward)}</span>
      </div>
      <div class="totals-row">
        <span class="total-item"><span class="ti-label">Club Gross</span> <span class="ti-value">${formatMFL(result.gross)}</span></span>
        <span class="total-item"><span class="ti-label">Your Cut</span> <span class="ti-value pos net">+${formatPct(result.multiplier)} / +${formatMFL(result.earnings)}</span></span>
      </div>
    </div>
  `;
}

function renderResults(results, playerLoanResults) {
  const sorted = calculateAll(results);
  const sortedPlayerLoans = [...playerLoanResults].sort((a, b) => b.earnings - a.earnings);
  document.getElementById('summary-bar').innerHTML = renderSummaryBar(sorted, sortedPlayerLoans);
  document.getElementById('club-cards').innerHTML = sorted.map(renderClubCard).join('');
  const playerSection = document.getElementById('player-section');
  if (sortedPlayerLoans.length > 0) {
    document.getElementById('player-cards').innerHTML = sortedPlayerLoans.map(renderPlayerCard).join('');
    playerSection.hidden = false;
  } else {
    playerSection.hidden = true;
  }
  document.getElementById('results').hidden = false;
}

// === INIT ===

function setStatus(message, isError = false) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = isError ? 'error' : '';
}

function setProgress(pct) {
  const wrap = document.getElementById('progress-bar-wrap');
  const bar = document.getElementById('progress-bar');
  wrap.hidden = false;
  bar.style.width = `${pct}%`;
}

function clearProgress() {
  const wrap = document.getElementById('progress-bar-wrap');
  const bar = document.getElementById('progress-bar');
  wrap.hidden = true;
  bar.style.width = '0%';
}

async function handleCalculate() {
  const walletAddress = document.getElementById('wallet-input').value.trim();
  if (!walletAddress) {
    setStatus('Please enter a wallet address.', true);
    return;
  }

  document.getElementById('results').hidden = true;
  document.getElementById('player-section').hidden = true;
  document.getElementById('calculate-btn').disabled = true;
  setProgress(5);
  setStatus('Fetching clubs and players...');

  try {
    const [clubs, playersData] = await Promise.all([
      fetchClubs(walletAddress),
      fetchPlayers(walletAddress).catch(() => null),
    ]);

    if (!clubs || clubs.length === 0) {
      setStatus('No clubs found for this wallet address.', true);
      clearProgress();
      return;
    }

    const playersList = Array.isArray(playersData)
      ? playersData
      : (playersData?.players ?? playersData?.data ?? []);
    const ownedPlayerIds = new Set(playersList.map(p => String(p.id)));

    const total = clubs.length;
    let loaded = 0;
    setProgress(15);
    setStatus(`Loading data for ${total} club${total !== 1 ? 's' : ''}...`);

    const rawData = await Promise.all(
      clubs.map(async (clubEntry) => {
        const leagueEntry = clubEntry.competitions.find(c => c.type === 'LEAGUE');
        const cupEntry = clubEntry.competitions.find(c => c.type === 'CUP');
        const [contractsData, leagueComp, cupComp] = await Promise.all([
          fetchContracts(clubEntry.club.id),
          leagueEntry ? fetchCompetition(leagueEntry.id) : Promise.resolve(null),
          cupEntry ? fetchCompetition(cupEntry.id) : Promise.resolve(null),
        ]);
        loaded++;
        setProgress(15 + Math.round((loaded / total) * 60));
        setStatus(`Loading data for ${total} club${total !== 1 ? 's' : ''}... (${loaded}/${total})`);
        return { clubEntry, contractsData, leagueComp, cupComp };
      })
    );

    const ownedClubIds = new Set(
      rawData
        .filter(rd => rd.clubEntry.title === 'MFL_OWNER')
        .map(rd => rd.clubEntry.club.id)
    );
    const results = rawData
      .filter(({ leagueComp, cupComp }) => leagueComp && cupComp)
      .map(({ clubEntry, contractsData, leagueComp, cupComp }) =>
        calculateClub(clubEntry, contractsData, leagueComp, cupComp, walletAddress, ownedPlayerIds)
      );

    // Process players on loan at external clubs
    const loanedPlayers = getLoanedOutPlayers(playersList, ownedClubIds);
    let playerLoanResults = [];

    if (loanedPlayers.length > 0) {
      setProgress(80);
      setStatus(`Loading data for ${loanedPlayers.length} loaned player${loanedPlayers.length !== 1 ? 's' : ''}...`);

      // Deduplicate: one fetch per unique club, not one per player
      const uniqueClubIds = [...new Set(loanedPlayers.map(lp => lp.clubId))];
      const compMap = new Map();
      await Promise.all(
        uniqueClubIds.map(async (clubId) => {
          try {
            const comps = await fetchClubCompetitions(clubId);
            if (!comps) return;
            const [leagueComp, cupComp] = await Promise.all([
              fetchCompetition(comps.leagueId),
              fetchCompetition(comps.cupId),
            ]);
            if (leagueComp && cupComp) compMap.set(clubId, { leagueComp, cupComp });
          } catch (e) {
            console.warn(`[MFL] Could not load competitions for club ${clubId}:`, e);
          }
        })
      );

      const playerLoanData = loanedPlayers.map(({ player, clubId, multiplier }) => {
        const comps = compMap.get(clubId);
        if (!comps) return null;
        return calculatePlayerLoan(player, multiplier, null, comps.leagueComp, comps.cupComp);
      });
      playerLoanResults = playerLoanData.filter(Boolean);
    }

    setStatus('');
    clearProgress();
    renderResults(results, playerLoanResults);
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    clearProgress();
    console.error(err);
  } finally {
    document.getElementById('calculate-btn').disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('calculate-btn').addEventListener('click', handleCalculate);
});
