import type {
    BluetoothAdapter,
    ConnectOptions,
    ConnectionStatus,
    ReadingListener,
    SensorConnection,
    SensorReading,
    StatusListener,
} from './types.js';
import { createListeners, reportError } from './listeners.js';
import { noopLogger } from './logger.js';
import { createReconnectionManager } from './reconnection.js';
import {
    initialCadenceState,
    parseCadenceMeasurement,
    parseHeartRateMeasurement,
    parseIndoorBikeData,
    parsePowerMeasurement,
    type CadenceState,
} from './parsers/index.js';

/** Metrics decoded from one notification, before a timestamp is attached. */
type ReadingFields = Omit<SensorReading, 'timestamp'>;

/**
 * Decodes one characteristic notification. Returns null to emit nothing —
 * a cadence sample with no usable delta, for instance.
 *
 * Parsers may be stateful, so a fresh one is created per connection and again
 * on every reconnect, which resets deltas that a gap would otherwise corrupt.
 */
type ValueParser = (value: DataView) => ReadingFields | null;

/** One GATT service/characteristic pair a sensor might speak. */
interface ServiceCandidate {
    serviceUuid: BluetoothServiceUUID;
    characteristicUuid: BluetoothCharacteristicUUID;
    createParser: () => ValueParser;
}

interface SensorConfig {
    /** Probed in order; the first service the device exposes wins. */
    candidates: ServiceCandidate[];
    defaultDeviceName: string;
    sensorName: string;
}

/**
 * Look up an already-permitted device, so reconnecting skips the chooser.
 *
 * Rejects rather than prompting in every failure case, and says which one:
 * a device that is gone, a browser that cannot look devices up at all, and a
 * lookup that failed need different responses from the caller.
 */
async function findPermittedDevice(bluetooth: BluetoothAdapter, deviceId: string): Promise<BluetoothDevice> {
    if (typeof bluetooth.getDevices !== 'function') {
        throw new Error(
            `Cannot reconnect to saved device ${deviceId} without a chooser: ` +
                'this browser does not support getDevices()'
        );
    }

    let devices: BluetoothDevice[];
    try {
        // The adapter is typed structurally, so the concrete Web Bluetooth
        // shapes are reasserted here, where the real typings are available.
        devices = (await bluetooth.getDevices()) as BluetoothDevice[];
    } catch (error) {
        throw new Error(`Could not look up saved device ${deviceId}`, { cause: error });
    }

    const device = devices.find((d) => d.id === deviceId);
    if (!device) {
        throw new Error(`Device ${deviceId} is not found in the permitted device list`);
    }
    return device;
}

async function connectSensor(config: SensorConfig, options: ConnectOptions = {}): Promise<SensorConnection> {
    const {
        previousDeviceId,
        logger = noopLogger,
        reconnect,
        bluetooth = globalThis.navigator?.bluetooth as BluetoothAdapter | undefined,
    } = options;

    if (!bluetooth) {
        throw new Error(
            'Web Bluetooth is not available. Use a Chromium-based browser over HTTPS or localhost, ' +
                'or pass a `bluetooth` implementation explicitly.'
        );
    }

    const serviceUuids = config.candidates.map((c) => c.serviceUuid);

    const device = previousDeviceId
        ? await findPermittedDevice(bluetooth, previousDeviceId)
        : ((await bluetooth.requestDevice({
              filters: config.candidates.map((c) => ({ services: [c.serviceUuid] })),
              optionalServices: serviceUuids,
          })) as BluetoothDevice);

    const gatt = device.gatt;
    if (!gatt) {
        throw new Error('GATT server not available on the selected device');
    }

    const deviceName = device.name || config.defaultDeviceName;
    const readingListeners = createListeners<SensorReading>();
    const statusListeners = createListeners<ConnectionStatus>();

    let characteristic: BluetoothRemoteGATTCharacteristic | null = null;
    let parseValue: ValueParser = () => null;

    // Neither a notification nor a reconnect has a caller to hand a listener's
    // error back to. Reporting it instead of throwing also keeps the caller's
    // bugs out of the reconnection logic: a throw from a 'connected' listener
    // used to register as a failed attempt, and retried forever.
    const notifyStatus = (status: ConnectionStatus): void => {
        statusListeners.emit(status).forEach(reportError);
    };

    const reconnection = createReconnectionManager({
        sensorName: config.sensorName,
        ...(reconnect === undefined ? {} : { options: reconnect }),
        logger,
        onStatusChange: notifyStatus,
    });

    const handleValueChanged = (event: Event): void => {
        const target = event.target as BluetoothRemoteGATTCharacteristic;
        const value = target.value;
        if (!value) return;

        let fields: ReadingFields | null;
        try {
            fields = parseValue(value);
        } catch (error) {
            logger.warn(`Malformed BLE packet from ${deviceName} (${value.byteLength} bytes)`, error);
            return;
        }
        if (!fields) return;

        const reading: SensorReading = { timestamp: Date.now(), ...fields };
        readingListeners.emit(reading).forEach(reportError);
    };

    /**
     * True when the caller disconnected while we were awaiting something. Every
     * step below spans an await, and a reconnect can be several seconds long,
     * so `disconnect()` can land at any point in here.
     */
    const abandoned = (): boolean => reconnection.isManualDisconnect();

    const connect = async (): Promise<void> => {
        const server = await gatt.connect();

        let selected: { characteristic: BluetoothRemoteGATTCharacteristic; createParser: () => ValueParser } | null =
            null;
        let lastCandidateError: unknown;
        for (const candidate of config.candidates) {
            try {
                const service = await server.getPrimaryService(candidate.serviceUuid);
                const char = await service.getCharacteristic(candidate.characteristicUuid);
                selected = { characteristic: char, createParser: candidate.createParser };
                break;
            } catch (error) {
                // Usually means the service is simply absent, but a GATT
                // failure looks identical here. Keep the last one so the
                // thrown error carries the real reason.
                lastCandidateError = error;
            }
        }

        if (!selected) {
            throw new Error(`${config.sensorName} exposes none of the expected BLE services`, {
                cause: lastCandidateError,
            });
        }

        await selected.characteristic.startNotifications();
        if (abandoned()) {
            gatt.disconnect();
            return;
        }

        // Everything below mutates connection state, and is deliberately after
        // the last await: a failure or an abandonment part-way through would
        // otherwise leave a half-wired connection behind.

        // Drop the previous connection's listener before rebinding. A browser
        // may hand back the same characteristic object on reconnect, and
        // subscribing twice delivers every notification twice — which silently
        // doubles the recorded sample rate rather than failing visibly.
        characteristic?.removeEventListener('characteristicvaluechanged', handleValueChanged);

        characteristic = selected.characteristic;
        parseValue = selected.createParser();
        characteristic.addEventListener('characteristicvaluechanged', handleValueChanged);

        reconnection.reset();
        notifyStatus('connected');
    };

    /**
     * One reconnect attempt. gatt.connect() can succeed and a later step still
     * fail, so a failed attempt closes the link rather than leaving it
     * half-open — otherwise it outlives 'failed' and holds the sensor, which
     * lets no other app or device connect to it.
     *
     * Closing the link fires gattserverdisconnected back at our own handler.
     * The reconnection manager ignores it: mid-cycle as a duplicate, and after
     * giving up because 'failed' is final.
     */
    const reconnectOnce = async (): Promise<void> => {
        try {
            await connect();
        } catch (error) {
            gatt.disconnect();
            throw error;
        }
    };

    const handleGattDisconnect = (): void => {
        if (!reconnection.isManualDisconnect()) {
            reconnection.handleDisconnect(reconnectOnce);
        }
    };
    device.addEventListener('gattserverdisconnected', handleGattDisconnect);

    try {
        await connect();
    } catch (error) {
        // The caller never receives a connection here, so nothing else can ever
        // clean this up. Left in place, the device listener would start a
        // reconnect loop on the next drop that no one holds a handle to.
        device.removeEventListener('gattserverdisconnected', handleGattDisconnect);
        reconnection.markManualDisconnect();
        gatt.disconnect();
        throw error;
    }

    const connection: SensorConnection = {
        deviceName,
        ...(device.id ? { deviceId: device.id } : {}),

        addListener(listener: ReadingListener): () => void {
            return readingListeners.add(listener);
        },

        onStatusChange(listener: StatusListener): () => void {
            return statusListeners.add(listener);
        },

        disconnect(): void {
            // Teardown often runs twice (an unmount and an unload handler, say);
            // the second call must not announce a second 'disconnected'.
            if (reconnection.isManualDisconnect()) return;
            reconnection.markManualDisconnect();
            device.removeEventListener('gattserverdisconnected', handleGattDisconnect);
            if (characteristic) {
                characteristic.removeEventListener('characteristicvaluechanged', handleValueChanged);
                characteristic.stopNotifications().catch((e) => logger.debug('stopNotifications failed', e));
            }
            gatt.disconnect();
            // The mock reports this too. A caller rendering state purely from
            // onStatusChange must not be left showing "connected".
            notifyStatus('disconnected');
        },
    };

    return connection;
}

/** Cycling Power Measurement: a single instantaneous power value. */
const cyclingPowerParser = (): ValueParser => (value) => ({ power: parsePowerMeasurement(value) });

/**
 * FTMS Indoor Bike Data: power and cadence arrive together, so both go into
 * the same frame rather than one of them leaving by a side channel.
 */
const indoorBikeParser = (): ValueParser => (value) => {
    const { powerW, cadenceRpm } = parseIndoorBikeData(value);
    if (powerW === null && cadenceRpm === null) return null;
    return {
        ...(powerW === null ? {} : { power: powerW }),
        ...(cadenceRpm === null ? {} : { cadence: cadenceRpm }),
    };
};

const heartRateParser = (): ValueParser => (value) => ({ heartRate: parseHeartRateMeasurement(value) });

/** CSC cadence is stateful: RPM is a delta, so each connection starts fresh. */
const cscCadenceParser = (): ValueParser => {
    let state: CadenceState = initialCadenceState;
    return (value) => {
        const result = parseCadenceMeasurement(value, state);
        state = result.state;
        return result.rpm === null ? null : { cadence: result.rpm };
    };
};

/**
 * Connect to a power source: a Cycling Power meter, or an FTMS smart trainer.
 *
 * The Cycling Power Service is preferred when present. An FTMS trainer also
 * reports cadence, which arrives in the same reading as the power it came with.
 */
export function connectPower(options?: ConnectOptions): Promise<SensorConnection> {
    return connectSensor(
        {
            candidates: [
                {
                    serviceUuid: 'cycling_power',
                    characteristicUuid: 'cycling_power_measurement',
                    createParser: cyclingPowerParser,
                },
                {
                    serviceUuid: 'fitness_machine',
                    characteristicUuid: 'indoor_bike_data',
                    createParser: indoorBikeParser,
                },
            ],
            defaultDeviceName: 'Power Sensor',
            sensorName: 'Power sensor',
        },
        options
    );
}

/** Connect to a heart rate monitor. */
export function connectHeartRate(options?: ConnectOptions): Promise<SensorConnection> {
    return connectSensor(
        {
            candidates: [
                {
                    serviceUuid: 'heart_rate',
                    characteristicUuid: 'heart_rate_measurement',
                    createParser: heartRateParser,
                },
            ],
            defaultDeviceName: 'Heart Rate Monitor',
            sensorName: 'Heart rate sensor',
        },
        options
    );
}

/** Connect to a cadence sensor speaking Cycling Speed and Cadence. */
export function connectCadence(options?: ConnectOptions): Promise<SensorConnection> {
    return connectSensor(
        {
            candidates: [
                {
                    serviceUuid: 'cycling_speed_and_cadence',
                    characteristicUuid: 'csc_measurement',
                    createParser: cscCadenceParser,
                },
            ],
            defaultDeviceName: 'Cadence Sensor',
            sensorName: 'Cadence sensor',
        },
        options
    );
}
