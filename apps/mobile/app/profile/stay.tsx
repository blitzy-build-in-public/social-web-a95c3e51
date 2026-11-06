/** My stay: the guest-list visibility switch at `/profile/stay` (AAP 0.5.8, AAP 0.8.1, criterion 15). */
import { useEffect, useState, type ReactElement } from 'react';
import { Platform, StyleSheet, Switch, Text, View, type SwitchProps } from 'react-native';
import { Stack, router } from 'expo-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MIN_TOUCH_TARGET, colors, fontWeights, spacing, typography } from '@tablemate/shared';
import type { MeDto } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { STAY_TOGGLE_LABEL, formatCalendarDate, guestListWarning } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Banner, Card, ListItem, Screen, announce } from '../../src/ui';
type LodgingClaim = NonNullable<MeDto['activeLodgingClaim']>;

const HEADER_TITLE = 'My stay';
const LOADING_TEXT = 'Loading…';
const RETRY_LABEL = 'Try again';
const NO_CLAIM_TEXT = "You haven't claimed a stay yet.";
const FIND_LODGING_LABEL = 'Find your lodging';
const VIEW_LODGING_LABEL = 'View lodging';
const PENDING_EXPLANATION =
  'You can choose whether to appear on the guest list once your stay is verified.';
const GUEST_LIST_NOTE =
  'Only verified travelers with a valid proof for this city can see it. Room numbers and dates are never shown.';
const CITY_PENDING_TEXT = 'Checking the city of your verified stay. The switch waits for it.';
const SHOWN_NOTICE = 'You now appear on the guest list';
const HIDDEN_NOTICE = "You're hidden from the guest list";
const LODGINGS_PREFIX = ['lodgings'] as const;
const NO_CLAIM = 'The lodging query was enabled without a claim.';
const STEP_TEXT = { pending_call: 'Waiting for the call', calling: 'Calling the lodging now' };
const TRACK_COLOR = { false: colors.border, true: colors.primary } as const;
const MEDIUM_LABEL = { ...typography.label, fontWeight: fontWeights.medium };

/** Web withholds both props: `react-native-web` would make the wrapper it draws the first keyboard stop (WCAG 2.1.1). */
const switchRoleProps = (checked: boolean, disabled: boolean): Partial<SwitchProps> =>
  Platform.OS === 'web'
    ? {}
    : { accessibilityRole: 'switch', accessibilityState: { checked, disabled } };

const browse = (): void => router.push('/lodgings');
const openLodging = (id: string): void =>
  router.push({ pathname: '/lodgings/[id]', params: { id } });
const codeOf = (error: unknown): string => (isApiError(error) ? error.code : 'invalid_response');
const messageFor = (error: unknown): string => userMessageFor(codeOf(error));
const fetchCities = (): ReturnType<typeof apiClient.listCities> => apiClient.listCities();
const FIND_LODGING = { label: FIND_LODGING_LABEL, onPress: browse } as const;
const VIEW_LODGING = { label: VIEW_LODGING_LABEL, testID: 'stay-view-lodging' } as const;
const stayDates = (claim: LodgingClaim): string =>
  `${formatCalendarDate(claim.stayFrom)} – ${formatCalendarDate(claim.stayTo)}`;

export default function StayScreen(): ReactElement {
  const me = useMe();
  const claim = me.data?.activeLodgingClaim ?? null;
  const verified = claim !== null && claim.status === 'verified';
  const proofCityId = me.data?.proof.cityId;
  const cities = useQuery({ queryKey: queryKeys.cities, queryFn: fetchCities, enabled: verified });
  const lodging = useQuery({
    queryKey: queryKeys.lodging(claim?.lodgingId ?? ''),
    queryFn: () =>
      claim === null ? Promise.reject(new Error(NO_CLAIM)) : apiClient.getLodging(claim.lodgingId),
    enabled: verified && proofCityId === undefined,
  });
  const cityId = proofCityId ?? lodging.data?.cityId;
  const namedCity = cities.data?.items.find((city) => city.id === cityId)?.name;
  const cityName = cityId === undefined || cities.isPending ? null : (namedCity ?? cityId);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (showStaying: boolean) => apiClient.setLodgingVisibility({ showStaying }),
    onSuccess: (response) => {
      setOptimistic(response.showStaying);
      const message = response.showStaying ? SHOWN_NOTICE : HIDDEN_NOTICE;
      setNotice(message);
      announce(message);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      void queryClient.invalidateQueries({ queryKey: LODGINGS_PREFIX });
      const id = claim?.lodgingId ?? null;
      if (id !== null) void queryClient.invalidateQueries({ queryKey: queryKeys.lodging(id) });
    },
    onError: () => {
      setOptimistic(null);
      setNotice(null);
    },
  });
  const meMessage = me.error === null ? null : messageFor(me.error);
  const saveError = mutation.error === null ? null : messageFor(mutation.error);
  const code = mutation.error === null ? null : codeOf(mutation.error);
  useEffect(() => {
    if (meMessage !== null) announce(meMessage);
    if (saveError !== null) announce(saveError);
  }, [saveError, meMessage]);
  useEffect(() => {
    if (code === 'no_verified_claim')
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [code]);
  const retry = { label: RETRY_LABEL, onPress: () => void me.refetch(), testID: 'stay-retry' };
  const warning = cityName === null ? CITY_PENDING_TEXT : guestListWarning(cityName);
  const noClaim = (
    <>
      <Text style={styles.body}>{NO_CLAIM_TEXT}</Text>
      <ListItem {...FIND_LODGING} role="link" testID="stay-find-lodging" />
    </>
  );
  let body: ReactElement;
  if (me.isPending) body = <Text style={styles.muted}>{LOADING_TEXT}</Text>;
  else if (meMessage !== null) {
    body = <Banner tone="error" message={meMessage} action={retry} testID="stay-error" />;
  } else if (claim !== null && (claim.status === 'pending_call' || claim.status === 'calling')) {
    body = (
      <Card title={claim.lodgingName} subtitle={stayDates(claim)} testID="stay-claim">
        <Text style={styles.body}>{STEP_TEXT[claim.status]}</Text>
        <Text style={styles.muted}>{PENDING_EXPLANATION}</Text>
        <ListItem {...VIEW_LODGING} onPress={() => openLodging(claim.lodgingId)} role="link" />
      </Card>
    );
  } else if (claim !== null && claim.status === 'verified') {
    const showStaying = optimistic ?? claim.showStaying;
    const toggleDisabled = cityName === null || mutation.isPending;
    body = (
      <Card title={claim.lodgingName} subtitle={stayDates(claim)} testID="stay-claim">
        <Banner tone="warning" message={warning} testID="stay-warning" />
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>{STAY_TOGGLE_LABEL}</Text>
          <Switch
            accessibilityLabel={STAY_TOGGLE_LABEL}
            disabled={toggleDisabled}
            ios_backgroundColor={colors.border}
            onValueChange={(next) => {
              setOptimistic(next);
              setNotice(null);
              mutation.mutate(next);
            }}
            testID="stay-toggle"
            thumbColor={colors.onPrimary}
            trackColor={TRACK_COLOR}
            value={showStaying}
            {...switchRoleProps(showStaying, toggleDisabled)}
          />
        </View>
        <Text style={styles.muted}>{GUEST_LIST_NOTE}</Text>
        {saveError === null ? null : (
          <Banner tone="error" message={saveError} testID="stay-mutation-error" />
        )}
        {notice === null ? null : <Banner tone="success" message={notice} testID="stay-notice" />}
      </Card>
    );
  } else body = noClaim;
  return (
    <Screen edges={['bottom', 'left', 'right']} testID="stay">
      <Stack.Screen options={{ title: HEADER_TITLE }} />
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: colors.text },
  muted: { ...typography.body, color: colors.textMuted },
  toggleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: MIN_TOUCH_TARGET,
  },
  toggleLabel: { ...MEDIUM_LABEL, color: colors.text, flexShrink: 1 },
});
