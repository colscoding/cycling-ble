import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRateMeasurement } from '../../src/parsers/heart-rate.js';

function view(bytes: number[]): DataView {
    const v = new DataView(new ArrayBuffer(bytes.length));
    bytes.forEach((b, i) => v.setUint8(i, b));
    return v;
}

describe('parseHeartRateMeasurement', () => {
    it('reads a uint8 value when the format bit is clear', () => {
        assert.equal(parseHeartRateMeasurement(view([0x00, 72])), 72);
    });

    it('reads a uint16 little-endian value when the format bit is set', () => {
        assert.equal(parseHeartRateMeasurement(view([0x01, 0x2c, 0x01])), 300);
    });

    it('reads a uint8 value above 127 without sign confusion', () => {
        assert.equal(parseHeartRateMeasurement(view([0x00, 200])), 200);
    });

    it('ignores unrelated flag bits', () => {
        // 0x06 sets sensor-contact bits but leaves the format bit clear.
        assert.equal(parseHeartRateMeasurement(view([0x06, 65])), 65);
    });
});
