/**
 * The terms screen at `/legal/terms` (AAP 0.5.8, AAP 0.8.1): what a card hold is, when a hold is
 * released, what a forfeit does, what Table Credit is, and the dispute and safety rules around them.
 *
 * It is the page the age gate links to before any consent exists, so `legal` is a public area of the
 * route tree (`app/_layout.tsx`) and this screen renders signed out and before the age gate: it reads
 * no session, calls no API and holds no state.
 *
 * Every legal sentence on the page comes from `src/copy/strings.ts`, which is also where
 * {@link TERMS_VERSION} lives — the version the age gate sends in `POST /v1/me/consents` (AAP 0.5.4).
 * The only words this file holds are the page title and the version label.
 *
 * Text is painted only in a recorded `CONTRAST_PAIRS` entry: the sections' 17.21:1 pair and the
 * version line's 7.07:1.
 */
import type { ReactElement } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { TextProps } from 'react-native';
import { Stack } from 'expo-router';
import { colors, fontWeights, spacing, typography } from '@tablemate/shared';

import {
  TABLE_CREDIT_NOTICE,
  TERMS_PENDING_REVIEW_NOTE,
  TERMS_SECTIONS,
  TERMS_VERSION,
} from '../../src/copy/strings';
import type { TermsSection } from '../../src/copy/strings';
import { Banner, Card, Screen } from '../../src/ui';

/**
 * The safe-area edges this screen claims: the navigator's header owns the top inset, so claiming it
 * here as well would add its height twice. The sides and the bottom still belong to the page.
 */
const SCREEN_EDGES = ['left', 'right', 'bottom'] as const;

/**
 * The page title. The navigator's header paints it, and that header title carries `role="heading"`
 * with `aria-level="1"` on every platform — react-native-web renders it as a real `<h1>` — so this
 * screen passes no `title` to `Screen`: a second one would paint a duplicate level-1 heading with the
 * same accessible name, which is what the other screens in this app avoid too (AAP 0.5.8).
 */
const SCREEN_TITLE = 'Terms';

/**
 * The section headings' platform attributes: `role="heading"` is iOS's header trait and Android's
 * heading role, and `aria-level` is what react-native-web reads to render a real `<h2>`. The
 * navigator's header title carries the same pair at level 1, so the two levels stay ordered.
 */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/**
 * Whether the section list already prints the Table Credit sentence (AAP 0.5.8).
 *
 * The sentence is shown exactly once on this page. It lives in the 'Table Credit' section of
 * `TERMS_SECTIONS`, so the notice below is rendered only when no section carries it — which is what
 * keeps a later edit to the copy from printing it twice.
 */
function printsTableCredit(sections: readonly TermsSection[]): boolean {
  return sections.some((section) => section.paragraphs.includes(TABLE_CREDIT_NOTICE));
}

/**
 * The terms on holds, forfeits and Table Credit (AAP 0.5.8, AAP 0.12.2).
 *
 * The pending-review note is rendered unconditionally, because every build this run produces is
 * non-production (AAP 0.3.4, AAP 0.7.2). A production flavour must gate it on the app's environment
 * before Table Credit and forfeits ship, per AAP 0.7.3.
 *
 * @returns The terms page: the pending-review notice, one card per section in
 * `TERMS_SECTIONS` order, and the version the age gate records consent against.
 */
export default function TermsScreen(): ReactElement {
  const showsTableCreditNotice = !printsTableCredit(TERMS_SECTIONS);

  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      {/* The header carries the page's level-1 heading; `Screen` is given no title of its own. */}
      <Screen scroll edges={SCREEN_EDGES} testID="terms">
        {/* A warning carries no meaning by colour alone: with no `title` of its own the banner
            prints its visible status word, and the note's text follows it. */}
        <Banner tone="warning" message={TERMS_PENDING_REVIEW_NOTE} testID="terms-pending-review" />
        {TERMS_SECTIONS.map((section) => (
          <Card key={section.title} testID={`terms-section-${section.title}`}>
            <Text {...SECTION_HEADING} style={styles.sectionHeading}>
              {section.title}
            </Text>
            {section.paragraphs.map((paragraph) => (
              <Text key={paragraph} style={styles.paragraph}>
                {paragraph}
              </Text>
            ))}
          </Card>
        ))}
        {showsTableCreditNotice ? (
          <Card testID="terms-table-credit">
            <Text style={styles.paragraph}>{TABLE_CREDIT_NOTICE}</Text>
          </Card>
        ) : null}
        <Text style={styles.version}>{`Terms version ${TERMS_VERSION}`}</Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  // The card's own headline type, so a section heading sits at the same step as every other card's
  // title on the surface it is drawn on (`text` on `background`, 17.21:1).
  sectionHeading: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  // Body paragraphs keep the page's reading size and no fixed height, so they reflow and scale with
  // the reader's system font size (AAP 0.5.8).
  paragraph: {
    ...typography.body,
    color: colors.text,
  },
  version: {
    ...typography.caption,
    color: colors.textMuted,
    paddingBlockStart: spacing.xs,
  },
});
