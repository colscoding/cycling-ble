# cycling-ble

Connect to cycling power meters, heart rate monitors, cadence sensors, and
FTMS smart trainers over Web Bluetooth. Zero runtime dependencies.

**Two things to know before you install:**

- **Browser and OS support vary.** Chrome supports Web Bluetooth on Android,
  ChromeOS, macOS, and Windows. Linux support is experimental and requires a
  browser flag. Safari and Firefox do not implement the API; do not assume
  that an iOS browser supports it. Check the
  [Web Bluetooth implementation status](https://github.com/whatwg/bluetooth/blob/main/implementation-status.md)
  for your browser and OS. The page must use a secure context, such as HTTPS
  or localhost; opening the device chooser requires a user gesture. See
  [Chrome's security requirements](https://developer.chrome.com/docs/capabilities/bluetooth#security_requirements).
- **Read-only.** This library subscribes to sensor notifications. It never
  writes to a GATT characteristic, so it **cannot control trainer
  resistance, ERG mode, or simulation grade.** If you need to control a
  trainer rather than record from one, this is not the library.

## Install

```sh
npm install cycling-ble
```

The package is ESM and declares Node 22 or later for Node consumers. CommonJS
code can `require()` it on Node 22.12 or later, where
[loading ESM through `require()` is enabled by default](https://nodejs.org/en/blog/release/v22.12.0).
Node does not supply `navigator.bluetooth`: use a compatible implementation
through `options.bluetooth` to connect there. The parsers and mocks work in
Node without Bluetooth. Browser applications can bundle the ESM entry points.

## Quick start

```ts
import { connectPower } from 'cycling-ble';

// Must be called from a user gesture — the browser shows a device chooser.
const connection = await connectPower();

console.log(`connected to ${connection.deviceName}`);

const unsubscribe = connection.addListener((reading) => {
    if (reading.power !== undefined) console.log(`${reading.power} W`);
    if (reading.cadence !== undefined) console.log(`${reading.cadence} rpm`);
});

// later
unsubscribe();
connection.disconnect();
```

### Readings carry more than one metric

An FTMS trainer can report power and cadence in a single Bluetooth notification,
so a reading is a timestamped frame rather than a single number:

```ts
interface SensorReading {
    timestamp: number; // local receipt time, ms since epoch
    power?: number; // watts
    cadence?: number; // rpm
    heartRate?: number; // bpm
}
```

Absent metrics are **omitted keys**, never `undefined` values, so the type is
correct under `exactOptionalPropertyTypes`. Check with `!== undefined` rather
than truthiness — `0 W` is a real reading.

## API

### `connectPower(options?)`

Connects to a power source. Prefers the Cycling Power Service (`0x1818`); if
that service or its measurement characteristic is missing, probes the Fitness
Machine Service (`0x1826`). Permission, transport, and notification setup
failures reject instead of triggering fallback. Readings include cadence when
the device reports it: an FTMS trainer directly, or a power meter through the
crank revolution data in its measurements. FTMS readings may contain power,
cadence, or both. A power meter's cadence is a
delta between crank samples, so it behaves like [`connectCadence`](#connectcadenceoptions):
cadence needs two usable crank samples after connecting or reconnecting.

### `connectHeartRate(options?)`

Connects to a Heart Rate Service (`0x180D`) monitor. Yields `heartRate`.

### `connectCadence(options?)`

Connects to a Cycling Speed and Cadence Service (`0x1816`) sensor. Yields
`cadence`. CSC reports cumulative crank counters, so the first notification
after connecting produces no reading — RPM only exists as a delta.

When pedalling stops, most sensors repeat their last crank event. That leaves
no delta to compute, so **readings stop rather than arriving as `0 rpm`**. If
your UI shows cadence, treat a value that has not been updated for a few
seconds as zero.

A sensor that instead advances its event time without reporting a new
revolution has timed a window the rider did not pedal through, and that does
yield a real `0`. Handle both explicit zero and stale cadence values. Track the
time of the last **cadence** update: power readings may continue without a
cadence field. Also track connection status so a lost connection is shown as
unavailable rather than mistaken for stopped pedalling.

### `ConnectOptions`

| Option             | Type                        | Default                 | Purpose                                                         |
| ------------------ | --------------------------- | ----------------------- | --------------------------------------------------------------- |
| `previousDeviceId` | `string`                    | —                       | Reconnect to a known device without showing the chooser         |
| `logger`           | `Logger`                    | no-op                   | Where the library logs; pass `console` to see it                |
| `reconnect`        | `ReconnectOptions \| false` | 5 attempts, 1 s backoff | Automatic reconnection tuning, or `false` to handle it yourself |
| `bluetooth`        | `BluetoothAdapter`          | `navigator.bluetooth`   | Supply a polyfill or a test fake                                |

#### `ReconnectOptions`

After an unexpected drop, the library waits, reconnects, and doubles the wait
after each failure, up to a ceiling:

| Option        | Default | Meaning                                         |
| ------------- | ------- | ----------------------------------------------- |
| `maxAttempts` | `5`     | Attempts before giving up and reporting failure |
| `baseDelayMs` | `1000`  | Wait before the first attempt                   |
| `maxDelayMs`  | `10000` | Ceiling on any single wait                      |

With the defaults the waits are 1 s, 2 s, 4 s, 8 s, then 10 s — 25 seconds
of backoff if every attempt fails, **plus the time spent connecting and
restoring notifications**. The library sets no timeout on those operations,
so this is not a deadline for `'failed'`. A successful reconnect restores the
full budget for the next drop. Pass `maxAttempts: Infinity` to keep retrying
failed attempts without a count limit.

Reconnection applies only after a connection has been returned. Initial
chooser or setup failures reject the connect promise without automatic
retries. With `reconnect: false`, clean up the old connection with
`disconnect()`, then call a connect function again when you want a new one.

`maxAttempts` must be a nonnegative safe integer or `Infinity`; `0` reports
`failed` after a drop without attempting to reconnect. Both delays must be
integer milliseconds from `0` through `2147483647`. A zero delay retries on
the next timer turn without an intentional backoff. Invalid options reject
with `RangeError` before requesting or looking up a device.

#### `Logger`

Any object with `debug`, `info`, `warn`, and `error` methods taking
`(message: string, ...args: unknown[])` — `console` qualifies. The library is
silent by default. Malformed packets are logged at `warn` and dropped rather
than thrown, so pass a logger if readings seem to be missing.

### `SensorConnection`

```ts
import type { ConnectionStatus, SensorReading } from 'cycling-ble';

interface SensorConnection {
    readonly deviceId?: string;
    readonly deviceName: string;
    addListener(listener: (reading: SensorReading) => void): () => void;
    onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
    disconnect(): void;
}
```

Both subscribe methods return an unsubscribe function. `disconnect()` is
final for that connection object and is safe to call more than once.

Notifications can arrive while connection setup is still completing or before
you subscribe. The newest reading received before the first `addListener`
call is retained and delivered synchronously when that listener attaches, so
prepare your listener before subscribing. Only that one reading is retained;
later subscriptions do not replay past readings. On reconnect, a setup sample
is delivered to existing listeners after `connected`.

`ConnectionStatus` is `'connected' | 'disconnected' | 'reconnecting' | 'failed'`.
Note that the initial connection is signalled by the connect promise resolving,
not by a `'connected'` status event — that event fires before you can attach a
listener. `onStatusChange` reports what happens _after_ that:

| Situation                     | Statuses, in order                                            |
| ----------------------------- | ------------------------------------------------------------- |
| Drop, then a successful retry | `disconnected` → `reconnecting` → `connected`                 |
| Drop, and every retry fails   | `disconnected` → `reconnecting` (once per attempt) → `failed` |
| Drop with `reconnect: false`  | `disconnected`                                                |
| Drop with `maxAttempts: 0`    | `disconnected` → `failed`                                     |
| You call `disconnect()`       | `disconnected`, and no reconnection follows                   |

`'failed'` is final: that connection object will not try again. Call
`disconnect()` on it to release the device, then connect afresh — with
`previousDeviceId` if you kept it.

Listeners run synchronously when a reading or status is delivered, including
from Bluetooth events, setup completion, and calls such as `disconnect()`.
Keep them quick. If a status listener calls `disconnect()` on its own
connection, its resulting status event is delivered after the current event
has reached all listeners, preserving transition order. A listener that
throws does not stop the others or disturb
reconnection: its error is passed to `reportError`, which puts it in the
console like any uncaught error and fires the window `error` event. Where
there is no `reportError`, as in Node, it is rethrown on a later tick.

### Reconnecting without a chooser

Persist `deviceId` and hand it back. Saved-device lookup depends on
`navigator.bluetooth.getDevices()`, which the
[implementation status](https://github.com/whatwg/bluetooth/blob/main/implementation-status.md#chrome)
currently lists behind Chrome's experimental web platform features flag.
Support for the chooser does not imply support for saved-device lookup.

The library never touches storage itself. Here are separate entry points for
a "Choose a sensor" button and an attempt to reuse a saved device:

```ts
import { connectPower, type SensorConnection } from 'cycling-ble';

// Call from a user gesture, such as a "Choose a sensor" button click.
async function chooseSensor(): Promise<SensorConnection> {
    const connection = await connectPower();
    if (connection.deviceId) {
        localStorage.setItem('powerDeviceId', connection.deviceId);
    }
    return connection;
}

// Next session. Returns null when no id is saved; lookup/setup errors reject.
async function connectRemembered(): Promise<SensorConnection | null> {
    const saved = localStorage.getItem('powerDeviceId');
    return saved ? connectPower({ previousDeviceId: saved }) : null;
}
```

This relies on `navigator.bluetooth.getDevices()`, which requires the user to
have previously granted access to that device. It rejects rather than falling
back to a chooser prompt, so you can tell the two situations apart. The
rejection says which case it hit:

- the device is no longer permitted — `classifyBluetoothError` reports
  `not-found`;
- the browser does not support `getDevices()` at all — `classifyBluetoothError`
  reports `unavailable` with `canRetry: false`, because repeating the same
  lookup cannot help while that API is unavailable;
- the lookup itself failed — the original error is the rejection's `cause`.

Handle a rejected `connectRemembered()` call in your UI. If the saved device
is no longer permitted, clear the stale id. Keep it on transient connection
failures, such as a powered-off sensor. Offer the "Choose a sensor" button
when lookup fails or no id is saved: waiting for a failed connection can
consume the user activation needed to open a chooser automatically.

The saved permission must also cover the requested sensor's GATT service. An
id saved by `connectHeartRate`, for example, does not itself grant access to
the Cycling Power Service on the same device; use the chooser to grant access
to additional services.

### `classifyBluetoothError(error, options?)`

Browsers disagree on both the `name` and the wording of Web Bluetooth
failures. This turns one into a stable category plus renderable copy:

```ts
import { connectPower, classifyBluetoothError } from 'cycling-ble';

try {
    await connectPower();
} catch (error) {
    const { kind, title, message, suggestions, canRetry } = classifyBluetoothError(error, {
        sensorLabel: 'power meter',
    });
    if (kind !== 'cancelled') console.error(title, message, suggestions, { canRetry });
}
```

`kind` is one of `cancelled`, `unavailable`, `not-found`, `connection-failed`,
`permission-denied`, `timeout`, `incompatible`, `unknown`.

### `cycling-ble/parsers`

The packet decoders on their own. No browser APIs — these run in Node, which
makes them useful for decoding recorded captures:

| Function                               | Takes                     | Returns                                      |
| -------------------------------------- | ------------------------- | -------------------------------------------- |
| `parsePowerMeasurement(view)`          | Cycling Power Measurement | watts (`number`)                             |
| `parsePowerCadence(view, state)`       | Cycling Power Measurement | `{ rpm, state }`, `rpm` may be null          |
| `parseHeartRateMeasurement(view)`      | Heart Rate Measurement    | bpm (`number`)                               |
| `parseCadenceMeasurement(view, state)` | CSC Measurement           | `{ rpm, state }`, `rpm` may be null          |
| `parseIndoorBikeData(view)`            | FTMS Indoor Bike Data     | `{ powerW, cadenceRpm }`, either may be null |

```ts
import { parseIndoorBikeData, parseCadenceMeasurement, initialCadenceState } from 'cycling-ble/parsers';

// Example capture: More Data, instantaneous cadence, instantaneous power.
const bikeData = new DataView(Uint8Array.of(0x45, 0, 180, 0, 250, 0).buffer);
console.log(parseIndoorBikeData(bikeData)); // { powerW: 250, cadenceRpm: 90 }

// The two cadence parsers are stateful: thread `state` through successive
// calls, starting from initialCadenceState. That starting object is frozen
// and shared, so reassign your variable — never write to it.
let state = initialCadenceState;
for (const bytes of [
    [0x02, 10, 0, 0, 4], // 10 revolutions at 1 second
    [0x02, 11, 0, 0, 8], // 11 revolutions at 2 seconds
]) {
    const result = parseCadenceMeasurement(new DataView(Uint8Array.from(bytes).buffer), state);
    state = result.state;
    console.log(result.rpm); // null, then 60
}
```

Every parser throws a `RangeError` when a packet is shorter than its flags say
it should be. The connect functions catch that and log it; if you call a parser
directly, catch it yourself. Parsers never mutate the `state` they are given.

Cadence is rounded to the nearest whole rpm. A rounded result of 300 rpm or
more is treated as implausible and returned as `null`; the connection omits
that metric. Power remains a signed watt value, including negative readings.

### `cycling-ble/mock`

Simulated sensors with the same shape as a real connection, for demos, UI work
without hardware, and end-to-end tests:

`createMockPowerSensor`, `createMockHeartRateSensor`, and
`createMockCadenceSensor` each take `{ deviceName?, intervalMs?, autoStart? }`.
`intervalMs` defaults to `1000` and `autoStart` to `true`; the first generated
reading arrives after one interval. Generated readings contain just the
sensor's metric: 200–250 W, 140–160 bpm, or 80–100 rpm, respectively. Default
names are `Mock Power Sensor`, `Mock Heart Rate Monitor`, and
`Mock Cadence Sensor`. Mocks do not expose a `deviceId`.

```ts
import { createMockPowerSensor } from 'cycling-ble/mock';

const sensor = createMockPowerSensor({ intervalMs: 1000 });
sensor.addListener((reading) => console.log(reading.power));
// later
sensor.disconnect();

// Or drive it yourself, which is what you want in a test — no wall-clock wait.
const manual = createMockPowerSensor({ autoStart: false });
manual.addListener((reading) => console.log(reading.power));
manual.emit({ power: 250 });

// Walk a UI through a dropout without switching a sensor off.
manual.simulateStatus('disconnected');
manual.simulateStatus('reconnecting');
manual.simulateStatus('connected');
manual.disconnect();
```

`simulateStatus` reports the supplied status to `onStatusChange` listeners;
it does not schedule retries or subsequent transitions. Readings flow only
while the simulated status is `'connected'`, so after `'disconnected'`,
`'reconnecting'`, or `'failed'` the
mock goes quiet — generated readings and `emit()` calls alike — until it is
sent `'connected'` again. A simulated `'failed'` can therefore be reversed for
testing, unlike a real connection's final failure. After `disconnect()`,
`emit()` and `simulateStatus()` are ignored.

Every listener receives each reading or status even if one throws. A mock
then rethrows the first error from `emit()`, `simulateStatus()`, or
`disconnect()`, so an assertion that fails inside a listener fails the test
that called it. Avoid nested mock status changes inside a status listener;
see [Known limitations](#known-limitations).

## Implemented services

| Service                   | UUID     | Characteristic            | Yields             |
| ------------------------- | -------- | ------------------------- | ------------------ |
| Cycling Power             | `0x1818` | Cycling Power Measurement | `power`, `cadence` |
| Heart Rate                | `0x180D` | Heart Rate Measurement    | `heartRate`        |
| Cycling Speed and Cadence | `0x1816` | CSC Measurement           | `cadence`          |
| Fitness Machine (FTMS)    | `0x1826` | Indoor Bike Data          | `power`, `cadence` |

The library reports power, cadence, and heart rate through the services above.
The FTMS adapter reports only instantaneous power and cadence; its heart-rate
field is skipped. Speed, distance, resistance, pedal balance, torque, and
other unreported fields are checked for length but not exposed as readings.

## Known limitations

- **One device, two connections.** A page has one GATT connection per physical
  device, so `connectPower` and `connectCadence` on the same device share it.
  Calling `disconnect()` on one drops the link under the other, which normally
  starts automatic reconnection if enabled. A power meter that reports
  crank data needs only `connectPower`, which already yields its cadence.
- **A drop during reconnect status delivery can be lost.** If a `connected`
  listener disconnects another subscription sharing the device, the first
  subscription can stop receiving readings while still reporting `connected`
  and never retry. Avoid changing another connection on the same device from
  that callback; if this occurs, disconnect the affected subscription and
  connect afresh.
- **Nested mock statuses are not queued.** If a mock status listener calls
  `disconnect()` during `simulateStatus('connected')`, later listeners receive
  `disconnected` followed by `connected`, even though the mock has stopped.
  Trigger the next mock transition after the current call returns.
- **FTMS Resistance Level width.** The parser assumes a two-byte Resistance
  Level field. The
  [2026-09-09 GATT Specification Supplement, §3.139](https://btprodspecificationrefs.blob.core.windows.net/gatt-specification-supplement/GATT_Specification_Supplement.pdf#page=125)
  defines it as one byte (`uint8`). A trainer using that one-byte layout with
  resistance present can cause a malformed-packet rejection or incorrect
  power decoding. The parser's layout has not been verified against hardware.

## Tested on

The library is covered by a local test suite that drives a simulated GATT
stack. That verifies decoding and connection logic; it does not verify any
particular device.

Hardware confirmed to work is listed here, and nothing is claimed that has not
actually been ridden with. If your sensor works — or doesn't — a
[hardware report](https://github.com/colscoding/cycling-ble/issues/new?template=hardware-report.yml)
saying which model would genuinely help.

- _(none recorded yet)_

## Development

For development, use the Node version in `.nvmrc` (currently 24.22.1) and the
pnpm version pinned in `package.json` (currently 12.16.0). These are the versions
used by the local checks, separate from the package's Node 22 runtime minimum.

```sh
nvm use
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm test               # run the suite
pnpm run test:coverage  # run it with coverage, failing below the thresholds
pnpm run build && pnpm run test:package # check the packed artifact in isolation
pnpm run check          # types, lint, format, coverage, release-script tests, build, package check
```

Corepack 0.36.0 was verified with this toolchain. If Corepack is missing or an
older installation cannot launch pnpm, follow the
[Corepack installation instructions](https://github.com/nodejs/corepack#how-to-install)
and enable its pnpm shim. pnpm can also be installed through its
[documented alternatives](https://pnpm.io/installation).

Tests use Node's built-in runner. `test/helpers/fake-bluetooth.ts` fakes the
small slice of Web Bluetooth the connect layer touches, so connection,
reconnection, and teardown logic run without a browser or a sensor. Parser
tests build packets byte by byte from the Bluetooth specifications. Coverage
must reach 98% of lines, 95% of branches, and 90% of functions. The package
check verifies ESM and CommonJS imports, declarations in an isolated consumer,
and source-map targets. There are no browser or hardware integration tests
or GitHub Actions workflows; run `pnpm run check` locally before submitting
changes.

### Manual releases

Install development dependencies first. Update the version in `package.json`
and the changelog, then commit the release changes. Set `NPM_TOKEN` in the
ignored `.env` file at the repository root. Both dry-run and publish modes
contact npm and require a valid token; neither accepts an already-published
version. The script also invokes `git`, `tar`, `npm`, and `pnpm`, which must be
available on `PATH`.

```sh
pnpm run release:dry-run # validate the release without publishing
pnpm run release         # validate, publish to npm, and verify its integrity
pnpm run release:verify  # resume verification if npm is still processing
```

The release script requires a clean tracked working tree and runs the full
check in a temporary export of the committed source, using the local
`node_modules` through a symlink. It packs and inspects that same source, reads
`.env` as data, and authenticates through a temporary npm configuration.
The token is redacted from command output and kept out of Git
and the package. An already-published version is refused. Local releases do
not include CI provenance. npm may take several minutes to process a new
release. After `npm publish` succeeds, the script saves a credential-free
receipt in ignored `.releases/` and checks the registry integrity. Verification
allows up to 41 lookups separated by 15-second waits when the version is not
yet visible. Use `release:verify` to resume without submitting again; it
requires the receipt matching the version currently in `package.json` and
does not require the token. If publication was interrupted before a receipt
was written, inspect the registry before attempting another publication.

Push the release commit and its matching `v*` tag to record the released source;
tags do not trigger publication. GitHub workflows are currently removed.

## License

MIT © Christian Olsson
