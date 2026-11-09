/**
 * Authentication contract (AAP 0.5.4, AAP 0.8.1): the body and the response of each of the four
 * `/auth` routes — the magic-link request, the verify exchange, the refresh rotation and the logout
 * that takes no body — plus the access-token claims the API's auth plugin reads off a verified JWT.
 * Sign-in is pseudonymous by construction: an address is used only to mail a 15-minute single-use
 * link, and on the server it is stored as ciphertext plus an HMAC lookup hash and never returned by
 * any route (AAP 0.5.2), so no payload here carries an email, a real name, a photo or a phone
 * number.
 */
import { z } from 'zod';

import { UserRole } from '../enums.ts';
import { Uuid } from './common.ts';
import { MeDto } from './me.ts';

/**
 * The body of public `POST /auth/magic-link`, the only sign-in path (AAP 0.5.4). The route answers
 * `202` with no body whatever the account state of the address, so it cannot be used to enumerate
 * accounts, and the address itself is never stored in the clear but as ciphertext with an HMAC
 * lookup hash (AAP 0.5.2).
 */
export const MagicLinkRequest = z.strictObject({ email: z.email().max(254) });
export type MagicLinkRequest = z.infer<typeof MagicLinkRequest>;

/**
 * The body of public `POST /auth/verify`: the single-use token the magic-link mail carried (AAP
 * 0.5.4). Deliberately no token-format pattern. An unknown, expired or already-used token has to
 * reach the handler to be answered `401 token_invalid`, whereas a pattern would reject it earlier
 * as a `400` and so narrow the shape of the tokens the server ever issued.
 */
export const VerifyRequest = z.strictObject({ token: z.string().min(1).max(512) });
export type VerifyRequest = z.infer<typeof VerifyRequest>;

/**
 * The response of `POST /auth/verify`: a fresh token pair and the caller's own account (AAP 0.5.4).
 * The access token is a 15-minute HS256 JWT carrying the {@link AccessTokenClaims} of `sub`, `role`
 * and `sid`, and the refresh token rotates on every use (AAP 0.3.3, AAP 0.11.2).
 */
export const VerifyResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: MeDto,
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

/**
 * The body of public `POST /auth/refresh` (AAP 0.5.4). A token presented after it has been rotated
 * away is therefore evidence of reuse, and the route revokes the whole session rather than issuing
 * another pair (AAP 0.11.2).
 */
export const RefreshRequest = z.strictObject({ refreshToken: z.string().min(1).max(512) });
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/**
 * The response of `POST /auth/refresh`: the rotated pair, with a newly issued access token (AAP
 * 0.5.4).
 */
export const RefreshResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type RefreshResponse = z.infer<typeof RefreshResponse>;

/**
 * The claims of a verified access token, which `apps/api/src/plugins/auth.ts` parses to
 * authenticate a request and to decide what the caller may reach (AAP 0.3.3). Strip mode rather
 * than strict, because `jose` adds `iat` and `exp` to the payload it verifies, so the parse accepts
 * an issued token while reading only the three claims the API acts on; this schema is not a second
 * expiry check, since `jose` establishes the HS256 signature and the 15-minute lifetime first.
 */
export const AccessTokenClaims = z.object({ sub: Uuid, role: UserRole, sid: Uuid });
export type AccessTokenClaims = z.infer<typeof AccessTokenClaims>;
