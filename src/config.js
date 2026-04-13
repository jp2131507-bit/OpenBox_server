import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  await import('dotenv/config');
} catch {
  // Local tests can run without dotenv.
}

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const normalizeOrigin = (value) => {
  if (!value) return '';
  try {
    return new URL(value).origin;
  } catch {
    return String(value);
  }
};

const parseOrigins = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => normalizeOrigin(entry.trim()))
    .filter(Boolean);

const parseWebhookEndpoints = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseCsvInts = (value, fallback = []) => {
  const entries = String(value || '')
    .split(',')
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry));
  return entries.length ? entries : fallback;
};

const resolveTiming = (primaryName, legacyName, fallback) =>
  toInt(process.env[primaryName] ?? process.env[legacyName], fallback);

const resolveDurationMsFromMinutes = (primaryName, legacyMsName, fallbackMs) => {
  if (process.env[primaryName] != null && process.env[primaryName] !== '') {
    return toInt(process.env[primaryName], Math.round(fallbackMs / 60000)) * 60000;
  }
  if (process.env[legacyMsName] != null && process.env[legacyMsName] !== '') {
    return toInt(process.env[legacyMsName], fallbackMs);
  }
  return fallbackMs;
};

const resolveDurationMsFromSeconds = (primaryName, legacySecondsName, fallbackMs) => {
  if (process.env[primaryName] != null && process.env[primaryName] !== '') {
    return toInt(process.env[primaryName], fallbackMs);
  }
  if (process.env[legacySecondsName] != null && process.env[legacySecondsName] !== '') {
    return toInt(process.env[legacySecondsName], Math.round(fallbackMs / 1000)) * 1000;
  }
  return fallbackMs;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultServerBaseUrl = `http://127.0.0.1:${toInt(process.env.PORT, 3211)}`;
const configuredClientBaseUrl = trimTrailingSlash(process.env.CLIENT_BASE_URL || '');
const clientOrigins = parseOrigins(process.env.CLIENT_ORIGIN || configuredClientBaseUrl || defaultServerBaseUrl);
const clientBaseUrl = trimTrailingSlash(configuredClientBaseUrl || clientOrigins[0] || defaultServerBaseUrl);

export const config = {
  port: toInt(process.env.PORT, 3211),
  storeMode: (process.env.STORE_MODE || 'memory').toLowerCase(),
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  redisKeyTtlSec: toInt(process.env.REDIS_KEY_TTL_SEC, 86400),
  clientBaseUrl: clientBaseUrl || defaultServerBaseUrl,
  clientOrigin: clientOrigins[0] || '',
  clientOrigins,
  controlApiToken: process.env.CONTROL_API_TOKEN || '',
  hmacSecret: process.env.HMAC_SECRET || '',
  matchmakingServiceUrl: process.env.MATCHMAKING_SERVICE_URL || '',
  devWaitForAllPlayers: toBool(process.env.DEV_WAIT_FOR_ALL_PLAYERS, false),
  firstJoinTimeoutMs: toInt(process.env.FIRST_JOIN_TIMEOUT_MS, 30000),
  readyCheckTimeoutMs: resolveTiming('READY_CHECK_TIMEOUT_MS', 'READY_TIMEOUT_MS', 10000),
  distributionLeadMs: resolveTiming('DISTRIBUTION_LEAD_MS', 'DISTRIBUTION_BUFFER_MS', 5200),
  swapPhaseMs: resolveDurationMsFromSeconds('SWAP_PHASE_MS', 'SWAP_WINDOW_SECONDS', 20000),
  swapSoftLockPercent: resolveTiming('SWAP_SOFT_LOCK_PERCENT', 'SOFTLOCK_PERCENT', 30),
  calcDelayMs: toInt(process.env.CALC_DELAY_MS, 2600),
  replayWaitMs: toInt(process.env.REPLAY_WAIT_MS, 30000),
  replayBufferMs: toInt(process.env.REPLAY_BUFFER_MS, 5000),
  heartbeatIntervalMs: toInt(process.env.HEARTBEAT_INTERVAL_MS, 3000),
  heartbeatTimeoutMs: toInt(process.env.HEARTBEAT_TIMEOUT_MS, 9000),
  webhookEndpoints: parseWebhookEndpoints(process.env.WEBHOOK_ENDPOINTS),
  webhookTimeoutMs: toInt(process.env.WEBHOOK_TIMEOUT_MS, 5000),
  maxWebhookAttempts: toInt(process.env.MAX_WEBHOOK_ATTEMPTS, 3),
  webhookRetryScheduleMs: parseCsvInts(process.env.RETRY_SCHEDULE_MS, [1000, 3000]),
  dlqDir: process.env.DLQ_DIR || path.resolve(__dirname, '../dlq'),
  dlqRetentionMs: toInt(process.env.DLQ_RETENTION_MS, 7 * 24 * 60 * 60 * 1000),
  dlqSweepIntervalMs: toInt(process.env.DLQ_SWEEP_INTERVAL_MS, 60 * 60 * 1000),
  platformFeeType: (process.env.PLATFORM_FEE_TYPE || 'percentage').toLowerCase(),
  platformFeeValue: toFloat(process.env.PLATFORM_FEE_VALUE, 10),
  sessionInactivityTimeoutMs: resolveDurationMsFromMinutes(
    'SESSION_INACTIVITY_TIMEOUT_MS',
    'SESSION_MAX_LIFETIME_MS',
    60 * 60 * 1000
  )
};

export default config;
