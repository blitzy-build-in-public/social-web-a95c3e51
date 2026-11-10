/**
 * The SMTP mailer the notification job delivers magic links and web notifications through (AAP 0.3.3, 0.3.4).
 *
 * AAP 0.3.3 names Nodemailer 10.3.1 over SMTP as the delivery path, with Mailpit v1.33.0 capturing mail locally so
 * end-to-end tests can read a magic link back out of it, and AAP 0.3.4 makes email the web fallback where Expo push cannot
 * reach. The mailer stays deliberately thin: its two settings arrive as arguments, so nothing here reads `process.env`
 * (AAP 0.6.2 keeps `src/env/*` the only reader), it logs nothing, and it hands back an interface a test can implement.
 *
 * Messages are plain text: no HTML, no attachments, no tracking headers. A rejected send throws {@link MailDeliveryError} so
 * the BullMQ job retries (AAP 0.11.1), and that error carries Nodemailer's error code and SMTP response code and nothing
 * else, because an SMTP response or the command in flight echoes the recipient address.
 */

import nodemailer from 'nodemailer';

/** The two schemes a connection URL may use (AAP 0.3.3): `smtps:` adds TLS on connect. */
const SMTP_PROTOCOLS = new Set(['smtp:', 'smtps:']);
/** The rejection every SMTP setting fault gets, so no failure can quote the URL or its credentials. */
const SMTP_URL_INVALID = 'SMTP_URL must use smtp: or smtps:';
/** How long one send may spend opening the connection, the same ten seconds AAP 0.11.1 bounds an external call with, so a notification job fails into its retry instead of hanging on a dark host. */
const SMTP_CONNECTION_TIMEOUT_MS = 10_000;
/** How long the server may take to greet, which an unreachable host never does. */
const SMTP_GREETING_TIMEOUT_MS = 10_000;
/** How long the socket may stay idle mid-session before the send is abandoned. */
const SMTP_SOCKET_TIMEOUT_MS = 20_000;
/** One message to deliver: plain text only (AAP 0.3.3, AAP 0.3.4). `to` is a single address the job has already resolved, `subject` and `text` are the rendered template of `notify/templates.ts`, and `from` is not a field because the mailer holds it. */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** What the job and the tests consume (AAP 0.3.3): the minimum a capturing implementation has to provide, so a test can record messages instead of reaching a server. `close` is optional because a capture holds no connection to release. */
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
  close?(): Promise<void>;
}

/** The two settings the mailer needs, taken from validated configuration rather than read here: `smtpUrl` is `env.SMTP_URL` and `from` is `env.EMAIL_FROM` of the `workers` schema (AAP 0.6.2). The URL may carry credentials, so it is never logged or echoed in an error. */
export interface MailerConfig {
  smtpUrl: string;
  from: string;
}

/** A send that SMTP refused or never completed (AAP 0.3.3, AAP 0.11.1). It keeps Nodemailer's `code` (`ECONNECTION`, `ETIMEDOUT`, `EENVELOPE`, `EAUTH`, …) and the numeric SMTP reply code, which is what an operator needs to tell a credential failure from a refused recipient, and drops the rest of the caught error: `message`, `response` and `command` quote the recipient address or the server's reply, and AAP 0.11.1 redacts email addresses from logs. */
export class MailDeliveryError extends Error {
  /** Nodemailer's error code, or `null` when the failure carried none. */
  readonly code: string | null;
  /** The numeric SMTP reply code a rejection carried, or `null` when there was no reply. */
  readonly responseCode: number | null;
  constructor(code: string | null, responseCode: number | null) {
    super(`smtp_send_failed code=${code ?? 'none'} responseCode=${responseCode ?? 'none'}`);
    this.name = 'MailDeliveryError';
    this.code = code;
    this.responseCode = responseCode;
  }
}

/** Builds the mailer for the given SMTP endpoint and sender (AAP 0.3.3, AAP 0.3.4). idempotent. only, never the URL, which may hold credentials. */
export function createMailer(config: MailerConfig): Mailer {
  assertSmtpUrl(config.smtpUrl);
  // `createTransport`'s second argument is message defaults, not transport options, so the three timeouts belong in the options object beside `url` and `from` becomes the default sender of every message. Nodemailer merges options given beside `url`, and the URL's own query values win on a conflict with them.
  const transport = nodemailer.createTransport(
    {
      url: config.smtpUrl,
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    },
    { from: config.from },
  );
  let closed = false;
  return {
    async send(msg: MailMessage): Promise<void> {
      try {
        // The result is dropped on purpose: the message id, the envelope and the accepted recipients are all things this module must not log (AAP 0.11.1).
        await transport.sendMail({ to: msg.to, subject: msg.subject, text: msg.text });
      } catch (error) {
        throw mailDeliveryError(error);
      }
    },
    // The transport's own `close` is synchronous, so this returns a settled promise instead of being an `async` method that awaits nothing, which the type-checked lint rules reject.
    close(): Promise<void> {
      if (!closed) {
        closed = true;
        transport.close();
      }
      return Promise.resolve();
    },
  };
}

/** Rejects a connection URL Nodemailer cannot use (AAP 0.3.3). An unparseable URL fails the same check with the same message, because WHATWG `URL`'s own `TypeError` quotes the input it was given, credentials included. */
function assertSmtpUrl(smtpUrl: string): void {
  try {
    if (SMTP_PROTOCOLS.has(new URL(smtpUrl).protocol)) {
      return;
    }
  } catch {
    // Falls through to the one rejection below: an unparseable URL is not a usable SMTP URL.
  }
  throw new Error(SMTP_URL_INVALID);
}

/** Maps a rejected send onto {@link MailDeliveryError} (AAP 0.11.1). The caught value is `unknown`, so its shape is read property by property instead of trusted, and only `code` and `responseCode` are carried over. */
function mailDeliveryError(error: unknown): MailDeliveryError {
  const code = errorProperty(error, 'code');
  const responseCode = errorProperty(error, 'responseCode');
  return new MailDeliveryError(
    typeof code === 'string' ? code : null,
    typeof responseCode === 'number' && Number.isFinite(responseCode) ? responseCode : null,
  );
}

/** Reads one property off a caught value, or `undefined` when it is not an object that could hold one. */
function errorProperty(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}
