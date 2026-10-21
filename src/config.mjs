/**
 * Runtime configuration from environment variables (documented in .env.example).
 * Invalid or unsafe settings throw, so the server refuses to start.
 */
import { resolveAiConfig } from './ai.mjs';
import { resolvePayPalConfig } from './paypal.mjs';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]{1,255}\.[a-z]{2,24}$/i;

/**
 * @param {Record<string, string|undefined>} env
 * @param {string[]} [argv] command-line flags; `--mock-paypal` forces PAYPAL_MOCK=1
 */
export function resolveConfig(env, argv = []) {
  const effective = { ...env };
  if (argv.includes('--mock-paypal')) effective.PAYPAL_MOCK = '1';

  const ai = resolveAiConfig(effective);
  const paypal = resolvePayPalConfig(effective);

  let listen = { host: '127.0.0.1', port: 4410 };
  if (effective.PORT !== undefined && effective.PORT !== '') {
    const port = Number(effective.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT must be a port number.');
    listen = { host: '0.0.0.0', port };
  }

  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const host of (effective.ALLOWED_HOSTS ?? '').split(',')) if (host.trim()) allowedHosts.add(host.trim().toLowerCase());
  if (effective.RENDER_EXTERNAL_HOSTNAME) allowedHosts.add(effective.RENDER_EXTERNAL_HOSTNAME.trim().toLowerCase());

  let payeeOverride = null;
  if (effective.PAYEE_EMAIL_OVERRIDE && effective.PAYEE_EMAIL_OVERRIDE.trim()) {
    payeeOverride = effective.PAYEE_EMAIL_OVERRIDE.trim().toLowerCase();
    if (!EMAIL.test(payeeOverride)) throw new ConfigError('PAYEE_EMAIL_OVERRIDE is not a valid email address.');
    if (paypal.environment === 'live') throw new ConfigError('PAYEE_EMAIL_OVERRIDE is a sandbox testing aid and is refused with live PayPal.');
  }

  let publicBaseUrl = null;
  if (effective.PUBLIC_BASE_URL) {
    try {
      publicBaseUrl = new URL(effective.PUBLIC_BASE_URL).origin;
    } catch {
      throw new ConfigError('PUBLIC_BASE_URL must be an absolute URL.');
    }
  }

  return {
    listen,
    ai,
    paypal,
    allowedHosts,
    publicBaseUrl,
    trustProxy: effective.TRUST_PROXY === '1' || Boolean(effective.RENDER),
    payeeOverride,
    approverPasscode: effective.APPROVER_PASSCODE ? String(effective.APPROVER_PASSCODE) : null,
    mcpBearerToken: effective.MCP_BEARER_TOKEN ? String(effective.MCP_BEARER_TOKEN) : null,
    aiMaxCallsPerHour: Number(effective.AI_MAX_CALLS_PER_HOUR) > 0 ? Number(effective.AI_MAX_CALLS_PER_HOUR) : 200,
    aiMaxCallsPerDay: Number(effective.AI_MAX_CALLS_PER_DAY) > 0 ? Number(effective.AI_MAX_CALLS_PER_DAY) : null,
    logRequests: effective.LOG_REQUESTS !== '0',
  };
}
