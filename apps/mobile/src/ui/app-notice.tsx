/**
 * The app-level notice, and the rule that keeps it the one notice for the failure it reports: an error `Banner` whose
 * sentence is the one the notice is speaking renders nothing, so one failure never reaches the reader twice with two
 * different action labels.
 *
 * `app/_layout.tsx` owns the state, because it is the caller of `bootstrap()`. A screen whose own read cannot run while
 * the session is unrestorable reads {@link useAppNoticeMessage} and leaves its loading placeholder out.
 */
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

// The sentence rather than a flag, because what a screen has to decide is whether the notice already
// says what the screen itself would say.
const AppNoticeContext = createContext<string | null>(null);

export interface AppNoticeProviderProps {
  /** What {@link useAppNoticeMessage} answers for every screen below this provider. */
  notice: string | null;
  children: ReactNode;
}

export function AppNoticeProvider({ notice, children }: AppNoticeProviderProps): ReactElement {
  return <AppNoticeContext.Provider value={notice}>{children}</AppNoticeContext.Provider>;
}

// A reader outside every provider gets null, which is what keeps the notice itself — rendered as the
// provider's sibling in the root layout — out of its own deferral rule.
export function useAppNoticeMessage(): string | null {
  return useContext(AppNoticeContext);
}
