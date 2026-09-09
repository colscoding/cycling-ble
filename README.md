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

### `ConnectOptions`

| Option             | Type                        | Default                 | Purpose                                                         |
| ------------------ | --------------------------- | ----------------------- | --------------------------------------------------------------- |
| `previousDeviceId` | `string`                    | —                       | Reconnect to a known device without showing the chooser         |
| `logger`           | `Logger`                    | no-op                   | Where the library logs; pass `console` to see it                |
| `reconnect`        | `ReconnectOptions \| false` | 5 attempts, 1 s backoff | Automatic reconnection tuning, or `false` to handle it yourself |
| `bluetooth`        | `BluetoothAdapter`          | `navigator.bluetooth`   | Supply a polyfill or a test fake                                |

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
listener. `onStatusChange` reports what happens _after_ that.

### Reconnecting without a chooser

Persist `deviceId` and hand it back. The library never touches storage itself,
so where you keep it is up to you:

```ts
const connection = await connectPower();
if (connection.deviceId) {
    localStorage.setItem('powerDeviceId', connection.deviceId);
}

// Next session. Fall back to a normal chooser prompt if the saved device is
// gone — connectPower rejects rather than prompting when it cannot find it.
const saved = localStorage.getItem('powerDeviceId');
try {
    const reconnected = await connectPower(saved ? { previousDeviceId: saved } : {});
} catch {
    const fresh = await connectPower();
}
```

This relies on `navigator.bluetooth.getDevices()`, which requires the user to
have previously granted access to that device. It rejects rather than falling
back to a chooser prompt, so you can tell the two situations apart.

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

## Implemented services

| Service                   | UUID     | Characteristic            | Yields             |
| ------------------------- | -------- | ------------------------- | ------------------ |
| Cycling Power             | `0x1818` | Cycling Power Measurement | `power`            |
| Heart Rate                | `0x180D` | Heart Rate Measurement    | `heartRate`        |
| Cycling Speed and Cadence | `0x1816` | CSC Measurement           | `cadence`          |
| Fitness Machine (FTMS)    | `0x1826` | Indoor Bike Data          | `power`, `cadence` |

Only instantaneous power and cadence are decoded. Speed, distance,
resistance, pedal balance, and torque are parsed past but not reported.

## Tested on

The library is covered by a test suite that drives a simulated GATT stack, and
that suite runs in CI. That verifies decoding and connection logic; it does not
verify any particular device.

Hardware confirmed to work is listed here, and nothing is claimed that has not
actually been ridden with. If your sensor works — or doesn't — an issue saying
which model would genuinely help.

- _(none recorded yet)_

## License

MIT © Christian Olsson
