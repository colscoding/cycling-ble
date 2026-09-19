import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBluetoothError } from '../src/errors.js';

function named(name: string, message: string): Error {
    const e = new Error(message);
    e.name = name;
    return e;
}

describe('classifyBluetoothError', () => {
    for (const [name, message, kind] of [
        ['SecurityError', 'GATT permission denied', 'permission-denied'],
        ['NetworkError', 'GATT connection timed out', 'timeout'],
        ['NotFoundError', 'Service not found', 'incompatible'],
        ['NotFoundError', 'Characteristic not found', 'incompatible'],
        ['NotFoundError', 'No Services matching UUID 0x180D in Bluetooth device', 'incompatible'],
        ['NotFoundError', 'No Characteristics matching UUID 0x2A37', 'incompatible'],
    ]) {
        it(`prioritizes specific errors: ${message}`, () => {
            assert.equal(classifyBluetoothError(named(name!, message!)).kind, kind);
        });
    }

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

    describe('NotFoundError, which browsers use for three different situations', () => {
        // The branch order in errors.ts exists for these cases. Reordering the
        // branches would break one of them, and these tests say which.
        it("is a cancelled chooser when the message mentions cancelling (Chrome's wording)", () => {
            const info = classifyBluetoothError(named('NotFoundError', 'User cancelled the requestDevice() chooser.'));
            assert.equal(info.kind, 'cancelled');
        });

        it('is a cancelled chooser for other cancel wordings too', () => {
            const info = classifyBluetoothError(named('NotFoundError', 'Request was cancel-ed by the user'));
            assert.equal(info.kind, 'cancelled');
        });

        it('is unavailable Bluetooth when the message mentions Bluetooth', () => {
            const info = classifyBluetoothError(named('NotFoundError', 'Bluetooth is turned off'));
            assert.equal(info.kind, 'unavailable');
        });

        it('is nothing found otherwise', () => {
            const info = classifyBluetoothError(named('NotFoundError', 'Nothing matched the filters'));
            assert.equal(info.kind, 'not-found');
        });
    });

    it('recognises the connect layer own no-Bluetooth error', () => {
        const info = classifyBluetoothError(new Error('Web Bluetooth is not available. Use a Chromium-based browser'));
        assert.equal(info.kind, 'unavailable');
        assert.equal(info.canRetry, false);
    });

    describe('matching wording regardless of capitalisation', () => {
        // Browsers capitalise these messages however they like, and a message
        // usually starts a sentence: "Failed to connect", not "failed to connect".
        it('recognises "Failed to connect" as a connection failure', () => {
            assert.equal(classifyBluetoothError(new Error('Failed to connect to device')).kind, 'connection-failed');
        });

        it('recognises "Connection attempt failed." as a connection failure', () => {
            assert.equal(classifyBluetoothError(new Error('Connection attempt failed.')).kind, 'connection-failed');
        });

        it('recognises "Timeout" and "timed out" as a timeout', () => {
            assert.equal(classifyBluetoothError(new Error('Operation Timeout')).kind, 'timeout');
            assert.equal(classifyBluetoothError(new Error('The operation timed out')).kind, 'timeout');
        });

        it('recognises "Permission denied" as a permission denial', () => {
            assert.equal(
                classifyBluetoothError(named('NotAllowedError', 'Permission denied')).kind,
                'permission-denied'
            );
        });
    });

    it('recognises a saved device that is no longer permitted as not found', () => {
        // The message connectPower throws for a stale previousDeviceId.
        const info = classifyBluetoothError(new Error('Device abc is not found in the permitted device list'));
        assert.equal(info.kind, 'not-found');
    });

    it('recognises a browser without getDevices() as unavailable and not retryable', () => {
        // The message connectPower throws when previousDeviceId is given but
        // the browser cannot look devices up. Retrying is pointless — the
        // browser will not grow the method — so the caller must fall back to
        // a chooser rather than try the same call again.
        const info = classifyBluetoothError(
            new Error(
                'Cannot reconnect to saved device abc without a chooser: ' +
                    'this browser does not support getDevices()'
            )
        );
        assert.equal(info.kind, 'unavailable');
        assert.equal(info.canRetry, false);
    });

    it('keeps a saved-device lookup that failed retryable', () => {
        // The third saved-device case, and the reason the branch above cannot
        // simply match on "saved device": a lookup that threw may well succeed
        // next time, so this one stays retryable.
        const info = classifyBluetoothError(new Error('Could not look up saved device abc'));
        assert.equal(info.canRetry, true);
    });

    it('reads name and message from an error-like object that is not an Error', () => {
        // Errors crossing a realm, a worker, or a serialisation boundary lose
        // their prototype but keep their fields.
        const info = classifyBluetoothError({
            name: 'NotFoundError',
            message: 'User cancelled the requestDevice() chooser.',
        });
        assert.equal(info.kind, 'cancelled');
    });

    it('treats null and objects without string name or message as unknown', () => {
        assert.equal(classifyBluetoothError(null).kind, 'unknown');
        assert.equal(classifyBluetoothError({ code: 42 }).kind, 'unknown');
        assert.equal(classifyBluetoothError({ name: 7, message: ['GATT'] }).kind, 'unknown');
    });

    it('classifies by name alone when the message is unhelpful', () => {
        assert.equal(classifyBluetoothError(named('SecurityError', '')).kind, 'permission-denied');
        assert.equal(classifyBluetoothError(named('NetworkError', '')).kind, 'timeout');
    });

    it('returns renderable copy for every kind', () => {
        const samples = [
            new Error('User cancelled the requestDevice() chooser.'),
            new Error('Bluetooth adapter not available'),
            new Error('No devices found'),
            new Error('GATT operation failed'),
            named('SecurityError', 'permission denied'),
            named('NetworkError', 'timeout'),
            new Error('Service heart_rate not found'),
            new Error('something else'),
        ];
        const kinds = new Set<string>();
        for (const error of samples) {
            const info = classifyBluetoothError(error);
            kinds.add(info.kind);
            assert.ok(info.title.length > 0, `${info.kind} has a title`);
            assert.ok(info.message.length > 0, `${info.kind} has a message`);
            assert.equal(info.suggestions.length === 0, info.kind === 'cancelled', `${info.kind} suggestions`);
        }
        assert.equal(kinds.size, 8, 'the samples cover every kind');
    });
});
