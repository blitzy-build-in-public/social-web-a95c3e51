/**
 * Authentication contract (AAP 0.5.4, AAP 0.8.1): the body and the response of each of the four
 * `/auth` routes — the magic-link request, the verify exchange that creates the account on first
 * use, the refresh rotation, and the logout that takes no body — plus the access-token claims the
 * API's auth plugin reads off a verified JWT.
 *
 * Sign-in is pseudonymous by construction. An address is used only to mail a 15-minute single-use
 * link, and on the server it is stored as ciphertext plus an HMAC lookup hash and never returned
 * by any route (AAP 0.5.2), so no payload here carries an email, a real name, a photo or a phone
 * number. `VerifyResponse.user` is the caller's own {@link MeDto} — the one profile shape that
 * carries tier-3 fields, because the caller is the owner (AAP 0.5.4).
 *
 * Request bodies are `z.strictObject` and reject an unknown key, which the routes answer with
 * `400 invalid_field`; responses are strip-mode `z.object`, so a key a schema does not declare
 * never leaves the server. Client-safe: `zod` and three sibling modules — no Node built-in, no DOM
 * global, no top-level side effect — because the same module loads under Hermes, in a browser and
 * in Node (AAP 0.11.1).
 *
 * @see AAP 0.3.3 for the bearer token, its 15-minute lifetime and the `sub`, `role` and `sid`
 * claims, AAP 0.11.2 for token rotation with reuse detection, and AAP 0.5.4 for the contract and
 * errors of each route these schemas belong to.
 */
import { z } from 'zod';

import { UserRole } from '../enums.ts';
import { Uuid } from './common.ts';
import { MeDto } from './me.ts';

/**
 * The body of public `POST /auth/magic-link`, the only sign-in path (AAP 0.5.4).
 *
 * The route answers `202` with no body whatever the account state of the address, so it cannot be
 * used to enumerate accounts, and it maps any parse failure of this body to `400 invalid_email`
 * rather than echoing which part failed. One address may request at most 5 links an hour, after
 * which the route answers `429 rate_limited`. The address itself is never stored in the clear: it
 * is kept as ciphertext with an HMAC lookup hash, which is what lets a first sign-in create the
 * account without a plaintext address anywhere (AAP 0.5.2). 254 characters is the SMTP limit on a
 * full address.
 */
export const MagicLinkRequest = z.strictObject({ email: z.email().max(254) });
export type MagicLinkRequest = z.infer<typeof MagicLinkRequest>;

/**
 * The body of public `POST /auth/verify`: the single-use token the magic-link mail carried
 * (AAP 0.5.4).
 *
 * Deliberately no token-format pattern. An unknown, expired or already-used token has to reach the
 * handler to be answered `401 token_invalid`, whereas a pattern would reject it earlier as a `400`
 * and so narrow the shape of the tokens the server ever issued. A first successful verify creates
 * the account; the token is single use and expires 15 minutes after it was issued (AAP 0.5.2).
 */
export const VerifyRequest = z.strictObject({ token: z.string().min(1).max(512) });
export type VerifyRequest = z.infer<typeof VerifyRequest>;

/**
 * The response of `POST /auth/verify`: a fresh token pair and the caller's own account
 * (AAP 0.5.4).
 *
 * The access token is a 15-minute HS256 JWT carrying the {@link AccessTokenClaims} of `sub`,
 * `role` and `sid`, and the refresh token rotates on every use (AAP 0.3.3, AAP 0.11.2). `user` is
 * the same payload `GET /me` returns, so the client routes straight from sign-in — to the age gate
 * while `consents` is unset, otherwise to the tabs (AAP 0.5.8).
 */
export const VerifyResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: MeDto,
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

/**
 * The body of public `POST /auth/refresh` (AAP 0.5.4).
 *
 * Refresh tokens rotate: each successful call returns a new pair, and the presented token stops
 * being valid. A token presented after it has been rotated away is therefore evidence of reuse,
 * and the route revokes the whole session rather than issuing another pair (AAP 0.11.2).
 *
 * `POST /auth/logout` takes no body at all: it revokes the session the caller's access token names
 * in its `sid`, which no field here would improve.
 */
export const RefreshRequest = z.strictObject({ refreshToken: z.string().min(1).max(512) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/**
 * The response of `POST /auth/refresh`: the rotated pair, with a newly issued access token
 * (AAP 0.5.4). No `user` — the caller is already signed in, and its own account is a `GET /me`
 * away. The token rotation rule is in {@link RefreshRequest}.
 */
export const RefreshResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type RefreshResponse = z.infer<typeof RefreshResponse>;

/**
 * The claims of a verified access token, which `apps/api/src/plugins/auth.ts` parses to
 * authenticate a request and to decide what the caller may reach (AAP 0.3.3).
 *
 * Strip mode rather than strict: `jose` adds `iat` and `exp` to the payload it verifies, so the
 * parse has to accept an issued token while reading only the three claims the API acts on. `sub`
 * is the account id every ownership check compares against, `role` admits an `operator` to the
 * `/admin` routes, and `sid` names the session that logout and refresh revoke.
 *
 * Nothing here is trusted on its own: `jose` establishes the HS256 signature and the 15-minute
 * lifetime before this parse, so this schema is not a second expiry check.
 */
export const AccessTokenClaims = z.object({ sub: Uuid, role: UserRole, sid: Uuid });
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;
