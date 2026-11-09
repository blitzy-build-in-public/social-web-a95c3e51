/**
 * Data sources — the attribution page (AAP 0.8.1; AAP 0.5.8's fixed attribution string).
 */
import { useState, type ReactElement } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text } from 'react-native';
import type { ViewStyle } from 'react-native';
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
const PAGE_TITLE = 'Data sources';
const OSM_HEADING = 'OpenStreetMap';
const FX_HEADING = 'Exchange rates';
const HEADING = { 'aria-level': 2, accessibilityRole: 'header' } as const;
function openExternal(url: string): void {
  try {
    void Linking.openURL(url).catch(() => {});
  } catch {}
}
type ExternalLinkProps = { label: string; url: string; testID: string };
function ExternalLink({ label, url, testID }: ExternalLinkProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const onKeyDown = (event: { key?: string; repeat?: boolean }): void => {
    if (event.key === 'Enter' && event.repeat !== true) openExternal(url);
  };
  const linkKeys = Platform.OS === 'web' ? { onKeyDown } : {};
  return (
    <Pressable
      {...linkKeys}
      accessibilityLabel={label}
      accessibilityRole="link"
      {...{ onBlur: () => setFocused(false), onFocus: () => setFocused(true) }}
      // Hover is a web state: React Native 0.76 declares the pair on `PressableProps` and
      // react-native-web forwards it to its hover hook, while iOS and Android never fire it.
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onPress={() => openExternal(url)}
      style={({ pressed }) => [
        styles.link,
        hovered ? styles.linkHovered : null,
        pressed ? styles.linkPressed : null,
        focused ? styles.linkFocused : null,
      ]}
      testID={testID}
    >
      <Text style={styles.linkLabel}>{label}</Text>
    </Pressable>
  );
}
export default function AttributionScreen(): ReactElement {
  return (
    <>
      <Stack.Screen options={{ title: PAGE_TITLE }} />
      <Screen scroll>
        <Card>
          <Text {...{ ...HEADING, style: styles.heading }}>{OSM_HEADING}</Text>
          <ExternalLink label={OSM_ATTRIBUTION} url={OSM_COPYRIGHT_URL} testID="osm-attribution" />
          <Text style={styles.body}>{OSM_LICENSE_NOTE}</Text>
        </Card>
        <Card>
          <Text {...{ ...HEADING, style: styles.heading }}>{FX_HEADING}</Text>
          <ExternalLink label={FX_ATTRIBUTION} url={FX_ATTRIBUTION_URL} testID="fx-attribution" />
        </Card>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  heading: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  body: { ...typography.body, color: colors.text },
  link: {
    ...(Platform.OS === 'web' ? ({ outlineStyle: 'none' } as ViewStyle) : null),
    alignSelf: 'flex-start',
    borderColor: colors.background,
    borderRadius: radii.sm,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.sm,
  },
  linkFocused: { borderColor: colors.focusRing },
  // The link's own fill is the lightest token, so the palette offers one pointer step for both
  // states, and hover takes the same fill the press paints.
  linkHovered: { backgroundColor: colors.surface },
  linkPressed: { backgroundColor: colors.surface },
  linkLabel: {
    ...typography.label,
    color: colors.primary,
    fontWeight: fontWeights.medium,
    textDecorationLine: 'underline',
  },
});
