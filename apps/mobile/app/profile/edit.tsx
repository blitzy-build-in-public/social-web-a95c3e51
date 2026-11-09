/** Edit profile (`/profile/edit`): the traveler's own pseudonymous profile, one group of fields per disclosure tier (AAP 0.5.8, AAP 0.7.1 row 8). */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { TextInputProps, TextProps, ViewProps, ViewStyle } from 'react-native';
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
  componentSizes,
  fontWeights,
  interactionOpacity,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import type { InterestTag, MeDto } from '@tablemate/shared';

import { apiClient } from '../../src/api/client';
import { isApiError, userMessageFor } from '../../src/api/errors';
import { bootstrap } from '../../src/auth/session';
import { remainingCharsText } from '../../src/copy/strings';
import { queryClient, queryKeys, useMe } from '../../src/state/meetup-store';
import { useSession } from '../../src/state/session-store';
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
const PHOTO_SIZE = componentSizes.avatarLarge;
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

/** The web key-event fields the toolbar reads: react-native-web forwards the browser's own event, while React Native declares no key events at all. */
type WebKeyEvent = Readonly<{
  altKey?: boolean;
  ctrlKey?: boolean;
  key?: string;
  metaKey?: boolean;
  preventDefault?: () => void;
}>;

/** `aria-orientation` tells assistive technology which way a toolbar's arrow keys move, and React Native declares it on no prop; naming the container's own type keeps the attribute explicit instead of an untyped literal. */
type ToolbarAttributes = ViewProps & Readonly<{ 'aria-orientation': 'horizontal' }>;
const TOOLBAR_ATTRIBUTES: ToolbarAttributes = { 'aria-orientation': 'horizontal' };

/** How each arrow key steps through the chips: the chips are one row at every width, so Up and Down move along that row exactly as Left and Right do. */
const ARROW_STEP: Readonly<Record<string, 1 | -1>> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};
function sortTags(tags: readonly InterestTag[]): InterestTag[] {
  return INTEREST_TAGS.filter((tag) => tags.includes(tag));
}
function toggled(tags: readonly InterestTag[], tag: InterestTag): InterestTag[] {
  return tags.includes(tag) ? tags.filter((chosen) => chosen !== tag) : sortTags([...tags, tag]);
}
/** The next enabled chip from `from`, stepping by `step` and wrapping at either end of the vocabulary; `from` itself comes back when no other chip is enabled, which leaves focus where it is. */
function enabledNeighbour(
  from: InterestTag,
  step: 1 | -1,
  disabled: (tag: InterestTag) => boolean,
): InterestTag {
  const count = INTEREST_TAGS.length;
  let index = INTEREST_TAGS.indexOf(from);
  for (let visited = 0; visited < count; visited += 1) {
    index = (index + step + count) % count;
    const tag = INTEREST_TAGS[index];
    if (tag !== undefined && !disabled(tag)) return tag;
  }
  return from;
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
  return counted ? remainingCharsText(value, spec.maxLength) : spec.hint;
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
  /** The chip's place in the toolbar's tab order: `0` for the current chip and `-1` for every other, and nothing off web, where each chip keeps the focusability it had. */
  readonly tabIndex?: 0 | -1 | undefined;
  readonly onPress: () => void;
  readonly onFocused: () => void;
  readonly registerRef: (tag: InterestTag, node: View | null) => void;
}
function InterestChip({
  tag,
  selected,
  disabled,
  tabIndex,
  onPress,
  onFocused,
  registerRef,
}: ChipProps): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const label = tag.replace(/_/g, ' ');
  return (
    <Pressable
      {...pressedAttributes(selected)}
      ref={(node) => registerRef(tag, node)}
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      onFocus={() => {
        setFocused(true);
        onFocused();
      }}
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
      tabIndex={tabIndex}
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

/** Props of the interests toolbar: the tags chosen, whether the tag limit is reached, and the toggle. */
interface InterestToolbarProps {
  readonly chosen: readonly InterestTag[];
  readonly atLimit: boolean;
  readonly onToggle: (tag: InterestTag) => void;
}

/** The interest chips as one toolbar of toggle buttons (WCAG 2.4.1): a single tab stop for the whole row with the arrow keys moving between the chips — the WAI-ARIA pattern for a row of buttons, which saves a keyboard user 31 presses. Exactly one chip is in the tab order: the chip the keyboard last moved to, or the first enabled chip until then, and a chip the three-tag limit disabled is never that chip and never takes focus. Everything else about a chip is unchanged. */
function InterestToolbar({ chosen, atLimit, onToggle }: InterestToolbarProps): ReactElement {
  // Each chip's element, which the arrow keys call `focus()` on: react-native-web gives a `Pressable`'s ref the browser element itself and React Native's own `View` type carries `focus()`, so the chip's handle is the same type on both platforms.
  const handles = useRef(new Map<InterestTag, View>());
  const [focusedTag, setFocusedTag] = useState<InterestTag | null>(null);
  const isDisabled = (tag: InterestTag): boolean => !chosen.includes(tag) && atLimit;
  const enabled = INTEREST_TAGS.filter((tag) => !isDisabled(tag));
  // The tab stop falls back to the first enabled chip when the remembered one stops being usable, which is what reaching the tag limit while an unselected chip is current would do.
  const current =
    focusedTag !== null && !isDisabled(focusedTag) ? focusedTag : (enabled[0] ?? null);
  const rememberHandle = useCallback((tag: InterestTag, node: View | null): void => {
    if (node === null) handles.current.delete(tag);
    else handles.current.set(tag, node);
  }, []);
  const focusTag = useCallback((tag: InterestTag): void => {
    setFocusedTag(tag);
    handles.current.get(tag)?.focus();
  }, []);
  const onKeyDown = (event: WebKeyEvent): void => {
    // Alt, Ctrl and Meta belong to the browser's own shortcuts — Alt+Left is Back — so the chips answer to the four arrows, Home and End alone and let every other key through untouched.
    if (event.altKey === true || event.ctrlKey === true || event.metaKey === true) return;
    if (current === null) return;
    const step = event.key === undefined ? undefined : ARROW_STEP[event.key];
    if (step !== undefined) {
      // The arrows and Home/End scroll the page when the browser acts on them itself, so a key this handler acts on is taken from the browser here.
      event.preventDefault?.();
      focusTag(enabledNeighbour(current, step, isDisabled));
      return;
    }
    if (event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault?.();
    const edge = event.key === 'Home' ? enabled[0] : enabled[enabled.length - 1];
    if (edge !== undefined) focusTag(edge);
  };
  const toolbarKeys: { onKeyDown?: (event: WebKeyEvent) => void } =
    Platform.OS === 'web' ? { onKeyDown } : {};
  return (
    <View
      {...TOOLBAR_ATTRIBUTES}
      {...toolbarKeys}
      role="toolbar"
      aria-label={INTERESTS_SECTION}
      style={styles.tags}
    >
      {INTEREST_TAGS.map((tag) => {
        const selected = chosen.includes(tag);
        return (
          <InterestChip
            key={tag}
            tag={tag}
            selected={selected}
            disabled={!selected && atLimit}
            tabIndex={Platform.OS === 'web' ? (tag === current ? 0 : -1) : undefined}
            onPress={() => {
              onToggle(tag);
              // The toggled chip keeps focus, which the WAI-ARIA toolbar pattern expects; the app releases focus from the control a press arrived on (`app/_layout.tsx`), so the chip asks for its own focus back.
              focusTag(tag);
            }}
            onFocused={() => setFocusedTag(tag)}
            registerRef={rememberHandle}
          />
        );
      })}
    </View>
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
              <InterestToolbar
                chosen={form.interestTags}
                atLimit={tagsAtLimit}
                onToggle={toggleTag}
              />
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
  const session = useSession();
  const errorCode = me.isError ? (isApiError(me.error) ? me.error.code : 'invalid_response') : null;
  // The own-profile read is unissued while the restore has not proved a session, so the failure's own code is shown and retried in its place.
  const restoreCode = session.status === 'loading' ? session.restoreFailureCode : undefined;
  const loadCode = errorCode ?? restoreCode ?? null;
  const loadMessage = loadCode === null ? null : userMessageFor(loadCode);
  const announced = useRef<string | null>(null);
  const profile = me.data;
  // A read that failed on its own is retried by refetching it; one that was never issued is not, because what has to run again is the restore.
  const reload = (): void => {
    if (restoreCode === undefined) void me.refetch();
    else void bootstrap();
  };
  const retry = { label: COPY.retry, onPress: reload, testID: 'profile-edit-retry' };
  useEffect(() => {
    if (loadCode === null) announced.current = null;
    else if (announced.current !== loadCode) {
      announced.current = loadCode;
      announce(userMessageFor(loadCode));
    }
  }, [loadCode]);
  const loading = (
    <Screen edges={SCREEN_EDGES} testID="profile-edit">
      {loadMessage === null ? (
        <Text style={styles.body}>{COPY.loading}</Text>
      ) : (
        <Banner {...LOAD_FAILED} message={loadMessage} action={retry} />
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
  // Faded as well as recoloured: the muted surface and label alone differ from an enabled chip by one step of fill, which a reader cannot tell from a chip they can still press.
  chipDisabled: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    opacity: interactionOpacity.disabled,
  },
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
