import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBluetoothError } from '../src/errors.js';

function named(name: string, message: string): Error {
    const e = new Error(message);
    e.name = name;
    return e;
}

describe('classifyBluetoothError', () => {
    it('recognises a cancelled chooser', () => {
        const info = classifyBluetoothError(new Error('User cancelled the requestDevice() chooser.'));
        assert.equal(info.kind, 'cancelled');
        assert.equal(info.canRetry, true);
        assert.deepEqual(info.suggestions, []);
    });

    it('recognises an unavailable adapter', () => {
        const info = classifyBluetoothError(new Error('Bluetooth adapter not available'));
        assert.equal(info.kind, 'unavailable');
        assert.equal(info.canRetry, false);
        assert.ok(info.suggestions.length > 0);
    });

    it('recognises no devices found', () => {
        const info = classifyBluetoothError(named('NotFoundError', 'No devices found'));
        assert.equal(info.kind, 'not-found');
        assert.equal(info.canRetry, true);
    });

    it('recognises a GATT failure', () => {
        const info = classifyBluetoothError(new Error('GATT operation failed'));
        assert.equal(info.kind, 'connection-failed');
    });

    it('recognises a permission denial', () => {
        const info = classifyBluetoothError(named('SecurityError', 'permission denied'));
        assert.equal(info.kind, 'permission-denied');
    });

    it('recognises a timeout', () => {
        const info = classifyBluetoothError(named('NetworkError', 'connection timeout'));
        assert.equal(info.kind, 'timeout');
    });

    it('recognises an incompatible sensor', () => {
        const info = classifyBluetoothError(new Error('Service heart_rate not found'));
        assert.equal(info.kind, 'incompatible');
    });

    it('falls back to unknown', () => {
        const info = classifyBluetoothError(new Error('something else entirely'));
        assert.equal(info.kind, 'unknown');
        assert.equal(info.canRetry, true);
    });

    it('handles a non-Error value', () => {
        const info = classifyBluetoothError('a string');
        assert.equal(info.kind, 'unknown');
        assert.ok(info.message.length > 0);
    });

    it('uses the sensor label in its message', () => {
        const info = classifyBluetoothError(new Error('No devices found'), { sensorLabel: 'power meter' });
        assert.match(info.message, /power meter/);
    });

    it('defaults the label to "sensor"', () => {
        const info = classifyBluetoothError(new Error('No devices found'));
        assert.match(info.message, /sensor/);
    });

    it('classifies the connect layer own incompatible-device error', () => {
        const info = classifyBluetoothError(new Error('Power sensor exposes none of the expected BLE services'));
        assert.equal(info.kind, 'incompatible');
    });
});
