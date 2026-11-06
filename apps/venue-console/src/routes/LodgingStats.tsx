/**
 * The lodging stats console: one lodging's leaderboard standing and its 90-day trend, read from
 * `GET /v1/lodging-console/stats` with the operator-issued secret in `X-Lodging-Secret`
 * (AAP 0.5.1, 0.5.4, 0.8.1; requirement 15).
 *
 * The screen shows the server's numbers and derives none of its own: a verified guest count below
 * three never arrives as a number, because the API serializes the label instead (AAP 0.5.7 "Lodging
 * visibility"), so the value is printed exactly as it was received and is never computed, compared or
 * substituted here; every score and rank is the leaderboard's, and the leaderboard is cached in Redis
 * for 60 s (AAP 0.5.7), so there is no auto-poll; and a rejected secret is not retried here, because
 * `api.ts` has already dropped it and reported kind `unauthorized` (AAP 0.5.4).
 *
 * Nothing is styled inline: the console's Content-Security-Policy admits no inline style attribute
 * (AAP 0.3.2), so every colour and measurement comes from a class in `../styles.css`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LEADERBOARD_PAIR_DEDUPE_DAYS,
  LEADERBOARD_WINDOW_DAYS,
  LODGING_TREND_WEEKS,
} from '@tablemate/shared';
import type { LodgingConsoleStats, TrendPoint } from '@tablemate/shared';

import { ConsoleApiError, fetchLodgingStats } from '../api.ts';

/** The trend's viewBox units: one 8-unit bar plus a 2-unit gap per week, in a 60-unit-tall plot. */
const TREND_UNIT_WIDTH = 10;
const TREND_BAR_WIDTH = 8;
const TREND_HEIGHT = 60;
const TREND_WIDTH = LODGING_TREND_WEEKS * TREND_UNIT_WIDTH;

/** One week of the trend as a bar: where it sits, how tall it is and the point it draws, which is
 * also its React key. A height of 0 is a week with no activity. */
interface TrendBar {
  point: TrendPoint;
  x: number;
  height: number;
}

/**
 * The trend's bars, each scaled against the busiest week of the window (AAP 0.5.4). A week with
 * activity keeps at least one unit, so a score that rounds below one still shows as a bar; a window
 * with no activity at all is drawn as its baseline alone.
 */
function trendBars(trend: readonly TrendPoint[]): TrendBar[] {
  const busiest = trend.reduce((highest, point) => Math.max(highest, point.activityScore), 0);
  if (busiest === 0) {
    return [];
  }
  return trend.map((point, index) => ({
    point,
    x: index * TREND_UNIT_WIDTH,
    height:
      point.activityScore === 0
        ? 0
        : Math.max(1, Math.round((point.activityScore / busiest) * TREND_HEIGHT)),
  }));
}

/** The trend's accessible name: every score in the order it is drawn, oldest first, because the
 * chart's own shape says nothing to a screen reader (AAP 0.5.8). */
function trendLabel(trend: readonly TrendPoint[]): string {
  const scores = trend.map((point) => point.activityScore).join(', ');
  return `Weekly activity scores, oldest first: ${scores}`;
}

/**
 * The lodging stats screen (AAP 0.5.4, 0.5.8). `onUnauthorized` is called when the API rejects the
 * secret, so `App.tsx` can return the console to its secret form.
 */
export function LodgingStats({
  secret,
  onUnauthorized,
}: {
  secret: string;
  onUnauthorized: () => void;
}): JSX.Element {
  const [stats, setStats] = useState<LodgingConsoleStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  // The latest `onUnauthorized`, held in a ref so a new callback does not restart a request that is
  // already in flight; it is read only after an await, never during render.
  const onUnauthorizedRef = useRef(onUnauthorized);
  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const next = await fetchLodgingStats(secret, controller.signal);
        if (controller.signal.aborted) {
          return;
        }
        setStats(next);
        setFailed(false);
        setLoading(false);
      } catch (error) {
        // A cancellation is this effect's own cleanup -- `api.ts` rethrows it exactly as it arrived
        // -- and is never a failure. A request cut short by its deadline is a `ConsoleApiError` of
        // kind `network`, which is handled with the other failures below (AAP 0.5.4, 0.11.1).
        if (controller.signal.aborted) {
          return;
        }
        if (error instanceof ConsoleApiError && error.kind === 'unauthorized') {
          // The request is over, so the screen must not go on claiming one is in flight while the
          // console asks for the secret again.
          setLoading(false);
          onUnauthorizedRef.current();
          return;
        }
        // Any previous stats stay on screen; only the failure line is added above them.
        setFailed(true);
        setLoading(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [secret, reloadToken]);

  const refresh = useCallback((): void => {
    // A new attempt replaces the last failure, so the screen never shows a stale failure while a
    // request it started is in flight (AAP 0.5.8 state precedence).
    setFailed(false);
    setLoading(true);
    setReloadToken((token) => token + 1);
  }, []);

  // A tab returning to the foreground refetches, and nothing else does: the leaderboard is cached
  // server-side for 60 s (AAP 0.5.7), so a poll would re-read the same answer.
  useEffect(() => {
    function onVisibilityChange(): void {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  const bars = stats === null ? [] : trendBars(stats.weeklyTrend);

  return (
    <>
      <header>
        <button type="button" onClick={refresh} disabled={loading}>
          {/* The control states what it is doing: before the first answer it is loading the screen,
              after one it is refreshing stats a reader has already been shown. */}
          {loading ? (stats === null ? 'Loading…' : 'Refreshing…') : 'Refresh'}
        </button>
      </header>

      {failed ? (
        <div role="alert" className="notice notice-error">
          <p>Couldn't load your stats. Try again.</p>
          <button type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}

      {/* The heading is the screen's own and never the lodging's — the route's body carries no name
          (AAP 0.5.4) — so the level-1 heading is here in every state, and the section, which is the
          region the request updates, carries the in-flight state rather than the button. */}
      <section data-testid="lodging-stats" aria-busy={loading}>
        <h1>Lodging stats</h1>
        {stats === null ? (
          loading ? (
            <p role="status" className="notice">
              Loading stats…
            </p>
          ) : null
        ) : (
          <>
            <dl>
              <div>
                <dt>Leaderboard rank</dt>
                {/* `rank` is always a positive integer of the city's ranking, even for a lodging
                    scoring 0 (AAP 0.5.4), so there is no unranked value to render. */}
                <dd data-testid="lodging-rank">{stats.rank}</dd>
              </div>
              <div>
                <dt>{`Activity score (last ${LEADERBOARD_WINDOW_DAYS} days)`}</dt>
                <dd data-testid="lodging-activity-score">{stats.activityScore}</dd>
              </div>
              <div>
                <dt>Verified guests</dt>
                {/* Printed exactly as the server sent it: a number of three or more, or the label it
                    substitutes below three, so a count under three never appears as a number
                    (AAP 0.5.7). */}
                <dd data-testid="lodging-verified-guests">{stats.verifiedGuests}</dd>
              </div>
            </dl>
            <p>{`Your score counts witnessed meetups involving your verified guests over the last ${LEADERBOARD_WINDOW_DAYS} days; each pair of travelers counts once in any ${LEADERBOARD_PAIR_DEDUPE_DAYS} days.`}</p>
          </>
        )}
      </section>

      {stats === null ? null : (
        <figure className="trend" data-testid="lodging-trend">
          <figcaption>{`Weekly activity, last ${LODGING_TREND_WEEKS} weeks`}</figcaption>
          {/* `../styles.css` gives the SVG the column's width, so the viewBox is scaled into that
              box rather than to an intrinsic size. */}
          <svg
            role="img"
            aria-label={trendLabel(stats.weeklyTrend)}
            viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
            preserveAspectRatio="none"
          >
            <line
              className="trend-baseline"
              x1={0}
              y1={TREND_HEIGHT}
              x2={TREND_WIDTH}
              y2={TREND_HEIGHT}
            />
            {bars.map((bar) => (
              <rect
                key={bar.point.weekStart}
                className="trend-bar"
                x={bar.x}
                y={TREND_HEIGHT - bar.height}
                width={TREND_BAR_WIDTH}
                height={bar.height}
              >
                <title>{`Week of ${bar.point.weekStart}: ${bar.point.activityScore}`}</title>
              </rect>
            ))}
          </svg>
        </figure>
      )}
    </>
  );
}
