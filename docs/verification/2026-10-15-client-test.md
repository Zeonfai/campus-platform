# HTTP client verification evidence

Date: 2026-10-15. Node 24.22.0. No project dependencies installed.

Original source: node --test packages/contracts/test/resource-client.test.ts; 5 tests passed using real loopback HTTP.

In a separate temporary copy, removed only result.sourceId !== sourceId, then ran the another-source test. Expected nonzero exit and Missing expected rejection; observed exactly that. Original source was preserved and the temporary copy was deleted.

The following is the expected failing mutation output, not an unresolved source defect:

```text
✖ a success response for another source must not confirm this command (17.972837ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 97.05761

✖ failing tests:

test at test/resource-client.test.ts:65:1
✖ a success response for another source must not confirm this command (17.972837ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection.
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async file:///tmp/campus-client-mutation-g5y8nf6j/test/resource-client.test.ts:68:5
      at async withServer (file:///tmp/campus-client-mutation-g5y8nf6j/test/resource-client.test.ts:18:9)
      at async TestContext.<anonymous> (file:///tmp/campus-client-mutation-g5y8nf6j/test/resource-client.test.ts:66:3)
      at async Test.run (node:internal/test_runner/test:1409:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: undefined,
    operator: 'rejects',
    diff: 'simple'
  }

```

This is HTTP client protocol evidence; it does not establish PostgreSQL scheduling, business authorization or full-system integration.
