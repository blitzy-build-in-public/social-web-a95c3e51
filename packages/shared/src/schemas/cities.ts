/**
 * The cities contract (AAP 0.8.1): the public city and venue lists of AAP 0.5.4, the discovery page
 * of travelers, the launch-city configuration in `config/cities.json` and the per-city seed fixture
 * file `config/fixtures/<cityId>.json` the seed loads (AAP 0.5.2). No field above tier 0 reaches
 * discovery through this module (criterion 5), and the configuration and fixture schemas are
 * `z.strictObject` and reject an unknown key, because a mistyped configuration key has to fail the
 * seed loudly rather than change the pilot's data silently.
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

/**
 * One configured city, as public `GET /cities` returns it; `countryCode` is the ISO 3166-1 alpha-2
 * code and `timezone` the IANA zone the city's local day is computed in (AAP 0.5.6, 0.5.7).
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
 * One partner venue, as `GET /cities/:cityId/venues` and `MeetupDto.venue` return it: exactly the
 * AAP 0.5.4 field list, with the console secret never serialized.
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
 * The body of `GET /cities/:cityId/venues`: active partner venues only. The route requires no
 * proof, so an unverified user can browse, and a proposal elsewhere is `422 venue_not_partner` (AAP
 * 0.5.4).
 */
export const VenuesResponse = z.object({ items: z.array(VenueDto) });
export type VenuesResponse = z.infer<typeof VenuesResponse>;

/**
 * One page of `GET /cities/:cityId/travelers`: 20 travelers with a keyset cursor over proof
 * creation time and id, each a `Tier0Profile`, so no nickname, bio or photo; a caller without a
 * valid proof for the city answers `403 no_valid_proof` (AAP 0.5.1, 0.5.4).
 */
export const TravelersResponse = paginated(Tier0Profile);
export type TravelersResponse = z.infer<typeof TravelersResponse>;

const ALIAS_MAX_BYTES = 32;

/**
 * A city's bounding box: the area the weekly place refresh asks Overpass for lodgings inside.
 * `south < north` and `west < east` are required, because an inverted or zero-height box would
 * leave the city with no lodgings and no error (AAP 0.5.6).
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
 * hashes (AAP 0.5.5). An alias is 1 to `ALIAS_MAX_BYTES` (32) UTF-8 bytes, matched literally: no
 * case folding and no transliteration, and a quoted-printable escape is part of the alias.
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
 * One launch city as `config/cities.json` carries it (AAP 0.5.2, 0.7.3). Both the circuit's integer
 * id and the aliases are configuration rather than code, so the pilot adds or renames a city by
 * editing the JSON and re-running `pnpm circuits:registry`.
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
 * The contents of `config/cities.json`: at least one city, with unique slugs and unique circuit
 * city ids (AAP 0.5.2). A repeated `circuitCityId` would let a proof for one city satisfy another,
 * because the circuit's output is that integer (AAP 0.5.5).
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

/**
 * The fictional phone numbers a fixture row may use, written out in full; the `555-01xx` block is
 * reserved for fiction, so no real business is dialed and only the telephony simulator answers them
 * (AAP 0.5.2, 0.11.2).
 */
export const FIXTURE_PHONE_PATTERN = /^\+1(202|312|415)55501\d{2}$/;

/** Least number of fixtures each city file carries (AAP 0.5.2). */
export const FIXTURE_MIN_COUNTS = { venues: 10, lodgings: 10, places: 30 } as const;

/**
 * The prefix every fixture name carries, so no real business is presented as a partner venue or a
 * lodging (AAP 0.5.2).
 */
export const FixtureName = z.string().startsWith('Fixture');
export type FixtureName = z.infer<typeof FixtureName>;

/**
 * The stable key of one fixture row within its file, which the seed matches an existing row by, so
 * re-seeding updates the same venue, lodging or place (AAP 0.5.2).
 */
export const FixtureKey = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(60);
export type FixtureKey = z.infer<typeof FixtureKey>;

/**
 * The optional fifth element of a fixture price item: the `PriceRecord` fields that qualify an item
 * rather than name or price it (AAP 0.5.2). `alcoholic` counts a drink in the non-alcoholic median
 * only with an explicit false, because an unknown is an exclusion (AAP 0.5.7).
 */
const FixturePriceOptions = z.strictObject({
  alcoholic: z.boolean().optional(),
  perPerson: z.boolean().optional(),
  ticketType: TicketType.optional(),
});
type FixturePriceOptions = z.infer<typeof FixturePriceOptions>;

/**
 * One fixture price item in the compact form the fixture files write it (AAP 0.5.2): the first four
 * elements are the item name, its `ItemCategory`, its price in USD cents and its `PriceSource`, and
 * the seed derives the rest.
 */
const FixturePriceItemBase = z.union([
  z.tuple([z.string().min(1), ItemCategory, UsdCents, PriceSource]),
  z.tuple([z.string().min(1), ItemCategory, UsdCents, PriceSource, FixturePriceOptions]),
]);

type FixturePriceItemValue = [
  name: string,
  category: ItemCategory,
  priceUsdCents: UsdCents,
  source: PriceSource,
  options?: FixturePriceOptions,
];

/**
 * One fixture price item that passed the ticket rule: a `ticket` carries both `perPerson` and
 * `ticketType`, and every other category carries neither (AAP 0.5.6, 0.5.7).
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
 * One seeded partner venue (AAP 0.5.2), the only kind of place a meetup may be held at; the seed
 * sets the city, `isActivePartner` and a random console secret, which is written to the gitignored
 * `.local/fixture-secrets.json`.
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
 * One seeded lodging (AAP 0.5.2); its fictional number is what an automated stay-verification call
 * would dial, so it stays inside {@link FIXTURE_PHONE_PATTERN} (AAP 0.5.6, 0.11.2).
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
 * within 2 km of a partner venue. `website`, `menuUrl` and `phone` are independent, so a place with
 * neither link takes the phone fallback, and `items` carries at least `MIN_PRICED_ITEMS` (5)
 * records (AAP 0.5.6).
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
 * places of one city, each list carrying at least its bound in {@link FIXTURE_MIN_COUNTS} (AAP
 * 0.5.2). The seed loads it only when `APP_ENV` is `test` or `demo`, marks every row `isFixture =
 * true` and refuses the file anywhere else.
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
