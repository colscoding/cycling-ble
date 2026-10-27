import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPowerSensor, createMockHeartRateSensor, createMockCadenceSensor } from '../src/mock.js';
import type { ConnectionStatus, SensorReading } from '../src/types.js';
import { waitFor } from './helpers/fake-bluetooth.js';

describe('mock sensors', () => {
    it('satisfies the SensorConnection shape', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        assert.equal(typeof sensor.addListener, 'function');
        assert.equal(typeof sensor.onStatusChange, 'function');
        assert.equal(typeof sensor.disconnect, 'function');
        assert.equal(typeof sensor.deviceName, 'string');
        sensor.disconnect();
    });

    it('emits a reading on demand', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        sensor.emit({ power: 200 });
        assert.equal(readings.length, 1);
        assert.equal(readings[0]!.power, 200);
        assert.ok(readings[0]!.timestamp > 0);
        sensor.disconnect();
    });

    it('unsubscribes', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const readings: SensorReading[] = [];
        const off = sensor.addListener((r) => readings.push(r));
        sensor.emit({ power: 100 });
        off();
        sensor.emit({ power: 200 });
        assert.equal(readings.length, 1);
        sensor.disconnect();
    });

    it('generates plausible power while running', async () => {
        const sensor = createMockPowerSensor({ intervalMs: 5 });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        await waitFor(() => readings.length >= 2, 1000, 'two readings');
        sensor.disconnect();
        for (const r of readings) {
            assert.ok(r.power !== undefined && r.power >= 200 && r.power <= 250);
        }
    });

    it('generates plausible heart rate', async () => {
        const sensor = createMockHeartRateSensor({ intervalMs: 5 });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        // every() is true for an empty array, so first make sure there is something to check.
        await waitFor(() => readings.length >= 2, 1000, 'two readings');
        sensor.disconnect();
        assert.ok(readings.every((r) => r.heartRate !== undefined && r.heartRate >= 140 && r.heartRate <= 160));
    });

    it('generates plausible cadence', async () => {
        const sensor = createMockCadenceSensor({ intervalMs: 5 });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        await waitFor(() => readings.length >= 2, 1000, 'two readings');
        sensor.disconnect();
        assert.ok(readings.every((r) => r.cadence !== undefined && r.cadence >= 80 && r.cadence <= 100));
    });

    it('reports disconnected and stops emitting after disconnect', async () => {
        const sensor = createMockPowerSensor({ intervalMs: 5 });
        const statuses: string[] = [];
        sensor.onStatusChange((s) => statuses.push(s));
        sensor.disconnect();

        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        await new Promise((resolve) => setTimeout(resolve, 30));

        assert.deepEqual(statuses, ['disconnected']);
        assert.equal(readings.length, 0);
    });

    it('reports disconnected the same way a real connection does', () => {
        // The mock exists to stand in for a real connection. If the two report
        // different statuses, a UI driven by onStatusChange behaves differently
        // in demo mode than in production, and the tests hide it.
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: string[] = [];
        sensor.onStatusChange((s) => statuses.push(s));
        sensor.disconnect();
        assert.deepEqual(statuses, ['disconnected']);
    });

    it('ignores emit() once disconnected', () => {
        // A real connection drops its characteristic listener on disconnect, so
        // nothing reaches a listener afterwards. The mock has to match.
        const sensor = createMockPowerSensor({ autoStart: false });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        sensor.disconnect();
        sensor.emit({ power: 250 });
        assert.equal(readings.length, 0);
    });

    it('treats a second disconnect() as a no-op, as a real connection does', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: string[] = [];
        sensor.onStatusChange((s) => statuses.push(s));
        sensor.disconnect();
        sensor.disconnect();
        assert.deepEqual(statuses, ['disconnected']);
    });

    it('stops notifying a status listener once unsubscribed', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: string[] = [];
        const off = sensor.onStatusChange((s) => statuses.push(s));
        off();
        sensor.disconnect();
        assert.deepEqual(statuses, []);
    });

    it('delivers each reading to every listener', () => {
        const sensor = createMockHeartRateSensor({ autoStart: false });
        const a: SensorReading[] = [];
        const b: SensorReading[] = [];
        sensor.addListener((r) => a.push(r));
        sensor.addListener((r) => b.push(r));
        sensor.emit({ heartRate: 150 });
        assert.equal(a.length, 1);
        assert.equal(b[0], a[0]);
        sensor.disconnect();
    });

    it('lets emit() carry several metrics in one frame, like an FTMS trainer', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        sensor.emit({ power: 240, cadence: 92 });
        assert.equal(readings[0]!.power, 240);
        assert.equal(readings[0]!.cadence, 92);
        sensor.disconnect();
    });

    it('uses a default device name per sensor type', () => {
        const sensors = [
            createMockPowerSensor({ autoStart: false }),
            createMockHeartRateSensor({ autoStart: false }),
            createMockCadenceSensor({ autoStart: false }),
        ];
        assert.deepEqual(
            sensors.map((s) => s.deviceName),
            ['Mock Power Sensor', 'Mock Heart Rate Monitor', 'Mock Cadence Sensor']
        );
        for (const s of sensors) s.disconnect();
    });

    it('uses a custom device name', () => {
        const sensor = createMockPowerSensor({ deviceName: 'My Fake Meter', autoStart: false });
        assert.equal(sensor.deviceName, 'My Fake Meter');
        sensor.disconnect();
    });
});

describe('mock sensor simulated status changes', () => {
    it('reports each simulated status to status listeners', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: ConnectionStatus[] = [];
        sensor.onStatusChange((s) => statuses.push(s));
        sensor.simulateStatus('disconnected');
        sensor.simulateStatus('reconnecting');
        sensor.simulateStatus('connected');
        assert.deepEqual(statuses, ['disconnected', 'reconnecting', 'connected']);
        sensor.disconnect();
    });

    it('drops emitted readings while the simulated link is down, as a real connection would', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        sensor.simulateStatus('reconnecting');
        sensor.emit({ power: 200 });
        assert.equal(readings.length, 0);
        sensor.simulateStatus('connected');
        sensor.emit({ power: 210 });
        assert.deepEqual(
            readings.map((r) => r.power),
            [210]
        );
        sensor.disconnect();
    });

    it('stops generated readings after a simulated failure', async () => {
        const sensor = createMockPowerSensor({ intervalMs: 5 });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        await waitFor(() => readings.length >= 1, 1000, 'a reading');
        sensor.simulateStatus('failed');
        const count = readings.length;
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(readings.length, count);
        sensor.disconnect();
    });

    it('still reports disconnected when disconnect() follows a simulated failure', () => {
        // The README tells callers to disconnect() a failed connection.
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: ConnectionStatus[] = [];
        sensor.onStatusChange((s) => statuses.push(s));
        sensor.simulateStatus('failed');
        sensor.disconnect();
        assert.deepEqual(statuses, ['failed', 'disconnected']);
    });

    it('ignores simulated statuses once disconnected', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: ConnectionStatus[] = [];
        const readings: SensorReading[] = [];
        sensor.onStatusChange((s) => statuses.push(s));
        sensor.addListener((r) => readings.push(r));
        sensor.disconnect();
        sensor.simulateStatus('connected');
        sensor.emit({ power: 200 });
        assert.deepEqual(statuses, ['disconnected']);
        assert.equal(readings.length, 0);
    });
});

describe('mock sensor listeners that throw', () => {
    // emit() is called by the test itself, so the error belongs to that
    // caller: it is rethrown, but only after every listener has run.

    it('delivers to every listener, then throws the first error from emit()', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const readings: SensorReading[] = [];
        sensor.addListener(() => {
            throw new Error('assertion inside a listener');
        });
        sensor.addListener((r) => readings.push(r));

        assert.throws(() => sensor.emit({ power: 200 }), /assertion inside a listener/);
        assert.equal(readings.length, 1);
        sensor.disconnect();
    });

    it('notifies every status listener, then throws from simulateStatus()', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: ConnectionStatus[] = [];
        const off = sensor.onStatusChange(() => {
            throw new Error('ui bug');
        });
        sensor.onStatusChange((s) => statuses.push(s));

        assert.throws(() => sensor.simulateStatus('reconnecting'), /ui bug/);
        assert.deepEqual(statuses, ['reconnecting']);
        off();
        sensor.disconnect();
    });

    it('notifies every status listener and still stops, then throws', () => {
        const sensor = createMockPowerSensor({ autoStart: false });
        const statuses: string[] = [];
        sensor.onStatusChange(() => {
            throw new Error('ui bug');
        });
        sensor.onStatusChange((s) => statuses.push(s));

        assert.throws(() => sensor.disconnect(), /ui bug/);
        assert.deepEqual(statuses, ['disconnected']);

        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        sensor.emit({ power: 1 });
        assert.equal(readings.length, 0, 'the sensor is stopped regardless');
    });
});
