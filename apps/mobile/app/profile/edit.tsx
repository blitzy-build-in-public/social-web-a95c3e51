/** Edit profile (`/profile/edit`): the traveler's own pseudonymous profile, one group of fields per disclosure tier (AAP 0.5.8, AAP 0.7.1 row 8). */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TextInputProps, TextProps, ViewStyle } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Stack } from 'expo-router';
import { useMutation } from '@tanstack/react-query';
import {
  BIO_MAX_CHARS,
  CountryCode,
  EXTERNAL_CONTACT_MAX_CHARS,
  FULL_NAME_MAX_CHARS,
  HOME_CITY_MAX_CHARS,
  INTEREST_TAGS,
  INTEREST_TAGS_MAX,
  MIN_TOUCH_TARGET,
  NICKNAME_MAX_CHARS,
  PHOTO_MAX_BYTES,
  ProfileUpdate,
  borderWidths,
  colors,
  fontWeights,
  interactionOpacity,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { InterestTag, MeDto } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { Avatar, Banner, Button, Screen, TextField, announce } from '../../src/ui';

const COPY = {
  screenTitle: 'Edit profile',
  loading: 'Loading your profile…',
  optional: 'Every field is optional. A real name, a photo and a phone number are never required.',
  retry: 'Try again',
  save: 'Save profile',
  saved: 'Profile saved.',
  noChanges: 'No changes to save.',
  interestsNote: 'Shown to verified travelers in your city.',
  aboutNote: 'Shown once a meetup is locked.',
  homeCityHint: 'Shown as your home region; only the country is shared with other travelers.',
  countryHint: 'Two-letter country code, e.g. PT',
  countryError: 'Enter a two-letter country code, e.g. PT.',
  photoNote: 'Shown after one completed meetup.',
  photoSet: 'Photo: set',
  photoNone: 'Photo: none',
  photoPreview: 'Selected photo',
  photoChoose: 'Choose photo',
  photoRemove: 'Remove photo',
  photoUnreadable: "This photo couldn't be read. Try another.",
  tier3Note: "Shown only to travelers you've completed two meetups with",
} as const;
const SCREEN_EDGES = ['left', 'right'] as const;
const PHOTO_SIZE = 96;
const COUNTRY_CODE_LENGTH = 2;
const INTERESTS_SECTION = 'Interests';
const PHOTO_SECTION = 'Photo';
const TIER3_FIELDS = ['fullName', 'externalContact'] as const;
const UNCHANGED_PHOTO: PhotoState = { kind: 'unchanged' };
const CHOOSE_PHOTO = { variant: 'secondary', testID: 'profile-edit-photo-choose' } as const;
const REMOVE_PHOTO = { variant: 'danger', testID: 'profile-edit-photo-remove' } as const;
const SAVE_PROFILE = { testID: 'profile-edit-save' } as const;
const SAVE_FAILED = { tone: 'error', testID: 'profile-edit-save-error' } as const;
const LOAD_FAILED = { tone: 'error', testID: 'profile-edit-load-error' } as const;
const PHOTO_LABEL = { accessibilityLabel: COPY.photoPreview } as const;
const TEXT_KEYS = [
  'nickname',
  'bio',
  'homeCity',
  'homeCountryCode',
  'fullName',
  'externalContact',
] as const;
type TextFieldKey = (typeof TEXT_KEYS)[number];
type FormState = Record<TextFieldKey, string> & { interestTags: InterestTag[] };
type PhotoState =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'new'; readonly base64: string; readonly uri: string }
  | { readonly kind: 'removed' };
interface FieldSpec {
  readonly label: string;
  readonly maxLength: number;
  readonly hint?: string;
  readonly multiline?: boolean;
  readonly autoComplete?: TextInputProps['autoComplete'];
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}
const COUNTED_FIELDS: readonly TextFieldKey[] = ['nickname', 'bio'];
const FIELDS: Readonly<Record<TextFieldKey, FieldSpec>> = {
  nickname: { label: 'Nickname', maxLength: NICKNAME_MAX_CHARS },
  bio: { label: 'Bio', maxLength: BIO_MAX_CHARS, multiline: true },
  homeCity: { label: 'Home city', maxLength: HOME_CITY_MAX_CHARS, hint: COPY.homeCityHint },
  homeCountryCode: {
    label: 'Country code',
    maxLength: COUNTRY_CODE_LENGTH,
    hint: COPY.countryHint,
    autoCapitalize: 'characters',
    autoComplete: 'country',
  },
  fullName: { label: 'Full name', maxLength: FULL_NAME_MAX_CHARS, autoComplete: 'name' },
  externalContact: { label: 'Contact', maxLength: EXTERNAL_CONTACT_MAX_CHARS },
};
interface SectionSpec {
  readonly title: string;
  readonly note?: string;
  readonly fields: readonly TextFieldKey[];
}
const SECTIONS: readonly SectionSpec[] = [
  { title: 'About you', note: COPY.aboutNote, fields: ['nickname', 'bio'] },
  { title: INTERESTS_SECTION, note: COPY.interestsNote, fields: [] },
  { title: 'Home', fields: ['homeCity', 'homeCountryCode'] },
  { title: PHOTO_SECTION, note: COPY.photoNote, fields: [] },
  { title: 'Only for close connections', note: COPY.tier3Note, fields: TIER3_FIELDS },
];
const SECTION_HEADING: TextProps & { 'aria-level': number } = { role: 'heading', 'aria-level': 2 };
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;
type Pressed = Readonly<{ 'aria-pressed': boolean }>;
const pressedAttributes = (selected: boolean): Pressed => ({ 'aria-pressed': selected });
function sortTags(tags: readonly InterestTag[]): InterestTag[] {
  return INTEREST_TAGS.filter((tag) => tags.includes(tag));
}
function toggled(tags: readonly InterestTag[], tag: InterestTag): InterestTag[] {
  return tags.includes(tag) ? tags.filter((chosen) => chosen !== tag) : sortTags([...tags, tag]);
}
function formFrom(profile: MeDto): FormState {
  const form = {} as Record<TextFieldKey, string>;
  for (const key of TEXT_KEYS) form[key] = profile[key] ?? '';
  return { ...form, interestTags: sortTags(profile.interestTags) };
}
function withField(form: FormState, key: TextFieldKey, value: string): FormState {
  return { ...form, [key]: value };
}
function countryCodeError(value: string): string | null {
  return value === '' || CountryCode.safeParse(value).success ? null : COPY.countryError;
}
function hintFor(key: TextFieldKey, spec: FieldSpec, value: string): string | undefined {
  const counted = COUNTED_FIELDS.includes(key);
  return counted ? `${spec.maxLength - value.length} characters left` : spec.hint;
}
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
function normalizeBase64(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const comma = value.indexOf(',');
  const body = value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
  return body.trim() || null;
}
function buildUpdate(form: FormState, baseline: MeDto, photo: PhotoState): ProfileUpdate | null {
  const update: ProfileUpdate = {};
  for (const key of TEXT_KEYS) {
    const next = form[key].trim();
    if (next === (baseline[key] ?? '')) continue;
    update[key] = next === '' ? null : next;
  }
  const tags = sortTags(form.interestTags);
  if (tags.join(',') !== sortTags(baseline.interestTags).join(',')) update.interestTags = tags;
  if (photo.kind !== 'unchanged') update.photoBase64 = photo.kind === 'new' ? photo.base64 : null;
  return Object.keys(update).length === 0 ? null : update;
}
interface ChipProps {
  readonly tag: InterestTag;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}
function InterestChip({ tag, selected, disabled, onPress }: ChipProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const label = tag.replace(/_/g, ' ');
  return (
    <Pressable
      {...pressedAttributes(selected)}
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => [
        styles.chip,
        selected && styles.chipSelected,
        disabled && styles.chipDisabled,
        hovered && !disabled && !selected && styles.chipOutlined,
        pressed && !disabled && (selected ? styles.chipPressed : styles.chipOutlined),
        focused && styles.chipFocused,
        webFocusRingReset,
      ]}
      testID={`profile-edit-tag-${tag}`}
    >
      <Text
        style={[
          styles.chipLabel,
          selected && styles.chipLabelSelected,
          disabled && styles.chipLabelDisabled,
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
function ProfileForm({ profile }: { readonly profile: MeDto }): ReactElement {
  const [form, setForm] = useState<FormState>(() => formFrom(profile));
  const [photo, setPhoto] = useState<PhotoState>(UNCHANGED_PHOTO);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [picking, setPicking] = useState(false);
  const update = buildUpdate(form, profile, photo);
  const countryIssue = countryCodeError(form.homeCountryCode);
  const tagsAtLimit = form.interestTags.length >= INTEREST_TAGS_MAX;
  const photoSet = photo.kind === 'new' || (profile.hasPhoto && photo.kind !== 'removed');
  const unsavable = update === null || countryIssue !== null;
  const save = useMutation({
    mutationFn: (body: ProfileUpdate) => apiClient.updateProfile(body),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.me, updated);
      setForm(formFrom(updated));
      setPhoto(UNCHANGED_PHOTO);
      setPhotoError(null);
      setSaveError(null);
      setSaved(true);
      announce(COPY.saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
    onError: (error: unknown) => {
      const code = isApiError(error) ? error.code : 'invalid_response';
      const message = userMessageFor(code);
      setSaved(false);
      if (code === 'photo_too_large') setPhotoError(message);
      else setSaveError(message);
      announce(message);
    },
  });
  function edited(): void {
    setSaved(false);
    setSaveError(null);
    setPhotoError(null);
  }
  function changeField(key: TextFieldKey, text: string): void {
    setForm((previous) =>
      withField(previous, key, key === 'homeCountryCode' ? text.toUpperCase() : text),
    );
    edited();
  }
  function toggleTag(tag: InterestTag): void {
    setForm((previous) => ({ ...previous, interestTags: toggled(previous.interestTags, tag) }));
    edited();
  }
  const chipFor = (tag: InterestTag) => {
    const chosen = form.interestTags.includes(tag);
    return { selected: chosen, disabled: !chosen && tagsAtLimit, onPress: () => toggleTag(tag) };
  };
  function removePhoto(): void {
    setPhoto({ kind: 'removed' });
    edited();
  }
  function refuse(set: (message: string) => void, message: string): void {
    set(message);
    announce(message);
  }
  async function choosePhoto(): Promise<void> {
    setPicking(true);
    edited();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      base64: true,
      exif: false,
      quality: 0.8,
    }).catch(() => null);
    setPicking(false);
    if (result === null) return refuse(setPhotoError, COPY.photoUnreadable);
    if (result.canceled) return;
    const asset = result.assets[0];
    const uri = asset?.uri ?? null;
    const base64 = normalizeBase64(asset?.base64);
    if (uri === null || base64 === null) return refuse(setPhotoError, COPY.photoUnreadable);
    if (decodedByteLength(base64) > PHOTO_MAX_BYTES) {
      return refuse(setPhotoError, userMessageFor('photo_too_large'));
    }
    setPhoto({ kind: 'new', base64, uri });
  }
  const pick = (): void => void choosePhoto();
  function saveNow(): void {
    if (countryIssue !== null) return announce(countryIssue);
    if (update === null) return;
    const parsed = ProfileUpdate.safeParse(update);
    if (!parsed.success) return refuse(setSaveError, userMessageFor('invalid_field'));
    save.mutate(parsed.data);
  }
  return (
    <Screen edges={SCREEN_EDGES} testID="profile-edit">
      <Text style={styles.body}>{COPY.optional}</Text>
      {saved ? <Banner tone="success" message={COPY.saved} testID="profile-edit-saved" /> : null}
      {saveError === null ? null : <Banner {...SAVE_FAILED} message={saveError} />}
      {SECTIONS.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.sectionTitle}>
            {section.title}
          </Text>
          {section.note === undefined ? null : <Text style={styles.note}>{section.note}</Text>}
          {section.title === INTERESTS_SECTION ? (
            <>
              <View aria-label={INTERESTS_SECTION} role="group" style={styles.tags}>
                {INTEREST_TAGS.map((tag) => (
                  <InterestChip key={tag} tag={tag} {...chipFor(tag)} />
                ))}
              </View>
              <Text aria-live="polite" accessibilityLiveRegion="polite" style={styles.hint}>
                {`${form.interestTags.length} of ${INTEREST_TAGS_MAX} chosen`}
              </Text>
            </>
          ) : null}
          {section.title === PHOTO_SECTION ? (
            <View style={styles.photo}>
              {photo.kind === 'new' ? (
                <Image source={{ uri: photo.uri }} style={styles.photoPreview} {...PHOTO_LABEL} />
              ) : (
                <Avatar avatarSeed={profile.avatarSeed} handle={profile.handle} size={PHOTO_SIZE} />
              )}
              <Text style={styles.body}>{photoSet ? COPY.photoSet : COPY.photoNone}</Text>
              <View style={styles.actions}>
                <Button {...CHOOSE_PHOTO} label={COPY.photoChoose} busy={picking} onPress={pick} />
                {photoSet ? (
                  <Button {...REMOVE_PHOTO} label={COPY.photoRemove} onPress={removePhoto} />
                ) : null}
              </View>
              {photoError === null ? null : <Text style={styles.error}>{photoError}</Text>}
            </View>
          ) : null}
          {section.fields.map((key) => {
            const spec = FIELDS[key];
            return (
              <TextField
                key={key}
                {...spec}
                value={form[key]}
                onChangeText={(text) => changeField(key, text)}
                hint={hintFor(key, spec, form[key])}
                error={key === 'homeCountryCode' ? countryIssue : null}
                testID={`profile-edit-${key}`}
              />
            );
          })}
        </View>
      ))}
      <Button
        {...SAVE_PROFILE}
        label={COPY.save}
        onPress={saveNow}
        busy={save.isPending}
        disabled={unsavable}
      />
      {update === null ? <Text style={styles.hint}>{COPY.noChanges}</Text> : null}
    </Screen>
  );
}
export default function EditProfileScreen(): ReactElement {
  const me = useMe();
  const errorCode = me.isError ? (isApiError(me.error) ? me.error.code : 'invalid_response') : null;
  const announced = useRef<string | null>(null);
  const profile = me.data;
  const reload = (): void => void me.refetch();
  const retry = { label: COPY.retry, onPress: reload, testID: 'profile-edit-retry' };
  useEffect(() => {
    if (errorCode === null) announced.current = null;
    else if (announced.current !== errorCode) {
      announced.current = errorCode;
      announce(userMessageFor(errorCode));
    }
  }, [errorCode]);
  const loading = (
    <Screen edges={SCREEN_EDGES} testID="profile-edit">
      {errorCode === null ? (
        <Text style={styles.body}>{COPY.loading}</Text>
      ) : (
        <Banner {...LOAD_FAILED} message={userMessageFor(errorCode)} action={retry} />
      )}
    </Screen>
  );
  return (
    <>
      <Stack.Screen options={{ title: COPY.screenTitle }} />
      {errorCode === null && profile !== undefined ? <ProfileForm profile={profile} /> : loading}
    </>
  );
}

const CHIP_CENTER = { alignItems: 'center' as const, justifyContent: 'center' as const };
const CHIP_EDGE = { borderColor: colors.border, borderRadius: radii.pill } as const;
const CHIP_FILL = { backgroundColor: colors.background, borderWidth: borderWidths.control };
const CHIP_PAD = { paddingHorizontal: spacing.md, paddingVertical: spacing.sm };
const PHOTO_BOX = { backgroundColor: colors.surface, borderRadius: radii.md };
const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  body: { ...typography.body, color: colors.text },
  chip: { ...CHIP_CENTER, ...CHIP_EDGE, ...CHIP_FILL, minHeight: MIN_TOUCH_TARGET, ...CHIP_PAD },
  chipDisabled: { backgroundColor: colors.surface, borderColor: colors.border },
  chipFocused: { borderColor: colors.focusRing },
  chipLabel: { ...typography.label, color: colors.text, fontWeight: fontWeights.medium },
  chipLabelDisabled: { color: colors.textMuted },
  chipLabelSelected: { color: colors.onPrimary },
  chipOutlined: { backgroundColor: colors.surface },
  chipPressed: { opacity: interactionOpacity.pressed },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  error: { ...typography.caption, color: colors.danger, fontWeight: fontWeights.medium },
  hint: { ...typography.caption, color: colors.textMuted },
  note: { ...typography.caption, color: colors.textMuted },
  photo: { alignItems: 'flex-start', gap: spacing.sm },
  photoPreview: { ...PHOTO_BOX, height: PHOTO_SIZE, width: PHOTO_SIZE },
  section: { gap: spacing.md },
  sectionTitle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
