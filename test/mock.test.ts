import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMockPowerSensor, createMockHeartRateSensor, createMockCadenceSensor } from '../src/mock.js';
import type { SensorReading } from '../src/types.js';

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
        await new Promise((resolve) => setTimeout(resolve, 40));
        sensor.disconnect();
        assert.ok(readings.length >= 2, 'emits repeatedly');
        for (const r of readings) {
            assert.ok(r.power !== undefined && r.power >= 200 && r.power <= 250);
        }
    });

    it('generates plausible heart rate', async () => {
        const sensor = createMockHeartRateSensor({ intervalMs: 5 });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        await new Promise((resolve) => setTimeout(resolve, 30));
        sensor.disconnect();
        assert.ok(readings.every((r) => r.heartRate !== undefined && r.heartRate >= 140 && r.heartRate <= 160));
    });

    it('generates plausible cadence', async () => {
        const sensor = createMockCadenceSensor({ intervalMs: 5 });
        const readings: SensorReading[] = [];
        sensor.addListener((r) => readings.push(r));
        await new Promise((resolve) => setTimeout(resolve, 30));
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

    it('uses a custom device name', () => {
        const sensor = createMockPowerSensor({ deviceName: 'My Fake Meter', autoStart: false });
        assert.equal(sensor.deviceName, 'My Fake Meter');
        sensor.disconnect();
    });
});
