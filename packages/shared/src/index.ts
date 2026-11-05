/**
 * Single source of every route, WebSocket frame and configuration schema, error codes, enums,
 * constants, framing copy, tier allowlists, UI tokens and the interest vocabulary
 * (AAP 0.3.2, 0.5.1, 0.5.4).
 *
 * Every workspace resolves `@tablemate/shared` here, so the re-exports below are the whole
 * public surface: a contract shape lives in its own module and is never redeclared, and this
 * barrel holds re-exports only, which keeps it free of logic, side effects and Node globals.
 */

export * from './errors.ts';
export * from './enums.ts';
export * from './constants.ts';
export * from './interests.ts';
export * from './tiers.ts';
export * from './copy.ts';
export * from './ui-tokens.ts';

export * from './schemas/common.ts';
export * from './schemas/auth.ts';
export * from './schemas/me.ts';
export * from './schemas/proofs.ts';
export * from './schemas/cities.ts';
export * from './schemas/users.ts';
export * from './schemas/meetups.ts';
export * from './schemas/messaging.ts';
export * from './schemas/suggestions.ts';
export * from './schemas/lodgings.ts';
export * from './schemas/consoles.ts';
export * from './schemas/admin.ts';
export * from './schemas/webhooks.ts';
export * from './schemas/events.ts';
export * from './schemas/ws.ts';
