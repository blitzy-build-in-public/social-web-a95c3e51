/**
 * The relay's own unit: what may be taken from a ConversationRelay `error` frame (AAP 0.5.2,
 * 0.11.1, 0.12.2).
 *
 * That frame is the one place on the relay socket where a provider hands this API its own free-form
 * text, and Twilio documents error 64111 as carrying the application's own unspoken tokens in the
 * same `description` field: on a `lodging_stay_verification` call those tokens are the disclosure
 * question naming the guest and the stay dates. Key-based redaction cannot rewrite a name embedded
 * inside another field's string, so the relay keeps the provider's numeric code and nothing else,
 * and `relayErrorCode` is the whole of that extraction.
 *
 * These rows are its bound: Twilio's documented payloads yield their own code alone, a description
 * naming none yields nothing, and no amount of free text around it reaches the result.
 *
 * The rest of the socket — the utterance bound on the same connection — is driven in
 * `voice-dialogue.test.ts`, whose fakes run one whole call.
 */

import { describe, expect, it } from 'vitest';

import { relayErrorCode } from '../../src/modules/voice-agent/relay-ws.ts';

/** The one booking name in this file: the fictional guest the AAP 0.5.2 fixture rules require. */
const BOOKING_NAME = 'Fixture Guest';

/** The two stay dates a lodging call's question names (AAP 0.5.6). */
const STAY_FROM = '10 November 2026';
const STAY_TO = '14 November 2026';

/**
 * Twilio's documented 64111 payload, in the shape its failover guidance writes it: the description
 * of a message whose tokens could not be converted to speech, carrying the tokens themselves — for
 * this API, the question it was about to ask a lodging.
 */
const DOCUMENTED_DESCRIPTION = `Error converting tokens to speech, code: 64111, error: , tokens: ${BOOKING_NAME} stays ${STAY_FROM} to ${STAY_TO}`;

/** One description, and the code alone it yields; `null` when it names none (AAP 0.11.1). */
const CODE_CASES: readonly (readonly [string, string, string | null])[] = [
  ['the documented 64111 payload', DOCUMENTED_DESCRIPTION, '64111'],
  [
    'a 64107 payload',
    'Error converting tokens to speech, code: 64107, error: message type is not valid',
    '64107',
  ],
  ['a description that names no code', 'Session closed by the provider.', null],
  [
    'a run of digits longer than a code',
    'Error converting tokens to speech, code: 641111, error: ',
    null,
  ],
];

describe('relayErrorCode', () => {
  it.each(CODE_CASES)('takes the code alone from %s', (_name, description, expected) => {
    expect(relayErrorCode(description)).toBe(expected);
  });

  it('returns a five-digit code or nothing at all, whatever the description carries', () => {
    for (const [, description] of CODE_CASES) {
      const code = relayErrorCode(description);
      expect(code === null || /^\d{5}$/.test(code)).toBe(true);
    }
  });

  it('keeps none of the free text around the code', () => {
    // The payload Twilio documents for 64111 is the one that carries personal data: on a stay-
    // verification call the tokens that could not be spoken name the guest and the two dates.
    const code = relayErrorCode(DOCUMENTED_DESCRIPTION);

    expect(code).toBe('64111');
    for (const freeText of [
      'Fixture',
      'Guest',
      BOOKING_NAME,
      STAY_FROM,
      STAY_TO,
      'tokens',
      'Error converting tokens to speech',
    ]) {
      expect(code).not.toContain(freeText);
    }
  });
});
