# jacktdry fork notes

Upstream: simonepri/refined-antigravity-acp

## Local lifecycle patches

Branch: fix/session-lifecycle-recycle

### Missing session close capability

Google Antigravity ACP implements session/close but does not advertise it in initialize sessionCapabilities. The fork normalizes Antigravity initialize responses to advertise close while leaving unsupported session/delete absent.

### Response-aware lifecycle cache

The upstream wrapper removed cached session metadata when close/delete was sent. This fork waits for the JSON-RPC response and only commits cache removal after success. A failed lifecycle request therefore does not make the wrapper forget a still-live session.

### Idle child recycle

When the final cached session closes successfully, the wrapper recycles the Google ACP child process and re-initializes the replacement. This gives the wrapper a process boundary that can release stale localharness_external descendants.

## Retirement condition

Each patch should be removed independently when upstream Google/refined behavior provides the equivalent guarantee:

- initialize advertises session/close;
- lifecycle cache is response-aware;
- final close releases the session-owned harness/process tree.

## Validation

Required before updating the installed fork:

- missing-session-close tests
- supervisor lifecycle tests
- lint / typecheck / build
- real Antigravity process smoke test when changing recycle behavior
