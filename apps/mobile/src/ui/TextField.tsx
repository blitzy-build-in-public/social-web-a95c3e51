/**
 * TextField — a labelled text input whose hint and error text are linked to the input itself (AAP 0.5.8).
 *
 * The label is always rendered and never replaced by a placeholder; `hint` and `error` are shown below the input and
 * bound to it (`aria-describedby` on web, `accessibilityHint` on iOS and Android); an error is prefixed with the word
 * "Error:" so its meaning is not carried by colour alone; the input keeps a 2 px border in every state, so the focus ring
 * never shifts the layout, and on web that band is the ring because `webFocusRingReset` keeps the browser's outline off
 * the input; and the field is at least `MIN_TOUCH_TARGET` tall with the 16-point body font, which also keeps iOS Safari
 * from zooming a focused input.
 * Every text colour is a `CONTRAST_PAIRS` entry over the field's own background and the border and ring are
 * `NON_TEXT_CONTRAST_PAIRS` entries (WCAG 1.4.11); the error state keeps that recorded border and carries its message in
 * the error text, its colour and `aria-invalid`, because the token module records no boundary pair for the error colour.
 * The field carries no live region on iOS or Android — the screens announce core-flow errors through `announce()` —
 * while on web the error text is itself the live region, because `announce()` is a no-op there (WCAG 4.1.3). Nothing here
 * logs or persists `value`, which is an email address or a booking name.
 */
import { useId, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Role, TextInputProps, TextStyle } from 'react-native';
import {
  borderWidths,
  colors,
  fontWeights,
  MIN_TOUCH_TARGET,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';

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
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  /** Visible helper text below the input, such as "6 digits". Linked to the input. */
  hint?: string | undefined;
  /** Visible error text below the input, or `null` while the field is valid. Linked to the input. */
  error?: string | null | undefined;
  disabled?: boolean | undefined;
  testID?: string | undefined;
}

/** Prefix that keeps an error legible without relying on its colour (WCAG 1.4.1). */
const ERROR_PREFIX = 'Error: ';
/**
 * The attributes that link the input to its visible label, its hint and its error text on web.
 */
interface WebInputAria {
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

/**
 * What makes the error text a live region, on web alone (AAP 0.5.8; WCAG 4.1.3): `announce()` is a no-op there
 * and this is the only place the message exists, while native screens announce through it.
 */
const webErrorLiveRegion: Readonly<{ role?: Role; 'aria-live'?: 'assertive' }> =
  Platform.OS === 'web' ? { role: 'alert', 'aria-live': 'assertive' } : {};
/**
 * The DOM `id` on web and the native accessibility identifier elsewhere: `nativeID` is the React Native spelling,
 * which react-native-web renders as the same DOM attribute.
 */
function elementId(value: string): { id?: string; nativeID?: string } {
  return Platform.OS === 'web' ? { id: value } : { nativeID: value };
}

// The browser's own focus outline is kept off the band this control reserves for its focus ring, so the ring a
// keyboard user sees is the app's own; on web React Native declares no `outline` style, so the long form is asserted
// here and the value is empty off web, which never reads it.
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
    borderWidth: borderWidths.control,
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
/** Labelled text input. See the module header for the input rules it carries. */
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
  // `useId()` yields a token such as `:r0:` in the client renderer: a valid HTML id but not a valid CSS
  // selector, so the punctuation is stripped before the label, input, hint and error ids are composed from it.
  // The value stays unique per field instance.
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
    // On web the visible label names the field: `aria-labelledby` outranks the `aria-label` below, which iOS and Android read.
    webAria['aria-labelledby'] = labelId;
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
        <Text {...elementId(errorId)} {...webErrorLiveRegion} style={styles.error}>
          {`${ERROR_PREFIX}${errorText}`}
        </Text>
      ) : null}
    </View>
  );
}
