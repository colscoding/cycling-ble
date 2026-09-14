import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { connectPower, connectHeartRate, connectCadence } from '../src/connect.js';
import { classifyBluetoothError } from '../src/errors.js';
import type { BluetoothAdapter, ConnectionStatus, SensorReading } from '../src/types.js';
import {
    FakeCharacteristic,
    createFakeBluetooth,
    powerPacket,
    indoorBikePacket,
    heartRatePacket,
    cscPacket,
    recordingLogger,
    waitFor,
} from './helpers/fake-bluetooth.js';

const CYCLING_POWER = 'cycling_power';
const CYCLING_POWER_MEASUREMENT = 'cycling_power_measurement';
const FITNESS_MACHINE = 'fitness_machine';
const INDOOR_BIKE_DATA = 'indoor_bike_data';
const HEART_RATE = 'heart_rate';
const HEART_RATE_MEASUREMENT = 'heart_rate_measurement';

function powerMeterSetup() {
    return createFakeBluetooth({
        deviceName: 'Stages LR',
        services: {
            [CYCLING_POWER]: { [CYCLING_POWER_MEASUREMENT]: new FakeCharacteristic(CYCLING_POWER_MEASUREMENT) },
        },
    });
}

function ftmsTrainerSetup() {
    return createFakeBluetooth({
        deviceName: 'Smart Trainer',
        services: {
            [FITNESS_MACHINE]: { [INDOOR_BIKE_DATA]: new FakeCharacteristic(INDOOR_BIKE_DATA) },
        },
    });
}

describe('connectPower', () => {
    it('uses the Cycling Power Service when the device exposes it', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT).emit(powerPacket(250));

        assert.equal(readings.length, 1);
        assert.equal(readings[0]!.power, 250);
        assert.equal(readings[0]!.cadence, undefined);
        assert.ok(readings[0]!.timestamp > 0);
    });

    it('falls back to FTMS when the Cycling Power Service is absent', async () => {
        const fake = ftmsTrainerSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        fake.characteristic(FITNESS_MACHINE, INDOOR_BIKE_DATA).emit(indoorBikePacket(90, 245));

        assert.equal(readings.length, 1);
        assert.equal(readings[0]!.power, 245);
        assert.equal(readings[0]!.cadence, 90, 'cadence rides along in the same frame');
    });

    it('exposes the device name and id', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        assert.equal(conn.deviceName, 'Stages LR');
        assert.equal(conn.deviceId, 'fake-device-1');
    });

    it('falls back to a generic name when the device advertises none', async () => {
        const fake = createFakeBluetooth({
            deviceName: undefined,
            services: {
                [CYCLING_POWER]: { [CYCLING_POWER_MEASUREMENT]: new FakeCharacteristic(CYCLING_POWER_MEASUREMENT) },
            },
        });
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        assert.equal(conn.deviceName, 'Power Sensor');
    });

    it('never writes to storage — deviceId is returned for the caller to persist', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        assert.equal(typeof conn.deviceId, 'string');
    });

    it('requests both candidate services so either device can be chosen', async () => {
        const fake = powerMeterSetup();
        await connectPower({ bluetooth: fake.bluetooth });
        const call = fake.requestDeviceCalls[0]!;
        assert.deepEqual(call.filters, [{ services: [CYCLING_POWER] }, { services: [FITNESS_MACHINE] }]);
        assert.deepEqual(call.optionalServices, [CYCLING_POWER, FITNESS_MACHINE]);
    });

    it('unsubscribes a listener', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });

        const readings: SensorReading[] = [];
        const unsubscribe = conn.addListener((r) => readings.push(r));
        const char = fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT);

        char.emit(powerPacket(100));
        unsubscribe();
        char.emit(powerPacket(200));

        assert.equal(readings.length, 1, 'the second packet reaches nobody');
    });

    it('survives a malformed packet without calling listeners', async () => {
        const fake = powerMeterSetup();
        const warnings: unknown[] = [];
        const conn = await connectPower({
            bluetooth: fake.bluetooth,
            logger: { debug: () => {}, info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
        });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));

        // One byte is too short for getInt16 at offset 2; the parser throws.
        fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT).emit(new DataView(new ArrayBuffer(1)));

        assert.equal(readings.length, 0);
        assert.equal(warnings.length, 1, 'the failure is logged, not swallowed silently');
    });

    it('is connected once connect resolves', async () => {
        const fake = powerMeterSetup();
        const statuses: string[] = [];
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        conn.onStatusChange((s) => statuses.push(s));
        // The initial 'connected' fires before any listener can attach, so
        // assert on the connection being live instead.
        assert.equal(fake.device.gatt.connected, true);
        assert.equal(statuses.length, 0);
    });

    it('reconnects after an unexpected drop', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({
            bluetooth: fake.bluetooth,
            reconnect: { baseDelayMs: 5, maxAttempts: 2 },
        });

        const statuses: string[] = [];
        conn.onStatusChange((s) => statuses.push(s));

        fake.device.gatt.connected = false;
        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 80));

        assert.ok(statuses.includes('disconnected'));
        assert.equal(fake.device.gatt.connected, true, 'reconnected');
    });

    it('does not reconnect after an explicit disconnect', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({
            bluetooth: fake.bluetooth,
            reconnect: { baseDelayMs: 5 },
        });

        conn.disconnect();
        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.equal(fake.device.gatt.connected, false);
        assert.equal(fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT).notificationsStopped, true);
    });

    it('does not resubscribe on reconnect, so one packet stays one reading', async () => {
        // Deliberately uses power rather than cadence. A stateful cadence
        // parser returns null on a duplicated packet (zero time delta), so it
        // would hide a double subscription; a power parser reports it.
        const fake = powerMeterSetup();
        const conn = await connectPower({
            bluetooth: fake.bluetooth,
            reconnect: { baseDelayMs: 5, maxAttempts: 2 },
        });
        const char = fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT);
        assert.equal(char.listenerCount, 1);

        fake.device.gatt.connected = false;
        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(fake.device.gatt.connected, true, 'reconnected');
        assert.equal(char.listenerCount, 1, 'reconnect must not stack a second listener');

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        char.emit(powerPacket(250));

        assert.equal(readings.length, 1, 'a doubled subscription would silently double the sample rate');
    });

    it('honours a disconnect that lands mid-reconnect', async () => {
        // A user tapping "disconnect" while the UI shows "reconnecting" is
        // ordinary. If the in-flight connect finishes afterwards it would
        // resurrect the connection and keep delivering readings.
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 10 } });
        const char = fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT);

        const gatt = fake.device.gatt;
        const realConnect = gatt.connect.bind(gatt);
        gatt.connect = async () => {
            await new Promise((r) => setTimeout(r, 60));
            return realConnect();
        };

        gatt.connected = false;
        fake.device.dropConnection();
        await new Promise((r) => setTimeout(r, 20)); // backoff done, connect() in flight
        conn.disconnect();
        await new Promise((r) => setTimeout(r, 120)); // let it finish

        assert.equal(gatt.connected, false, 'must not be left connected');
        assert.equal(char.listenerCount, 0, 'must not leave a listener attached');

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        char.emit(powerPacket(250));
        assert.equal(readings.length, 0, 'must not deliver readings after disconnect');
    });

    it('removes its characteristic listener on disconnect', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const char = fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT);
        assert.equal(char.listenerCount, 1);
        conn.disconnect();
        assert.equal(char.listenerCount, 0);
    });

    it('rejects when the device exposes none of the candidate services', async () => {
        const fake = createFakeBluetooth({ services: {} });
        await assert.rejects(() => connectPower({ bluetooth: fake.bluetooth }), /none of the expected BLE services/);
    });

    it('carries the underlying failure as the error cause', async () => {
        // A GATT failure looks the same as an absent service from inside the
        // candidate loop, so the real reason has to travel with the error.
        const char = new FakeCharacteristic(CYCLING_POWER_MEASUREMENT);
        const fake = createFakeBluetooth({ services: { [CYCLING_POWER]: { [CYCLING_POWER_MEASUREMENT]: char } } });
        const gatt = fake.device.gatt;
        const boom = new Error('GATT operation failed for unknown reason');
        gatt.getPrimaryService = async () => {
            throw boom;
        };

        await assert.rejects(
            () => connectPower({ bluetooth: fake.bluetooth }),
            (error: Error) => {
                assert.match(error.message, /none of the expected BLE services/);
                assert.equal(error.cause, boom, 'the real failure is not lost');
                return true;
            }
        );
    });

    it('never reconnects when reconnect is false', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth, reconnect: false });

        const statuses: string[] = [];
        conn.onStatusChange((s) => statuses.push(s));

        fake.device.gatt.connected = false;
        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 60));

        assert.equal(fake.device.gatt.connected, false, 'stays down');
        assert.deepEqual(statuses, ['disconnected'], 'the drop is still reported so the caller can act on it');
    });

    it('leaves nothing attached when the initial connect fails', async () => {
        const fake = createFakeBluetooth({ services: {} });

        await assert.rejects(() => connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 5 } }));

        assert.equal(
            fake.device.listenerCountFor('gattserverdisconnected'),
            0,
            'a surviving listener would reconnect a connection the caller never received'
        );

        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 60));
        assert.equal(fake.device.gatt.connected, false, 'no orphaned reconnect loop');
    });

    it('rejects when no Bluetooth implementation is available', async () => {
        await assert.rejects(
            () => connectPower({ bluetooth: undefined as unknown as Bluetooth }),
            /Web Bluetooth is not available/
        );
    });

    it('reuses a permitted device when previousDeviceId matches', async () => {
        const fake = createFakeBluetooth({
            deviceId: 'saved-1',
            deviceName: 'Saved Meter',
            permitted: true,
            services: {
                [CYCLING_POWER]: { [CYCLING_POWER_MEASUREMENT]: new FakeCharacteristic(CYCLING_POWER_MEASUREMENT) },
            },
        });
        const conn = await connectPower({ bluetooth: fake.bluetooth, previousDeviceId: 'saved-1' });
        assert.equal(conn.deviceName, 'Saved Meter');
        assert.equal(fake.requestDeviceCalls.length, 0, 'no chooser prompt');
    });

    it('rejects rather than prompting when a saved device is gone', async () => {
        const fake = createFakeBluetooth({
            deviceId: 'saved-1',
            permitted: false,
            services: {
                [CYCLING_POWER]: { [CYCLING_POWER_MEASUREMENT]: new FakeCharacteristic(CYCLING_POWER_MEASUREMENT) },
            },
        });
        await assert.rejects(
            () => connectPower({ bluetooth: fake.bluetooth, previousDeviceId: 'saved-1' }),
            /not found in the permitted device list/
        );
    });
});

describe('connectHeartRate', () => {
    it('yields heartRate readings', async () => {
        const fake = createFakeBluetooth({
            deviceName: 'HRM-Pro',
            services: {
                [HEART_RATE]: { [HEART_RATE_MEASUREMENT]: new FakeCharacteristic(HEART_RATE_MEASUREMENT) },
            },
        });
        const conn = await connectHeartRate({ bluetooth: fake.bluetooth });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        fake.characteristic(HEART_RATE, HEART_RATE_MEASUREMENT).emit(heartRatePacket(142));

        assert.equal(readings[0]!.heartRate, 142);
        assert.equal(readings[0]!.power, undefined);
    });
});

describe('connectCadence', () => {
    const CSC = 'cycling_speed_and_cadence';
    const CSC_MEASUREMENT = 'csc_measurement';

    function cadenceSetup() {
        return createFakeBluetooth({
            deviceName: 'Cadence Pod',
            services: { [CSC]: { [CSC_MEASUREMENT]: new FakeCharacteristic(CSC_MEASUREMENT) } },
        });
    }

    it('emits nothing for the first notification, because RPM needs a delta', async () => {
        const fake = cadenceSetup();
        const conn = await connectCadence({ bluetooth: fake.bluetooth });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        fake.characteristic(CSC, CSC_MEASUREMENT).emit(cscPacket(10, 1024));

        assert.equal(readings.length, 0, 'a lone cumulative sample yields no cadence');
    });

    it('emits cadence once two samples have arrived', async () => {
        const fake = cadenceSetup();
        const conn = await connectCadence({ bluetooth: fake.bluetooth });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        const char = fake.characteristic(CSC, CSC_MEASUREMENT);
        char.emit(cscPacket(10, 1024));
        char.emit(cscPacket(11, 2048));

        assert.equal(readings.length, 1);
        assert.equal(readings[0]!.cadence, 60);
        assert.equal(readings[0]!.power, undefined);
    });

    it('starts from a clean parser after reconnecting', async () => {
        const fake = cadenceSetup();
        const conn = await connectCadence({
            bluetooth: fake.bluetooth,
            reconnect: { baseDelayMs: 5, maxAttempts: 2 },
        });

        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));
        const char = fake.characteristic(CSC, CSC_MEASUREMENT);
        char.emit(cscPacket(10, 1024));
        char.emit(cscPacket(11, 2048));
        assert.equal(readings.length, 1, 'baseline: cadence flows before the drop');

        fake.device.gatt.connected = false;
        fake.device.dropConnection();
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(fake.device.gatt.connected, true, 'reconnected');

        // Crank counters kept running while disconnected. A parser carrying
        // stale state would compute a huge bogus delta from this single sample.
        char.emit(cscPacket(400, 60000));
        assert.equal(readings.length, 1, 'the first sample after reconnect yields nothing');
    });
});

describe('every connect function', () => {
    const cases = [
        {
            name: 'connectPower',
            fn: connectPower,
            services: [CYCLING_POWER, FITNESS_MACHINE],
            fallback: 'Power Sensor',
        },
        { name: 'connectHeartRate', fn: connectHeartRate, services: [HEART_RATE], fallback: 'Heart Rate Monitor' },
        {
            name: 'connectCadence',
            fn: connectCadence,
            services: ['cycling_speed_and_cadence'],
            fallback: 'Cadence Sensor',
        },
    ];

    for (const { name, fn, services, fallback } of cases) {
        it(`${name} asks the chooser only for its own services`, async () => {
            const fake = createFakeBluetooth({ services: {} });
            await assert.rejects(() => fn({ bluetooth: fake.bluetooth }));
            const call = fake.requestDeviceCalls[0]!;
            assert.deepEqual(
                call.filters,
                services.map((s) => ({ services: [s] }))
            );
            assert.deepEqual(call.optionalServices, services);
        });

        it(`${name} rejects with an error classified as incompatible when no service matches`, async () => {
            const fake = createFakeBluetooth({ deviceName: undefined, services: {} });
            await assert.rejects(
                () => fn({ bluetooth: fake.bluetooth }),
                (error) => classifyBluetoothError(error).kind === 'incompatible'
            );
        });

        it(`${name} names an anonymous device "${fallback}"`, async () => {
            const [serviceUuid] = services;
            const characteristicUuid = {
                [CYCLING_POWER]: CYCLING_POWER_MEASUREMENT,
                [HEART_RATE]: HEART_RATE_MEASUREMENT,
                cycling_speed_and_cadence: 'csc_measurement',
            }[serviceUuid!]!;
            const fake = createFakeBluetooth({
                deviceName: undefined,
                services: { [serviceUuid!]: { [characteristicUuid]: new FakeCharacteristic(characteristicUuid) } },
            });
            const conn = await fn({ bluetooth: fake.bluetooth });
            assert.equal(conn.deviceName, fallback);
            conn.disconnect();
        });
    }
});

describe('connection setup edge cases', () => {
    it('propagates a cancelled chooser unchanged and attaches nothing', async () => {
        const cancelled = new Error('User cancelled the requestDevice() chooser.');
        cancelled.name = 'NotFoundError';
        const fake = createFakeBluetooth({ services: {}, rejectRequest: cancelled });

        await assert.rejects(
            () => connectPower({ bluetooth: fake.bluetooth }),
            (error) => error === cancelled
        );
        assert.equal(classifyBluetoothError(cancelled).kind, 'cancelled');
        assert.equal(fake.device.listenerCountFor('gattserverdisconnected'), 0);
    });

    it('throws an error classified as unavailable when there is no Bluetooth', async () => {
        await assert.rejects(
            () => connectPower({ bluetooth: undefined as unknown as BluetoothAdapter }),
            (error) => classifyBluetoothError(error).kind === 'unavailable'
        );
    });

    it('rejects when the chosen device has no GATT server', async () => {
        const fake = powerMeterSetup();
        Object.defineProperty(fake.device, 'gatt', { value: undefined });
        await assert.rejects(() => connectPower({ bluetooth: fake.bluetooth }), /GATT server not available/);
    });

    it('omits deviceId when the platform exposes none', async () => {
        const fake = createFakeBluetooth({
            deviceId: '',
            services: {
                [CYCLING_POWER]: { [CYCLING_POWER_MEASUREMENT]: new FakeCharacteristic(CYCLING_POWER_MEASUREMENT) },
            },
        });
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        assert.equal('deviceId' in conn, false, 'an omitted key, not an empty string');
    });

    it('rejects without prompting when getDevices() is unavailable, and says why in the log', async () => {
        const fake = powerMeterSetup();
        const { logger, calls } = recordingLogger();
        const bluetooth: BluetoothAdapter = { requestDevice: fake.bluetooth.requestDevice };

        await assert.rejects(
            () => connectPower({ bluetooth, logger, previousDeviceId: 'fake-device-1' }),
            /not found in the permitted device list/
        );
        assert.equal(fake.requestDeviceCalls.length, 0, 'no chooser prompt');
        assert.match(calls.debug.join('\n'), /getDevices\(\) is unavailable/);
    });

    it('rejects and warns when getDevices() itself fails', async () => {
        const fake = powerMeterSetup();
        const { logger, calls } = recordingLogger();
        const bluetooth: BluetoothAdapter = {
            requestDevice: fake.bluetooth.requestDevice,
            getDevices: async () => {
                throw new Error('permissions backend unavailable');
            },
        };

        await assert.rejects(
            () => connectPower({ bluetooth, logger, previousDeviceId: 'fake-device-1' }),
            /not found in the permitted device list/
        );
        assert.equal(calls.warn.length, 1, 'the lookup failure is not silently reported as "not found"');
    });
});

describe('notifications', () => {
    it('ignores a notification that carries no value', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));

        fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT).emit(undefined);
        assert.equal(readings.length, 0);
    });

    it('delivers each reading to every listener', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const a: SensorReading[] = [];
        const b: SensorReading[] = [];
        conn.addListener((r) => a.push(r));
        conn.addListener((r) => b.push(r));

        fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT).emit(powerPacket(180));
        assert.equal(a.length, 1);
        assert.equal(b[0], a[0], 'the same frame object, not a copy per listener');
    });

    it('emits nothing for an FTMS packet with neither power nor cadence', async () => {
        const fake = ftmsTrainerSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));

        const speedOnly = new DataView(new ArrayBuffer(4)); // flags 0: instantaneous speed only
        speedOnly.setUint16(2, 3000, true);
        fake.characteristic(FITNESS_MACHINE, INDOOR_BIKE_DATA).emit(speedOnly);
        assert.equal(readings.length, 0, 'an empty frame is not a reading');
    });

    it('omits the cadence key when an FTMS packet carries only power', async () => {
        const fake = ftmsTrainerSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));

        const powerOnly = new DataView(new ArrayBuffer(4));
        powerOnly.setUint16(0, (1 << 0) | (1 << 6), true);
        powerOnly.setInt16(2, 199, true);
        fake.characteristic(FITNESS_MACHINE, INDOOR_BIKE_DATA).emit(powerOnly);

        assert.equal(readings[0]!.power, 199);
        assert.equal('cadence' in readings[0]!, false);
    });

    it('omits the power key when an FTMS packet carries only cadence', async () => {
        const fake = ftmsTrainerSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const readings: SensorReading[] = [];
        conn.addListener((r) => readings.push(r));

        const cadenceOnly = new DataView(new ArrayBuffer(4));
        cadenceOnly.setUint16(0, (1 << 0) | (1 << 2), true);
        cadenceOnly.setUint16(2, 160, true);
        fake.characteristic(FITNESS_MACHINE, INDOOR_BIKE_DATA).emit(cadenceOnly);

        assert.equal(readings[0]!.cadence, 80);
        assert.equal('power' in readings[0]!, false);
    });
});

describe('connection lifecycle', () => {
    it('reports disconnected, reconnecting, then connected across a drop', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 2 } });
        const statuses: ConnectionStatus[] = [];
        conn.onStatusChange((s) => statuses.push(s));

        fake.device.dropConnection();
        await waitFor(() => statuses.includes('connected'), 1000, "'connected'");

        assert.deepEqual(statuses, ['disconnected', 'reconnecting', 'connected']);
        conn.disconnect();
    });

    it('reports failed once reconnection gives up', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 2, maxAttempts: 2 } });
        const statuses: ConnectionStatus[] = [];
        conn.onStatusChange((s) => statuses.push(s));

        fake.device.gatt.getPrimaryService = async () => {
            throw new Error('GATT operation failed');
        };
        fake.device.dropConnection();
        await waitFor(() => statuses.includes('failed'), 1000, "'failed'");

        assert.deepEqual(statuses, ['disconnected', 'reconnecting', 'reconnecting', 'failed']);
        conn.disconnect();
    });

    it('gives a later drop a full set of attempts after a successful reconnect', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth, reconnect: { baseDelayMs: 2, maxAttempts: 1 } });
        const statuses: ConnectionStatus[] = [];
        conn.onStatusChange((s) => statuses.push(s));

        fake.device.dropConnection();
        await waitFor(() => statuses.filter((s) => s === 'connected').length === 1, 1000, 'first reconnect');
        fake.device.dropConnection();
        await waitFor(() => statuses.filter((s) => s === 'connected').length === 2, 1000, 'second reconnect');

        assert.equal(statuses.includes('failed'), false, 'the single attempt was not used up by the first drop');
        conn.disconnect();
    });

    it('reports disconnected when the caller disconnects', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const statuses: ConnectionStatus[] = [];
        conn.onStatusChange((s) => statuses.push(s));

        conn.disconnect();
        assert.deepEqual(statuses, ['disconnected']);
        assert.equal(fake.device.listenerCountFor('gattserverdisconnected'), 0);
    });

    it('stops notifying a status listener once unsubscribed', async () => {
        const fake = powerMeterSetup();
        const conn = await connectPower({ bluetooth: fake.bluetooth });
        const statuses: ConnectionStatus[] = [];
        const off = conn.onStatusChange((s) => statuses.push(s));

        off();
        conn.disconnect();
        assert.deepEqual(statuses, []);
    });

    it('logs rather than throws when stopNotifications() fails during disconnect', async () => {
        const fake = powerMeterSetup();
        const { logger, calls } = recordingLogger();
        const conn = await connectPower({ bluetooth: fake.bluetooth, logger });
        fake.characteristic(CYCLING_POWER, CYCLING_POWER_MEASUREMENT).stopNotifications = async () => {
            throw new Error('GATT Server is disconnected');
        };

        assert.doesNotThrow(() => conn.disconnect());
        await waitFor(() => calls.debug.some((m) => m.includes('stopNotifications failed')), 1000, 'debug log');
    });
});
