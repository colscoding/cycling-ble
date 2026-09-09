import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';
import * as parsers from '../src/parsers/index.js';
import * as mock from '../src/mock.js';

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
});
