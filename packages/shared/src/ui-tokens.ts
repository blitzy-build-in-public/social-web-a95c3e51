/**
 * Design tokens for every Tablemate surface: colour, spacing, layout and component sizes, radii, type roles with
 * the one font family they paint in, the boundary widths and interaction opacity the primitives paint, and the
 * contrast records the primitives are built and checked against.
 *
 * Platform-neutral plain values with no imports, so the native app, the web build and the Vite venue console all
 * read the same numbers. Consumers style from these tokens and never hard-code a colour, a spacing step, a size, a
 * boundary width, a type size or a font family of their own, so a value has exactly one home.
 */
/**
 * Colour tokens: `danger`, `success` and `warning` carry status, and status is never conveyed by colour alone —
 * the check-in screen shows the time left as text, not as a colour change — so each status colour is paired with
 * text, an icon or a pattern.
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
/** Every colour token name, so a call site or a test can constrain a value to the palette. */
export type ColorToken = keyof typeof colors;
/** Spacing scale in points on native and CSS px on web, on the 4-point grid. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;
/** Layout sizes in points on native and CSS px on web: the widest a content column grows, the responsive widths of the rows that wrap, and the geometry of the operator dashboard's rate bars. A wrapping row takes a `*Basis` value as its `flexBasis` and the `*MinWidth` beside it as the width it stops shrinking at, so the row reflows into the next line instead of overflowing a narrow viewport. A bar's `barFillInset` is the gap it keeps inside its own track on every side, so `barHeight - barFillInset * 2` is its drawn thickness. */
export const layout = {
  maxContentWidth: 1200,
  dateFieldBasis: 180,
  dateFieldMinWidth: 160,
  panelBasis: 340,
  panelMinWidth: 280,
  headlineMainBasis: 240,
  headlineAsideBasis: 200,
  barHeight: 12,
  barFillInset: 2,
  barMarkerWidth: 2,
  barMarkerCasing: 4,
} as const;
/** Corner radii in points / CSS px; `pill` rounds a control to a capsule. */
export const radii = {
  sm: 4,
  md: 8,
  lg: 16,
  pill: 999,
} as const;
/** Type roles, each a scalable base `fontSize` and `lineHeight` in points / CSS px. The sizes are base values, never fixed caps: React Native keeps `allowFontScaling` on and the web uses the rem equivalent, so text follows the reader's system font size. Only `caption` sits below the 16-point body size, and it is never used for a control label. */
export const typography = {
  caption: { fontSize: 14, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 24 },
  label: { fontSize: 16, lineHeight: 24 },
  title: { fontSize: 20, lineHeight: 28 },
  heading: { fontSize: 24, lineHeight: 32 },
  display: { fontSize: 32, lineHeight: 40 },
} as const;
/** The one font stack the product paints, written as a CSS `font-family` value. Every face it names is one a reader's device already holds — the platform's own UI face first, then the three named fallbacks, then the generic family — so no surface downloads a webfont. The names stay unquoted: the venue console writes this string straight into a custom property and relies on the browser parsing it as written. */
export const fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
/** Font weights in string form, which React Native and CSS both accept. */
export const fontWeights = {
  regular: '400',
  medium: '500',
  bold: '700',
} as const;
/** Sizes in points on native and CSS px on web that more than one screen paints and that neither the spacing scale nor a layout width describes: the fixed side a control or a figure is drawn at. `avatarSmall`, `avatarMedium` and `avatarLarge` are the three frame sizes a traveler's avatar takes, so one size has one home. The `trend*` values are the lodging trend chart's viewBox units rather than pixels. */
export const componentSizes = {
  avatarSmall: 40,
  avatarMedium: 72,
  avatarLarge: 96,
  readingColumnWidth: 640,
  qrCodeWidth: 288,
  trendUnitWidth: 10,
  trendBarWidth: 8,
  trendHeight: 60,
} as const;
/** Minimum size of any touch target, in points / CSS px: at least 44x44. */
export const MIN_TOUCH_TARGET = 44;
/** Boundary widths in points on native and CSS px on web, so no primitive carries a boundary value of its own. `edge` is a resting boundary, `control` the outline a control paints, which also reserves the band its keyboard focus ring shows, `accent` a status edge wide enough to carry a banner's tone, and `separator` the rule between stacked rows: one CSS pixel on web, one device pixel on native. */
export const borderWidths = { separator: 1, edge: 1, control: 2, accent: 4 } as const;
/**
 * How a control answers the pointer, as an opacity over its own fill, and the factor an unavailable one dims by.
 * The palette holds no darker shade of `primary` or `danger` and records no darker text pair, so a filled control
 * dims instead of taking a second colour: at `pressed` the white label still measures above 5:1 on either fill
 * (onPrimary/primary 5.30:1, onDanger/danger 5.13:1 composited), and `hover` is the lighter step. A control whose
 * own fill is the lightest token steps to `surface` instead of dimming.
 *
 * `disabled` says something else: a control that cannot be activated at all fades to this over its own fill, and
 * its own text is exempt from the text-contrast minimums, because nothing in it is operable content.
 */
export const interactionOpacity = { hover: 0.9, pressed: 0.85, disabled: 0.5 } as const;
/** A foreground painted on a background, with the measured contrast between them. */
interface ContrastPair {
  readonly foreground: ColorToken;
  readonly background: ColorToken;
  readonly ratio: number;
}
/** Text contrast records: every pair a primitive paints text with, over the WCAG 2.1 relative-luminance formula, floored to two decimals. Each ratio clears AA normal text (4.5:1); `primary` doubles as link text, and `onPrimary` / `onDanger` are text on a filled control. Add a pair here with its computed ratio before a primitive uses it. */
export const CONTRAST_PAIRS = [
  { foreground: 'text', background: 'background', ratio: 17.21 },
  // Measured 15.5297: the floored record is 15.52, not the rounded 15.53.
  { foreground: 'text', background: 'surface', ratio: 15.52 },
  { foreground: 'textMuted', background: 'background', ratio: 7.07 },
  { foreground: 'textMuted', background: 'surface', ratio: 6.38 },
  { foreground: 'onPrimary', background: 'primary', ratio: 7.3 },
  // The fill a filled action dims toward while hovered, which its white label keeps 17.21:1 over.
  { foreground: 'onPrimary', background: 'text', ratio: 17.21 },
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
/** Non-text contrast records for component boundaries and the focus indicator (WCAG 1.4.11, 3:1), so a control's edge and the keyboard focus ring stay distinguishable. */
export const NON_TEXT_CONTRAST_PAIRS = [
  { foreground: 'border', background: 'background', ratio: 3.7 },
  { foreground: 'border', background: 'surface', ratio: 3.34 },
  // The hovered boundary of an outlined control: over the page it sits on and over its own fill.
  { foreground: 'primary', background: 'background', ratio: 7.3 },
  { foreground: 'primary', background: 'surface', ratio: 6.59 },
  { foreground: 'focusRing', background: 'background', ratio: 6.7 },
  { foreground: 'focusRing', background: 'surface', ratio: 6.04 },
] as const satisfies readonly ContrastPair[];
