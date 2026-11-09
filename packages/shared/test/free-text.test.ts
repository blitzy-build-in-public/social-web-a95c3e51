/**
 * The free-text guard and the request fields that carry it (AAP 0.11.2 input validation on every route and frame).
 * A NUL byte passes a bare `z.string()` and PostgreSQL's UTF-8 `text` refuses it with SQLSTATE 22021, so the route
 * that validated it answers `500` where the boundary owes the caller `400 invalid_field`. Every case is a row of a
 * table, and each composed row is read twice over the same text: once with the byte in it, once with a newline where
 * the byte stood.
 */
import { describe, expect, it } from 'vitest';

import {
  AdminCallTasksQuery,
  ChatSend,
  CreateVenueRequest,
  DisputeRequest,
  FreeText,
  LodgingClaimRequest,
  PriceItemInput,
  ProfileUpdate,
  PushTokenRequest,
  ReportRequest,
} from '../src/index.ts';

/** The byte that reaches the columns if the guard lets it through, between two letters. */
const NUL_BETWEEN = 'a\u0000b';
/** The same text with a newline in the byte's place, which every field below admits. */
const NEWLINE_BETWEEN = 'a\nb';

interface GuardCase {
  readonly name: string;
  readonly value: string;
  readonly accepted: boolean;
}

/** One row per character class the guard judges: the four controls it refuses, and the text, tab, line break and non-ASCII it lets through. */
const GUARD_CASES: readonly GuardCase[] = [
  {
    name: 'U+0000, the one code point PostgreSQL cannot store',
    value: NUL_BETWEEN,
    accepted: false,
  },
  { name: 'U+0001', value: 'a\u0001b', accepted: false },
  { name: 'U+001F, the last C0 control', value: 'a\u001fb', accepted: false },
  { name: 'U+007F, DEL', value: 'a\u007fb', accepted: false },
  { name: 'plain text', value: 'a table for two', accepted: true },
  { name: 'a tab', value: 'a\tb', accepted: true },
  { name: 'a newline', value: NEWLINE_BETWEEN, accepted: true },
  { name: 'a carriage return', value: 'a\rb', accepted: true },
  { name: 'non-ASCII text', value: 'Bacalhau à Brás, 東京都', accepted: true },
];

interface TextFieldCase {
  readonly name: string;
  /** The smallest body that carries the field under test, with the field's own value supplied by the case. */
  readonly body: (value: string) => Record<string, unknown>;
  /** The composed request schema, reduced to whether it accepts one body. */
  readonly accepts: (body: unknown) => boolean;
}

/** The id every body below needs wherever the schema requires a meetup, a lodging or a venue's city. */
const ID = '0190a5b2-7c3d-7e4f-8a1b-2c3d4e5f6a7b';

/** One operator-entered price at a place, which is the body a price row below swaps one text field of; `main` with both ticket fields null is what the ticket rule admits. */
const OPERATOR_PRICE = {
  name: 'Bacalhau à Brás',
  category: 'main',
  priceText: '$12.50',
  currency: 'USD',
  alcoholic: null,
  perPerson: null,
  ticketType: null,
  localAmountMinor: 1250,
};

/** One row per composed request schema that carries a free-text field: the schema's own refusal, not the guard's, is what the route answers `400 invalid_field` from. */
const TEXT_FIELD_CASES: readonly TextFieldCase[] = [
  {
    name: 'ProfileUpdate.nickname',
    body: (value) => ({ nickname: value }),
    accepts: (body) => ProfileUpdate.safeParse(body).success,
  },
  {
    name: 'ProfileUpdate.bio',
    body: (value) => ({ bio: value }),
    accepts: (body) => ProfileUpdate.safeParse(body).success,
  },
  {
    name: 'ProfileUpdate.homeCity',
    body: (value) => ({ homeCity: value }),
    accepts: (body) => ProfileUpdate.safeParse(body).success,
  },
  {
    name: 'PushTokenRequest.token',
    body: (value) => ({ token: value, platform: 'ios' }),
    accepts: (body) => PushTokenRequest.safeParse(body).success,
  },
  {
    name: 'ReportRequest.reason',
    body: (value) => ({ reason: value }),
    accepts: (body) => ReportRequest.safeParse(body).success,
  },
  {
    name: 'DisputeRequest.reason',
    body: (value) => ({ reason: value }),
    accepts: (body) => DisputeRequest.safeParse(body).success,
  },
  {
    name: 'ChatSend.body',
    body: (value) => ({ type: 'chat_send', meetupId: ID, body: value }),
    accepts: (body) => ChatSend.safeParse(body).success,
  },
  {
    name: 'LodgingClaimRequest.bookingName',
    body: (value) => ({
      lodgingId: ID,
      stayFrom: '2026-11-10',
      stayTo: '2026-11-20',
      bookingName: value,
    }),
    accepts: (body) => LodgingClaimRequest.safeParse(body).success,
  },
  {
    name: 'AdminCallTasksQuery.q',
    body: (value) => ({ q: value }),
    accepts: (body) => AdminCallTasksQuery.safeParse(body).success,
  },
  {
    name: 'CreateVenueRequest.name',
    body: (value) => ({
      cityId: 'lisbon',
      name: value,
      address: '3 Fixture Street',
      lat: 38.71,
      lng: -9.14,
    }),
    accepts: (body) => CreateVenueRequest.safeParse(body).success,
  },
  {
    name: 'PriceItemInput.name',
    body: (value) => ({ ...OPERATOR_PRICE, name: value }),
    accepts: (body) => PriceItemInput.safeParse(body).success,
  },
  {
    name: 'PriceItemInput.priceText',
    body: (value) => ({ ...OPERATOR_PRICE, priceText: value }),
    accepts: (body) => PriceItemInput.safeParse(body).success,
  },
];

describe('FreeText', () => {
  it.each(GUARD_CASES)('answers $accepted for $name', (row) => {
    expect(FreeText.safeParse(row.value).success).toBe(row.accepted);
  });
});

describe('free-text request fields', () => {
  it.each(TEXT_FIELD_CASES)('refuses a NUL byte in $name', (row) => {
    expect(row.accepts(row.body(NUL_BETWEEN))).toBe(false);
  });

  it.each(TEXT_FIELD_CASES)('accepts a newline in $name', (row) => {
    expect(row.accepts(row.body(NEWLINE_BETWEEN))).toBe(true);
  });
});
