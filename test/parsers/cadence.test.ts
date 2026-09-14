import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCadenceMeasurement, initialCadenceState } from '../../src/parsers/cadence.js';

/** Build a CSC measurement with crank data only (flags bit 1 set). */
function crankView(revs: number, timeUnits: number): DataView {
    const v = new DataView(new ArrayBuffer(5));
    v.setUint8(0, 0x02);
    v.setUint16(1, revs, true);
    v.setUint16(3, timeUnits, true);
    return v;
}

/** Build a CSC measurement carrying wheel data before crank data (bits 0 and 1). */
function wheelAndCrankView(revs: number, timeUnits: number): DataView {
    const v = new DataView(new ArrayBuffer(11));
    v.setUint8(0, 0x03);
    v.setUint32(1, 12345, true); // wheel revolutions, skipped
    v.setUint16(5, 999, true); // wheel event time, skipped
    v.setUint16(7, revs, true);
    v.setUint16(9, timeUnits, true);
    return v;
}

describe('parseCadenceMeasurement', () => {
    it('returns null on the first sample because RPM needs a delta', () => {
        const result = parseCadenceMeasurement(crankView(10, 1024), initialCadenceState);
        assert.equal(result.rpm, null);
        assert.deepEqual(result.state, { lastCrankRevs: 10, lastCrankTime: 1024 });
    });

    it('computes 60 rpm from one revolution per second', () => {
        const first = parseCadenceMeasurement(crankView(10, 1024), initialCadenceState);
        const second = parseCadenceMeasurement(crankView(11, 2048), first.state);
        assert.equal(second.rpm, 60);
    });

    it('computes 90 rpm from three revolutions in two seconds', () => {
        const first = parseCadenceMeasurement(crankView(0, 0), initialCadenceState);
        const second = parseCadenceMeasurement(crankView(3, 2048), first.state);
        assert.equal(second.rpm, 90);
    });

    it('returns null when the crank-data flag is clear', () => {
        const v = new DataView(new ArrayBuffer(7));
        v.setUint8(0, 0x01); // wheel data only
        const result = parseCadenceMeasurement(v, initialCadenceState);
        assert.equal(result.rpm, null);
    });

    it('skips wheel data when both flags are set', () => {
        const first = parseCadenceMeasurement(wheelAndCrankView(10, 1024), initialCadenceState);
        const second = parseCadenceMeasurement(wheelAndCrankView(11, 2048), first.state);
        assert.equal(second.rpm, 60);
    });

    it('handles uint16 rollover of the revolution counter', () => {
        const first = parseCadenceMeasurement(crankView(65535, 1024), initialCadenceState);
        const second = parseCadenceMeasurement(crankView(0, 2048), first.state);
        assert.equal(second.rpm, 60);
    });

    it('handles uint16 rollover of the crank event time', () => {
        const first = parseCadenceMeasurement(crankView(10, 65535), initialCadenceState);
        const second = parseCadenceMeasurement(crankView(11, 1023), first.state);
        assert.equal(second.rpm, 60);
    });

    it('rejects an implausible cadence above 300 rpm', () => {
        const first = parseCadenceMeasurement(crankView(0, 0), initialCadenceState);
        const second = parseCadenceMeasurement(crankView(100, 1024), first.state);
        assert.equal(second.rpm, null);
    });

    it('accepts cadence just under the 300 rpm ceiling and rejects it at the ceiling', () => {
        const first = parseCadenceMeasurement(crankView(0, 0), initialCadenceState);
        // 299 revolutions in 60 s (61440 / 1024) is 299 rpm.
        assert.equal(parseCadenceMeasurement(crankView(299, 61440), first.state).rpm, 299);
        // 5 revolutions in 1 s is exactly 300 rpm.
        assert.equal(parseCadenceMeasurement(crankView(5, 1024), first.state).rpm, null);
    });

    it('emits nothing, not zero, when the crank stops', () => {
        // A stopped crank repeats its last event, so there is no delta to
        // compute. Callers see readings stop rather than a 0 rpm reading —
        // the README tells them to treat a stale cadence as zero.
        const first = parseCadenceMeasurement(crankView(40, 5000), initialCadenceState);
        const repeat = parseCadenceMeasurement(crankView(40, 5000), first.state);
        assert.equal(repeat.rpm, null);
    });

    it('does not mutate the state it was given', () => {
        const state = { lastCrankRevs: 10, lastCrankTime: 1024 };
        parseCadenceMeasurement(crankView(11, 2048), state);
        assert.deepEqual(state, { lastCrankRevs: 10, lastCrankTime: 1024 });
    });

    it('returns null but still advances state when time does not move', () => {
        const first = parseCadenceMeasurement(crankView(10, 1024), initialCadenceState);
        const second = parseCadenceMeasurement(crankView(11, 1024), first.state);
        assert.equal(second.rpm, null);
        assert.deepEqual(second.state, { lastCrankRevs: 11, lastCrankTime: 1024 });
    });
});
