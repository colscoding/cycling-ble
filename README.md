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
(`0x1826`). An FTMS trainer yields cadence alongside power in the same reading.

### `connectHeartRate(options?)`

Connects to a Heart Rate Service (`0x180D`) monitor. Yields `heartRate`.

### `connectCadence(options?)`

Connects to a Cycling Speed and Cadence Service (`0x1816`) sensor. Yields
`cadence`. CSC reports cumulative crank counters, so the first notification
after connecting produces no reading — RPM only exists as a delta.

For the same reason, **a stopped crank produces no reading rather than a
`0 rpm` one**: the sensor repeats its last crank event, and there is no delta
to compute. If your UI shows cadence, treat a value that has not been updated
for a few seconds as zero.

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
quick. A listener that throws does not stop the others or disturb
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
- the browser does not support `getDevices()` at all, so there is no point
  saving device ids;
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
| `parseHeartRateMeasurement(view)`      | Heart Rate Measurement    | bpm (`number`)                               |
| `parseCadenceMeasurement(view, state)` | CSC Measurement           | `{ rpm, state }`, `rpm` may be null          |
| `parseIndoorBikeData(view)`            | FTMS Indoor Bike Data     | `{ powerW, cadenceRpm }`, either may be null |

```ts
import { parseIndoorBikeData, parseCadenceMeasurement, initialCadenceState } from 'cycling-ble/parsers';

const { powerW, cadenceRpm } = parseIndoorBikeData(dataView);

// parseCadenceMeasurement is the one stateful parser: thread its `state`
// through successive calls, starting from initialCadenceState.
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
```

Every listener receives each reading even if one throws. Unlike a real
connection, a mock then rethrows the first error from `emit()` or
`disconnect()`, so an assertion that fails inside a listener fails the test
that called it.

## Implemented services

| Service                   | UUID     | Characteristic            | Yields             |
| ------------------------- | -------- | ------------------------- | ------------------ |
| Cycling Power             | `0x1818` | Cycling Power Measurement | `power`            |
| Heart Rate                | `0x180D` | Heart Rate Measurement    | `heartRate`        |
| Cycling Speed and Cadence | `0x1816` | CSC Measurement           | `cadence`          |
| Fitness Machine (FTMS)    | `0x1826` | Indoor Bike Data          | `power`, `cadence` |

Only instantaneous power and cadence are decoded. Speed, distance,
resistance, pedal balance, and torque are parsed past but not reported.

## Known limitations

- **Cadence from a power meter.** Many crank power meters report cadence
  inside the Cycling Power Measurement rather than through a separate CSC
  service. That field is not decoded yet, so `connectPower` yields only
  `power` from such a meter.
- **One device, two connections.** A page has one GATT connection per physical
  device, so `connectPower` and `connectCadence` on the same device share it.
  Calling `disconnect()` on one drops the link under the other, whose
  automatic reconnection then brings it back.
- **FTMS Resistance Level width.** FTMS v1.0 gives this field as two bytes and
  the later Bluetooth specification supplement gives one. The parser follows
  FTMS v1.0. A trainer that follows the other reading _and_ reports resistance
  would decode power incorrectly. No such trainer has been reported.

## Tested on

The library is covered by a test suite that drives a simulated GATT stack, and
that suite runs in CI. That verifies decoding and connection logic; it does not
verify any particular device.

Hardware confirmed to work is listed here, and nothing is claimed that has not
actually been ridden with. If your sensor works — or doesn't — an issue saying
which model would genuinely help.

- _(none recorded yet)_

## Development

Requires Node 22 or later and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm test               # run the suite
pnpm run test:coverage  # run it with coverage, failing below the thresholds
pnpm run check          # everything CI runs: types, lint, format, coverage, build
```

Tests use Node's built-in runner. `test/helpers/fake-bluetooth.ts` fakes the
small slice of Web Bluetooth the connect layer touches, so connection,
reconnection, and teardown logic run without a browser or a sensor. Parser
tests build packets byte by byte from the Bluetooth specifications.

Releases are published to npm by CI when a `v*` tag is pushed.

## License

MIT © Christian Olsson
