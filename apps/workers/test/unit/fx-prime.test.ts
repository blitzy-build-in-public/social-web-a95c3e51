/**
 * The FX prime's unit suite (AAP 0.5.6): the one-off `fx-refresh` run `apps/workers/src/main.ts`
 * enqueues at startup while no run has written the `FxRate` table.
 *
 * The rule it holds is the conversion's own: AAP 0.5.6 converts a price at the capture day's
 * `FxRate`, and the delivered `fx-refresh` job is the only writer of that table, on a schedule whose
 * first run is 00:30 UTC — so a stack younger than that run has a price entry that can convert
 * nothing until the prime runs the same job. The prime therefore adds a job and returns; it never
 * writes a rate, which is what keeps "no price is ever guessed" true on this path (AAP 0.5.6).
 *
 * No database, no Redis and no provider are needed: the context is a fake whose only collaborators
 * are the row count the gate reads and the producer registry it adds through, so a case reads the
 * queue, the job name, the parsed data and the options a real enqueue would have carried
 * (AAP 0.11.2). The table holds one row or none, which is all the gate asks. The fake is cast to
 * {@link WorkerContext} because a start path builds a dozen collaborators this function never
 * touches.
 *
 * @see AAP 0.5.6 for the daily 00:30 UTC refresh, its 10-minute backoff and the conversion rule,
 *   0.3.2 for the custom job id BullMQ accepts, 0.11.1 for the injected clock this module never
 *   reads, and 0.8.1 for this file.
 */

import { describe, expect, it } from 'vitest';

import {
  FX_REFRESH_PRIME_JOB_ID,
  JOB,
  QUEUE,
  jobOptionsFor,
  parseJobData,
} from '@tablemate/server-core';

import { primeFxTable } from '../../src/schedulers.ts';
import type { WorkerContext } from '../../src/queues.ts';

/**
 * One enqueue as the fake producer recorded it: the queue it went to, and the three arguments the
 * `add` call carried. `queue` is the string the registry was asked for rather than a `QueueName`, so
 * a prime that enqueued into the wrong queue fails the assertion instead of being typed away.
 */
interface Enqueue {
  readonly queue: string;
  readonly name: string;
  readonly data: unknown;
  readonly options: Record<string, unknown>;
}

/**
 * A context whose only collaborators are the two reads {@link primeFxTable} makes: `fxRows` is what
 * `db.fxRate.count()` answers, and the producer registry records every `add` into the returned list.
 * Nothing is connected, so the suite runs with no PostgreSQL and no Redis in sight (AAP 0.11.2).
 *
 * @param fxRows - how many `FxRate` rows the case's table holds: `0` for a stack no run has primed.
 * @returns the context to pass, and the enqueues it recorded.
 */
function contextWith(fxRows: number): {
  readonly ctx: WorkerContext;
  readonly enqueued: Enqueue[];
} {
  const enqueued: Enqueue[] = [];

  const ctx = {
    db: { fxRate: { count: (): Promise<number> => Promise.resolve(fxRows) } },
    queues: {
      get: (queue: string) => ({
        add: (name: string, data: unknown, options: Record<string, unknown>): Promise<void> => {
          enqueued.push({ queue, name, data, options });
          return Promise.resolve();
        },
      }),
    },
  } as unknown as WorkerContext;

  return { ctx, enqueued };
}

describe('primeFxTable', () => {
  it('enqueues exactly one fx-refresh run while the table is empty', async () => {
    const { ctx, enqueued } = contextWith(0);

    expect(await primeFxTable(ctx)).toBe(true);

    expect(enqueued).toHaveLength(1);
    const [job] = enqueued;

    // The delivered job of the queue `fx-refresh` runs, under the name its own processor accepts:
    // priming runs the pipeline that exists rather than a second way to write a rate (AAP 0.5.6).
    expect(job?.queue).toBe(QUEUE.fxRefresh);
    expect(job?.name).toBe(JOB[QUEUE.fxRefresh].refresh);

    // The data is the parse's own answer, so a payload the queue's schema refuses fails the start
    // rather than a processor (AAP 0.5.6).
    expect(job?.data).toEqual(parseJobData(QUEUE.fxRefresh, JOB[QUEUE.fxRefresh].refresh, {}));

    // The id is the constant's — `fx-refresh-prime`, whose `-` is what BullMQ accepts in a custom id
    // (AAP 0.3.2) — and the rest of the options are the queue's own policy, so a provider outage
    // retries on the five tries and 10-minute backoff of AAP 0.5.6 like any other run of the job.
    expect(job?.options).toEqual(
      jobOptionsFor(QUEUE.fxRefresh, { jobId: FX_REFRESH_PRIME_JOB_ID }),
    );
    expect(FX_REFRESH_PRIME_JOB_ID.includes(':')).toBe(false);
  });

  it('enqueues nothing once the table holds a rate', async () => {
    const { ctx, enqueued } = contextWith(1);

    expect(await primeFxTable(ctx)).toBe(false);

    // A table with a row already serves the conversion — the read `usdRateFor` makes takes the latest
    // rate at or before the capture day — so a second provider call would be nothing but traffic.
    expect(enqueued).toHaveLength(0);
  });
});
