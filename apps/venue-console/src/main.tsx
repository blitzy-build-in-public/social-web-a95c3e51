/**
 * The partner console's entry point: the declaration that keeps the console eval-free for the policy that serves it,
 * its stylesheet, the shared design tokens published as CSS custom properties on the document root, and the mount of
 * `App` (AAP 0.6.2, 0.5.8).
 *
 * `styles.css` paints every colour, length, type size, font stack, boundary width and pointer opacity through the
 * `--tm-*` properties written here, so those values live in one place (`packages/shared/src/ui-tokens.ts`) and neither
 * the stylesheet nor a screen holds a literal of its own. The write goes through CSSOM rather than a `<style>` block,
 * which a `style-src 'self'` policy admits without `'unsafe-inline'` (AAP 0.3.2).
 */
import './styles.css';
// Ahead of `@tablemate/shared`, whose schemas are built at import and would otherwise probe `eval`
// through a policy that forbids it; see the module itself.
import './zod-jitless.ts';

import {
  borderWidths,
  colors,
  componentSizes,
  fontFamily,
  fontWeights,
  interactionOpacity,
  MIN_TOUCH_TARGET,
  radii,
  spacing,
  typography,
} from '@tablemate/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';

/** A token key in the spelling a custom property takes (`textMuted` becomes `text-muted`), applied to every
 * group rather than to `colors` alone, so a key added to any of them needs no second thought here. */
function toKebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
const rootStyle = document.documentElement.style;
for (const [key, value] of Object.entries(colors)) {
  rootStyle.setProperty(`--tm-color-${toKebab(key)}`, value);
}
for (const [key, value] of Object.entries(spacing)) {
  rootStyle.setProperty(`--tm-space-${toKebab(key)}`, `${value / 16}rem`);
}
for (const [key, value] of Object.entries(radii)) {
  rootStyle.setProperty(`--tm-radius-${toKebab(key)}`, `${value / 16}rem`);
}
for (const [key, { fontSize, lineHeight }] of Object.entries(typography)) {
  rootStyle.setProperty(`--tm-font-size-${toKebab(key)}`, `${fontSize / 16}rem`);
  rootStyle.setProperty(`--tm-line-height-${toKebab(key)}`, `${lineHeight / 16}rem`);
}
for (const [key, value] of Object.entries(fontWeights)) {
  rootStyle.setProperty(`--tm-font-weight-${toKebab(key)}`, value);
}
// The product's one font stack: a single value rather than a group, so it is published on its own
// beside the weights it paints in.
rootStyle.setProperty('--tm-font-family', fontFamily);
// Boundary widths in px rather than rem: a hairline or a focus band is a device-independent pixel
// in the tokens, not a length that grows with the reader's text size.
for (const [key, value] of Object.entries(borderWidths)) {
  rootStyle.setProperty(`--tm-border-${toKebab(key)}`, `${value}px`);
}
// Unitless, because each is a factor over a control's own fill rather than a length.
for (const [key, value] of Object.entries(interactionOpacity)) {
  rootStyle.setProperty(`--tm-opacity-${toKebab(key)}`, `${value}`);
}
rootStyle.setProperty('--tm-touch-target', `${MIN_TOUCH_TARGET / 16}rem`);
// The console's own two lengths, from the shared component sizes: the readable measure of its single column and the
// square its check-in code resolves to, in rem like the scale lengths above so both follow the reader's text size.
rootStyle.setProperty(
  '--tm-layout-reading-column-width',
  `${componentSizes.readingColumnWidth / 16}rem`,
);
rootStyle.setProperty('--tm-size-qr-code', `${componentSizes.qrCodeWidth / 16}rem`);
const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('Tablemate console: #root element missing from index.html');
}
createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
