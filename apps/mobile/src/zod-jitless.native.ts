/**
 * The native half of the eval-free declaration whose web half is `zod-jitless.web.ts` (AAP 0.3.2).
 *
 * Nothing is declared on iOS and Android, and nothing needs to be: a native runtime enforces no
 * Content-Security-Policy, so Zod's `new Function('')` probe has no policy to violate and there is
 * nothing for the platform to report. The file exists so the entry point's extensionless
 * `./zod-jitless` import resolves on every platform; it holds no statement on purpose.
 */
