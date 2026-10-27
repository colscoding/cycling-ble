import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePowerMeasurement, parsePowerCadence } from '../../src/parsers/cycling-power.js';
import { initialCadenceState } from '../../src/parsers/cadence.js';

function powerView(watts: number): DataView {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint8(0, 0x00); // flags, unused for instantaneous power
    view.setUint8(1, 0x00);
    view.setInt16(2, watts, true);
    return view;
}

/** Build a Cycling Power Measurement with crank revolution data only (flags bit 5). */
function crankView(revs: number, timeUnits: number): DataView {
    const v = new DataView(new ArrayBuffer(8));
    v.setUint16(0, 0x0020, true);
    v.setInt16(2, 200, true);
    v.setUint16(4, revs, true);
    v.setUint16(6, timeUnits, true);
    return v;
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
        // field and is left to parsePowerCadence.
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

describe('parsePowerCadence', () => {
    it('returns null on the first sample because RPM needs a delta', () => {
        const result = parsePowerCadence(crankView(10, 1024), initialCadenceState);
        assert.equal(result.rpm, null);
        assert.deepEqual(result.state, { lastCrankRevs: 10, lastCrankTime: 1024 });
    });

    it('computes 60 rpm from one revolution per second', () => {
        const first = parsePowerCadence(crankView(10, 1024), initialCadenceState);
        const second = parsePowerCadence(crankView(11, 2048), first.state);
        assert.equal(second.rpm, 60);
    });

    it('finds crank data behind the optional fields that precede it', () => {
        // Pedal power balance (1 byte), accumulated torque (2) and wheel
        // revolution data (6) all sit between power and the crank fields.
        const v = new DataView(new ArrayBuffer(17));
        v.setUint16(0, 0x0001 | 0x0004 | 0x0010 | 0x0020, true);
        v.setInt16(2, 200, true);
        v.setUint8(4, 0xff); // pedal power balance
        v.setUint16(5, 0xffff, true); // accumulated torque
        v.setUint32(7, 0xffffffff, true); // wheel revolutions
        v.setUint16(11, 0xffff, true); // wheel event time
        v.setUint16(13, 11, true);
        v.setUint16(15, 2048, true);

        const first = parsePowerCadence(crankView(10, 1024), initialCadenceState);
        assert.equal(parsePowerCadence(v, first.state).rpm, 60);
    });

    it('returns null and keeps the state when the packet has no crank data', () => {
        const first = parsePowerCadence(crankView(10, 1024), initialCadenceState);
        const result = parsePowerCadence(powerView(250), first.state);
        assert.equal(result.rpm, null);
        assert.equal(result.state, first.state);
    });

    it('returns null when a stopped crank repeats its last event', () => {
        const first = parsePowerCadence(crankView(10, 1024), initialCadenceState);
        assert.equal(parsePowerCadence(crankView(10, 1024), first.state).rpm, null);
    });

    it('handles the uint16 counters wrapping', () => {
        const first = parsePowerCadence(crankView(65535, 65000), initialCadenceState);
        const second = parsePowerCadence(crankView(0, 65000 + 1024 - 65536), first.state);
        assert.equal(second.rpm, 60);
    });

    it('throws a RangeError when the announced crank data is truncated', () => {
        const v = new DataView(new ArrayBuffer(6));
        v.setUint16(0, 0x0020, true);
        assert.throws(() => parsePowerCadence(v, initialCadenceState), RangeError);
    });
});
