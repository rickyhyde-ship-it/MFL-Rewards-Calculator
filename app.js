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

// === RENDERING ===

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('calculate-btn').addEventListener('click', handleCalculate);
});

async function handleCalculate() {
  // wired up in Task 9
}
