/**
 * One lodging's detail page: the lodging's identity and its witnessed-meetup standing, the
 * travelers who chose to show they are staying there, and the door to claiming a stay
 * (AAP 0.5.8, AAP 0.5.4, criterion 15).
 *
 * Everything rendered here is the API's own answer to `GET /lodgings/:id`, printed as it arrived.
 * `rank` is the standing AAP 0.5.7 defines and never the position of the order a query asked for,
 * and a verified guest count below three arrives as `'fewer than 3'` rather than as a number, so no
 * reader can single out the one or two travelers staying somewhere. A guest appears as the tier-0
 * profile the API released — a handle and a generated avatar, with no room number and no stay dates
 * — and nothing here filters or derives a guest field, because disclosure is the API's field-level
 * decision (AAP 0.3.2, AAP 0.5.4).
 *
 * The read is not gated on the client's own proof status: `GET /lodgings/:id` answers
 * `403 no_valid_proof` for a city the caller holds no proof for, and that answer replaces the whole
 * page with the import banner (AAP 0.5.8, "Browsing without a valid proof").
 *
 * The phone is the lodging's own business number, which the directory requires and which is never a
 * traveler's field (AAP 0.5.4). Lodgings compete on witnessed-meetup activity alone, so there is no
 * rating, star, review or comment anywhere on this screen (AAP 0.7.2). Nothing here logs: the only
 * detail of a failure that leaves this file is an error code (AAP 0.11.1).
 */
import { useEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import type { TextProps } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { GuestCount, LodgingKind, Tier0Profile } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import {
  IMPORT_BANNER,
  OSM_ATTRIBUTION,
  OSM_COPYRIGHT_URL,
  guestCountText,
} from '../../src/copy/strings';
import { queryKeys, useMe } from '../../src/state/meetup-store';
import { Avatar, Banner, Button, Card, ListItem, Screen, announce } from '../../src/ui';

/** Header title for the states that have no lodging to name yet, and for a lodging that is gone. */
const HEADER_FALLBACK_TITLE = 'Lodging';

/** Side of a guest's avatar, in points / CSS px. */
const GUEST_AVATAR_SIZE = 32;

/** The kind label shown under a lodging's name, from OpenStreetMap's `tourism` tags (AAP 0.5.6). */
const KIND_LABELS = {
  hostel: 'Hostel',
  hotel: 'Hotel',
  guesthouse: 'Guesthouse',
} as const satisfies Record<LodgingKind, string>;

/**
 * The strings this screen owns. The import banner, the guest-count rule and the OpenStreetMap
 * attribution belong to `src/copy/strings.ts` and are imported above; the two sentences a failed
 * read shows are this screen's own state, as is the loading line every screen writes itself.
 */
const LOADING = 'Loading…';
const TRAVELERS_HEADING = 'Travelers staying here';
const TRAVELERS_EMPTY = "No guests have chosen to show they're staying here.";
const CLAIM_START_LABEL = "I'm staying here";
const MY_STAY_LABEL = 'My stay';
const BACK_TO_LODGINGS_LABEL = 'Back to lodgings';
const TRY_AGAIN_LABEL = 'Try again';
const VERIFY_MY_STAY_LABEL = 'Verify my stay';
const NOT_FOUND_MESSAGE = "This lodging isn't available.";

/**
 * A section heading. `role="heading"` with `aria-level: 2` is the pair React Native maps to its own
 * header trait on iOS and Android, and the pair react-native-web reads to render a real `<h2>`
 * beneath the page's `<h1>`; React Native's `TextProps` does not declare `aria-level` yet, so the
 * object is named as `TextProps` plus that one attribute.
 */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/** The page's single top-level heading, the lodging's name. */
const PAGE_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 1,
};

/**
 * The Enter activation a `Text` link needs on web.
 *
 * react-native-web makes an element whose role is `link` a keyboard tab stop (`tabIndex="0"`), but
 * it wires a click handler alone onto a pressable `Text`, so Enter would focus the link and do
 * nothing. This is the same fix `ListItem` applies to its own link rows; it is empty off web, where
 * React Native has no key events and the platform's own responder answers the press. The attribute
 * is written through a typed object because `TextProps` declares no key handler while
 * react-native-web forwards one.
 */
type TextLinkProps = TextProps &
  Readonly<{ onKeyDown?: (event: { key?: string; repeat?: boolean }) => void }>;

function textLinkKeys(activate: () => void): TextLinkProps {
  if (Platform.OS !== 'web') return {};
  return {
    onKeyDown: (event) => {
      if (event.key === 'Enter' && event.repeat !== true) activate();
    },
  };
}

/** `Rank #3 by meetup activity`: the standing AAP 0.5.7 defines, never a position in a list. */
function rankText(rank: number): string {
  return `Rank #${rank} by meetup activity`;
}

/** `Activity score: 12 (witnessed meetups, last 90 days)`, the figure the API computed. */
function activityText(activityScore: number): string {
  return `Activity score: ${activityScore} (witnessed meetups, last 90 days)`;
}

/**
 * `Verified guests: 4`, or `Verified guests: fewer than 3`. The count is never compared, converted
 * or rounded here: the label is printed exactly as it arrived (AAP 0.5.4, criterion 15).
 */
function guestCountLine(guestCount: GuestCount): string {
  return `Verified guests: ${guestCountText(guestCount)}`;
}

/**
 * The sentence a failure shows (AAP 0.5.8). A missing route parameter and the API's own
 * `lodging_not_found` are one state with one sentence, the import prompt speaks for itself, and
 * every other code shows the client's own copy for that code — never the server's `message`.
 */
function messageForCode(code: string): string {
  if (code === 'lodging_not_found') return NOT_FOUND_MESSAGE;
  if (code === 'no_valid_proof') return IMPORT_BANNER;
  return userMessageFor(code);
}

/** The code of a failed read: the API's own code, or the client's answer that was not the envelope. */
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

/**
 * One opted-in guest: the handle and the generated avatar the API released, and nothing more. The
 * avatar is decorative because the row's own label already names the traveler, and the row is a
 * link to the profile a viewer at this tier may read (AAP 0.5.4, AAP 0.5.7).
 */
function guestRow(guest: Tier0Profile): ReactElement {
  return (
    <ListItem
      key={guest.id}
      label={`@${guest.handle}`}
      leading={
        <Avatar
          avatarSeed={guest.avatarSeed}
          handle={guest.handle}
          size={GUEST_AVATAR_SIZE}
          decorative
        />
      }
      onPress={() => {
        router.push(`/users/${guest.id}`);
      }}
      role="link"
      testID={`lodging-guest-${guest.id}`}
    />
  );
}

/**
 * The lodging detail screen.
 *
 * @returns The import banner when the caller holds no valid proof for the lodging's city, the
 * not-found sentence with a way back when the lodging is gone or the route carries no id, an error
 * banner with a retry for any other failure, and otherwise the lodging's summary, its verified
 * guest count, the guests who opted in, the claim entry and the OpenStreetMap attribution
 * (AAP 0.3.1, AAP 0.5.8).
 */
export default function LodgingDetailScreen(): ReactElement {
  const params = useLocalSearchParams();
  // A route parameter arrives as text, as repeated text, or not at all; anything but one string is
  // read as the same missing-lodging state the API answers for an unknown id.
  const id = typeof params.id === 'string' ? params.id : '';
  const hasId = id !== '';

  const lodging = useQuery({
    queryKey: queryKeys.lodging(id),
    queryFn: () => apiClient.getLodging(id),
    enabled: hasId,
  });
  const me = useMe();

  const code = !hasId ? 'lodging_not_found' : lodging.isError ? errorCodeOf(lodging.error) : null;

  // A failure is spoken once per distinct code: a re-render over the same failed read would repeat
  // the sentence, and a recovery clears the code so the next failure speaks again (AAP 0.5.8).
  const announcedCode = useRef<string | null>(null);
  useEffect(() => {
    if (code === null) {
      announcedCode.current = null;
      return;
    }
    if (announcedCode.current === code) return;
    announcedCode.current = code;
    announce(messageForCode(code));
  }, [code]);

  const header = <Stack.Screen options={{ title: lodging.data?.name ?? HEADER_FALLBACK_TITLE }} />;

  if (code === 'no_valid_proof') {
    return (
      <Screen testID="lodging-detail">
        {header}
        <Banner
          tone="info"
          message={IMPORT_BANNER}
          action={{
            label: VERIFY_MY_STAY_LABEL,
            onPress: () => {
              router.push('/proof/import');
            },
          }}
          testID="proof-banner"
        />
      </Screen>
    );
  }

  if (code === 'lodging_not_found') {
    return (
      <Screen testID="lodging-detail">
        {header}
        <Text style={styles.note} testID="lodging-not-found">
          {NOT_FOUND_MESSAGE}
        </Text>
        <Button
          label={BACK_TO_LODGINGS_LABEL}
          onPress={() => {
            router.replace('/lodgings');
          }}
          testID="lodging-back"
        />
      </Screen>
    );
  }

  if (code !== null) {
    return (
      <Screen testID="lodging-detail">
        {header}
        <Banner
          tone="error"
          message={messageForCode(code)}
          action={{
            label: TRY_AGAIN_LABEL,
            onPress: () => {
              void lodging.refetch();
            },
          }}
          testID="lodging-error"
        />
      </Screen>
    );
  }

  const detail = lodging.data;
  if (detail === undefined) {
    return (
      <Screen testID="lodging-detail">
        {header}
        <Text style={styles.note}>{LOADING}</Text>
      </Screen>
    );
  }

  const { phone, address } = detail;
  const activeClaim = me.data?.activeLodgingClaim ?? null;

  // The claim entry is offered only once the caller's own account is known: while `GET /me` is
  // still answering, neither the claim button nor the "already claimed" line would be true.
  const claimEntry =
    me.data === undefined ? null : activeClaim === null ? (
      <Button
        label={CLAIM_START_LABEL}
        onPress={() => {
          router.push({ pathname: '/lodgings/claim', params: { lodgingId: id } });
        }}
        testID="lodging-claim-start"
      />
    ) : (
      <View style={styles.claim}>
        <Text style={styles.body}>
          {`You already have a stay claim at ${activeClaim.lodgingName}.`}
        </Text>
        <Button
          label={MY_STAY_LABEL}
          variant="secondary"
          onPress={() => {
            router.push('/profile/stay');
          }}
          testID="lodging-my-stay"
        />
      </View>
    );

  return (
    <Screen testID="lodging-detail">
      {header}
      <Card testID="lodging-summary">
        <Text {...PAGE_HEADING} style={styles.name}>
          {detail.name}
        </Text>
        <Text style={styles.note}>{KIND_LABELS[detail.kind]}</Text>
        {address === null || address.trim() === '' ? null : (
          <Text style={styles.body}>{address}</Text>
        )}
        {phone === null ? null : (
          <Text
            {...textLinkKeys(() => {
              void Linking.openURL(`tel:${phone}`);
            })}
            accessibilityLabel={`Call ${phone}`}
            accessibilityRole="link"
            accessible
            style={styles.link}
            testID="lodging-phone"
          >
            {phone}
          </Text>
        )}
        <Text style={styles.body}>{rankText(detail.rank)}</Text>
        <Text style={styles.note}>{activityText(detail.activityScore)}</Text>
      </Card>

      <Text style={styles.body} testID="lodging-guest-count">
        {guestCountLine(detail.guestCount)}
      </Text>

      <Text {...SECTION_HEADING} style={styles.section}>
        {TRAVELERS_HEADING}
      </Text>
      {detail.guests.length === 0 ? (
        <Text style={styles.note}>{TRAVELERS_EMPTY}</Text>
      ) : (
        <View>{detail.guests.map(guestRow)}</View>
      )}

      {claimEntry}

      <Text
        {...textLinkKeys(() => {
          void Linking.openURL(OSM_COPYRIGHT_URL);
        })}
        accessibilityLabel={OSM_ATTRIBUTION}
        accessibilityRole="link"
        accessible
        style={styles.link}
        testID="osm-attribution"
      >
        {OSM_ATTRIBUTION}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: {
    ...typography.heading,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  section: {
    ...typography.title,
    color: colors.text,
    fontWeight: fontWeights.bold,
  },
  body: {
    ...typography.body,
    color: colors.text,
  },
  note: {
    ...typography.body,
    color: colors.textMuted,
  },
  // A link is a control, so its box carries the 44-point minimum the plan requires. `hitSlop` is
  // not part of React Native's `TextProps`, and `display: flex` is what lets the minimum height
  // apply on web, where a `Text` is an inline box by default. `primary` on the card's own
  // `background` fill is a recorded pair at 7.3:1, and the browser keeps painting its own focus
  // outline, which is the visible focus indicator on web (WCAG 2.4.7).
  link: {
    ...typography.body,
    alignSelf: 'flex-start',
    alignItems: 'center',
    color: colors.primary,
    display: 'flex',
    minHeight: MIN_TOUCH_TARGET,
    paddingVertical: spacing.sm,
    textDecorationLine: 'underline',
  },
  claim: {
    gap: spacing.md,
  },
});
