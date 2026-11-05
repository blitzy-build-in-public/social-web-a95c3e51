/**
 * `Banner` — the notice and error surface every Tablemate screen shows, and `announce()`, the
 * announcement the core flows' errors are spoken through (AAP 0.5.8, AAP 0.8.1).
 *
 * A banner carries the import prompt, the safety notice shown before a proposal and before a
 * lock, the `lock_lost` sentences and API errors. It never holds the words itself: copy comes from
 * `src/copy/strings.ts` and `@tablemate/shared`, so a screen passes the string it already has.
 *
 * Colour, spacing, radius and type all come from `@tablemate/shared`'s tokens. Every tone paints
 * its text in a `CONTRAST_PAIRS` entry — the tone's foreground over the `surface` fill, from
 * 5.83:1 to 15.52:1 — and its accent edge in `colors.border`, the boundary token whose pairs
 * `NON_TEXT_CONTRAST_PAIRS` records over both the fill (3.34:1) and the page behind it (3.7:1).
 * No literal colour is written here.
 *
 * A tone is never signalled by colour alone (WCAG 1.4.1): an `error` or `warning` banner with no
 * `title` renders the visible status word "Error" or "Warning", so the state reads without the
 * tint. `info` and `success` need no such word, because the notice's own text states what they
 * say.
 *
 * The live region wraps the title and the message and stops before the action, so a change
 * re-announces the notice rather than the button beside it. Android reads it from `aria-live`,
 * which React Native maps to `accessibilityLiveRegion`; iOS has no live region in React Native,
 * which is what `announce()` is for on the core flows; on web the region becomes a real
 * `role="alert"` or `role="status"` element. Off web the region is a plain `View`, because
 * React Native has no role to map `status` onto.
 */
import { Children, type ReactElement, type ReactNode } from 'react';
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  Text,
  View,
  type Role,
  type ViewProps,
} from 'react-native';
import { borderWidths, colors, fontWeights, radii, spacing, typography } from '@tablemate/shared';
import type { ColorToken } from '@tablemate/shared';
import { Button } from './Button';

/**
 * What a banner communicates. The tone selects its text colour and, for the two states a reader
 * has to act on, the visible status word.
 */
export type BannerTone = 'info' | 'warning' | 'error' | 'success';

/**
 * The banner's single optional action, rendered as a {@link Button} under the notice.
 */
export interface BannerAction {
  /** Visible text, and the button's accessible name. */
  label: string;
  /** Runs on press. */
  onPress: () => void;
  /** Forwarded to the button, so a test can find it. */
  testID?: string;
}

/**
 * Props of {@link Banner}.
 */
export interface BannerProps {
  /** The tone: it selects the text colour and the default status word. */
  tone: BannerTone;
  /** The notice itself. Empty or whitespace alone renders nothing. */
  message: string;

  /**
   * A heading line above the message, painted in the tone's colour and bold. Left out, an `error`
   * or `warning` banner falls back to its status word and `info` and `success` render no heading.
   */
  title?: string;

  /**
   * Content under the message, such as the safety tips. A bare string or number child is wrapped
   * in the banner's type and takes the tone's colour; an element child keeps its own styling, so a
   * caller paints it in the tone's colour or in `colors.text` itself.
   */
  children?: ReactNode;

  /** An action under the notice, such as retrying the request that failed. */
  action?: BannerAction;

  /** Forwarded to the container that carries the tone, so a test can find it. */
  testID?: string;
}

/**
 * Window, in milliseconds, within which the same message is not announced a second time: a screen
 * re-rendering over its own state changes would otherwise repeat the sentence.
 */
const ANNOUNCE_DEDUP_MS = 1_000;

/**
 * What a tone supplies. `foreground` is the text colour, always the foreground of a
 * `CONTRAST_PAIRS` entry whose background is `surface`; `statusWord` is the visible title an
 * `error` or `warning` banner renders when its caller gives none.
 */
interface ToneSpec {
  readonly foreground: ColorToken;
  readonly statusWord?: string;
}

const TONES: Record<BannerTone, ToneSpec> = {
  // text/surface 15.52:1 · warning/surface 6.39:1 · danger/surface 5.83:1 · success/surface 6.43:1.
  info: { foreground: 'text' },
  warning: { foreground: 'warning', statusWord: 'Warning' },
  error: { foreground: 'danger', statusWord: 'Error' },
  success: { foreground: 'success' },
};

/**
 * The attributes the live region carries: always its politeness, and on web the role that gives
 * the region its meaning in the DOM.
 */
type LiveRegionProps = Pick<ViewProps, 'aria-live'> & Readonly<{ role?: Role }>;

/**
 * Builds the live region's attributes for a tone.
 *
 * An error interrupts, because a failed check-in or a rejected card is not something to wait
 * behind other speech; every other tone speaks when the reader is next at a pause. The role is
 * asserted on web alone: React Native maps `role` onto `accessibilityRole` on native, which has no
 * `status` to map to, and web is the only platform that renders a live region from a role.
 */
function liveRegionFor(tone: BannerTone): LiveRegionProps {
  const props: LiveRegionProps = { 'aria-live': tone === 'error' ? 'assertive' : 'polite' };
  return Platform.OS === 'web' ? { ...props, role: tone === 'error' ? 'alert' : 'status' } : props;
}

/**
 * React Native refuses a bare string or number outside a `<Text>`, and `children` may be given
 * one, so each such child is wrapped in the banner's message type; elements pass through untouched
 * and nothing is rendered twice.
 */
function wrapPlainText(value: ReactNode, color: string): ReactNode {
  return Children.map(value, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <Text style={[styles.message, { color }]}>{child}</Text>
    ) : (
      child
    ),
  );
}

/**
 * Renders a notice in one of the four tones.
 *
 * The container has no fixed height: it grows with its content and with the reader's system font
 * size, which React Native keeps scaling by default. Reading and focus order follow source order —
 * title, message, children, action — and the action is a real button, reachable by keyboard. The
 * container itself is rendered even when no slot holds text, so a screen keeps one layout and one
 * test identifier as its copy arrives.
 *
 * @param props - {@link BannerProps}.
 * @returns The notice element.
 */
export function Banner({
  tone,
  message,
  title,
  children,
  action,
  testID,
}: BannerProps): ReactElement {
  const spec = TONES[tone];
  const color = colors[spec.foreground];
  // A title of whitespace alone counts as none, exactly as an empty one does.
  const heading = title !== undefined && title.trim() !== '' ? title : spec.statusWord;

  return (
    <View style={styles.container} testID={testID}>
      <View {...liveRegionFor(tone)} style={styles.liveRegion}>
        {heading === undefined ? null : <Text style={[styles.title, { color }]}>{heading}</Text>}
        {message.trim() === '' ? null : <Text style={[styles.message, { color }]}>{message}</Text>}
      </View>
      {wrapPlainText(children, color)}
      {action === undefined ? null : (
        <Button
          // The outlined variant's label pair is `text` on its own `background` fill at 17.21:1 and
          // its edge `border` on that fill at 3.7:1, so it stays legible over all four tone
          // surfaces; a filled variant would be read as the screen's own primary or destructive
          // action, which the notice is not.
          variant="secondary"
          label={action.label}
          onPress={action.onPress}
          style={styles.action}
          {...(action.testID === undefined ? {} : { testID: action.testID })}
        />
      )}
    </View>
  );
}

/** Last message spoken, and when, so an immediate repeat is dropped. */
let lastAnnounced: string | null = null;
let lastAnnouncedAt = 0;

/**
 * Speaks a message to a screen reader on iOS and Android, once per distinct message.
 *
 * Screens call this for every error in sign-in, proposal, lock and check-in, in addition to
 * rendering an error {@link Banner}: `announce(userMessageFor(code))`, where the copy for the code
 * is the app's own. This is the announcement iOS has no live region to provide, and on Android it
 * covers a change a mounted banner's live region does not carry.
 *
 * Pass the app's own copy for the error code, never server-supplied text, a token, an email
 * address or coordinates: whatever is passed here reaches the screen reader verbatim.
 *
 * @param message - The sentence to speak. Empty or whitespace alone is ignored.
 */
export function announce(message: string): void {
  // On web the banner's own live region speaks, and off iOS and Android React Native exposes no
  // announcement to call, so this returns early instead of issuing a call nothing implements.
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;

  const text = message.trim();
  if (text === '') return;

  const now = Date.now();
  if (text === lastAnnounced && now - lastAnnouncedAt < ANNOUNCE_DEDUP_MS) return;

  lastAnnounced = text;
  lastAnnouncedAt = now;
  AccessibilityInfo.announceForAccessibility(text);
}

const styles = StyleSheet.create({
  container: {
    // `surface` is the one fill every tone's text colour is recorded against. The edge is a
    // logical `borderStart`, so it sits on the reading-start side in a right-to-left layout too,
    // and it takes the accent step: wide enough to read as a boundary rather than as a second
    // border, with the `border` token clearing the 3:1 non-text minimum against this fill.
    backgroundColor: colors.surface,
    borderStartColor: colors.border,
    borderStartWidth: borderWidths.accent,
    borderRadius: radii.md,
    gap: spacing.md,
    padding: spacing.lg,
  },
  liveRegion: {
    gap: spacing.xs,
  },
  title: {
    ...typography.label,
    fontWeight: fontWeights.bold,
  },
  message: {
    ...typography.body,
  },
  action: {
    // The button keeps its own width rather than stretching across the notice.
    alignSelf: 'flex-start',
  },
});
