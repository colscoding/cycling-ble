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
const AVG_SPEED = 1 << 1;
const INST_CADENCE = 1 << 2;
const AVG_CADENCE = 1 << 3;
const TOTAL_DISTANCE = 1 << 4;
const RESISTANCE = 1 << 5;
const INST_POWER = 1 << 6;
const AVG_POWER = 1 << 7;

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

    it('walks every optional field that precedes power', () => {
        // Each skipped field holds a distinct value, so a skip of the wrong
        // width lands power or cadence on a neighbour and the assertion fails.
        // Resistance Level is 2 bytes (sint16) per FTMS v1.0; see indoor-bike.ts.
        const v = ftmsView(AVG_SPEED | INST_CADENCE | AVG_CADENCE | TOTAL_DISTANCE | RESISTANCE | INST_POWER, [
            { size: 2, value: 1111 }, // instantaneous speed (More Data clear)
            { size: 2, value: 2222 }, // average speed
            { size: 2, value: 170 }, // instantaneous cadence -> 85 rpm
            { size: 2, value: 3333 }, // average cadence
            { size: 3, value: 0x0a0b0c }, // total distance
            { size: 2, value: -7, signed: true }, // resistance level
            { size: 2, value: 321, signed: true }, // instantaneous power
        ]);
        assert.deepEqual(parseIndoorBikeData(v), { powerW: 321, cadenceRpm: 85 });
    });

    for (const [name, flag, width] of [
        ['average speed', AVG_SPEED, 2],
        ['average cadence', AVG_CADENCE, 2],
        ['resistance level', RESISTANCE, 2],
    ] as const) {
        it(`skips ${name} on its own`, () => {
            const v = ftmsView(MORE_DATA | flag | INST_POWER, [
                { size: width, value: 0x7777 },
                { size: 2, value: 205, signed: true },
            ]);
            assert.equal(parseIndoorBikeData(v).powerW, 205);
        });
    }

    it('ignores fields that follow power', () => {
        const v = ftmsView(MORE_DATA | INST_POWER | AVG_POWER, [
            { size: 2, value: 230, signed: true },
            { size: 2, value: 999, signed: true }, // average power
        ]);
        assert.equal(parseIndoorBikeData(v).powerW, 230);
    });

    it('rounds half-rpm cadence and accepts values just under the ceiling', () => {
        const half = ftmsView(MORE_DATA | INST_CADENCE, [{ size: 2, value: 171 }]); // 85.5 rpm
        assert.equal(parseIndoorBikeData(half).cadenceRpm, 86);

        const justUnder = ftmsView(MORE_DATA | INST_CADENCE, [{ size: 2, value: 598 }]); // 299 rpm
        assert.equal(parseIndoorBikeData(justUnder).cadenceRpm, 299);

        const atCeiling = ftmsView(MORE_DATA | INST_CADENCE, [{ size: 2, value: 600 }]); // 300 rpm
        assert.equal(parseIndoorBikeData(atCeiling).cadenceRpm, null);
    });

    it('throws a RangeError when a flagged field is missing from the packet', () => {
        // The connect layer catches this and logs a malformed packet; direct
        // users of the parser have to catch it themselves.
        const truncated = ftmsView(MORE_DATA | INST_POWER, []);
        assert.throws(() => parseIndoorBikeData(truncated), RangeError);
    });
});
