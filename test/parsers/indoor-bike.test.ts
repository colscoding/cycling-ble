import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseIndoorBikeData } from '../../src/parsers/indoor-bike.js';

/**
 * Build an Indoor Bike Data packet. `fields` are appended in the fixed order
 * the spec defines; the caller supplies the flags that match.
 */
function ftmsView(flags: number, fields: { size: 2 | 3; value: number; signed?: boolean }[]): DataView {
    const length = 2 + fields.reduce((n, f) => n + f.size, 0);
    const v = new DataView(new ArrayBuffer(length));
    v.setUint16(0, flags, true);
    let offset = 2;
    for (const f of fields) {
        if (f.size === 2) {
            if (f.signed) v.setInt16(offset, f.value, true);
            else v.setUint16(offset, f.value, true);
        } else {
            v.setUint16(offset, f.value & 0xffff, true);
            v.setUint8(offset + 2, (f.value >> 16) & 0xff);
        }
        offset += f.size;
    }
    return v;
}

const MORE_DATA = 1 << 0;
const INST_CADENCE = 1 << 2;
const TOTAL_DISTANCE = 1 << 4;
const INST_POWER = 1 << 6;

describe('parseIndoorBikeData', () => {
    it('reads power when only the power flag is set', () => {
        // MORE_DATA set means instantaneous speed is absent.
        const v = ftmsView(MORE_DATA | INST_POWER, [{ size: 2, value: 210, signed: true }]);
        assert.deepEqual(parseIndoorBikeData(v), { powerW: 210, cadenceRpm: null });
    });

    it('reads power and cadence from one packet', () => {
        const v = ftmsView(MORE_DATA | INST_CADENCE | INST_POWER, [
            { size: 2, value: 180 }, // cadence, 0.5 rpm per unit -> 90 rpm
            { size: 2, value: 245, signed: true },
        ]);
        assert.deepEqual(parseIndoorBikeData(v), { powerW: 245, cadenceRpm: 90 });
    });

    it('skips instantaneous speed when the More Data bit is clear', () => {
        // Bit 0 is inverted: clear means speed IS present.
        const v = ftmsView(INST_POWER, [
            { size: 2, value: 3000 }, // instantaneous speed, skipped
            { size: 2, value: 199, signed: true },
        ]);
        assert.deepEqual(parseIndoorBikeData(v), { powerW: 199, cadenceRpm: null });
    });

    it('skips the 3-byte total distance field', () => {
        const v = ftmsView(MORE_DATA | TOTAL_DISTANCE | INST_POWER, [
            { size: 3, value: 123456 },
            { size: 2, value: 150, signed: true },
        ]);
        assert.deepEqual(parseIndoorBikeData(v), { powerW: 150, cadenceRpm: null });
    });

    it('returns nulls when neither power nor cadence is present', () => {
        const v = ftmsView(MORE_DATA, []);
        assert.deepEqual(parseIndoorBikeData(v), { powerW: null, cadenceRpm: null });
    });

    it('reads negative power', () => {
        const v = ftmsView(MORE_DATA | INST_POWER, [{ size: 2, value: -12, signed: true }]);
        assert.equal(parseIndoorBikeData(v).powerW, -12);
    });

    it('rejects an implausible cadence', () => {
        const v = ftmsView(MORE_DATA | INST_CADENCE | INST_POWER, [
            { size: 2, value: 1000 }, // 500 rpm
            { size: 2, value: 100, signed: true },
        ]);
        const result = parseIndoorBikeData(v);
        assert.equal(result.cadenceRpm, null);
        assert.equal(result.powerW, 100, 'power is still read after a rejected cadence');
    });
});
