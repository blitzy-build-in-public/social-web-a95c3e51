/**
 * The lodging stats console: one lodging's leaderboard standing and its 90-day trend, read from
 * `GET /v1/lodging-console/stats` with the operator-issued secret in `X-Lodging-Secret` (AAP 0.5.1, 0.5.4, 0.8.1;
 * requirement 15).
 *
 * The screen shows the server's numbers and derives none of its own: a verified guest count below three never arrives as a
 * number, because the API serializes the label instead (AAP 0.5.7 "Lodging visibility"), so the value is printed exactly as
 * received and is never computed, compared or substituted here; every score and rank is the leaderboard's, cached in Redis
 * for 60 s (AAP 0.5.7), so there is no auto-poll; and a rejected secret is not retried here, because `api.ts` has already
 * dropped it and reported kind `unauthorized` (AAP 0.5.4). Nothing is styled inline: the console's Content-Security-Policy
 * admits no inline style attribute (AAP 0.3.2), so every colour and measurement comes from a class in `../styles.css`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LEADERBOARD_PAIR_DEDUPE_DAYS,
  LEADERBOARD_WINDOW_DAYS,
  LODGING_TREND_WEEKS,
  componentSizes,
} from '@tablemate/shared';
import type { LodgingConsoleStats, TrendPoint } from '@tablemate/shared';

import { ConsoleApiError, fetchLodgingStats } from '../api.ts';

/** The trend's viewBox units, from the shared component sizes: one bar plus the rest of its unit as
 * the gap to the next week, in a plot the tokens' `trendHeight` tall. */
const TREND_UNIT_WIDTH = componentSizes.trendUnitWidth;
const TREND_BAR_WIDTH = componentSizes.trendBarWidth;
const TREND_HEIGHT = componentSizes.trendHeight;
const TREND_WIDTH = LODGING_TREND_WEEKS * TREND_UNIT_WIDTH;

/** Every fourth week carries an axis label below the chart (AAP 0.5.8): with 13 slots that is the
 * first, fifth, ninth and last column, which dates a bar closely enough to read the chart while
 * leaving the labels room enough not to meet at the narrowest viewport. */
const TREND_LABEL_EVERY = 4;

/** One week of the trend as drawn: where its slot sits, how tall its bar is and the point it draws,
 * which is also its React key. A height of 0 is a week with no activity: it shows no bar, and its
 * slot still carries a target of its own, so the week is inspected like any other. */
interface TrendWeek {
  point: TrendPoint;
  x: number;
  height: number;
}

/**
 * The trend's weeks, each bar scaled against the busiest week of the window (AAP 0.5.4). A week with activity keeps at
 * least one unit, so a score that rounds below one still shows as a bar; a week with none keeps a height of 0 and draws no
 * bar at all — a zero-height rect has no area and cannot be pointed at — but it keeps its slot, which is what lets the
 * chart give it a target of its own. A window with no activity is therefore its baseline alone, with all 13 weeks still
 * inspectable.
 */
function trendWeeks(trend: readonly TrendPoint[]): TrendWeek[] {
  const busiest = trend.reduce((highest, point) => Math.max(highest, point.activityScore), 0);
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

/** The abbreviated month names, by month number minus one, for {@link axisLabel}. */
const MONTH_ABBREVIATIONS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * The axis row's label for one week start: the server's own `2026-08-30` reads as `Aug 30`. The fields are read out of the
 * string, never through `Date`, which would read a bare date at UTC midnight and show the previous day in a browser behind
 * UTC, while `weekStart` is the city's own calendar date (AAP 0.5.4). A value outside the schema's `DateOnly` spelling falls
 * back to the string it arrived as, so a label is always printed rather than a blank track.
 */
function axisLabel(weekStart: string): string {
  const month = MONTH_ABBREVIATIONS[Number(weekStart.slice(5, 7)) - 1];
  const day = Number(weekStart.slice(8, 10));
  if (month === undefined || !Number.isInteger(day)) {
    return weekStart;
  }
  return `${month} ${day}`;
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
  const weeks = stats === null ? [] : trendWeeks(stats.weeklyTrend);
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
            {/* The bars first, then one transparent target per week over them: a target drawn under
                its bar would answer the pointer only in the slot beside it, and a week with no
                activity would answer nothing at all, because its own rect has no area. Every week
                therefore carries its own `<title>`, the zero weeks included (AAP 0.5.8). */}
            {weeks.map((week) =>
              week.height === 0 ? null : (
                <rect
                  key={week.point.weekStart}
                  className="trend-bar"
                  x={week.x}
                  y={TREND_HEIGHT - week.height}
                  width={TREND_BAR_WIDTH}
                  height={week.height}
                />
              ),
            )}
            {weeks.map((week) => (
              <rect
                key={week.point.weekStart}
                className="trend-target"
                x={week.x}
                y={0}
                width={TREND_UNIT_WIDTH}
                height={TREND_HEIGHT}
              >
                <title>{`Week of ${week.point.weekStart}: ${week.point.activityScore}`}</title>
              </rect>
            ))}
          </svg>
          {/* The x-axis as HTML rather than text inside the SVG, whose `preserveAspectRatio`
              "none" would stretch whatever it draws. Its 13 tracks are the bars' own slots -- one
              per week, so a label starts where the bar above it starts -- and it is hidden from
              assistive technology because the SVG's own name already lists every score. */}
          <div className="trend-axis" data-testid="lodging-trend-axis" aria-hidden="true">
            {weeks.map((week, index) => (
              <span key={week.point.weekStart}>
                {index % TREND_LABEL_EVERY === 0 ? axisLabel(week.point.weekStart) : ''}
              </span>
            ))}
          </div>
        </figure>
      )}
    </>
  );
}
