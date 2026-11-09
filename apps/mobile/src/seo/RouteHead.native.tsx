/**
 * The native half of the `RouteHead` platform pair: nothing.
 *
 * The extensionless `./RouteHead` import in `app/_layout.tsx` is what picks this file, the pattern `src/auth/storage`
 * and `src/payments/card-setup` already follow. Both halves are checked in their own right, so this one has to satisfy
 * the pair's signature. A native window has no document head to write: each screen's title already reaches the window
 * through the navigator's own header, so there is no second source for a title to disagree with.
 */

export function RouteHead(): null {
  return null;
}
