import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';
import * as parsers from '../src/parsers/index.js';
import * as mock from '../src/mock.js';
import type { BluetoothAdapter, ConnectOptions } from '../src/index.js';

// Type-only surface, checked by `pnpm run typecheck` rather than at runtime.
// ConnectOptions.bluetooth is typed with BluetoothAdapter, so anyone writing a
// polyfill or a fake needs to be able to name it.
const adapterIsNameable: ConnectOptions['bluetooth'] = undefined as BluetoothAdapter | undefined;
void adapterIsNameable;

describe('public surface', () => {
    it('exports the three connect functions', () => {
        assert.equal(typeof api.connectPower, 'function');
        assert.equal(typeof api.connectHeartRate, 'function');
        assert.equal(typeof api.connectCadence, 'function');
    });

    it('exports error classification', () => {
        assert.equal(typeof api.classifyBluetoothError, 'function');
    });

    it('exports the parsers from the subpath', () => {
        assert.equal(typeof parsers.parsePowerMeasurement, 'function');
        assert.equal(typeof parsers.parseHeartRateMeasurement, 'function');
        assert.equal(typeof parsers.parseCadenceMeasurement, 'function');
        assert.equal(typeof parsers.parseIndoorBikeData, 'function');
    });

    it('exports the mocks from the subpath', () => {
        assert.equal(typeof mock.createMockPowerSensor, 'function');
        assert.equal(typeof mock.createMockHeartRateSensor, 'function');
        assert.equal(typeof mock.createMockCadenceSensor, 'function');
    });

    it('does not leak internals from the root entry', () => {
        assert.equal('createReconnectionManager' in api, false);
    });

    // Exact runtime surfaces. Adding or removing an export is a semver
    // decision, so it should take a deliberate edit here rather than slip in.
    it('root entry exports exactly the documented values', () => {
        assert.deepEqual(Object.keys(api).sort(), [
            'classifyBluetoothError',
            'connectCadence',
            'connectHeartRate',
            'connectPower',
        ]);
    });

    it('parsers entry exports exactly the documented values', () => {
        assert.deepEqual(Object.keys(parsers).sort(), [
            'initialCadenceState',
            'parseCadenceMeasurement',
            'parseHeartRateMeasurement',
            'parseIndoorBikeData',
            'parsePowerMeasurement',
        ]);
    });

    it('mock entry exports exactly the documented values', () => {
        assert.deepEqual(Object.keys(mock).sort(), [
            'createMockCadenceSensor',
            'createMockHeartRateSensor',
            'createMockPowerSensor',
        ]);
    });
});
