/**
 * The app-level notice and the rule that keeps it the one notice for the failure it reports
 * (AAP 0.5.8, AAP 0.8.1).
 *
 * `app/_layout.tsx` owns the state, because it is the caller of `bootstrap()`: when the session
 * cannot be restored because the API did not answer, the root layout renders the notice and
 * publishes its sentence here, around the screens. Two behaviours follow from that one value:
 *
 *   - a screen whose own read cannot even run while the session is unrestorable — its query is
 *     disabled until the session exists, so it stays `isPending` for as long as the API is
 *     unreachable — reads {@link useAppNoticeMessage} and leaves its loading placeholder out,
 *     because the notice already explains why nothing arrived;
 *   - an error `Banner` whose sentence is the one the notice is speaking renders nothing, so one
 *     failure never reaches the reader twice with two different action labels.
 *
 * The notice itself is rendered outside the scope this provider creates — it is the provider's
 * sibling in the root layout — so a notice can never yield to itself.
 */
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

/**
 * The sentence the app-level notice is speaking, or null while no such notice is on screen. The
 * sentence is the value rather than a flag, because what a screen has to decide is whether the
 * notice already says what the screen itself would say.
 */
const AppNoticeContext = createContext<string | null>(null);

/**
 * Props of {@link AppNoticeProvider}.
 */
export interface AppNoticeProviderProps {
  /** What {@link useAppNoticeMessage} answers for every screen below this provider. */
  notice: string | null;

  /** The subtree the value applies to: the router's screens. */
  children: ReactNode;
}

/**
 * Publishes the app-level notice's sentence to the screens below it.
 *
 * A provider and not a store of its own: the state belongs to the root layout, which is the only
 * caller of `bootstrap()`, and everything that reads it sits inside that same tree.
 *
 * @param props - {@link AppNoticeProviderProps}.
 * @returns The context provider, which draws no element of its own.
 */
export function AppNoticeProvider({ notice, children }: AppNoticeProviderProps): ReactElement {
  return <AppNoticeContext.Provider value={notice}>{children}</AppNoticeContext.Provider>;
}

/**
 * The sentence the app-level notice is speaking, or null while no such notice is on screen.
 *
 * A component outside every {@link AppNoticeProvider} reads null, which is what keeps the notice
 * itself — rendered as the provider's sibling — out of its own deferral rule.
 *
 * @returns The notice's sentence, or null.
 */
export function useAppNoticeMessage(): string | null {
  return useContext(AppNoticeContext);
}
