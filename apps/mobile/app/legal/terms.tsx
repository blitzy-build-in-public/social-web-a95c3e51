/** The terms screen at `/legal/terms`: what a card hold is, when a hold is released, what a forfeit does, and what Table Credit is. */
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

type HeadingProps = TextProps & Readonly<{ 'aria-level': number }>;
const SCREEN_TITLE = 'Terms';
const SECTION_HEADING: HeadingProps = { role: 'heading', 'aria-level': 2 };
const printsTableCredit = (sections: readonly TermsSection[]): boolean =>
  sections.some((section) => section.paragraphs.includes(TABLE_CREDIT_NOTICE));
export default function TermsScreen(): ReactElement {
  const showsTableCreditNotice = !printsTableCredit(TERMS_SECTIONS);
  const creditText = <Text style={styles.paragraph}>{TABLE_CREDIT_NOTICE}</Text>;
  return (
    <>
      <Stack.Screen options={{ title: SCREEN_TITLE }} />
      <Screen scroll edges={['left', 'right', 'bottom']} testID="terms">
        <Banner tone="warning" message={TERMS_PENDING_REVIEW_NOTE} testID="terms-pending-review" />
        {TERMS_SECTIONS.map((section) => (
          <Card key={section.title} testID={`terms-section-${section.title}`}>
            <Text {...SECTION_HEADING} style={styles.sectionHeading} children={section.title} />
            {section.paragraphs.map((paragraph) => (
              <Text key={paragraph} style={styles.paragraph} children={paragraph} />
            ))}
          </Card>
        ))}
        {showsTableCreditNotice ? <Card testID="terms-table-credit" children={creditText} /> : null}
        <Text style={styles.version}>{`Terms version ${TERMS_VERSION}`}</Text>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  sectionHeading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  paragraph: { ...typography.body, color: colors.text },
  version: { ...typography.caption, color: colors.textMuted, paddingBlockStart: spacing.xs },
});
