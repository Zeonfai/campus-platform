export function validateEnvironment(input: Record<string, unknown>): Record<string, unknown> {
  const environment = String(input.NODE_ENV ?? 'development');
  if (!['development', 'test', 'production'].includes(environment))
    throw new Error('Invalid NODE_ENV');
  const port = Number(input.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1..65535');
  const raw = String(input.DATABASE_URL ?? '');
  let database: URL;
  try {
    database = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is required and must be a PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !database.hostname ||
    database.pathname.length < 2 ||
    raw.includes('REPLACE_WITH_')
  )
    throw new Error('DATABASE_URL must contain actual local configuration');
  const origins = String(input.FRONTEND_ORIGINS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const origin of origins) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin)
      throw new Error('FRONTEND_ORIGINS must contain exact HTTP(S) origins');
  }
  const docs = String(input.API_DOCS_ENABLED ?? 'false');
  if (!['true', 'false'].includes(docs)) throw new Error('API_DOCS_ENABLED must be true or false');
  if (environment === 'production' && docs === 'true')
    throw new Error('API docs are disabled in production baseline');
  if (
    !['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].includes(
      String(input.LOG_LEVEL ?? 'info'),
    )
  )
    throw new Error('Invalid LOG_LEVEL');
  if (input.RESOURCE_CORE_URL) {
    const url = new URL(String(input.RESOURCE_CORE_URL));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== String(input.RESOURCE_CORE_URL) ||
      url.username ||
      url.password
    )
      throw new Error('RESOURCE_CORE_URL must be an HTTP(S) origin');
  }
  if (input.M2_SERVICE_TOKEN && !/^[A-Za-z0-9_-]{32,200}$/.test(String(input.M2_SERVICE_TOKEN)))
    throw new Error('M2_SERVICE_TOKEN must contain 32..200 URL-safe characters');
  if (
    input.M2_WORKER_ENABLED !== undefined &&
    !['true', 'false'].includes(String(input.M2_WORKER_ENABLED))
  )
    throw new Error('M2_WORKER_ENABLED must be true or false');
  const interval = Number(input.M2_WORKER_INTERVAL_MS ?? 500);
  if (!Number.isInteger(interval) || interval < 100 || interval > 60000)
    throw new Error('M2_WORKER_INTERVAL_MS must be 100..60000');
  const releaseDelay = Number(input.M2_RELEASE_RETRY_DELAY_MS ?? 300000);
  if (!Number.isInteger(releaseDelay) || releaseDelay < 100 || releaseDelay > 600000)
    throw new Error('M2_RELEASE_RETRY_DELAY_MS must be 100..600000');
  if (input.M3_SERVICE_TOKEN && !/^[A-Za-z0-9_-]{32,200}$/.test(String(input.M3_SERVICE_TOKEN)))
    throw new Error('M3_SERVICE_TOKEN must contain 32..200 URL-safe characters');
  if (
    input.M3_WORKER_ENABLED !== undefined &&
    !['true', 'false'].includes(String(input.M3_WORKER_ENABLED))
  )
    throw new Error('M3_WORKER_ENABLED must be true or false');
  const maintenanceInterval = Number(input.M3_WORKER_INTERVAL_MS ?? 500);
  if (
    !Number.isInteger(maintenanceInterval) ||
    maintenanceInterval < 100 ||
    maintenanceInterval > 60000
  )
    throw new Error('M3_WORKER_INTERVAL_MS must be 100..60000');
  const maintenanceReleaseDelay = Number(input.M3_RELEASE_RETRY_DELAY_MS ?? 300000);
  if (
    !Number.isInteger(maintenanceReleaseDelay) ||
    maintenanceReleaseDelay < 100 ||
    maintenanceReleaseDelay > 600000
  )
    throw new Error('M3_RELEASE_RETRY_DELAY_MS must be 100..600000');
  return {
    ...input,
    NODE_ENV: environment,
    PORT: port,
    FRONTEND_ORIGINS: origins,
    API_DOCS_ENABLED: docs === 'true',
  };
}
