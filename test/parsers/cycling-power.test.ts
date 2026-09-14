import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePowerMeasurement } from '../../src/parsers/cycling-power.js';

function powerView(watts: number): DataView {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint8(0, 0x00); // flags, unused for instantaneous power
    view.setUint8(1, 0x00);
    view.setInt16(2, watts, true);
    return view;
}

describe('parsePowerMeasurement', () => {
    it('reads instantaneous power from bytes 2-3 little-endian', () => {
        assert.equal(parsePowerMeasurement(powerView(250)), 250);
    });

    it('reads zero', () => {
        assert.equal(parsePowerMeasurement(powerView(0)), 0);
    });

    it('reads a high but legal wattage', () => {
        assert.equal(parsePowerMeasurement(powerView(2000)), 2000);
    });

    it('reads negative power, which trainers report while coasting', () => {
        assert.equal(parsePowerMeasurement(powerView(-5)), -5);
    });

    it('ignores the flags and any fields after power', () => {
        // Flags 0x20 announce crank revolution data, which follows the power
        // field and is not decoded.
        const v = new DataView(new ArrayBuffer(8));
        v.setUint16(0, 0x0020, true);
        v.setInt16(2, 310, true);
        v.setUint16(4, 1234, true);
        v.setUint16(6, 5678, true);
        assert.equal(parsePowerMeasurement(v), 310);
    });

    it('throws a RangeError on a packet too short to hold power', () => {
        assert.throws(() => parsePowerMeasurement(new DataView(new ArrayBuffer(3))), RangeError);
    });
});
