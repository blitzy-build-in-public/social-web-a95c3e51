/**
 * Data sources — the attribution page (AAP 0.8.1; AAP 0.5.8's fixed attribution string).
 *
 * Two datasets reach the app from outside it, and each source asks for a credit where its data is
 * used: OpenStreetMap place and lodging data read through the Overpass API under the Open Database
 * License (AAP 0.3.1), and the daily exchange-rate table that turns menu prices into USD cents
 * (AAP 0.3.1, AAP 0.3.3). The day plan repeats the OpenStreetMap credit beside its own results; this
 * page is the standing record the Profile screen links to, and the plan names it as the about screen
 * for the exchange-rate source.
 *
 * Every sentence and URL is read from the copy module, so a credit is written once and cannot drift
 * from what is recorded there. The page reads no session and calls no API: it is public while signed
 * out, which is why the root layout keeps `legal` an open area (AAP 0.5.8).
 */
import { useState, type ReactElement } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { TextProps, ViewStyle } from 'react-native';
import { Stack } from 'expo-router';
import {
  MIN_TOUCH_TARGET,
  borderWidths,
  colors,
  fontWeights,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

import {
  FX_ATTRIBUTION,
  FX_ATTRIBUTION_URL,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  OSM_LICENSE_NOTE,
} from '../../src/copy/strings';
import { Card, Screen } from '../../src/ui';

/** The page's title: the navigator header, and the page's single level-1 heading. */
const PAGE_TITLE = 'Data sources';

/** The section headings. UI labels are not in the fixed-string table of AAP 0.5.8. */
const OSM_HEADING = 'OpenStreetMap';
const FX_HEADING = 'Exchange rates';

/**
 * The section headings' platform attributes. `accessibilityRole="header"` is the whole contract on
 * native, where iOS maps it to its header trait and Android to its heading role, and `aria-level` is
 * what react-native-web 0.19 reads to render a real `<h2>` beneath the page title's `<h1>` rather
 * than an unlevelled span. `Screen` asserts the same pair at level 1 for the title.
 */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  accessibilityRole: 'header',
  'aria-level': 2,
};

/**
 * Opens a URL outside the app, and reports nothing when it cannot be opened.
 *
 * `Linking.openURL` rejects when no app or browser answers the URL and throws synchronously when the
 * platform cannot attempt it at all. Neither is a state this page can act on or retry, so both are
 * ignored — and the URL is never logged (AAP 0.11.1).
 */
function openExternal(url: string): void {
  try {
    void Linking.openURL(url).catch(() => {
      // No handler answered; the same link can be reached from a browser.
    });
  } catch {
    // The platform refused the attempt before it started.
  }
}

/** Props of the page's own link. */
interface ExternalLinkProps {
  /** The link's visible text, which is also its accessible name: the credited source. */
  label: string;
  /** The destination, always a constant from the copy module. */
  url: string;
  /** Test handle; `osm-attribution` and `fx-attribution` are the app-wide ids for these two links. */
  testID: string;
}

/**
 * One attribution link.
 *
 * A `Pressable` rather than a platform link, because the destination opens in the browser on all
 * three platforms and nothing here navigates inside the app. The label is underlined and painted in
 * the link colour — `primary` on `background`, a recorded text pair at 7.3:1 — so it reads as a link
 * without leaning on colour alone (WCAG 1.4.1). `Pressable` keeps the pointer cursor on web itself.
 *
 * Two web details are load-bearing. The pressable reserves a 2px band in the page's own fill and
 * swaps it to `colors.focusRing` while focused: that band is the visible focus ring, because
 * `webFocusRingReset` keeps the browser's own outline off it. And Enter is handled here, because
 * react-native-web withholds its responder's Enter activation from a `link` role — it assumes the
 * browser activates a link itself, and this element is a `<div>` with no `href`, so Enter would do
 * nothing (ListItem's link rows carry the same handler for the same reason).
 */
function ExternalLink({ label, url, testID }: ExternalLinkProps): ReactElement {
  const [focused, setFocused] = useState(false);

  const linkKeys: { onKeyDown?: (event: { key?: string; repeat?: boolean }) => void } =
    Platform.OS === 'web'
      ? {
          onKeyDown: (event) => {
            if (event.key === 'Enter' && event.repeat !== true) openExternal(url);
          },
        }
      : {};

  return (
    <Pressable
      {...linkKeys}
      accessibilityLabel={label}
      accessibilityRole="link"
      onBlur={() => setFocused(false)}
      onFocus={() => setFocused(true)}
      onPress={() => openExternal(url)}
      style={[styles.link, focused ? styles.linkFocused : null, webFocusRingReset]}
      testID={testID}
    >
      <Text style={styles.linkLabel}>{label}</Text>
    </Pressable>
  );
}

/**
 * Renders the credits for the two external data sources.
 *
 * The route is `/legal/attribution`, outside the age gate's protected routes, so the credits are
 * readable before consent is recorded and while signed out.
 */
export default function AttributionScreen(): ReactElement {
  return (
    <>
      <Stack.Screen options={{ title: PAGE_TITLE }} />
      <Screen title={PAGE_TITLE} scroll>
        <Card>
          <Text {...SECTION_HEADING} style={styles.heading}>
            {OSM_HEADING}
          </Text>
          <ExternalLink label={OSM_ATTRIBUTION} url={OSM_COPYRIGHT_URL} testID="osm-attribution" />
          <Text style={styles.body}>{OSM_LICENSE_NOTE}</Text>
        </Card>
        <Card>
          <Text {...SECTION_HEADING} style={styles.heading}>
            {FX_HEADING}
          </Text>
          <ExternalLink label={FX_ATTRIBUTION} url={FX_ATTRIBUTION_URL} testID="fx-attribution" />
        </Card>
      </Screen>
    </>
  );
}

/**
 * Keeps the browser's own focus outline off the focused link on web, where it would be painted over
 * the reserved ring band and a keyboard user would see the browser's default rather than
 * `colors.focusRing` (WCAG 2.4.7). React Native 0.76 declares no `outline` style, so the long form is
 * asserted once here; the value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  heading: {
    color: colors.text,
    fontSize: typography.title.fontSize,
    fontWeight: fontWeights.bold,
    lineHeight: typography.title.lineHeight,
  },
  body: {
    ...typography.body,
    color: colors.text,
  },
  link: {
    // The band the focus ring appears in is reserved in the page's own fill, so revealing the ring
    // moves nothing; `alignSelf` keeps the target around the words rather than across the card.
    alignSelf: 'flex-start',
    borderColor: colors.background,
    borderRadius: radii.sm,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
  },
  linkFocused: {
    borderColor: colors.focusRing,
  },
  linkLabel: {
    // `primary` on `background` is a recorded text pair at 7.3:1, and the underline carries the link
    // affordance, so the colour is never the only signal.
    color: colors.primary,
    fontSize: typography.label.fontSize,
    fontWeight: fontWeights.medium,
    lineHeight: typography.label.lineHeight,
    textDecorationLine: 'underline',
  },
});
