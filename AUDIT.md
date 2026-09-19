# Project audit: cycling-ble

Audited on 2026-09-19 at commit `c8f1890` (package version `0.1.1`).

The existing checks pass, but targeted probes found correctness gaps in status
delivery, error classification, packet validation, and cancellation handling.
The initial audit made no production changes. Remediation progress is tracked
below; the findings describe behavior at the audited commit.

## Remediation status

| Item | Finding                                 | State                    |
| ---- | --------------------------------------- | ------------------------ |
| 1    | Nested status delivery                  | Fixed; full check passed |
| 2    | Discovery errors and classification     | Fixed; full check passed |
| 3    | Packet-length validation                | Fixed; full check passed |
| 4    | Cancellation at asynchronous boundaries | Fixed; full check passed |
| 5    | Numeric reconnection options            | Fixed; full check passed |
| 6    | Published source maps                   | Fixed; full check passed |

Last updated: 2026-09-19. All six prioritized findings are fixed and verified.
Package isolation and minimum-runtime follow-ups are also complete. Broader
real-browser and hardware validation remain open.

Latest verification: `pnpm run check` passed with 211 source tests and the
isolated packed-package test. Source coverage is 99.76% lines, 100% branches,
and 95.24% functions, above all configured thresholds. The packed-package test
also passed on Node 20.0.0 via
`npm exec --yes --package=node@20.0.0 -- node --test scripts/check-package.mjs`.

The scope/check results immediately below are the original audit baseline.

## Scope and verification

Reviewed all source modules, tests, public API documentation, package exports,
TypeScript configuration, and CI/publishing workflows.

| Check                                        | Result                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm run check`                             | Passed: types, lint, formatting, coverage, build                                          |
| Existing tests                               | 166 passed; no failures or skips                                                          |
| Reported source coverage                     | 100% lines, 100% branches, 95.06% functions                                               |
| `pnpm audit --json`                          | No advisories reported, including development dependencies                                |
| `npm pack --dry-run --json --ignore-scripts` | Inspected package file list; source-map issue below                                       |
| Built package imports                        | Root, `/parsers`, and `/mock` imported successfully                                       |
| Additional probes                            | Reproduced the behaviors described below using small scripts and existing Bluetooth fakes |

Environment: Node `22.21.1`, pnpm `11.25.0`. Hardware and real-browser behavior
were not exercised. Fake-adapter results establish library behavior for those
inputs and timings; they do not establish how frequently a browser or sensor
produces them. The dependency result is a point-in-time registry check.

## Prioritized fixes

P2 means a correctness issue worth fixing soon. P3 means a lower-priority
robustness or packaging issue. No P0/P1 finding was established.

### 1. P2 — Prevent stale status delivery when a listener disconnects

**State: Fixed (2026-09-19).** `connect.ts` now queues nested status transitions
until the current event has reached every subscriber. All subscribers receive
the same transition order and finish with `disconnected` when a status listener
disconnects. Reading delivery and listener-error isolation are preserved.

**Verification:** Four new regression tests cover disconnecting from `connected`
and `reconnecting`, both with and without a subsequent listener exception. All
four failed before the fix and pass afterward. `pnpm run check` passed with
170 tests, type checking, linting, formatting, coverage, and the build. Coverage
remains 100% lines, 100% branches, and 95.06% functions.

The original finding and reproduction are retained below. Source line references
throughout the original findings refer to the audited commit.

**Locations:** `src/connect.ts:119`, `src/connect.ts:201`,
`src/connect.ts:255`, `src/listeners.ts:23`.

Status delivery is synchronous and iterates a snapshot. If the first listener
calls `connection.disconnect()` upon receiving a successful reconnect's
`connected` event, a nested `disconnected` event reaches all subscribers. The
outer emission then resumes and sends `connected` to the remaining subscribers.

**Reproduced:** Register two status listeners. Have the first call `disconnect()`
on `connected`; have the second record statuses. Drop the fake device and allow
reconnection. The second listener observes:

```text
disconnected → reconnecting → disconnected → connected
```

At the end, `gatt.connected` is `false`. A UI driven by the second listener ends
up displaying a connected sensor that has already been disconnected.

**Fix:** Make lifecycle event delivery safe against nested transitions. Queue
status emissions in transition order, or invalidate an older emission when a
new transition occurs. Preserve listener-error isolation.

**Regression check:** Exercise disconnects from both `connected` and
`reconnecting` callbacks with multiple subscribers. Every subscriber's final
status must agree with the final connection state.

### 2. P2 — Preserve discovery failure categories and prioritize specific errors

**State: Fixed (2026-09-19).** Discovery only falls back on `NotFoundError`;
permission, transport, and unexpected errors propagate unchanged. Specific
classification rules precede generic GATT/chooser rules. Fakes now use native
missing-attribute error names. Added overlapping-message, discovery-failure,
and missing-characteristic fallback regressions. `pnpm run check` passed
with 182 tests.

**Locations:** `src/connect.ts:161–178`, `src/errors.ts:110–189`.

There are two related ways the current API gives misleading troubleshooting
advice:

- Discovery catches every failure and ultimately throws “exposes none of the
  expected BLE services.” A permission or transport failure therefore becomes
  `incompatible`, even though the device may support the required service.
  Keeping the original error in `cause` does not help the classifier, which
  only reads the outer error.
- Classification checks the broad word `gatt` before checking `SecurityError`
  or timeouts. It also checks generic `NotFoundError` before missing-service
  wording.

**Reproduced inputs and results:**

| Input                                                                          | Actual category     | Expected category   |
| ------------------------------------------------------------------------------ | ------------------- | ------------------- |
| `SecurityError("GATT permission denied")`                                      | `connection-failed` | `permission-denied` |
| `NetworkError("GATT connection timed out")`                                    | `connection-failed` | `timeout`           |
| `NotFoundError("Service not found")`                                           | `not-found`         | `incompatible`      |
| `getPrimaryService()` rejects with `SecurityError` during `connectHeartRate()` | `incompatible`      | `permission-denied` |

The discovery distinction is part of the
[Web Bluetooth hierarchy algorithm](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/index.bs):
permission failures, disconnected transports, and absent attributes have
different error types.

**Fix:** Fall back to another service for genuine missing-service or
missing-characteristic failures. Preserve other failures, or attach explicit
operation/category information instead of replacing them with incompatibility.
Give specific error names and messages priority over generic keyword matching;
if inspecting causes, bound traversal and handle cycles.

**Regression check:** Add table-driven tests for overlapping names/messages and
end-to-end tests where discovery rejects with permission and network failures.
Keep genuine service absence and chooser cancellation covered.

### 3. P2 — Enforce the documented packet-length contract

**State: Fixed (2026-09-19).** All four parsers validate the complete declared
layout, including skipped fields, trailing fields, and complete heart-rate RR
intervals. Added exhaustive optional-field subset/truncation tests and warning/
drop integration tests for each sensor type. `pnpm run check` passed with
192 tests. The existing two-byte FTMS resistance interpretation is preserved.
Field layouts were checked against the
[Heart Rate Service](https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/HRS_v1.0/out/en/index-en.html),
[Cycling Power Service](https://www.bluetooth.org/DocMan/handlers/DownloadDoc.ashx?doc_id=585857),
and [Fitness Machine Service](https://www.bluetooth.org/DocMan/handlers/DownloadDoc.ashx?doc_id=423422).

**Locations:** `src/parsers/indoor-bike.ts:51–76`,
`src/parsers/cadence.ts:69–74`, `src/parsers/heart-rate.ts:16–22`,
`src/parsers/cycling-power.ts:14–16`; README parser documentation.

The README promises a `RangeError` whenever a packet is shorter than its flags
require. Current parsers generally validate only fields they actually read.
Incrementing an offset does not check the buffer length, ignored trailing
fields are not checked, and CSC returns early for packets without crank data.

**Reproduced:** Each of these truncated packets returns normally:

| Parser        | Bytes, hexadecimal | Missing field                 | Actual result       |
| ------------- | ------------------ | ----------------------------- | ------------------- |
| Indoor bike   | `00 00`            | Mandatory instantaneous speed | Both metrics `null` |
| Indoor bike   | `C1 00 C8 00`      | Flagged average power         | `powerW: 200`       |
| Heart rate    | `08 48`            | Flagged energy expended       | `72`                |
| Cycling power | `20 00 FA 00`      | Flagged crank data            | `250`               |
| CSC cadence   | `01`               | Flagged wheel data            | `rpm: null`         |

Consequently, some malformed notifications produce readings while others are
silently ignored, bypassing the promised malformed-packet warning.

**Fix:** Validate the required length of all declared fields before returning,
including skipped and trailing fields. If prefix-only decoding is intentional,
narrow the README and parser contracts explicitly instead of promising whole
packet validation.

**Regression check:** Truncate valid packets at every byte boundary for each
optional-field combination, including combinations with no requested metric.
Verify both direct parser behavior and connect-layer warning/drop behavior.

### 4. P2 — Stop abandoned reconnect work at each asynchronous boundary

**State: Fixed (2026-09-19).** Cancellation is checked after each asynchronous
setup operation, including discovery rejection before fallback. Cleanup uses a
per-GATT attempt identity, so a late old completion cannot close a replacement
connection. Initial setup cannot launch an overlapping automatic reconnect.
Added resolve/reject cancellation tests at all four stages, replacement-connection
races, and an initial-setup drop test. `pnpm run check` passed with 203 tests.
No new transport timeout policy was introduced; pending adapter promises still
rely on adapter settlement, while disconnect closes an already-open link.

**Locations:** `src/connect.ts:153–185`, `src/connect.ts:255–265`.

The only abandonment check inside `connect()` runs after service discovery,
characteristic discovery, and `startNotifications()` have all completed. A
late adapter completion can therefore continue setup after the caller has
disconnected.

**Reproduced with the injected fake adapter:**

1. Establish a connection and trigger automatic reconnection.
2. Hold the reconnect's `gatt.connect()` promise pending.
3. Call `connection.disconnect()`.
4. Resolve the held connect promise, reopening the fake GATT link.
5. Hold the subsequent service-discovery promise pending.

Service discovery starts despite cancellation, and the link remains connected
until that later operation settles. An operation that never settles prevents
the final abandonment check from releasing it. This probe specifically models
an adapter that completes a connect after cancellation; it is not evidence
that every native browser behaves this way.

**Fix:** Check cancellation immediately after each awaited setup operation and
close a late connection before issuing further GATT work. Use attempt identity
or generation tracking so completion of an older attempt cannot tear down a
newer connection. Consider a bounded setup timeout for injected adapters.

**Regression check:** Extend the existing mid-reconnect cancellation test to
hold each setup operation separately. After cancellation, releasing that
operation must not start the next one or leave an open link.

### 5. P3 — Validate numeric reconnection options

**State: Fixed (2026-09-19).** Attempt counts require nonnegative safe integers
or `Infinity`; delays require integer milliseconds from zero through the timer
maximum (2147483647). Validation happens before device selection or lookup.
Backoff arithmetic stays finite even during unlimited zero-delay retries.
Added invalid-input, boundary, zero-attempt, and 1030-attempt cancellation
regressions. `pnpm run check` passed with 211 tests.

**Locations:** `src/reconnection.ts:40–44`, `src/reconnection.ts:73–86`,
`src/types.ts:63–70`.

Options accept any JavaScript number. `maxAttempts: NaN` makes the exhaustion
comparison permanently false. Invalid delays also flow directly into timer
scheduling.

**Reproduced:** With `{ maxAttempts: NaN, baseDelayMs: 0 }` and a failing connect
function, eight attempts ran before the probe explicitly cancelled the manager;
no `failed` status was emitted. The loop has no attempt limit for this input.
This can arise from parsing invalid configuration, not only from an explicit
`NaN` literal.

**Fix:** Accept only a nonnegative integer or the documented `Infinity` for
`maxAttempts`. Require finite, supported nonnegative delay values and document
zero-delay behavior. Reject invalid values before device selection/connection.

**Regression check:** Cover `NaN`, negative and fractional attempt counts,
infinite delays, and valid `maxAttempts: Infinity` with cancellation.

### 6. P3 — Publish usable source maps

**State: Fixed (2026-09-19).** The package includes `src`, resolving both
JavaScript and declaration source-map targets. `scripts/check-package.mjs`
packs and installs the actual tarball in a temporary consumer, verifies every
map source, exercises all public import paths, and compiles a consumer with
`types: []` and `skipLibCheck: false`. It is included in `pnpm run check`.
The test passed on Node 22.21.1 and Node 20.0.0; CI now checks both runtimes.

**Locations:** `package.json:30–34`, `tsconfig.build.json:7–8`.

The build emits JavaScript and declaration maps, but the package's file list
excludes `src`. For example, both `dist/connect.js.map` and
`dist/connect.d.ts.map` reference `../src/connect.ts`; neither embeds
`sourcesContent`. The pack dry run confirmed that the referenced source is not
included.

**Impact:** Consumers cannot resolve the original TypeScript through these
maps in debugging and editor navigation.

**Fix:** Include the referenced TypeScript sources in the package, or embed
JavaScript map sources and make a deliberate separate choice for declaration
maps. Remove maps if source navigation is intentionally unsupported.

**Regression check:** Inspect the actual packed artifact and ensure each map's
source is either present in the package or embedded appropriately.

## Follow-up validation improvements

These were coverage improvements, not additional confirmed production defects.

- **GATT failure behavior — partially covered.** Fakes now use native
  missing-attribute error names. Regression tests cover delayed completions,
  permission/network discovery failures, cancellation at every setup stage,
  replacement connections, and drops during initial setup. Attribute
  invalidation and real-browser behavior still need broader integration tests.
  See the Web Bluetooth
  [persistence and disconnection rules](https://github.com/WebBluetoothCG/web-bluetooth/blob/main/index.bs).
- **Isolated distributable — complete.** The new packed-package check exercises
  public imports, consumer declarations without repository ambient types, and
  map sources from the actual installed tarball.
- **Minimum supported runtime — complete.** The packed-package check passed on
  Node 20.0.0. CI runs it at that boundary after the Node 22 development checks.
- **Hardware evidence — open.** No sensor or recorded hardware captures were
  available for this work. The README's hardware status and FTMS resistance-width
  limitation remain accurate. Captured fixtures and browser/device results are
  still needed. Missing power-meter cadence support and shared-device connection
  ownership remain documented product limitations.

## Original suggested implementation order

1. Fix lifecycle status ordering and cancellation; add targeted race tests.
2. Fix discovery error preservation and classification precedence.
3. Settle and enforce the parser validation contract.
4. Validate retry configuration and repair package maps.
5. Add isolated package checks and hardware-backed fixtures.

High execution coverage is useful, but these results show that it does not
cover all event orderings, protocol flag combinations, or packaging behavior.
