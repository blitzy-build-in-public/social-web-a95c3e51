/**
 * The cities contract (AAP 0.8.1): the public city and venue lists of AAP 0.5.4, the discovery page
 * of travelers, the launch-city configuration in `config/cities.json` and the per-city seed fixture
 * file `config/fixtures/<cityId>.json` the seed loads (AAP 0.5.2).
 *
 * `GET /cities` answers {@link CitiesResponse}; `GET /cities/:cityId/venues` answers
 * {@link VenuesResponse} with no proof required; `GET /cities/:cityId/travelers` answers one
 * page of {@link TravelersResponse}, always a `Tier0Profile`. No field above tier 0 reaches
 * discovery through this module (AAP 0.5.4, criterion 5).
 *
 * The response DTOs are `z.object` and drop an unknown key on serialization. The configuration and
 * fixture schemas are `z.strictObject` and reject one, because a mistyped configuration key has to
 * fail the seed loudly rather than change the pilot's data silently. Nothing here reads a file: the
 * seed parses both JSON files with these schemas from `packages/db/seed/load-config.ts`.
 *
 * Client-safe by construction — `zod`, the contract primitives, the domain enums and the profile
 * DTO, with no Node built-in, no DOM global and no top-level side effect — because `apps/mobile`
 * imports these DTOs and the same module loads under Hermes, in a browser and in Node (AAP 0.11.1).
 *
 * @see AAP 0.5.2 for the `City`, `Venue`, `Lodging` and `Place` models and the fixture sets, 0.5.4
 * for the three routes, 0.5.5 for the circuit's city aliases, 0.5.6 for the bbox the lodging
 * ingestion queries and 0.5.7 for the rules the fixture prices feed.
 */
import { z } from 'zod';

import { MIN_PRICED_ITEMS } from '../constants.ts';
import {
  CallLanguage,
  ItemCategory,
  LodgingKind,
  PlaceCategory,
  PriceSource,
  TicketType,
} from '../enums.ts';
import {
  CitySlug,
  CountryCode,
  CurrencyCode,
  LatLng,
  Latitude,
  Longitude,
  Uuid,
  UsdCents,
  paginated,
  utf8ByteLength,
} from './common.ts';
import { Tier0Profile } from './users.ts';

/*
 * Responses (AAP 0.5.4).
 */

/**
 * One configured city, as public `GET /cities` returns it.
 *
 * The slug is the identifier every route's `:cityId` parameter takes. `circuitCityId` is
 * deliberately absent: it is an input of the itinerary circuit and reaches the client only through
 * `GET /zk/config` (AAP 0.5.5). `countryCode` is the ISO 3166-1 alpha-2 code, and `timezone` the
 * IANA zone the city's local day is computed in — calling hours, the 23:00 suggestion cut-off and
 * the end of a claim's stay (AAP 0.5.6, 0.5.7).
 */
export const CityDto = z.object({
  id: CitySlug,
  name: z.string(),
  countryCode: CountryCode,
  timezone: z.string(),
  currency: CurrencyCode,
});
export type CityDto = z.infer<typeof CityDto>;

/** The body of public `GET /cities` (AAP 0.5.4). */
export const CitiesResponse = z.object({ items: z.array(CityDto) });
export type CitiesResponse = z.infer<typeof CitiesResponse>;

/**
 * One partner venue, as `GET /cities/:cityId/venues` and `MeetupDto.venue` return it: exactly
 * the AAP 0.5.4 field list.
 *
 * `Venue.secretLookupHash` and `Venue.secretCiphertext` are not fields here and are never
 * serialized: a console secret is shown once, by its issue route (AAP 0.5.4). `lat` and `lng` are
 * the venue's own place of business — what the client maps it by and what the 150 m check-in
 * geofence is measured from (AAP 0.5.7) — never a user's coordinates.
 */
export const VenueDto = z.object({
  id: Uuid,
  cityId: CitySlug,
  name: z.string(),
  address: z.string(),
  lat: Latitude,
  lng: Longitude,
  isActivePartner: z.boolean(),
});
export type VenueDto = z.infer<typeof VenueDto>;

/**
 * The body of `GET /cities/:cityId/venues`: active partner venues only.
 *
 * The route requires no proof, so an unverified user can browse where a meetup may be held, and
 * `422 venue_not_partner` is what rejects a proposal at any other place (AAP 0.5.4).
 */
export const VenuesResponse = z.object({ items: z.array(VenueDto) });
export type VenuesResponse = z.infer<typeof VenuesResponse>;

/**
 * One page of `GET /cities/:cityId/travelers`: 20 travelers with a keyset cursor over
 * proof creation time and id (AAP 0.5.1, 0.5.4).
 *
 * Every traveler is a `Tier0Profile`, the stranger's view: no nickname, bio or photo.
 *
 * The route answers `403 no_valid_proof` to a caller without a valid proof for that city, so
 * the proof unlocks the list, not the tier.
 */
export const TravelersResponse = paginated(Tier0Profile);
export type TravelersResponse = z.infer<typeof TravelersResponse>;

/*
 * Launch-city configuration, `config/cities.json` (AAP 0.5.2).
 */

/** Longest city alias in bytes: the circuit's anchor and alias bound (AAP 0.5.5). */
const ALIAS_MAX_BYTES = 32;

/**
 * A city's bounding box: the area the weekly place refresh asks OpenStreetMap's Overpass API for
 * lodgings inside (AAP 0.5.6).
 *
 * `south < north` and `west < east` are both required. An inverted or zero-height box matches no
 * element, which would leave the city with no lodgings and no error to explain it, so it fails the
 * configuration instead.
 */
export const Bbox = z
  .strictObject({
    south: Latitude,
    west: Longitude,
    north: Latitude,
    east: Longitude,
  })
  .refine(
    (box) => box.south < box.north && box.west < box.east,
    'bbox requires south < north and west < east',
  );
export type Bbox = z.infer<typeof Bbox>;

/**
 * One byte string as it appears in a decoded booking-confirmation body, which is what the circuit
 * hashes when it proves the email's city is in the registry (AAP 0.5.5).
 *
 * An alias is 1 to `ALIAS_MAX_BYTES` (32) UTF-8 bytes, counted with `utf8ByteLength` rather
 * than a platform encoder, so the count is what the prover hashes and no Node built-in is
 * needed. Bytes are matched literally: no case folding and no transliteration, so `Lisboa`
 * in the email is not the alias `Lisbon`, and a city whose issuer writes it differently
 * lists each byte string it writes. A quoted-printable escape is part of the alias.
 */
export const CityAlias = z.string().superRefine((alias, ctx) => {
  const bytes = utf8ByteLength(alias);
  if (bytes >= 1 && bytes <= ALIAS_MAX_BYTES) {
    return;
  }

  ctx.addIssue({
    code: 'custom',
    message: `A city alias is 1-${ALIAS_MAX_BYTES} UTF-8 bytes, got ${bytes}.`,
  });
});
export type CityAlias = z.infer<typeof CityAlias>;

/**
 * One launch city as `config/cities.json` carries it (AAP 0.5.2, 0.7.3).
 *
 * Both the circuit's integer id and the aliases are configuration rather than code, so the
 * pilot adds or renames a city by editing the JSON and re-running `pnpm circuits:registry`,
 * with no circuit change (AAP 0.5.5). `callLanguage` is the ConversationRelay speech pairing
 * the phone agent opens in; the five launch cities use `pt-PT`, `es-US`, `es-US`, `th-TH` and
 * `id-ID` (AAP 0.5.2). `currency` is the local currency the price pipeline converts from
 * (AAP 0.5.6).
 *
 * The IANA zone name is checked for shape only and never against a runtime `Intl` database: Hermes
 * ships a variable subset of it, so an `Intl` check would pass on one device and fail on another.
 */
export const CityConfig = z.strictObject({
  id: CitySlug,
  circuitCityId: z.number().int().min(1).max(4294967295),
  name: z.string().min(1),
  countryCode: CountryCode,
  timezone: z.string().regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/),
  callLanguage: CallLanguage,
  currency: CurrencyCode,
  centroid: LatLng,
  bbox: Bbox,
  aliases: z
    .array(CityAlias)
    .min(1)
    .superRefine((aliases, ctx) => {
      const seen = new Set<string>();

      aliases.forEach((alias, index) => {
        if (seen.has(alias)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate city alias "${alias}".`,
            path: [index],
          });
        }
        seen.add(alias);
      });
    }),
});
export type CityConfig = z.infer<typeof CityConfig>;

/**
 * The contents of `config/cities.json`: at least one city, with unique slugs and unique
 * circuit city ids (AAP 0.5.2).
 *
 * A repeated slug would let two records claim one city, and a repeated `circuitCityId` would let a
 * proof for one city satisfy another, because the circuit's output is that integer (AAP 0.5.5).
 * Both are rejected here rather than survived by the registry builder.
 */
export const CitiesFile = z
  .strictObject({ cities: z.array(CityConfig).min(1) })
  .superRefine((file, ctx) => {
    const slugs = new Set<string>();
    const circuitIds = new Set<number>();

    file.cities.forEach((city, index) => {
      if (slugs.has(city.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate city id "${city.id}".`,
          path: ['cities', index, 'id'],
        });
      }
      slugs.add(city.id);

      if (circuitIds.has(city.circuitCityId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate circuitCityId ${city.circuitCityId}.`,
          path: ['cities', index, 'circuitCityId'],
        });
      }
      circuitIds.add(city.circuitCityId);
    });
  });
export type CitiesFile = z.infer<typeof CitiesFile>;

/*
 * Per-city seed fixtures, `config/fixtures/<cityId>.json` (AAP 0.5.2).
 */

/**
 * The fictional phone numbers a fixture row may use, written out in full: `+1 202 555 0100`
 * to `+1 202 555 0199`, `+1 312 555 0100` to `+1 312 555 0199` and `+1 415 555 0100` to
 * `+1 415 555 0199`. The `555-01xx` block is reserved for fiction, so no real business is
 * dialed; only the test environment's `CALL_ALLOWLIST` holds these numbers and only the
 * telephony simulator answers them (AAP 0.5.2, 0.11.2).
 */
export const FIXTURE_PHONE_PATTERN = /^\+1(202|312|415)55501\d{2}$/;

/**
 * Least number of fixtures each city file carries (AAP 0.5.2). Over the five launch cities
 * that is 50 partner venues, 50 lodgings and 150 priced places, which is what requirement 10
 * and criterion 9 check.
 */
export const FIXTURE_MIN_COUNTS = { venues: 10, lodgings: 10, places: 30 } as const;

/**
 * The prefix every fixture name carries, so no real business is presented as a partner venue
 * or a lodging (AAP 0.5.2).
 */
export const FixtureName = z.string().startsWith('Fixture');
export type FixtureName = z.infer<typeof FixtureName>;

/**
 * The stable key of one fixture row within its file, which the seed matches an existing row by, so
 * re-seeding updates the same venue, lodging or place instead of adding another (AAP 0.5.2).
 *
 * Lowercase kebab case, at most 60 characters. Uniqueness within each list is enforced by
 * {@link CityFixturesFile}.
 */
export const FixtureKey = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(60);
export type FixtureKey = z.infer<typeof FixtureKey>;

/**
 * The optional fifth element of a fixture price item: the `PriceRecord` fields that qualify an item
 * rather than name or price it (AAP 0.5.2).
 *
 * `alcoholic` is true for a beer or a wine and false for a coffee or a soft drink; the estimate
 * counts a drink in its non-alcoholic median only with an explicit false, because an unknown is
 * an exclusion (AAP 0.5.7). `perPerson` and `ticketType` are set on a `ticket` price only:
 * `perPerson` is true when the price admits one person, and the estimate reads the lowest listed
 * standard per-person ticket (AAP 0.5.6, 0.5.7).
 */
const FixturePriceOptions = z.strictObject({
  alcoholic: z.boolean().optional(),
  perPerson: z.boolean().optional(),
  ticketType: TicketType.optional(),
});
type FixturePriceOptions = z.infer<typeof FixturePriceOptions>;

/**
 * One fixture price item in the compact form the fixture files write it (AAP 0.5.2): a place's
 * priced items are inline arrays of the `PriceRecord` fields the estimate reads, so a fixture
 * file holds one record per line and stays inside the configuration budget (AAP 0.8.1).
 *
 * The first four elements are the item name, its `ItemCategory`, its price in USD cents and
 * the `PriceSource` it came from; the optional fifth carries the qualifiers. The seed derives
 * the rest — `normalizedName`, `priceText`, `currency`, `localAmountMinor`, a
 * `captureBatchId`, a fresh `capturedAt` and `reviewStatus = approved` — and mixes all three
 * sources across a city's places, so the estimate has an `online_menu`, a `phone_quote` and an
 * `operator_entry` record to read.
 */
const FixturePriceItemBase = z.union([
  z.tuple([z.string().min(1), ItemCategory, UsdCents, PriceSource]),
  z.tuple([z.string().min(1), ItemCategory, UsdCents, PriceSource, FixturePriceOptions]),
]);

/** A fixture price item as the ticket rule reads it, with the qualifiers present or absent. */
type FixturePriceItemValue = [
  name: string,
  category: ItemCategory,
  priceUsdCents: UsdCents,
  source: PriceSource,
  options?: FixturePriceOptions,
];

/**
 * One fixture price item that passed the ticket rule: a `ticket` carries both `perPerson` and
 * `ticketType`, and every other category carries neither, so an activity is priced by whole tickets
 * and a menu item is never read as one (AAP 0.5.6, 0.5.7). `alcoholic` is unconstrained by the rule
 * and may accompany any category.
 */
export const FixturePriceItem = FixturePriceItemBase.superRefine(
  (item: FixturePriceItemValue, ctx): void => {
    const options = item[4];
    const ticket = item[1] === 'ticket';
    const qualifiers: [field: 'perPerson' | 'ticketType', set: boolean][] = [
      ['perPerson', options?.perPerson !== undefined],
      ['ticketType', options?.ticketType !== undefined],
    ];

    for (const [field, set] of qualifiers) {
      if (set === ticket) {
        continue;
      }
      const rule = ticket ? 'is required on a ticket price' : 'applies to ticket prices only';
      ctx.addIssue({ code: 'custom', message: `${field} ${rule}.`, path: [field] });
    }
  },
);
export type FixturePriceItem = z.infer<typeof FixturePriceItem>;

/**
 * One seeded partner venue (AAP 0.5.2), the only kind of place a meetup may be held at. The city,
 * `isActivePartner` and the console secret are set by the seed: the secret is random per venue and
 * written to the gitignored `.local/fixture-secrets.json`, never to the repository.
 */
export const VenueFixture = z.strictObject({
  key: FixtureKey,
  name: FixtureName,
  address: z.string().min(1),
  lat: Latitude,
  lng: Longitude,
});
export type VenueFixture = z.infer<typeof VenueFixture>;

/**
 * One seeded lodging (AAP 0.5.2). Its fictional number is what an automated stay-verification call
 * would dial, so the number stays inside {@link FIXTURE_PHONE_PATTERN} and the task is answered by
 * the telephony simulator or refused by the allowlist (AAP 0.5.6, 0.11.2).
 */
export const LodgingFixture = z.strictObject({
  key: FixtureKey,
  name: FixtureName,
  kind: LodgingKind,
  address: z.string().min(1),
  phone: z.string().regex(FIXTURE_PHONE_PATTERN),
  lat: Latitude,
  lng: Longitude,
});
export type LodgingFixture = z.infer<typeof LodgingFixture>;

/**
 * One seeded place with its priced items (AAP 0.5.2): a restaurant, a café, a bar or an activity
 * within 2 km of a partner venue, which suggestions rank and the price pipeline refreshes.
 *
 * `website`, `menuUrl` and `phone` are independent: a place with neither link takes the phone
 * fallback and needs a fixture number, while a place with a link keeps the seed's local
 * fixture host (AAP 0.5.6). `openingHours` is raw OpenStreetMap syntax, evaluated by the
 * `opening_hours` package where it is read rather than here, because this module also runs on
 * the client. `items` carries at least `MIN_PRICED_ITEMS` (5) records, the floor below which a
 * real place would be queued for a price call (AAP 0.5.6).
 */
export const PlaceFixture = z.strictObject({
  key: FixtureKey,
  name: FixtureName,
  category: PlaceCategory,
  lat: Latitude,
  lng: Longitude,
  phone: z.string().regex(FIXTURE_PHONE_PATTERN).optional(),
  website: z.url().optional(),
  menuUrl: z.url().optional(),
  openingHours: z.string().min(1),
  items: z.array(FixturePriceItem).min(MIN_PRICED_ITEMS),
});
export type PlaceFixture = z.infer<typeof PlaceFixture>;

/**
 * The contents of `config/fixtures/<cityId>.json`: the partner venues, the lodgings and the priced
 * places of one city, each list carrying at least its bound in {@link FIXTURE_MIN_COUNTS}
 * (AAP 0.5.2).
 *
 * The seed loads a fixture file only when `APP_ENV` is `test` or `demo`, marks every row
 * `isFixture = true` and refuses the file in any other environment, where `fixtures-guard.ts` also
 * filters fixture rows out of every read. `cityId` must equal the file's own name, which the seed
 * checks. Keys are unique within the list that holds them: a venue, a lodging and a place are
 * separate records and may share a name.
 */
export const CityFixturesFile = z
  .strictObject({
    cityId: CitySlug,
    venues: z.array(VenueFixture).min(FIXTURE_MIN_COUNTS.venues),
    lodgings: z.array(LodgingFixture).min(FIXTURE_MIN_COUNTS.lodgings),
    places: z.array(PlaceFixture).min(FIXTURE_MIN_COUNTS.places),
  })
  .superRefine((file, ctx) => {
    const lists: [list: 'venues' | 'lodgings' | 'places', rows: readonly { key: string }[]][] = [
      ['venues', file.venues],
      ['lodgings', file.lodgings],
      ['places', file.places],
    ];

    for (const [list, rows] of lists) {
      const seen = new Set<string>();

      rows.forEach((row, index) => {
        if (seen.has(row.key)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate ${list} key "${row.key}".`,
            path: [list, index, 'key'],
          });
        }
        seen.add(row.key);
      });
    }
  });
export type CityFixturesFile = z.infer<typeof CityFixturesFile>;
