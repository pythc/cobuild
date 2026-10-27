import { randomBytes } from 'node:crypto';
import { parseEmbeddingOrigins } from './embedding.js';

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
};

export type AppConfig = {
  appOrigin: string;
  publicBaseUrl: string;
  /** Exact previous HTTPS origins, retained for existing browser and MCP connections. */
  legacyAppOrigins?: string[];
  storageDir: string;
  nodeEnv: string;
  port: number;
  dbSchema: string;
  cookieSecure: boolean;
  embeddingOrigins?: string[];
  trustProxy: boolean;
  mailTestSink: boolean;
  seedDemo: boolean;
  smtp: SmtpConfig | null;
  sessionSecret: string;
  registrationMailHourlyBudget: number;
  registrationMailDailyBudget: number;
  registrationQueueLimit: number;
  githubToken?: string;
};

export type StartupSecrets = {
  adminEmail?: string;
  adminPassword?: string;
  adminName: string;
  databaseUrl: string;
};

export type LoadedConfig = {
  config: AppConfig;
  startup: StartupSecrets;
};

const SCHEMA_RE = /^[a-z][a-z0-9_]{0,62}$/;

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function readBudget(value: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/.test(value.trim())) throw new Error(`Invalid ${name}`);
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}`);
  return parsed;
}

function readOrigin(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute http(s) origin`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include credentials, query, or hash`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`${name} must not include a path`);
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv): LoadedConfig {
  const nodeEnv = env.NODE_ENV?.trim() || 'development';
  const production = nodeEnv === 'production';
  const databaseUrl = env.DATABASE_URL?.trim() ?? '';
  if (!databaseUrl) throw new Error('Missing DATABASE_URL');

  const appOrigin = readOrigin(env.APP_ORIGIN?.trim() || 'http://127.0.0.1:5173', 'APP_ORIGIN');
  const publicBaseUrl = readOrigin(
    env.PUBLIC_BASE_URL?.trim() || appOrigin,
    'PUBLIC_BASE_URL',
  );
  const legacyInputs = env.LEGACY_APP_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  if (legacyInputs.length > 4) throw new Error('LEGACY_APP_ORIGINS supports at most four origins');
  const legacyAppOrigins = [...new Set(legacyInputs.map(value => {
    const origin = readOrigin(value, 'LEGACY_APP_ORIGINS');
    if (!origin.startsWith('https://') || new URL(origin).hostname.includes('*')) {
      throw new Error('LEGACY_APP_ORIGINS requires exact HTTPS origins');
    }
    return origin;
  }))].filter(origin => origin !== appOrigin);
  if (legacyAppOrigins.length && (!appOrigin.startsWith('https://') || appOrigin !== publicBaseUrl)) {
    throw new Error('Legacy origins require matching HTTPS APP_ORIGIN and PUBLIC_BASE_URL');
  }
  const dbSchema = (env.DB_SCHEMA?.trim() || 'assessment').toLowerCase();
  if (!SCHEMA_RE.test(dbSchema)) throw new Error('Invalid DB_SCHEMA');

  const seedDemo = flag(env.SEED_DEMO);
  const mailTestSink = flag(env.MAIL_TEST_SINK);
  if (production && seedDemo) throw new Error('SEED_DEMO is refused in production');
  if (production && mailTestSink) throw new Error('MAIL_TEST_SINK is refused in production');

  let sessionSecret = env.SESSION_SECRET?.trim() ?? '';
  if (production && sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters in production');
  }
  if (!sessionSecret) sessionSecret = randomBytes(32).toString('hex');

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

  const adminEmail = env.ADMIN_EMAIL?.trim().toLowerCase() || undefined;
  const adminPassword = env.ADMIN_PASSWORD ?? '';
  if ((adminEmail && !adminPassword) || (!adminEmail && adminPassword)) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set together');
  }
  if (adminPassword && adminPassword.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters');
  }

  const smtpHost = env.SMTP_HOST?.trim() ?? '';
  let smtp: SmtpConfig | null = null;
  if (smtpHost) {
    const from = env.SMTP_FROM?.trim() ?? '';
    if (!from) throw new Error('SMTP_FROM is required when SMTP_HOST is set');
    const smtpPort = Number(env.SMTP_PORT ?? '587');
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
      throw new Error('Invalid SMTP_PORT');
    }
    const user = env.SMTP_USER?.trim() || undefined;
    const pass = env.SMTP_PASS || undefined;
    smtp = {
      host: smtpHost,
      port: smtpPort,
      secure: flag(env.SMTP_SECURE) || smtpPort === 465,
      from,
      ...(user ? { user } : {}),
      ...(pass ? { pass } : {}),
    };
  }

  const registrationMailHourlyBudget = readBudget(env.REGISTRATION_MAIL_HOURLY_BUDGET, 'REGISTRATION_MAIL_HOURLY_BUDGET', 300, 1, 100_000);
  const registrationMailDailyBudget = readBudget(env.REGISTRATION_MAIL_DAILY_BUDGET, 'REGISTRATION_MAIL_DAILY_BUDGET', 1500, 1, 1_000_000);
  const registrationQueueLimit = readBudget(env.REGISTRATION_QUEUE_LIMIT, 'REGISTRATION_QUEUE_LIMIT', 200, 1, 100_000);
  if (registrationMailDailyBudget < registrationMailHourlyBudget) {
    throw new Error('REGISTRATION_MAIL_DAILY_BUDGET must be greater than or equal to REGISTRATION_MAIL_HOURLY_BUDGET');
  }

  const githubToken = env.GITHUB_TOKEN?.trim() || undefined;

  const cookieSecure = env.COOKIE_SECURE
    ? flag(env.COOKIE_SECURE)
    : publicBaseUrl.startsWith('https://');
  const embeddingOrigins = parseEmbeddingOrigins(env.EMBEDDING_ORIGINS);
  if (embeddingOrigins.length && (!cookieSecure || !appOrigin.startsWith('https://'))) {
    throw new Error('Embedding requires HTTPS and secure cookies');
  }

  const config: AppConfig = {
    appOrigin,
    publicBaseUrl,
    legacyAppOrigins,
    storageDir: env.STORAGE_DIR?.trim() || 'uploads',
    nodeEnv,
    port,
    dbSchema,
    cookieSecure,
    embeddingOrigins,
    trustProxy: flag(env.TRUST_PROXY),
    mailTestSink,
    seedDemo,
    smtp,
    sessionSecret,
    registrationMailHourlyBudget,
    registrationMailDailyBudget,
    registrationQueueLimit,
    ...(githubToken ? { githubToken } : {}),
  };
  Object.defineProperty(config, 'sessionSecret', { enumerable: false });
  if (githubToken) Object.defineProperty(config, 'githubToken', { enumerable: false });
  if (smtp?.pass) Object.defineProperty(smtp, 'pass', { enumerable: false });

  return {
    config,
    startup: {
      ...(adminEmail ? { adminEmail } : {}),
      ...(adminPassword ? { adminPassword } : {}),
      adminName: env.ADMIN_NAME?.trim() || '管理员',
      databaseUrl,
    },
  };
}
