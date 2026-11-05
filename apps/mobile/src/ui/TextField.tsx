/**
 * TextField — a labelled text input whose hint and error text are linked to the input itself.
 *
 * One primitive carries the input rules the form screens depend on (AAP 0.5.8): the label is always
 * rendered and is never replaced by a placeholder; `hint` and `error` are shown below the input and
 * bound to it (`aria-describedby` on web, `accessibilityHint` on iOS and Android) so a screen reader
 * reaches them from the field; an error is prefixed with the word "Error:" so its meaning is not
 * carried by colour alone; the input keeps a 2 px border in every state, so the focus ring never
 * shifts the layout; on web that band is the ring itself, because `webFocusRingReset` keeps the
 * browser's own outline off the input; and the field is at least `MIN_TOUCH_TARGET` tall with the
 * 16-point body font, which also keeps iOS Safari from zooming a focused input.
 *
 * Every colour, spacing step, radius and type size comes from the shared tokens: each text colour is
 * a `CONTRAST_PAIRS` entry over the field's own background, and the input border and focus ring are
 * `NON_TEXT_CONTRAST_PAIRS` entries (WCAG 1.4.11). The error state keeps that recorded border and
 * carries its message in the error text, its colour and `aria-invalid`, because the token module
 * records no boundary pair for the error colour and a primitive never invents one. The field carries
 * no live region — the screens announce core-flow errors through `announce()` in `Banner.tsx`, and
 * one here would speak them twice.
 *
 * Nothing in this component logs or persists `value`, which is an email address or a booking name.
 */
import { useId, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps, TextStyle } from 'react-native';
import {
  colors,
  fontWeights,
  MIN_TOUCH_TARGET,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

/**
 * Props of {@link TextField}.
 *
 * Every remaining `TextInputProps` member is passed through unchanged, so a caller sets
 * `keyboardType`, `inputMode`, `maxLength`, `autoComplete`, `textContentType`, `autoCapitalize`,
 * `autoCorrect`, `secureTextEntry`, `multiline`, `returnKeyType` and `onSubmitEditing` directly —
 * the check-in screen, for example, passes `inputMode="numeric"`, `maxLength={6}`,
 * `autoComplete="one-time-code"` and `textContentType="oneTimeCode"`. `allowFontScaling` stays at
 * its default of `true`, so text follows the reader's system font size.
 *
 * `style`, `value` and `onChangeText` are omitted because the field owns them, and
 * `placeholderTextColor` because the placeholder colour is a token. `contextMenuHidden` is omitted
 * because the selection menu, and therefore pasting the 6-digit venue code, must stay available.
 */
export interface TextFieldProps extends Omit<
  TextInputProps,
  | 'style'
  | 'editable'
  | 'contextMenuHidden'
  | 'placeholderTextColor'
  | 'accessibilityLabel'
  | 'aria-label'
  | 'value'
  | 'onChangeText'
> {
  /** Visible label above the input; it is also the input's accessible name. */
  label: string;
  /** Current text. The field is controlled: render only what the caller stores. */
  value: string;
  /** Called with the new text on every keystroke. */
  onChangeText: (text: string) => void;
  /** Visible helper text below the input, such as "6 digits". Linked to the input. */
  hint?: string | undefined;
  /** Visible error text below the input, or `null` while the field is valid. Linked to the input. */
  error?: string | null | undefined;
  /** Renders the field non-editable and non-focusable, in the muted disabled colours. */
  disabled?: boolean | undefined;
  /** Forwarded to the `TextInput`, so e2e tests can fill the field by `data-testid`. */
  testID?: string | undefined;
}

/** Prefix that keeps an error legible without relying on its colour (WCAG 1.4.1). */
const ERROR_PREFIX = 'Error: ';

/**
 * The two attributes that link the input to its hint and error text on web.
 *
 * `react-native-web` 0.19 forwards both to the DOM, but React Native 0.76's `TextInputProps`
 * declares neither, so they are spread from this explicitly typed object rather than through a cast.
 */
interface WebInputAria {
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/**
 * The DOM `id` on web and the native accessibility identifier elsewhere. `nativeID` is the React
 * Native spelling; `react-native-web` renders `id` as the same DOM attribute and warns that
 * `nativeID` is deprecated, so each platform is given the spelling it accepts quietly.
 */
function elementId(value: string): { id?: string; nativeID?: string } {
  return Platform.OS === 'web' ? { id: value } : { nativeID: value };
}

/**
 * Keeps the browser's own focus outline off the input on web, where it would otherwise be painted
 * over the reserved 2 px band and the ring a keyboard user sees would be the browser's default
 * rather than the `colors.focusRing` border the focused input paints (WCAG 2.4.7). React Native
 * 0.76 declares no `outline` style, so the long form is asserted once here; react-native-web drops
 * the `outline` shorthand as an invalid short form. The value is empty off web.
 */
const webFocusRingReset = (Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) as TextStyle;

const styles = StyleSheet.create({
  field: {
    gap: spacing.xs,
  },
  label: {
    ...typography.label,
    color: colors.text,
    fontWeight: fontWeights.medium,
  },
  input: {
    minHeight: MIN_TOUCH_TARGET,
    paddingBlock: spacing.sm,
    paddingInline: spacing.md,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: radii.md,
    backgroundColor: colors.background,
    color: colors.text,
    ...typography.body,
  },
  inputMultiline: {
    textAlignVertical: 'top',
  },
  inputFocused: {
    borderColor: colors.focusRing,
  },
  inputDisabled: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    color: colors.textMuted,
  },
  hint: {
    ...typography.caption,
    color: colors.textMuted,
  },
  error: {
    ...typography.caption,
    color: colors.danger,
    fontWeight: fontWeights.medium,
  },
});

/**
 * Labelled text input. See the module header for the rules it carries.
 *
 * `onFocus` and `onBlur` are called after the field's own focus state is updated, so a caller's
 * handler sees the state its own render will show.
 */
export function TextField({
  label,
  value,
  onChangeText,
  hint,
  error,
  disabled,
  testID,
  onBlur,
  onFocus,
  ...inputProps
}: TextFieldProps) {
  const [focused, setFocused] = useState(false);

  // `useId()` yields a token such as `:r0:` in the client renderer and `R0` on the server: a valid
  // HTML id, but not a valid CSS selector, so the punctuation is stripped before the label, input,
  // hint and error ids are composed from it. The value stays unique per field instance.
  const uid = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const labelId = `${uid}-label`;
  const inputId = `${uid}-input`;
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;

  const hintText = hint ?? '';
  const errorText = error ?? '';
  const isDisabled = disabled === true;
  // React Native derives `editable` from `readOnly`, and react-native-web deprecates `editable`, so
  // the non-editable state travels once, through `readOnly`, on both platforms.
  const isReadOnly = isDisabled || inputProps.readOnly === true;
  const isMultiline = inputProps.multiline === true;

  // Native screen readers read the hint after the label and the value. The error comes first in the
  // sentence because it is the part the reader has to act on.
  const spoken = [errorText, hintText].filter((part) => part !== '');
  const accessibilityHint = spoken.length > 0 ? spoken.join('. ') : undefined;

  const describedByIds: string[] = [];
  if (hintText !== '') describedByIds.push(hintId);
  if (errorText !== '') describedByIds.push(errorId);

  const webAria: WebInputAria = {};
  if (Platform.OS === 'web') {
    if (describedByIds.length > 0) webAria['aria-describedby'] = describedByIds.join(' ');
    if (errorText !== '') webAria['aria-invalid'] = true;
  }

  return (
    <View style={styles.field}>
      <Text {...elementId(labelId)} style={styles.label}>
        {label}
      </Text>
      <TextInput
        {...inputProps}
        {...webAria}
        {...elementId(inputId)}
        accessibilityHint={accessibilityHint}
        aria-label={label}
        aria-disabled={isDisabled}
        readOnly={isReadOnly}
        value={value}
        onChangeText={onChangeText}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        placeholderTextColor={colors.textMuted}
        style={[
          styles.input,
          isMultiline ? styles.inputMultiline : null,
          focused ? styles.inputFocused : null,
          isDisabled ? styles.inputDisabled : null,
          webFocusRingReset,
        ]}
        testID={testID}
      />
      {hintText !== '' ? (
        <Text {...elementId(hintId)} style={styles.hint}>
          {hintText}
        </Text>
      ) : null}
      {errorText !== '' ? (
        <Text {...elementId(errorId)} style={styles.error}>
          {`${ERROR_PREFIX}${errorText}`}
        </Text>
      ) : null}
    </View>
  );
}
