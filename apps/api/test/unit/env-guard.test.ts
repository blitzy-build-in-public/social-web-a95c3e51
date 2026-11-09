/**
 * The environment guards' unit suite (AAP 0.6.2, 0.12.2): each process schema in each mode, over the
 * five claims the AAP states for it.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  ENV_LLM_PROVIDERS,
  ENV_STRIPE_MODES,
  ENV_TELEPHONY_MODES,
  EnvValidationError,
  STRIPE_MOCK_PLACEHOLDERS,
  SUPPORTED_MODELS,
  TWILIO_SIMULATOR,
  loadApiEnv,
  loadWorkersEnv,
} from '@tablemate/server-core';
import type { ApiEnv, WorkersEnv } from '@tablemate/server-core';

/*
 * Each is a fragment list joined here, so no complete credential shape is written into this file, and
 * each is random, so a value that reached an error stays distinguishable from a fixed reason.
 */
const stripeTestKey = ['sk', 'test', randomBytes(16).toString('hex')].join('_');
const stripeLiveKey = ['sk', 'live', randomBytes(16).toString('hex')].join('_');
const publishableTestKey = ['pk', 'test', randomBytes(16).toString('hex')].join('_');
const publishableLiveKey = ['pk', 'live', randomBytes(16).toString('hex')].join('_');
const webhookSecret = ['whsec', randomBytes(20).toString('hex')].join('_');
const openAiKey = ['sk', randomBytes(24).toString('hex')].join('-');
const twilioSid = ['AC', randomBytes(16).toString('hex')].join('');
const twilioToken = randomBytes(16).toString('hex');
const testControlToken = randomBytes(24).toString('hex');

/** A raw environment: what a process would see, or the record a row hands a loader. */
type RawMap = Record<string, string | undefined>;

/** A secret variable's value: 48 hex characters, above the 32-character minimum. */
function secret(): string {
  return randomBytes(24).toString('hex');
}

/** A `FIELD_ENCRYPTION_KEY`: the canonical base64 of one 32-byte AES-256-GCM key. */
function fieldKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * `base` with `overrides` applied. An override of `undefined` removes the variable, so a row can
 * state an absent variable rather than a stand-in value.
 */
function withOverrides(base: RawMap, overrides: RawMap): RawMap {
  const merged: RawMap = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

/** The variables both processes read (AAP 0.6.2), with the two credential-free modes as the default. */
function commonRaw(appEnv: string): RawMap {
  return {
    APP_ENV: appEnv,
    DATABASE_URL: 'postgres://tablemate@127.0.0.1:5432/tablemate',
    REDIS_URL: 'redis://127.0.0.1:6379',
    FIELD_ENCRYPTION_KEY: fieldKey(),
    FIELD_ENCRYPTION_KEY_ID: 'k1',
    ANALYTICS_SALT: secret(),
    TELEPHONY_MODE: 'off',
    LLM_PROVIDER: 'fake',
  };
}

/**
 * The Stripe variables an `APP_ENV` carries by default: the live triple in production, and the
 * credential-free `mock` posture the proxy of `docker-compose.yml` serves everywhere else.
 */
function stripeFor(appEnv: string): RawMap {
  return appEnv === 'production'
    ? {
        STRIPE_MODE: 'live',
        STRIPE_SECRET_KEY: stripeLiveKey,
        STRIPE_PUBLISHABLE_KEY: publishableLiveKey,
        STRIPE_WEBHOOK_SECRET: webhookSecret,
      }
    : { STRIPE_MODE: 'mock', STRIPE_API_BASE: 'http://127.0.0.1:12100' };
}

/** The raw environment of an `api` process: its own scope's variables and no other process's. */
function apiRaw(appEnv: string, overrides: RawMap = {}): RawMap {
  return withOverrides(
    {
      ...commonRaw(appEnv),
      ...stripeFor(appEnv),
      API_PUBLIC_URL: 'https://api.tablemate.test',
      WEB_ORIGIN: 'http://web.tablemate.test',
      VENUE_CONSOLE_ORIGIN: 'http://console.tablemate.test',
      JWT_SECRET: secret(),
      EMAIL_LOOKUP_PEPPER: secret(),
      EXPERIMENT_SALT: secret(),
      NULLIFIER_SALT: '1234567',
      ARTIFACTS_BASE_URL: 'http://artifacts.tablemate.test',
      TERMS_VERSION: '2026-11-01',
    },
    overrides,
  );
}

/** The raw environment of a `workers` process: its own scope's variables, and no `STRIPE_*` key. */
function workersRaw(appEnv: string, overrides: RawMap = {}): RawMap {
  return withOverrides(
    {
      ...commonRaw(appEnv),
      SMTP_URL: 'smtp://127.0.0.1:1025',
      EMAIL_FROM: 'Tablemate <no-reply@tablemate.test>',
      CRAWLER_CONTACT_URL: 'https://tablemate.test/bot',
      API_PUBLIC_URL: 'https://api.tablemate.test',
      WEB_ORIGIN: 'http://web.tablemate.test',
    },
    overrides,
  );
}

/**
 * The fixed vocabulary a reason may name — every mode, and both booleans — so {@link expectEnvError}
 * does not mistake a word like `simulator` for a leaked value: the reasons legitimately read
 * `is required when TELEPHONY_MODE=simulator`. The mode lists come from the modules that own them.
 */
const REASON_VOCABULARY: ReadonlySet<string> = new Set([
  ...ENV_STRIPE_MODES,
  ...ENV_TELEPHONY_MODES,
  ...ENV_LLM_PROVIDERS,
  'test',
  'demo',
  'staging',
  'production',
  'true',
  'false',
]);

/**
 * Run `load` and assert it was refused: the error is an {@link EnvValidationError} naming every
 * variable of `variables`, and no value of `raw` outside {@link REASON_VOCABULARY} and long enough
 * to carry a credential appears in its message, in `String(error)` or in the serialized issues
 * (AAP 0.11.1, 0.12.2).
 */
function expectEnvError(
  load: () => unknown,
  variables: readonly string[],
  raw: RawMap,
): EnvValidationError {
  let thrown: unknown;
  try {
    load();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(EnvValidationError);
  const error = thrown as EnvValidationError;
  const named = error.issues.map((issue) => issue.variable);
  for (const variable of variables) {
    expect(named).toContain(variable);
  }
  const surfaces = [error.message, String(error), JSON.stringify(error.issues)];
  for (const value of Object.values(raw)) {
    if (value === undefined || value.length < 8 || REASON_VOCABULARY.has(value)) {
      continue;
    }
    for (const surface of surfaces) {
      expect(surface).not.toContain(value);
    }
  }
  return error;
}

/**
 * Every own property name reachable in `value`, at any depth, so a Stripe-shaped key cannot hide in
 * a nested object from the `workers` rows.
 */
function propertyNames(value: unknown, seen: Set<object> = new Set()): string[] {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const names: string[] = [];
  for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
    names.push(name, ...propertyNames(child, seen));
  }
  return names;
}

/** The two process loaders, so a row that states the same rule for both process uses one table. */
const LOADERS = {
  api: { raw: apiRaw, load: loadApiEnv },
  workers: { raw: workersRaw, load: loadWorkersEnv },
} as const;

const PROCESSES = ['api', 'workers'] as const;

/** What an API row expects: the variables a refusal has to name, or the assertions a load passes. */
type ApiExpectation = readonly string[] | ((env: ApiEnv) => void);

/** One API row: its label, the mode it starts in, what to change, and what to expect. */
type ApiCase = readonly [label: string, appEnv: string, edit: RawMap, expected: ApiExpectation];

/** The Stripe environments the rows below start from (AAP 0.6.2). */
const STRIPE_TEST_RAW: RawMap = {
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: stripeTestKey,
  STRIPE_PUBLISHABLE_KEY: publishableTestKey,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
};
const STRIPE_LIVE_RAW: RawMap = {
  ...STRIPE_TEST_RAW,
  STRIPE_MODE: 'live',
  STRIPE_SECRET_KEY: stripeLiveKey,
};

/** What each mode's configuration holds once its guard accepted the environment (AAP 0.6.2). */
const MOCK_STRIPE = {
  mode: 'mock',
  apiBase: 'http://127.0.0.1:12100',
  ...STRIPE_MOCK_PLACEHOLDERS,
};
const TEST_STRIPE = {
  mode: 'test',
  secretKey: stripeTestKey,
  publishableKey: publishableTestKey,
  webhookSecret,
};
const LIVE_STRIPE = {
  mode: 'live',
  secretKey: stripeLiveKey,
  publishableKey: publishableLiveKey,
  webhookSecret,
};

const API_STRIPE_CASES: readonly ApiCase[] = [
  ['mock: the placeholders load', 'demo', {}, (env) => expect(env.stripe).toEqual(MOCK_STRIPE)],
  ['mock: no STRIPE_API_BASE', 'demo', { STRIPE_API_BASE: undefined }, ['STRIPE_API_BASE']],
  ['mock: an empty STRIPE_API_BASE', 'demo', { STRIPE_API_BASE: '' }, ['STRIPE_API_BASE']],
  [
    'test: the triple loads',
    'staging',
    STRIPE_TEST_RAW,
    (env) => expect(env.stripe).toEqual(TEST_STRIPE),
  ],
  [
    'test: no STRIPE_SECRET_KEY',
    'staging',
    { ...STRIPE_TEST_RAW, STRIPE_SECRET_KEY: undefined },
    ['STRIPE_SECRET_KEY'],
  ],
  [
    'test: a live key is refused',
    'staging',
    { ...STRIPE_TEST_RAW, STRIPE_SECRET_KEY: stripeLiveKey },
    ['STRIPE_SECRET_KEY'],
  ],
  [
    'mock: a live key is refused too',
    'demo',
    { STRIPE_SECRET_KEY: stripeLiveKey },
    ['STRIPE_SECRET_KEY'],
  ],
  ['live: outside production', 'staging', STRIPE_LIVE_RAW, ['STRIPE_MODE', 'STRIPE_SECRET_KEY']],
  [
    'live: the live triple loads',
    'production',
    {},
    (env) => expect(env.stripe).toEqual(LIVE_STRIPE),
  ],
  [
    'live: a test key is refused',
    'production',
    { STRIPE_SECRET_KEY: stripeTestKey },
    ['STRIPE_SECRET_KEY'],
  ],
  [
    'test: it loads under APP_ENV=test',
    'test',
    STRIPE_TEST_RAW,
    (env) => expect(env.stripe.mode).toBe('test'),
  ],
];

/** The four variables `LLM_PROVIDER=openai` requires, with the two prices of AAP 0.5.6. */
const OPENAI_LLM: RawMap = {
  LLM_PROVIDER: 'openai',
  LLM_API_KEY: openAiKey,
  LLM_MODEL: SUPPORTED_MODELS[0],
  LLM_PRICE_INPUT_USD_PER_MTOK: '0.40',
  LLM_PRICE_OUTPUT_USD_PER_MTOK: '1.60',
};

/** What the provider modes build, once their guard accepted the environment (AAP 0.2.4, 0.5.6). */
const SIMULATOR_TELEPHONY = { mode: 'simulator', ...TWILIO_SIMULATOR };
const API_TWILIO = { mode: 'twilio', accountSid: twilioSid, authToken: twilioToken };
const OPENAI_CONFIG = {
  provider: 'openai',
  apiKey: openAiKey,
  model: SUPPORTED_MODELS[0],
  prices: { inputUsdPerMTok: '0.40', outputUsdPerMTok: '1.60' },
};

const API_MODE_CASES: readonly ApiCase[] = [
  [
    'simulator: the published values load',
    'demo',
    { TELEPHONY_MODE: 'simulator' },
    (env) => expect(env.telephony).toEqual(SIMULATOR_TELEPHONY),
  ],
  [
    'off: the mode carries nothing',
    'demo',
    {},
    (env) => expect(env.telephony).toEqual({ mode: 'off' }),
  ],
  [
    'twilio: both credentials are required',
    'demo',
    { TELEPHONY_MODE: 'twilio' },
    ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  ],
  [
    'twilio: both load, and the API carries no caller id',
    'demo',
    { TELEPHONY_MODE: 'twilio', TWILIO_ACCOUNT_SID: twilioSid, TWILIO_AUTH_TOKEN: twilioToken },
    (env) => expect(env.telephony).toEqual(API_TWILIO),
  ],
  [
    'fake: the provider needs no credential',
    'demo',
    {},
    (env) => expect(env.llm.provider).toBe('fake'),
  ],
  [
    'openai: an unsupported LLM_MODEL',
    'demo',
    { ...OPENAI_LLM, LLM_MODEL: 'not-a-supported-model' },
    ['LLM_MODEL'],
  ],
  ['openai: no LLM_API_KEY', 'demo', { ...OPENAI_LLM, LLM_API_KEY: undefined }, ['LLM_API_KEY']],
  [
    'openai: a malformed price',
    'demo',
    { ...OPENAI_LLM, LLM_PRICE_INPUT_USD_PER_MTOK: 'not-a-price' },
    ['LLM_PRICE_INPUT_USD_PER_MTOK'],
  ],
  [
    'openai: the key, model and prices load',
    'demo',
    OPENAI_LLM,
    (env) => expect(env.llm).toEqual(OPENAI_CONFIG),
  ],
];

/** Run one API row: a refusal, or a load that the row's own assertions inspect. */
function runApiCase(appEnv: string, overrides: RawMap, expectation: ApiExpectation): void {
  const raw = apiRaw(appEnv, overrides);
  if (typeof expectation === 'function') {
    expectation(loadApiEnv(raw));
    return;
  }
  expectEnvError(() => loadApiEnv(raw), expectation, raw);
}

/** Each test-only variable, with a value `APP_ENV=test` accepts (AAP 0.5.1). */
const TEST_ONLY_VALUES: readonly (readonly [variable: string, value: string])[] = [
  ['ZK_ALLOW_TEST_ISSUER', 'true'],
  ['TEST_CONTROL_TOKEN', testControlToken],
  ['CRAWL_ALLOW_PRIVATE_HOSTS', 'fixtures.local'],
];

/** The environments that may not carry a test-only variable. */
const NON_TEST_ENVS = ['demo', 'staging', 'production'] as const;

/**
 * Every test-only variable in every environment that refuses it (AAP 0.6.2). The `api` rows of this
 * table start from {@link apiRaw}, whose production environment carries the live Stripe triple, so
 * the test-only variable is the only finding of that start attempt.
 */
const TEST_ONLY_VIOLATIONS: readonly (readonly [
  appEnv: string,
  variable: string,
  value: string,
])[] = NON_TEST_ENVS.flatMap((appEnv) =>
  TEST_ONLY_VALUES.map(([variable, value]) => [appEnv, variable, value] as const),
);

/** The variables `TELEPHONY_MODE=twilio` requires of `workers` (AAP 0.6.2). */
const WORKERS_TWILIO: RawMap = {
  TELEPHONY_MODE: 'twilio',
  TWILIO_ACCOUNT_SID: twilioSid,
  TWILIO_AUTH_TOKEN: twilioToken,
  TWILIO_FROM_NUMBER: '+14155550100',
  CALL_ALLOWLIST: '+14155550101',
};

/** One `workers` row: a telephony posture with its variables, and a language-model posture. */
type WorkersCase = readonly [label: string, telephonyEnv: RawMap, llmEnv: RawMap];

/** Both provider postures of `workers`, telephony × language model (AAP 0.6.2). */
const WORKERS_CASES: readonly WorkersCase[] = [
  ['off + fake', { TELEPHONY_MODE: 'off' }, { LLM_PROVIDER: 'fake' }],
  ['off + openai', { TELEPHONY_MODE: 'off' }, OPENAI_LLM],
  [
    'simulator + fake',
    { TELEPHONY_MODE: 'simulator', VOICE_SIM_URL: 'http://voice-sim.tablemate.test' },
    { LLM_PROVIDER: 'fake' },
  ],
  [
    'simulator + openai',
    { TELEPHONY_MODE: 'simulator', VOICE_SIM_URL: 'http://voice-sim.tablemate.test' },
    OPENAI_LLM,
  ],
  ['twilio + fake', WORKERS_TWILIO, { LLM_PROVIDER: 'fake' }],
  ['twilio + openai', WORKERS_TWILIO, OPENAI_LLM],
];

describe('api: the Stripe mode guards', () => {
  it.each(API_STRIPE_CASES)('%s', (_label, appEnv, overrides, expectation) => {
    runApiCase(appEnv, overrides, expectation);
  });
});

describe('api: the telephony and language-model modes', () => {
  it.each(API_MODE_CASES)('%s', (_label, appEnv, overrides, expectation) => {
    runApiCase(appEnv, overrides, expectation);
  });
  it('needs no simulator URL, because it validates signatures and dials nothing', () => {
    const env = loadApiEnv(
      apiRaw('demo', { TELEPHONY_MODE: 'simulator', VOICE_SIM_URL: undefined }),
    );
    expect(env.telephony.mode).toBe('simulator');
  });
  it('returns a configuration frozen at every depth', () => {
    const env = loadApiEnv(apiRaw('demo'));
    for (const section of [env, env.stripe, env.telephony, env.llm, env.testOnly]) {
      expect(Object.isFrozen(section)).toBe(true);
    }
  });
});

describe('test-only variables', () => {
  it.each(TEST_ONLY_VIOLATIONS)('api refuses %s in %s', (appEnv, variable, value) => {
    const raw = apiRaw(appEnv, { [variable]: value });
    const error = expectEnvError(() => loadApiEnv(raw), [variable], raw);
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
  });
  it.each(TEST_ONLY_VIOLATIONS)('workers refuses %s in %s', (appEnv, variable, value) => {
    const raw = workersRaw(appEnv, { [variable]: value });
    const error = expectEnvError(() => loadWorkersEnv(raw), [variable], raw);
    expect(error.issues.map((issue) => issue.variable)).toEqual([variable]);
  });
  it.each(PROCESSES)('%s accepts all three under APP_ENV=test', (name) => {
    const raw = LOADERS[name].raw('test', {
      ZK_ALLOW_TEST_ISSUER: 'true',
      TEST_CONTROL_TOKEN: testControlToken,
      CRAWL_ALLOW_PRIVATE_HOSTS: 'fixtures.local',
    });
    expect(LOADERS[name].load(raw).testOnly).toEqual({
      zkAllowTestIssuer: true,
      testControlToken,
      crawlAllowPrivateHosts: ['fixtures.local'],
    });
  });
  it('keeps every test-only switch off in production', () => {
    const raw = apiRaw('production', { TEST_CONTROL_TOKEN: '' });
    expect(loadApiEnv(raw).testOnly).toEqual({
      zkAllowTestIssuer: false,
      testControlToken: null,
      crawlAllowPrivateHosts: [],
    });
  });
});

describe('workers: no Stripe variable in any mode', () => {
  it.each(WORKERS_CASES)('%s starts without one', (_label, telephonyEnv, llmEnv) => {
    const raw = workersRaw('demo', { ...telephonyEnv, ...llmEnv });
    expect(Object.keys(raw).filter((name) => name.startsWith('STRIPE_'))).toEqual([]);
    const env: WorkersEnv = loadWorkersEnv(raw);
    expect(propertyNames(env).filter((name) => /stripe/i.test(name))).toEqual([]);
  });
  it('ignores the Stripe triple an environment may carry', () => {
    const raw = workersRaw('demo', {
      STRIPE_MODE: 'mock',
      STRIPE_SECRET_KEY: stripeTestKey,
      STRIPE_PUBLISHABLE_KEY: publishableTestKey,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
    });
    expect(propertyNames(loadWorkersEnv(raw)).filter((name) => /stripe/i.test(name))).toEqual([]);
  });
  it('requires VOICE_SIM_URL in simulator mode', () => {
    const raw = workersRaw('demo', { TELEPHONY_MODE: 'simulator' });
    expectEnvError(() => loadWorkersEnv(raw), ['VOICE_SIM_URL'], raw);
  });
  it('requires both credentials, the caller id and the allowlist in twilio mode', () => {
    const raw = workersRaw('demo', { TELEPHONY_MODE: 'twilio' });
    expectEnvError(
      () => loadWorkersEnv(raw),
      ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'CALL_ALLOWLIST'],
      raw,
    );
  });
  it('requires the allowlist for twilio outside production only', () => {
    const overrides: RawMap = { ...WORKERS_TWILIO, CALL_ALLOWLIST: undefined };
    const staging = workersRaw('staging', overrides);
    expectEnvError(() => loadWorkersEnv(staging), ['CALL_ALLOWLIST'], staging);
    const production = loadWorkersEnv(workersRaw('production', overrides));
    expect(production.telephony.mode).toBe('twilio');
    expect(production.CALL_ALLOWLIST.size).toBe(0);
  });
  it('refuses an allowlist entry that is not an E.164 number', () => {
    const raw = workersRaw('demo', { CALL_ALLOWLIST: 'not-a-number' });
    expectEnvError(() => loadWorkersEnv(raw), ['CALL_ALLOWLIST'], raw);
  });
});

describe('both processes: the common variables', () => {
  it.each(PROCESSES)('%s refuses a missing APP_ENV', (name) => {
    const raw = LOADERS[name].raw('demo', { APP_ENV: undefined });
    expectEnvError(() => LOADERS[name].load(raw), ['APP_ENV'], raw);
  });
  it.each(PROCESSES)('%s refuses an APP_ENV outside the four modes', (name) => {
    const raw = LOADERS[name].raw('prod', {});
    expect(expectEnvError(() => LOADERS[name].load(raw), ['APP_ENV'], raw).process).toBe(name);
  });
  it.each(PROCESSES)('%s refuses a FIELD_ENCRYPTION_KEY that is not 32 bytes', (name) => {
    const raw = LOADERS[name].raw('demo', {
      FIELD_ENCRYPTION_KEY: randomBytes(31).toString('base64'),
    });
    expectEnvError(() => LOADERS[name].load(raw), ['FIELD_ENCRYPTION_KEY'], raw);
  });
  it('api refuses a JWT_SECRET shorter than 32 characters', () => {
    const raw = apiRaw('demo', { JWT_SECRET: randomBytes(5).toString('hex') });
    expectEnvError(() => loadApiEnv(raw), ['JWT_SECRET'], raw);
  });
  it('requires only the variables of the process being configured', () => {
    // `SMTP_URL` belongs to `workers` and `JWT_SECRET` to `api`; each schema drops the other's, so
    // neither is ever required where it does not belong (AAP 0.6.2, 0.11.2).
    expect(loadApiEnv(apiRaw('demo', { SMTP_URL: 'smtp://127.0.0.1:1025' })).APP_ENV).toBe('demo');
    expect(loadWorkersEnv(workersRaw('demo', { JWT_SECRET: secret() })).APP_ENV).toBe('demo');
    const missing = workersRaw('demo', { SMTP_URL: undefined });
    expect(expectEnvError(() => loadWorkersEnv(missing), ['SMTP_URL'], missing).process).toBe(
      'workers',
    );
  });
  it('requires neither of the two api-scoped variables of workers', () => {
    // `API_PUBLIC_URL` and `WEB_ORIGIN` are the `api` row's (AAP 0.6.2) and `workers` reads them
    // where a deployment provides them, so their absence fails the call-dispatch or magic-link work
    // rather than this process's start — while `api`, whose row they are, still requires both.
    const workers = workersRaw('demo', { API_PUBLIC_URL: undefined, WEB_ORIGIN: undefined });
    const env = loadWorkersEnv(workers);
    expect(env.API_PUBLIC_URL).toBeNull();
    expect(env.WEB_ORIGIN).toBeNull();
    const api = apiRaw('demo', { WEB_ORIGIN: undefined });
    expectEnvError(() => loadApiEnv(api), ['WEB_ORIGIN'], api);
  });
  it('reports every finding of one start attempt, once each', () => {
    const raw = apiRaw('demo', { JWT_SECRET: undefined, NULLIFIER_SALT: 'not a field element' });
    const error = expectEnvError(() => loadApiEnv(raw), ['JWT_SECRET', 'NULLIFIER_SALT'], raw);
    const named = error.issues.map((issue) => issue.variable);
    expect(new Set(named).size).toBe(named.length);
    for (const issue of error.issues) {
      expect(issue.reason.length).toBeGreaterThan(0);
    }
  });
});
