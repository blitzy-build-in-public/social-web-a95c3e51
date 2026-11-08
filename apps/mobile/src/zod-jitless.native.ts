/**
 * The native half of the eval-free declaration whose web half is `zod-jitless.web.ts` (AAP 0.3.2).
 *
 * Nothing is declared on iOS and Android, and nothing needs to be: a native runtime enforces no
 * Content-Security-Policy, so there is no policy for Zod's `new Function('')` probe to violate and
 * nothing for the platform to report, however Hermes answers it. Setting the flag here would have
 * one effect only -- Zod's JIT validators off for every schema on both phone platforms -- in answer
 * to a policy that does not exist there.
 *
 * The file exists so that the entry point's extensionless `./zod-jitless` import resolves on every
 * platform, the way `./auth/storage` and `./zk/artifacts` do: Metro takes the `.web` half for the web
 * bundle and this one for an iOS or Android bundle, and TypeScript's `moduleSuffixes` takes this
 * one. It holds no statement on purpose, so it contributes nothing to a native bundle.
 */
