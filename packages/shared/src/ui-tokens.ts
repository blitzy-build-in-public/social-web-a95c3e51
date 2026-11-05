/**
 * Design tokens for every Tablemate surface: colour, spacing, radii, type roles and the
 * contrast records the UI primitives are built and checked against (AAP 0.5.8).
 *
 * Platform-neutral plain values with no imports, so the native app, the web build and the Vite
 * venue console all read the same numbers. Consumers style from these tokens and never
 * hard-code a colour, a spacing step or a type size of their own.
 */

/**
 * Colour tokens.
 *
 * `danger`, `success` and `warning` carry status, and status is never conveyed by colour
 * alone (AAP 0.5.8: the check-in screen shows the time left as text, not as a colour change),
 * so each status colour is paired with text, an icon or a pattern.
 */
export const colors = {
  background: '#FFFFFF',
  surface: '#F5F3EF',
  text: '#1C1B19',
  textMuted: '#5C5850',
  primary: '#9A3412',
  onPrimary: '#FFFFFF',
  border: '#8A847A',
  danger: '#B91C1C',
  onDanger: '#FFFFFF',
  success: '#166534',
  warning: '#92400E',
  focusRing: '#1D4ED8',
} as const;

/**
 * Every colour token name, so a call site or a test can constrain a value to the palette.
 */
export type ColorToken = keyof typeof colors;

/**
 * Spacing scale in points on native and CSS px on web, on the 4-point grid.
 */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/**
 * Corner radii in points / CSS px; `pill` rounds a control to a capsule.
 */
export const radii = {
  sm: 4,
  md: 8,
  lg: 16,
  pill: 999,
} as const;

/**
 * Type roles, each a scalable base `fontSize` and `lineHeight` in points / CSS px.
 *
 * The sizes are base values, never fixed caps: React Native keeps `allowFontScaling` on and
 * the web uses the rem equivalent, so text follows the reader's system font size (AAP 0.5.8).
 * Only `caption` sits below the 16-point body size, and it is never used for a control label.
 */
export const typography = {
  caption: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 24 },
  label: { fontSize: 16, lineHeight: 24 },
  title: { fontSize: 20, lineHeight: 28 },
  heading: { fontSize: 24, lineHeight: 32 },
  display: { fontSize: 32, lineHeight: 40 },
} as const;

/**
 * Font weights in string form, which React Native and CSS both accept.
 */
export const fontWeights = {
  regular: '400',
  medium: '500',
  bold: '700',
} as const;

/**
 * Minimum size of any touch target, in points / CSS px (AAP 0.5.8: at least 44x44).
 */
export const MIN_TOUCH_TARGET = 44;

/**
 * A foreground painted on a background, with the measured contrast between them.
 */
interface ContrastPair {
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly ratio: number;
}

/**
 * Text contrast records: every pair a primitive paints text with, over the WCAG 2.1
 * relative-luminance formula, floored to two decimals. Each ratio clears AA normal text
 * (4.5:1); `primary` doubles as link text, and `onPrimary` / `onDanger` are text on a filled
 * control. Add a pair here with its computed ratio before a primitive uses it.
 */
export const CONTRAST_PAIRS = [
  { foreground: 'text', background: 'background', ratio: 17.21 },
  // Measured 15.5297: the floored record is 15.52, not the rounded 15.53.
  { foreground: 'text', background: 'surface', ratio: 15.52 },
  { foreground: 'textMuted', background: 'background', ratio: 7.07 },
  { foreground: 'textMuted', background: 'surface', ratio: 6.38 },
  { foreground: 'onPrimary', background: 'primary', ratio: 7.3 },
  { foreground: 'primary', background: 'background', ratio: 7.3 },
  { foreground: 'primary', background: 'surface', ratio: 6.59 },
  { foreground: 'onDanger', background: 'danger', ratio: 6.47 },
  { foreground: 'danger', background: 'background', ratio: 6.47 },
  { foreground: 'danger', background: 'surface', ratio: 5.83 },
  { foreground: 'success', background: 'background', ratio: 7.13 },
  { foreground: 'success', background: 'surface', ratio: 6.43 },
  { foreground: 'warning', background: 'background', ratio: 7.09 },
  { foreground: 'warning', background: 'surface', ratio: 6.39 },
] as const satisfies readonly ContrastPair[];

/**
 * Non-text contrast records for component boundaries and the focus indicator (WCAG 1.4.11,
 * 3:1), so a control's edge and the keyboard focus ring stay distinguishable.
 */
export const NON_TEXT_CONTRAST_PAIRS = [
  { foreground: 'border', background: 'background', ratio: 3.7 },
  { foreground: 'border', background: 'surface', ratio: 3.34 },
  { foreground: 'focusRing', background: 'background', ratio: 6.7 },
  { foreground: 'focusRing', background: 'surface', ratio: 6.04 },
] as const satisfies readonly ContrastPair[];
