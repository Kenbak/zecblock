# Server regressions

Run `npm run test:server-regressions` from the repository root. Optional database
fixtures retain their existing environment variables and availability checks.

The error-message leakage suite runs last through
`npm run test:error-message-leakage`, as a separate `node` process without the
`--test` parent. Node's `node:test` module still runs all seven tests and sets a
nonzero exit status on assertion failure. The suite, real route handlers and
their log output are unchanged; its process remains separate from other files.
The command therefore prints two test summaries, and either failing group fails
the npm script.

This avoids Node 22's parent test-runner stdout deserialization bug, which can
crash this log-heavy file after its assertions pass. See upstream
[issue #65934](https://github.com/nodejs/node/issues/65934) and
[fix #64706](https://github.com/nodejs/node/pull/64706). Keep the standalone
invocation until the supported runtime includes the fix and the combined run
has been verified. Other files keep the existing `--test` execution model.

Node documents direct `node:test` execution and failure exit status in its
[22.23.4 test-runner guide](https://nodejs.org/download/release/v22.23.4/docs/api/test.html).
