/**
 * The operator's language-model re-enable at the module boundary (AAP 0.5.6, 0.11.1): the flag it
 * clears, the counter it leaves standing, the store it resolves and the one refusal it raises.
 *
 * The route end to end, against real Redis, is `apps/api/test/integration/admin.test.ts`. What no
 * integration case can stage is a flag store that fails while Redis otherwise answers, because such a
 * request is refused at the rate limiter first: an operator would see the limiter's
 * `503 service_unavailable` and never reach the handler. That refusal is what these rows pin, since
 * it is the difference between an actionable "the suspension could not be cleared" and a `500` for an
 * outage the route never mentions.
 *
 * @see AAP 0.5.6 for the suspension, its two Redis keys and the operator's re-enable, 0.11.1 for the
 *   narrowed log line that carries a failure's own short code and nothing else.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  LLM_COUNT_MISMATCHES_KEY,
  LLM_SUSPENDED_KEY,
  createRedisSuspensionStore,
} from '@tablemate/server-core';
import type { SuspensionRedis } from '@tablemate/server-core';

import { reEnableLanguageModel } from '../../src/modules/admin/metrics.ts';
import type { AdminMetricsServices } from '../../src/modules/admin/metrics.ts';

/** The operator every row acts as: an id and nothing else, which is all the re-enable reads. */
const OPERATOR_ID = '00000000-0000-4000-8000-0000000000c1';

/** The flag's value as `SuspensionStore.suspend` writes it, for a row that starts suspended. */
const SUSPENDED_VALUE = JSON.stringify({
  since: '2026-11-04T12:00:00.000Z',
  reason: 'llm_count_mismatch',
});

/** One captured line: the level it was written at, and the fields it carried. */
interface CapturedLine {
  readonly level: 'info' | 'warn';
  readonly fields: Record<string, unknown>;
}

/** Every line the module logged, in order, cleared per row. */
const lines: CapturedLine[] = [];

/**
 * The two suspension keys in memory, as {@link createRedisSuspensionStore} uses them: one map behind
 * `get`/`set`/`del`, an `incr` the mismatch path needs, and a `failWith` that makes every command
 * reject with that code, which is what a connection left unanswered by a paused server reports.
 */
class FakeSuspensionRedis implements SuspensionRedis {
  readonly values = new Map<string, string>();

  /** The code every command rejects with, or null while the fake answers normally. */
  failWith: string | null = null;

  get(key: string): Promise<string | null> {
    return this.run(() => this.values.get(key) ?? null);
  }

  set(key: string, value: string): Promise<unknown> {
    return this.run(() => {
      this.values.set(key, value);
      return 'OK';
    });
  }

  incr(key: string): Promise<number> {
    return this.run(() => {
      const next = Number.parseInt(this.values.get(key) ?? '0', 10) + 1;
      this.values.set(key, String(next));
      return next;
    });
  }

  del(key: string): Promise<number> {
    return this.run(() => (this.values.delete(key) ? 1 : 0));
  }

  private run<T>(command: () => T): Promise<T> {
    const code = this.failWith;
    if (code === null) {
      return Promise.resolve(command());
    }
    return Promise.reject(Object.assign(new Error('redis unavailable'), { code }));
  }
}

/**
 * The services {@link reEnableLanguageModel} reads — the flag's store or the Redis it is built from,
 * and the logger — under the narrowed declaration `metrics.ts` states.
 *
 * The database and configuration members the interface also carries are `null` behind the one cast:
 * the re-enable reaches the flag and no table and no cap, so a fake Prisma client and a fabricated
 * environment would be two more doubles for nothing. The logger is a real double rather than pino, so
 * a row asserts on the fields of each line.
 */
function servicesWith(
  stores: Pick<AdminMetricsServices, 'suspension' | 'redis'>,
): AdminMetricsServices {
  const logger = {
    info: (fields: unknown) =>
      lines.push({ level: 'info', fields: fields as Record<string, unknown> }),
    warn: (fields: unknown) =>
      lines.push({ level: 'warn', fields: fields as Record<string, unknown> }),
  };

  return { db: null, env: null, logger, ...stores } as unknown as AdminMetricsServices;
}

beforeEach(() => {
  lines.length = 0;
});

describe('the operator language-model re-enable (AAP 0.5.6)', () => {
  it('clears the flag, answers the state it read back and leaves the counter standing', async () => {
    const redis = new FakeSuspensionRedis();
    redis.values.set(LLM_SUSPENDED_KEY, SUSPENDED_VALUE);
    redis.values.set(LLM_COUNT_MISMATCHES_KEY, '4');

    const answer = await reEnableLanguageModel(
      servicesWith({ suspension: createRedisSuspensionStore(redis) }),
      OPERATOR_ID,
    );

    // The flag is gone and the counter is not: the count is the spend panel's evidence, and only the
    // flag is the suspension (AAP 0.5.6).
    expect(answer).toEqual({ suspended: false, mismatches: 4 });
    expect(redis.values.has(LLM_SUSPENDED_KEY)).toBe(false);
    expect(redis.values.get(LLM_COUNT_MISMATCHES_KEY)).toBe('4');

    // One success line, the event and the acting operator, and nothing else (AAP 0.11.1).
    expect(lines).toEqual([
      { level: 'info', fields: { event: 'llm_suspension_cleared', operatorId: OPERATOR_ID } },
    ]);
  });

  it.each([
    {
      name: 'the Redis client itself',
      of: (redis: FakeSuspensionRedis): SuspensionRedis => redis,
    },
    {
      name: 'the connection object the app holds it under',
      of: (redis: FakeSuspensionRedis): SuspensionRedis | { client: SuspensionRedis } => ({
        client: redis,
      }),
    },
  ])(
    'resolves the flag through $name when the root exposes no store of its own',
    async ({ of }) => {
      const redis = new FakeSuspensionRedis();
      redis.values.set(LLM_SUSPENDED_KEY, SUSPENDED_VALUE);
      redis.values.set(LLM_COUNT_MISMATCHES_KEY, '1');

      const answer = await reEnableLanguageModel(servicesWith({ redis: of(redis) }), OPERATOR_ID);

      expect(answer).toEqual({ suspended: false, mismatches: 1 });
      expect(redis.values.has(LLM_SUSPENDED_KEY)).toBe(false);
    },
  );

  it('refuses with 503 service_unavailable and one narrowed line when the clear fails', async () => {
    const redis = new FakeSuspensionRedis();
    redis.failWith = 'ETIMEDOUT';

    await expect(
      reEnableLanguageModel(
        servicesWith({ suspension: createRedisSuspensionStore(redis) }),
        OPERATOR_ID,
      ),
    ).rejects.toMatchObject({ code: 'service_unavailable', httpStatus: 503 });

    // The failure's own short code reaches the line; its message and stack do not (AAP 0.11.1).
    expect(lines).toEqual([
      { level: 'warn', fields: { event: 'llm_suspension_clear_failed', code: 'ETIMEDOUT' } },
    ]);
    expect(redis.values.size).toBe(0);
  });

  it('refuses the same way when the composition root holds no flag store at all', async () => {
    await expect(reEnableLanguageModel(servicesWith({}), OPERATOR_ID)).rejects.toMatchObject({
      code: 'service_unavailable',
      httpStatus: 503,
    });

    expect(lines).toEqual([
      { level: 'warn', fields: { event: 'llm_suspension_clear_failed', code: 'no_store' } },
    ]);
  });
});
