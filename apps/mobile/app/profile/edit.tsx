/**
 * Edit profile (`/profile/edit`): the traveler's own pseudonymous profile, one group of fields per
 * disclosure tier (AAP 0.5.8, AAP 0.7.1 row 8).
 *
 * It writes exactly the fields of `PUT /me/profile` (AAP 0.5.4) and only the ones that changed: a
 * field left as it arrived is not sent, one cleared to empty is sent as `null`, and the tags are sent
 * in the vocabulary's own order. Every field is optional and saving an empty profile is valid
 * (AAP 0.1.1); the API stays the authority on every limit, so the shared constants repeated here only
 * spare a round trip, and a value it still refuses arrives as `400 invalid_field` or
 * `413 photo_too_large`, shown through `userMessageFor` and spoken through `announce` (AAP 0.5.8).
 *
 * A profile with no staged photo shows the generated avatar: `GET /users/:userId/photo` is defined by
 * viewer tier with no self-view (AAP 0.5.4), so this screen never asks for its own photo. The picker
 * is asked for no EXIF, and a staged photo's base64 lives in component state alone until the save
 * drops it; the API decodes it, refuses anything over `PHOTO_MAX_BYTES` and re-encodes the rest to
 * WebP with metadata and GPS stripped (AAP 0.5.2).
 *
 * Form state lives in {@link ProfileForm}, mounted once the profile has loaded with that profile as
 * its initial value, so a background refetch re-renders it without overwriting what is being typed.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
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

// --- Fixed strings and constants ----------------------------------------------------------------

/**
 * Every sentence this screen owns. The deposit framing, the safety notice and the lodging-call
 * notice belong to their own screens and are never repeated here (AAP 0.5.8).
 */
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

/** The safe-area edges: the navigator's header already insets the top. */
const SCREEN_EDGES = ['left', 'right'] as const;

/**
 * The stack header's title, which is also the page's one first-level heading. The screen renders no
 * heading of its own: repeating the title inside the screen would show the words twice and put a
 * second `h1` on the web page (a real browser walk found both), and the header's own heading is what
 * the section headings below it nest under.
 */
const SCREEN_OPTIONS = { title: COPY.screenTitle } as const;

/** Side of a staged photo's preview, in points / CSS px. */
const PHOTO_SIZE = 96;

/** Characters in an ISO 3166-1 alpha-2 code, which `CountryCode` accepts upper-case alone. */
const COUNTRY_CODE_LENGTH = 2;

/** The interests and photo sections, whose bodies are rendered beside the field table. */
const INTERESTS_SECTION = 'Interests';
const PHOTO_SECTION = 'Photo';

/** The photo as it stands while nothing has been done to it; shared, because it holds nothing. */
const UNCHANGED_PHOTO: PhotoState = { kind: 'unchanged' };

// --- Types and the field table -------------------------------------------------------------------

/** The six editable text fields; every other profile field is written by its own screen. */
const TEXT_KEYS = [
  'nickname',
  'bio',
  'homeCity',
  'homeCountryCode',
  'fullName',
  'externalContact',
] as const;

type TextFieldKey = (typeof TEXT_KEYS)[number];

/** Every text field's editable value, with the API's `null`s read as empty strings. */
interface FormState {
  nickname: string;
  bio: string;
  homeCity: string;
  homeCountryCode: string;
  fullName: string;
  externalContact: string;
  interestTags: InterestTag[];
}

/**
 * The tier-2 photo as the form holds it: the stored one untouched, a chosen one staged with its
 * bytes and its URI, or a removal that has not been saved. A staged photo is the only copy of that
 * picture this screen has, and it lives in state until the save clears it.
 */
type PhotoState =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'new'; readonly base64: string; readonly uri: string }
  | { readonly kind: 'removed' };

/** One editable field: its visible label, its limit, and the input hints its value needs. */
interface FieldSpec {
  readonly label: string;
  readonly maxLength: number;
  readonly hint?: string;
  /** Shows the characters the field has left instead of `hint`; it carries one or the other. */
  readonly counted?: boolean;
  readonly multiline?: boolean;
  readonly autoComplete?: TextInputProps['autoComplete'];
  readonly autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}

/**
 * The fields by key, so a section names them and one map renders every one of them. Only the two
 * fields the platform can fill knowingly carry an `autoComplete` hint; nothing here asks for
 * autofill of a contact handle, and no field asks the browser to remember a value it should not.
 */
const FIELDS: Readonly<Record<TextFieldKey, FieldSpec>> = {
  nickname: { label: 'Nickname', maxLength: NICKNAME_MAX_CHARS, counted: true },
  bio: { label: 'Bio', maxLength: BIO_MAX_CHARS, counted: true, multiline: true },
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

/** A section of the form: its heading, the note under it saying who sees it, and its fields. */
interface SectionSpec {
  readonly title: string;
  readonly note?: string;
  readonly fields: readonly TextFieldKey[];
}

/**
 * The sections in reading order, each with the heading that says who sees it (AAP 0.5.4 tier table,
 * AAP 0.5.8). The interests and photo sections carry no text field, so their bodies are rendered
 * beside this table.
 */
const SECTIONS: readonly SectionSpec[] = [
  { title: 'About you', note: COPY.aboutNote, fields: ['nickname', 'bio'] },
  { title: INTERESTS_SECTION, note: COPY.interestsNote, fields: [] },
  { title: 'Home', fields: ['homeCity', 'homeCountryCode'] },
  { title: PHOTO_SECTION, note: COPY.photoNote, fields: [] },
  {
    title: 'Only for close connections',
    note: COPY.tier3Note,
    fields: ['fullName', 'externalContact'],
  },
];

/**
 * The section headings as headings of the second level, under the page's own first-level heading.
 * `aria-level` is not in React Native 0.76's types yet while `Text` spreads unlisted props onto the
 * host view, where react-native-web reads it to render a real `h2`.
 */
const SECTION_HEADING: TextProps & Readonly<{ 'aria-level': number }> = {
  role: 'heading',
  'aria-level': 2,
};

/**
 * Keeps the browser's own focus outline off a focused chip on web, where it would be painted over the
 * border the chip reserves and the ring a keyboard user sees would be the browser's default rather
 * than `colors.focusRing` (WCAG 2.4.7). The value is empty off web, which never reads it.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as ViewStyle;

/**
 * The toggle state as react-native-web reads it: React Native 0.76 declares no `aria-pressed` while
 * its `Pressable` spreads unlisted props onto the host view, and the native platforms carry the same
 * state through `accessibilityState.selected`, which react-native-web has no rendering for.
 */
function pressedAttributes(selected: boolean): Readonly<{ 'aria-pressed': boolean }> {
  return { 'aria-pressed': selected };
}

// --- Pure helpers --------------------------------------------------------------------------------

/** The tags in the vocabulary's own order, which is the order the API receives them in. */
function sortTags(tags: readonly InterestTag[]): InterestTag[] {
  return INTEREST_TAGS.filter((tag) => tags.includes(tag));
}

/** True when two sets hold the same tags, so an unchanged interest list is not sent at all. */
function tagsEqual(left: readonly InterestTag[], right: readonly InterestTag[]): boolean {
  return sortTags(left).join(',') === sortTags(right).join(',');
}

/** A tag's display label: the vocabulary's snake_case spelling, read as words. */
function tagLabel(tag: InterestTag): string {
  return tag.replace(/_/g, ' ');
}

/** The form's initial value, with the API's `null`s read as empty fields. */
function formFrom(profile: MeDto): FormState {
  return {
    nickname: profile.nickname ?? '',
    bio: profile.bio ?? '',
    homeCity: profile.homeCity ?? '',
    homeCountryCode: profile.homeCountryCode ?? '',
    fullName: profile.fullName ?? '',
    externalContact: profile.externalContact ?? '',
    interestTags: sortTags(profile.interestTags),
  };
}

/**
 * One text field replaced. Written as a switch because a computed key over the field union would
 * widen the form to an index signature and lose the guarantee that every field is a string.
 */
function withField(form: FormState, key: TextFieldKey, value: string): FormState {
  switch (key) {
    case 'nickname':
      return { ...form, nickname: value };
    case 'bio':
      return { ...form, bio: value };
    case 'homeCity':
      return { ...form, homeCity: value };
    case 'homeCountryCode':
      return { ...form, homeCountryCode: value };
    case 'fullName':
      return { ...form, fullName: value };
    case 'externalContact':
      return { ...form, externalContact: value };
  }
}

/** The country code's inline message, or `null` while the field is empty or holds a valid code. */
function countryCodeError(value: string): string | null {
  if (value === '') return null;
  return CountryCode.safeParse(value).success ? null : COPY.countryError;
}

/** The hint under a field: the characters it has left, or the fixed sentence it carries. */
function hintFor(spec: FieldSpec, value: string): string | undefined {
  return spec.counted === true ? `${spec.maxLength - value.length} characters left` : spec.hint;
}

/** The bytes a base64 string decodes to, from its length and padding alone; the API decodes it too. */
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** A picked image's base64 without the `data:` prefix a web reader may keep, or `null` for none. */
function normalizeBase64(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const comma = value.indexOf(',');
  const body = value.startsWith('data:') && comma !== -1 ? value.slice(comma + 1) : value;
  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The body `PUT /me/profile` receives, or `null` when nothing changed and there is nothing to save:
 * only the text fields whose trimmed value differs, the tags only when the set differs, and the
 * photo only when it was staged or removed. An empty field becomes `null`, which is what clears it
 * (AAP 0.5.4).
 */
function buildUpdate(form: FormState, baseline: MeDto, photo: PhotoState): ProfileUpdate | null {
  const update: ProfileUpdate = {};

  for (const key of TEXT_KEYS) {
    const next = form[key].trim();
    if (next === (baseline[key] ?? '')) continue;
    update[key] = next === '' ? null : next;
  }

  const tags = sortTags(form.interestTags);
  if (!tagsEqual(tags, baseline.interestTags)) update.interestTags = tags;

  if (photo.kind === 'new') update.photoBase64 = photo.base64;
  if (photo.kind === 'removed') update.photoBase64 = null;

  return Object.keys(update).length === 0 ? null : update;
}

// --- One interest tag as a toggle -----------------------------------------------------------------

/**
 * An interest tag a traveler turns on or off. It is a toggle button rather than a checkbox because
 * react-native-web starts a press from the keyboard on Space alone for a `button` role, and it is a
 * `Pressable` rather than the `Button` primitive because `Button` paints three roles and carries no
 * selected state: the chip takes a `pill` edge, the `primary` fill when chosen and the page fill
 * otherwise, every one of them a pair `CONTRAST_PAIRS` or `NON_TEXT_CONTRAST_PAIRS` records. Both
 * `aria-pressed` and `accessibilityState.selected` carry the state, and a chip beyond the third is
 * reportable as disabled rather than silently unpressed (AAP 0.5.8).
 */
function InterestChip({
  tag,
  selected,
  disabled,
  onPress,
}: {
  readonly tag: InterestTag;
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const [focused, setFocused] = useState(false);
  const [hovered, setHovered] = useState(false);
  const label = tagLabel(tag);

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

// --- The form ------------------------------------------------------------------------------------

/**
 * The edit form, mounted once `GET /me` has answered and holding that profile as its initial value.
 *
 * A later prop change — the background refetch `meetup-store` runs on a focused window — is
 * deliberately not read back into the form, because what a traveler is typing is theirs until they
 * save it. The save's own answer is what re-fills the form: `PUT /me/profile` returns the same
 * `MeDto` `GET /me` does, so the form is re-read from it and stands as the new baseline before the
 * query is invalidated for every other reader of the profile.
 *
 * @param props - The loaded profile: the form's prefill, and the baseline every change is compared
 * against.
 * @returns The form's sections, its photo controls and its save.
 */
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
      // The photo's own refusal belongs beside the photo, which is the field to change.
      if (code === 'photo_too_large') setPhotoError(message);
      else setSaveError(message);
      announce(message);
    },
  });

  /** Clears the notices an edit makes stale, so a save's answer never outlives the change. */
  function edited(): void {
    setSaved(false);
    setSaveError(null);
    setPhotoError(null);
  }

  function changeField(key: TextFieldKey, text: string): void {
    // `CountryCode` accepts upper-case letters alone, so the code is upper-cased as it is typed.
    setForm((previous) =>
      withField(previous, key, key === 'homeCountryCode' ? text.toUpperCase() : text),
    );
    edited();
  }

  function toggleTag(tag: InterestTag): void {
    setForm((previous) => ({
      ...previous,
      interestTags: previous.interestTags.includes(tag)
        ? previous.interestTags.filter((chosen) => chosen !== tag)
        : sortTags([...previous.interestTags, tag]),
    }));
    edited();
  }

  function removePhoto(): void {
    setPhoto({ kind: 'removed' });
    edited();
  }

  async function choosePhoto(): Promise<void> {
    setPicking(true);
    edited();

    let result: ImagePicker.ImagePickerResult;
    try {
      // SDK 52's string `MediaType` list, which is the v16 typings' own form: `MediaTypeOptions` is
      // deprecated there. Picking from the library needs no media permission, and `exif: false`
      // keeps the picked file's metadata, its GPS block included, out of this process entirely.
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        base64: true,
        exif: false,
        quality: 0.8,
      });
    } catch {
      setPicking(false);
      setPhotoError(COPY.photoUnreadable);
      announce(COPY.photoUnreadable);
      return;
    }
    setPicking(false);
    if (result.canceled) return;

    const asset = result.assets[0];
    const uri = asset?.uri ?? null;
    const base64 = normalizeBase64(asset?.base64);
    if (uri === null || base64 === null) {
      setPhotoError(COPY.photoUnreadable);
      announce(COPY.photoUnreadable);
      return;
    }

    // The API decodes the photo itself and answers `413 photo_too_large`; counting the bytes here
    // only spares the 8 MB request body of a picture that would be refused.
    if (decodedByteLength(base64) > PHOTO_MAX_BYTES) {
      const message = userMessageFor('photo_too_large');
      setPhotoError(message);
      announce(message);
      return;
    }

    setPhoto({ kind: 'new', base64, uri });
  }

  function saveNow(): void {
    if (countryIssue !== null) {
      announce(countryIssue);
      return;
    }
    if (update === null) return;

    // The last gate before the request: the body is checked with the route's own schema, so a body
    // the API would refuse is not sent at all (AAP 0.5.4, `400 invalid_field`).
    const parsed = ProfileUpdate.safeParse(update);
    if (!parsed.success) {
      const message = userMessageFor('invalid_field');
      setSaveError(message);
      announce(message);
      return;
    }

    save.mutate(parsed.data);
  }

  return (
    <Screen edges={SCREEN_EDGES} testID="profile-edit">
      <Text style={styles.body}>{COPY.optional}</Text>
      {saved ? <Banner tone="success" message={COPY.saved} testID="profile-edit-saved" /> : null}
      {saveError === null ? null : (
        <Banner tone="error" message={saveError} testID="profile-edit-save-error" />
      )}

      {SECTIONS.map((section) => (
        <View key={section.title} style={styles.section}>
          <Text {...SECTION_HEADING} style={styles.sectionTitle}>
            {section.title}
          </Text>
          {section.note === undefined ? null : <Text style={styles.note}>{section.note}</Text>}

          {section.title === INTERESTS_SECTION ? (
            <>
              {/* The chips are one labelled group, so a screen reader reaches them as a set rather
                  than as thirty-one unrelated buttons. */}
              <View aria-label={INTERESTS_SECTION} role="group" style={styles.tags}>
                {INTEREST_TAGS.map((tag) => {
                  const chosen = form.interestTags.includes(tag);
                  return (
                    <InterestChip
                      key={tag}
                      tag={tag}
                      selected={chosen}
                      // A fourth tag cannot be chosen: every unselected chip is disabled at the cap.
                      disabled={!chosen && tagsAtLimit}
                      onPress={() => toggleTag(tag)}
                    />
                  );
                })}
              </View>
              {/* A live region, because the count is the only feedback a toggle gives and colour
                  alone never carries it (WCAG 4.1.3). React Native has no live region on iOS, where
                  the chip's own pressed state is what VoiceOver reads. */}
              <Text aria-live="polite" accessibilityLiveRegion="polite" style={styles.hint}>
                {`${form.interestTags.length} of ${INTEREST_TAGS_MAX} chosen`}
              </Text>
            </>
          ) : null}

          {section.title === PHOTO_SECTION ? (
            <View style={styles.photo}>
              {photo.kind === 'new' ? (
                <Image
                  source={{ uri: photo.uri }}
                  style={styles.photoPreview}
                  accessibilityLabel={COPY.photoPreview}
                />
              ) : (
                <Avatar avatarSeed={profile.avatarSeed} handle={profile.handle} size={PHOTO_SIZE} />
              )}
              <Text style={styles.body}>{photoSet ? COPY.photoSet : COPY.photoNone}</Text>
              <View style={styles.actions}>
                <Button
                  label={COPY.photoChoose}
                  onPress={() => void choosePhoto()}
                  variant="secondary"
                  busy={picking}
                  testID="profile-edit-photo-choose"
                />
                {photoSet ? (
                  <Button
                    label={COPY.photoRemove}
                    onPress={removePhoto}
                    variant="danger"
                    testID="profile-edit-photo-remove"
                  />
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
                label={spec.label}
                value={form[key]}
                onChangeText={(text) => changeField(key, text)}
                hint={hintFor(spec, form[key])}
                error={key === 'homeCountryCode' ? countryIssue : null}
                maxLength={spec.maxLength}
                multiline={spec.multiline === true}
                autoCapitalize={spec.autoCapitalize ?? 'sentences'}
                autoComplete={spec.autoComplete}
                testID={`profile-edit-${key}`}
              />
            );
          })}
        </View>
      ))}

      <Button
        label={COPY.save}
        onPress={saveNow}
        busy={save.isPending}
        disabled={update === null || countryIssue !== null}
        testID="profile-edit-save"
      />
      {update === null ? <Text style={styles.hint}>{COPY.noChanges}</Text> : null}
    </Screen>
  );
}

// --- The route -----------------------------------------------------------------------------------

/** The code of a failed read: the API's own code, or the client's answer that was not the envelope. */
function errorCodeOf(error: unknown): string {
  return isApiError(error) ? error.code : 'invalid_response';
}

/**
 * The Edit profile route.
 *
 * The form exists only once `GET /me` has answered (AAP 0.5.4): until then the screen is one line,
 * and a failed read is the sentence for its code with the retry that runs it again. That failure is
 * spoken once per distinct code, because a re-render over the same failed read would otherwise
 * repeat it, and a recovery clears the code so a next failure speaks again (AAP 0.5.8).
 *
 * @returns The edit screen, in whichever state the read is in.
 */
export default function EditProfileScreen(): ReactElement {
  const me = useMe();
  const errorCode = me.isError ? errorCodeOf(me.error) : null;
  const announced = useRef<string | null>(null);
  const profile = me.data;

  useEffect(() => {
    if (errorCode === null) {
      announced.current = null;
      return;
    }
    if (announced.current === errorCode) return;
    announced.current = errorCode;
    announce(userMessageFor(errorCode));
  }, [errorCode]);

  return (
    <>
      <Stack.Screen options={SCREEN_OPTIONS} />
      {errorCode === null && profile !== undefined ? (
        <ProfileForm profile={profile} />
      ) : (
        <Screen edges={SCREEN_EDGES} testID="profile-edit">
          {errorCode === null ? (
            <Text style={styles.body}>{COPY.loading}</Text>
          ) : (
            <Banner
              tone="error"
              message={userMessageFor(errorCode)}
              action={{
                label: COPY.retry,
                onPress: () => void me.refetch(),
                testID: 'profile-edit-retry',
              }}
              testID="profile-edit-load-error"
            />
          )}
        </Screen>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  body: { ...typography.body, color: colors.text },
  chip: {
    alignItems: 'center',
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: radii.pill,
    borderWidth: borderWidths.control,
    justifyContent: 'center',
    minHeight: MIN_TOUCH_TARGET,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
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
  photoPreview: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    height: PHOTO_SIZE,
    width: PHOTO_SIZE,
  },
  section: { gap: spacing.md },
  sectionTitle: { ...typography.title, color: colors.text, fontWeight: fontWeights.bold },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
});
