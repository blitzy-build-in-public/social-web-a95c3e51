/**
 * The native half of `zod-jitless`, whose web half declares the flag: a native runtime enforces no
 * Content-Security-Policy, so there is nothing to declare. The file exists so that the entry point's
 * extensionless `./src/zod-jitless` import resolves on every platform, and it holds no statement on
 * purpose.
 */
