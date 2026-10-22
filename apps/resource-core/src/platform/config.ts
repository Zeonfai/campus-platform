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
  for (const name of ['M2_SERVICE_TOKEN', 'M3_SERVICE_TOKEN']) {
    const token = input[name];
    if (token !== undefined && !/^[A-Za-z0-9_-]{32,200}$/.test(String(token)))
      throw new Error('Invalid workflow service identity format');
  }
  if (input.M2_SERVICE_TOKEN && input.M2_SERVICE_TOKEN === input.M3_SERVICE_TOKEN)
    throw new Error('M2 and M3 service identities must be distinct');
  return {
    ...input,
    NODE_ENV: environment,
    PORT: port,
    FRONTEND_ORIGINS: origins,
    API_DOCS_ENABLED: docs === 'true',
  };
}
