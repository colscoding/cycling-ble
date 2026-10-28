# cycling-ble

Connect to cycling power meters, heart rate monitors, cadence sensors, and
FTMS smart trainers over Web Bluetooth. Zero runtime dependencies.

**Two things to know before you install:**

- **Chromium only.** Web Bluetooth ships in Chrome, Edge, and Opera, on
  desktop and Android. Safari and Firefox do not implement it, and iOS does
  not implement it in any browser. The page must be served over HTTPS or
  from localhost.
- **Read-only.** This library subscribes to sensor notifications. It never
  writes to a GATT characteristic, so it **cannot control trainer
  resistance, ERG mode, or simulation grade.** If you need to control a
  trainer rather than record from one, this is not the library.

## Install

```sh
npm install cycling-ble
```

The package is ESM. CommonJS code can `require()` it on Node 22.12 or later.

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

An FTMS trainer reports power and cadence in a single Bluetooth notification,
so a reading is a timestamped frame rather than a single number:

```ts
interface SensorReading {
    timestamp: number; // ms since epoch
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
the device does not expose it, falls back to the Fitness Machine Service
(`0x1826`). Cadence arrives alongside power in the same reading when the
device reports it: an FTMS trainer directly, or a power meter through the
crank revolution data in its measurements. A power meter's cadence is a
delta between crank samples, so it behaves like [`connectCadence`](#connectcadenceoptions):
the first reading after connecting has no cadence.

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
yield a real `0`. Handle both: a `0` reading and a reading that stops arriving
mean the same thing.

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

With the defaults the waits are 1 s, 2 s, 4 s, 8 s, then 10 s — about 25
seconds in total before `'failed'`. A successful reconnect restores the full
budget for the next drop. For a long ride where giving up is never right, pass
`maxAttempts: Infinity`.

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
interface SensorConnection {
    readonly deviceId?: string;
    readonly deviceName: string;
    addListener(listener: (reading: SensorReading) => void): () => void;
    onStatusChange(listener: (status: ConnectionStatus) => void): () => void;
    disconnect(): void;
}
```

Both subscribe methods return an unsubscribe function.

Notifications can arrive while connection setup is still completing. The
newest such reading is retained and delivered synchronously when the first
`addListener` call attaches, so prepare your listener before subscribing. This
is a single setup sample, not a replay of earlier readings. On reconnect, a
setup sample is delivered to existing listeners after `connected`.

`ConnectionStatus` is `'connected' | 'disconnected' | 'reconnecting' | 'failed'`.
Note that the initial connection is signalled by `connectPower()` resolving,
not by a `'connected'` status event — that event fires before you can attach a
listener. `onStatusChange` reports what happens _after_ that:

| Situation                     | Statuses, in order                                            |
| ----------------------------- | ------------------------------------------------------------- |
| Drop, then a successful retry | `disconnected` → `reconnecting` → `connected`                 |
| Drop, and every retry fails   | `disconnected` → `reconnecting` (once per attempt) → `failed` |
| Drop with `reconnect: false`  | `disconnected`                                                |
| You call `disconnect()`       | `disconnected`, and no reconnection follows                   |

`'failed'` is final: that connection object will not try again. Call
`disconnect()` on it to release the device, then connect afresh — with
`previousDeviceId` if you kept it.

Listeners run synchronously inside the Bluetooth event handler, so keep them
quick. If a status listener calls `disconnect()`, its resulting status event is
delivered after the current event has reached all listeners, preserving
transition order. A listener that throws does not stop the others or disturb
reconnection: its error is passed to `reportError`, which puts it in the
console like any uncaught error and fires the window `error` event. Where
there is no `reportError`, as in Node, it is rethrown on a later tick.

### Reconnecting without a chooser

Persist `deviceId` and hand it back. The library never touches storage itself,
so where you keep it is up to you:

```ts
import { connectPower, type SensorConnection } from 'cycling-ble';

const connection = await connectPower();
if (connection.deviceId) {
    localStorage.setItem('powerDeviceId', connection.deviceId);
}

// Next session. Try the saved device first, and fall back to the chooser if
// it is gone — connectPower rejects rather than prompting when it cannot
// find it.
async function connectRemembered(): Promise<SensorConnection> {
    const saved = localStorage.getItem('powerDeviceId');
    if (saved) {
        try {
            return await connectPower({ previousDeviceId: saved });
        } catch {
            localStorage.removeItem('powerDeviceId');
        }
    }
    return connectPower();
}
```

This relies on `navigator.bluetooth.getDevices()`, which requires the user to
have previously granted access to that device. It rejects rather than falling
back to a chooser prompt, so you can tell the two situations apart. The
rejection says which case it hit:

- the device is no longer permitted — `classifyBluetoothError` reports
  `not-found`;
- the browser does not support `getDevices()` at all — `classifyBluetoothError`
  reports `unavailable` with `canRetry: false`, because retrying cannot help
  and there is no point saving device ids;
- the lookup itself failed — the original error is the rejection's `cause`.

The chooser still needs a user gesture. A saved device that is switched off or
out of range can take a while to fail, and by then the browser may no longer
treat the click as recent enough to open a chooser. If the fallback is refused,
show a "Choose a sensor" button rather than retrying automatically.

### `classifyBluetoothError(error, options?)`

Browsers disagree on both the `name` and the wording of Web Bluetooth
failures. This turns one into a stable category plus renderable copy:

```ts
import { classifyBluetoothError } from 'cycling-ble';

try {
    await connectPower();
} catch (error) {
    const { kind, title, message, suggestions, canRetry } = classifyBluetoothError(error, {
        sensorLabel: 'power meter',
    });
    if (kind !== 'cancelled') showDialog(title, message, suggestions, canRetry);
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

const { powerW, cadenceRpm } = parseIndoorBikeData(dataView);

// The two cadence parsers are stateful: thread `state` through successive
// calls, starting from initialCadenceState. That starting object is frozen
// and shared, so reassign your variable — never write to it.
let state = initialCadenceState;
const result = parseCadenceMeasurement(dataView, state);
state = result.state;
```

Every parser throws a `RangeError` when a packet is shorter than its flags say
it should be. The connect functions catch that and log it; if you call a parser
directly, catch it yourself. Parsers never mutate the `state` they are given.

### `cycling-ble/mock`

Simulated sensors with the same shape as a real connection, for demos, UI work
without hardware, and end-to-end tests:

`createMockPowerSensor`, `createMockHeartRateSensor`, and
`createMockCadenceSensor` each take `{ deviceName?, intervalMs?, autoStart? }`
and generate plausible values on an interval until `disconnect()`.

```ts
import { createMockPowerSensor } from 'cycling-ble/mock';

const sensor = createMockPowerSensor({ intervalMs: 1000 });
sensor.addListener((reading) => console.log(reading.power));
sensor.disconnect();

// Or drive it yourself, which is what you want in a test — no wall-clock wait.
const manual = createMockPowerSensor({ autoStart: false });
manual.emit({ power: 250 });

// Walk a UI through a dropout without switching a sensor off.
manual.simulateStatus('disconnected');
manual.simulateStatus('reconnecting');
manual.simulateStatus('connected');
```

`simulateStatus` reports a status to `onStatusChange` listeners as a real
connection would. Readings flow only while the simulated status is
`'connected'`, so after `'disconnected'`, `'reconnecting'`, or `'failed'` the
mock goes quiet — generated readings and `emit()` calls alike — until it is
sent `'connected'` again. After `disconnect()` it is ignored.

Every listener receives each reading even if one throws. Unlike a real
connection, a mock then rethrows the first error from `emit()` or
`disconnect()`, so an assertion that fails inside a listener fails the test
that called it.

## Implemented services

| Service                   | UUID     | Characteristic            | Yields             |
| ------------------------- | -------- | ------------------------- | ------------------ |
| Cycling Power             | `0x1818` | Cycling Power Measurement | `power`, `cadence` |
| Heart Rate                | `0x180D` | Heart Rate Measurement    | `heartRate`        |
| Cycling Speed and Cadence | `0x1816` | CSC Measurement           | `cadence`          |
| Fitness Machine (FTMS)    | `0x1826` | Indoor Bike Data          | `power`, `cadence` |

Only instantaneous power and cadence are decoded. Speed, distance,
resistance, pedal balance, and torque are parsed past but not reported.

## Known limitations

- **One device, two connections.** A page has one GATT connection per physical
  device, so `connectPower` and `connectCadence` on the same device share it.
  Calling `disconnect()` on one drops the link under the other, whose
  automatic reconnection then brings it back. A power meter that reports
  crank data needs only `connectPower`, which already yields its cadence.
- **FTMS Resistance Level width.** FTMS v1.0 gives this field as two bytes and
  the later Bluetooth specification supplement gives one. The parser follows
  FTMS v1.0. A trainer that follows the other reading _and_ reports resistance
  would decode power incorrectly. No such trainer has been reported.

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

The package runs on Node 22 or later. Working on it needs the Node in `.nvmrc`
(`nvm use`) and pnpm 12, pinned in `package.json`: run `corepack enable pnpm`.
pnpm 12 needs Corepack 0.34.5 or later, which Node 24 ships and Node 22.21 does not.

```sh
pnpm install
pnpm test               # run the suite
pnpm run test:coverage  # run it with coverage, failing below the thresholds
pnpm run build && pnpm run test:package # check the packed artifact in isolation
pnpm run check          # types, lint, format, coverage, build, packed-package check
```

Tests use Node's built-in runner. `test/helpers/fake-bluetooth.ts` fakes the
small slice of Web Bluetooth the connect layer touches, so connection,
reconnection, and teardown logic run without a browser or a sensor. Parser
tests build packets byte by byte from the Bluetooth specifications.

### Manual releases

Update the version in `package.json` and the changelog, then commit the release
changes. Set `NPM_TOKEN` in the ignored `.env` file at the repository root.

```sh
pnpm run release:dry-run # validate the release without publishing
pnpm run release         # validate, publish to npm, and verify its integrity
pnpm run release:verify  # resume verification if npm is still processing
```

The release script requires a clean tracked working tree and runs the full
check in a temporary export of the committed source. It packs and inspects that
same source, reads `.env` as data, and authenticates through a temporary npm
configuration. The token is redacted from command output and kept out of Git
and the package. An already-published version is refused. Local releases do
not include CI provenance. npm may take several minutes to process a new
release. The script waits for the registry and saves a credential-free receipt
in ignored `.releases/`; use `release:verify` to resume verification without
submitting the version again.

Push the release commit and its matching `v*` tag to record the released source;
tags do not trigger publication. GitHub workflows are currently removed.

## License

MIT © Christian Olsson
