const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteJson } = require('./session-state');
const { SETTINGS_DIR } = require('./settings');

// A depleted balance (402) or a rate limit (429) answers every prompt the same
// way until it resets, so asking again only adds latency and load. Pause
// per-prompt recall for a fixed window instead of retrying on each prompt.
const RECALL_COOLDOWN_MS = 60 * 60 * 1000;
const LIMIT_STATUSES = new Set([402, 429]);
const COOLDOWN_FILE = path.join(SETTINGS_DIR, 'recall-cooldown.json');

function isLimitStatus(status) {
  return LIMIT_STATUSES.has(status);
}

function recallCoolingDown(now = Date.now()) {
  try {
    const { until } = JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    return typeof until === 'number' && until > now;
  } catch {
    return false;
  }
}

function startRecallCooldown(status, now = Date.now()) {
  try {
    atomicWriteJson(COOLDOWN_FILE, { status, until: now + RECALL_COOLDOWN_MS });
  } catch {
    // Best effort: without the marker the next prompt asks once more.
  }
}

module.exports = {
  isLimitStatus,
  recallCoolingDown,
  startRecallCooldown,
};
