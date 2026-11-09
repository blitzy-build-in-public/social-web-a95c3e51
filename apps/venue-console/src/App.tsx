/**
 * The partner console's shell: which of its two screens a URL opens, and the gate holding the operator-issued secret in
 * front of both (AAP 0.5.1, 0.5.4, 0.8.1).
 *
 * The console holds no secret of its own (AAP 0.3.2): the operator types one in here, `api.ts` keeps it in `sessionStorage`
 * for the life of the tab, and it reaches only the two console routes' secret header — never a message, a log line or a
 * URL; a route answering `401`, with the secret already dropped by `api.ts`, returns this page to its secret form. There
 * is no router — `nginx` answers `index.html` for both paths (AAP 0.6.2) — so the path is read from `window.location`;
 * exactly one `<h1>` is on every page (AAP 0.5.8).
 */
import { useCallback, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';

import { clearSecret, readSecret, saveSecret } from './api.ts';
import type { ConsoleKind } from './api.ts';
import { LodgingStats } from './routes/LodgingStats.tsx';
import { VenueCode } from './routes/VenueCode.tsx';

/** The two screens' paths (AAP 0.3.2, 0.5.8), and the site name every page carries -- the header
 * renders it as the page's only `<h1>` at most. */
const VENUE_PATH = '/venue';
const LODGING_PATH = '/lodging';
const SITE_NAME = 'Tablemate partner console';

/** Trailing slashes stripped from a path, so `/venue/` opens the venue console. */
const TRAILING_SLASHES = /\/+$/;

/** The help text beside the secret field, which that field's `aria-describedby` points at. */
const HELP_TEXT =
  'Enter the secret Tablemate operations gave you. It stays in this browser tab and is cleared when the tab closes.';

/** The messages this screen shows for an empty submission and for a secret the API rejected. */
const EMPTY_SECRET_MESSAGE = 'Enter the secret.';
const REJECTED_MESSAGE = 'That secret was not recognised. Ask Tablemate operations for a new one.';

/**
 * One console's secret form: the label it shows and the ids its field and help text answer to
 * (AAP 0.5.4). The ids and `data-testid` values are relied on by `apps/mobile/e2e/playwright`, so
 * they are part of this component's contract.
 */
interface SecretForm {
  label: string;
  fieldId: string;
  helpId: string;
  inputTestId: string;
  submitTestId: string;
}

const SECRET_FORMS: Record<ConsoleKind, SecretForm> = {
  venue: {
    label: 'Venue secret',
    fieldId: 'venue-secret',
    helpId: 'venue-secret-help',
    inputTestId: 'venue-secret-input',
    submitTestId: 'venue-secret-submit',
  },
  lodging: {
    label: 'Lodging secret',
    fieldId: 'lodging-secret',
    helpId: 'lodging-secret-help',
    inputTestId: 'lodging-secret-input',
    submitTestId: 'lodging-secret-submit',
  },
};

/**
 * The path this page was opened at, with trailing slashes removed. Read during render and never held
 * in state: the console navigates by full page loads, so the path cannot change while the page is up.
 */
function currentPath(): string {
  const stripped = window.location.pathname.replace(TRAILING_SLASHES, '');
  return stripped.length === 0 ? '/' : stripped;
}

/** The console at whichever of its two paths the browser opened (AAP 0.5.8), exported as the named
 * export `main.tsx` mounts. */
export function App(): JSX.Element {
  const path = currentPath();
  if (path === VENUE_PATH) {
    return <ConsoleGate kind="venue" />;
  }
  if (path === LODGING_PATH) {
    return <ConsoleGate kind="lodging" />;
  }
  return <ConsoleIndex notFound={path !== '/'} />;
}

/** The index of the two consoles, and the page a path outside them reaches (AAP 0.5.8); `notFound`
 * is true for a path that names neither console. */
function ConsoleIndex({ notFound }: { notFound: boolean }): JSX.Element {
  return (
    <main>
      <header>
        <h1>{SITE_NAME}</h1>
      </header>
      {notFound ? <p>Page not found</p> : null}
      <nav aria-label="Consoles">
        <ul>
          <li>
            <a href={VENUE_PATH}>Venue check-in code</a>
          </li>
          <li>
            <a href={LODGING_PATH}>Lodging stats</a>
          </li>
        </ul>
      </nav>
    </main>
  );
}

/** One console, behind the operator-issued secret that opens it (AAP 0.5.4). `kind` selects the
 * field's label and the route a held secret renders. */
function ConsoleGate({ kind }: { kind: ConsoleKind }): JSX.Element {
  const form = SECRET_FORMS[kind];
  const [secret, setSecret] = useState<string | null>(() => readSecret(kind));
  const [rejected, setRejected] = useState(false);
  const [draft, setDraft] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  // Stable across renders, so the open screen's polling or stats request is not restarted by a new
  // callback identity on every render of the gate.
  const handleUnauthorized = useCallback((): void => {
    // `api.ts` dropped the stored secret when it read the 401; dropping it again is idempotent.
    clearSecret(kind);
    setSecret(null);
    setRejected(true);
  }, [kind]);
  function handleForget(): void {
    clearSecret(kind);
    setSecret(null);
    setRejected(false);
  }
  function handleDraftChange(event: ChangeEvent<HTMLInputElement>): void {
    setDraft(event.target.value);
    setFieldError(null);
  }
  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const value = draft.trim();
    if (value.length === 0) {
      // An empty field and spaces alone both land here: the trimmed value decides.
      setFieldError(EMPTY_SECRET_MESSAGE);
      return;
    }
    saveSecret(kind, value);
    setSecret(value);
    setDraft('');
    setRejected(false);
  }
  return (
    <main>
      <header>
        {secret === null ? <h1>{SITE_NAME}</h1> : <p>{SITE_NAME}</p>}
        {secret === null ? null : (
          <button type="button" onClick={handleForget}>
            Forget secret
          </button>
        )}
      </header>
      {rejected ? (
        <p role="alert" className="notice notice-error">
          {REJECTED_MESSAGE}
        </p>
      ) : null}
      {secret === null ? (
        // Constraint validation stays off although the field is `required`: leaving it on would replace
        // this screen's announced message with the browser's own bubble, which is no live region.
        <form onSubmit={handleSubmit} noValidate>
          <label htmlFor={form.fieldId}>{form.label}</label>
          <input
            id={form.fieldId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            required
            value={draft}
            onChange={handleDraftChange}
            aria-describedby={form.helpId}
            aria-invalid={fieldError !== null}
            data-testid={form.inputTestId}
          />
          <p id={form.helpId}>{HELP_TEXT}</p>
          {fieldError === null ? null : (
            <p role="alert" className="notice notice-error">
              {fieldError}
            </p>
          )}
          <button type="submit" data-testid={form.submitTestId}>
            Open console
          </button>
        </form>
      ) : kind === 'venue' ? (
        // Keyed by the secret, so a new one remounts the screen instead of inheriting the previous
        // secret's in-flight request.
        <VenueCode key={secret} secret={secret} onUnauthorized={handleUnauthorized} />
      ) : (
        <LodgingStats key={secret} secret={secret} onUnauthorized={handleUnauthorized} />
      )}
    </main>
  );
}
