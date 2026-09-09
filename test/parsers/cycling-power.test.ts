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
});
