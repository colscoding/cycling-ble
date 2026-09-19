import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    initialCadenceState,
    parseCadenceMeasurement,
    parseHeartRateMeasurement,
    parseIndoorBikeData,
    parsePowerMeasurement,
} from '../../src/parsers/index.js';

// Payload fragments follow the Bluetooth characteristic layouts. Generate every
// subset, then cut each complete packet at every byte boundary. No parser flag
// constants or length calculations are imported into the fixtures.
function checkSubsets(
    parse: (value: DataView) => unknown,
    header: number[],
    fields: readonly (readonly [bit: number, bytes: readonly number[]])[]
): void {
    for (let subset = 0; subset < 2 ** fields.length; subset++) {
        const bytes = [...header];
        for (const [index, [bit, payload]] of fields.entries()) {
            if (!(subset & (1 << index))) continue;
            bytes[bit >> 3]! ^= 1 << (bit % 8);
            bytes.push(...payload);
        }
        // A subview also checks that surrounding buffer bytes cannot conceal
        // a truncated notification.
        const buffer = Uint8Array.from([0xff, ...bytes, 0xff]).buffer;
        assert.doesNotThrow(() => parse(new DataView(buffer, 1, bytes.length)));
        for (let length = 0; length < bytes.length; length++) {
            assert.throws(
                () => parse(new DataView(buffer, 1, length)),
                RangeError,
                `subset ${subset}, truncated to ${length}/${bytes.length} bytes`
            );
        }
    }
}

describe('complete packet length validation', () => {
    it('validates all Indoor Bike Data field combinations, including speed-only and trailing fields', () => {
        checkSubsets(
            parseIndoorBikeData,
            [1, 0],
            [
                [0, [0x10, 0x27]], // inverted More Data: include speed when cleared
                [1, [0x20, 0x27]], // average speed
                [2, [180, 0]], // cadence
                [3, [170, 0]], // average cadence
                [4, [1, 2, 3]], // total distance
                [5, [10, 0]], // resistance, FTMS v1.0 width
                [6, [250, 0]], // power
                [7, [200, 0]], // average power
                [8, [1, 0, 2, 0, 3]], // total energy, energy/hour, energy/minute
                [9, [140]], // heart rate
                [10, [10]], // metabolic equivalent
                [11, [60, 0]], // elapsed time
                [12, [120, 0]], // remaining time
            ]
        );
    });

    it('validates every Cycling Power optional field, including packed angles', () => {
        checkSubsets(
            parsePowerMeasurement,
            [0, 0, 250, 0],
            [
                [0, [100]], // pedal balance
                [2, [10, 0]], // accumulated torque
                [4, [1, 0, 0, 0, 0, 4]], // wheel data
                [5, [1, 0, 0, 4]], // crank data
                [6, [1, 0, 2, 0]], // extreme force
                [7, [3, 0, 4, 0]], // extreme torque
                [8, [0x12, 0x34, 0x56]], // two uint12 angles
                [9, [10, 0]], // top dead spot
                [10, [20, 0]], // bottom dead spot
                [11, [30, 0]], // accumulated energy
            ]
        );
        // Reference/source/offset-compensation bits do not add payload fields.
        assert.equal(parsePowerMeasurement(new DataView(Uint8Array.from([0x0a, 0xf0, 250, 0]).buffer)), 250);
    });

    it('validates CSC packets even when only wheel data is present', () => {
        checkSubsets(
            (view) => parseCadenceMeasurement(view, initialCadenceState),
            [0],
            [
                [0, [1, 0, 0, 0, 0, 4]],
                [1, [1, 0, 0, 4]],
            ]
        );
    });

    for (const header of [
        [0, 72],
        [1, 0x2c, 1],
    ]) {
        it(`validates optional heart-rate fields in ${header.length === 2 ? 'uint8' : 'uint16'} format`, () => {
            checkSubsets(parseHeartRateMeasurement, header, [
                [3, [1, 0]], // energy expended
                [4, [0, 4]], // at least one RR interval
            ]);
        });
    }

    it('accepts multiple complete RR intervals but rejects a partial final interval', () => {
        const bytes = Uint8Array.from([0x18, 72, 1, 0, 0, 4, 0, 4, 0, 4]);
        assert.equal(parseHeartRateMeasurement(new DataView(bytes.buffer)), 72);
        assert.throws(() => parseHeartRateMeasurement(new DataView(bytes.buffer, 0, bytes.length - 1)), RangeError);
    });
});
