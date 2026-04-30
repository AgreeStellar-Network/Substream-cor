export const DEFAULT_POOL_MAX = 10;

const DEFAULT_POOL_MIN = 0;
const DEFAULT_IDLE_TIMEOUT_MS = 10000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 3000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 15000;
const DEFAULT_MAX_USES = 7500;

export function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readPoolMax(env: NodeJS.ProcessEnv = process.env, fallback = DEFAULT_POOL_MAX): number {
  return readPositiveInt(env.DB_POOL_MAX || env.DB_MAX_CONNECTIONS, fallback);
}

export function getPostgresPoolSizing(env: NodeJS.ProcessEnv = process.env, overrides: Record<string, unknown> = {}) {
  const max = Math.max(1, readPositiveInt(overrides.max, readPoolMax(env)));
  const requestedMin = readPositiveInt(overrides.min, readPositiveInt(env.DB_POOL_MIN, DEFAULT_POOL_MIN));
  const min = Math.min(requestedMin, max);

  return {
    min,
    max,
    idleTimeoutMillis: readPositiveInt(
      overrides.idleTimeoutMillis,
      readPositiveInt(env.DB_POOL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    ),
    connectionTimeoutMillis: readPositiveInt(
      overrides.connectionTimeoutMillis,
      readPositiveInt(env.DB_POOL_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS),
    ),
    statementTimeoutMillis: readPositiveInt(
      overrides.statementTimeoutMillis,
      readPositiveInt(env.DB_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS),
    ),
    idleInTransactionSessionTimeoutMillis: readPositiveInt(
      overrides.idleInTransactionSessionTimeoutMillis,
      readPositiveInt(env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS),
    ),
    maxUses: readPositiveInt(
      overrides.maxUses,
      readPositiveInt(env.DB_POOL_MAX_USES, DEFAULT_MAX_USES),
    ),
  };
}

export function getPgPoolConfig(env: NodeJS.ProcessEnv = process.env, overrides: Record<string, unknown> = {}) {
  const sizing = getPostgresPoolSizing(env, overrides);

  return {
    min: sizing.min,
    max: sizing.max,
    idleTimeoutMillis: sizing.idleTimeoutMillis,
    connectionTimeoutMillis: sizing.connectionTimeoutMillis,
    statement_timeout: sizing.statementTimeoutMillis,
    idle_in_transaction_session_timeout: sizing.idleInTransactionSessionTimeoutMillis,
    maxUses: sizing.maxUses,
  };
}

export function getKnexPoolConfig(env: NodeJS.ProcessEnv = process.env, overrides: Record<string, unknown> = {}) {
  const sizing = getPostgresPoolSizing(env, overrides);

  return {
    min: sizing.min,
    max: sizing.max,
    acquireTimeoutMillis: readPositiveInt(env.DB_POOL_ACQUIRE_TIMEOUT_MS, sizing.connectionTimeoutMillis),
    createTimeoutMillis: sizing.connectionTimeoutMillis,
    destroyTimeoutMillis: readPositiveInt(env.DB_POOL_DESTROY_TIMEOUT_MS, 5000),
    idleTimeoutMillis: sizing.idleTimeoutMillis,
    reapIntervalMillis: readPositiveInt(env.DB_POOL_REAP_INTERVAL_MS, 1000),
    createRetryIntervalMillis: readPositiveInt(env.DB_POOL_CREATE_RETRY_INTERVAL_MS, 200),
    propagateCreateError: false,
  };
}
