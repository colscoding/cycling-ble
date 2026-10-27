/**
 * Cycling Power Service (0x1818) — Cycling Power Measurement (0x2A63).
 */

import { crankCadence, type CadenceParseResult, type CadenceState } from './cadence.js';
import { requireLength } from './length.js';

/** Flags bit 5: crank revolution data present. */
const CRANK_DATA_BIT = 5;

/** Presence flag and total field width, per Cycling Power Measurement. */
const OPTIONAL_FIELDS = [
    [0, 1], // pedal power balance
    [2, 2], // accumulated torque
    [4, 6], // wheel revolutions and event time
    [CRANK_DATA_BIT, 4], // crank revolutions and event time
    [6, 4], // extreme force magnitudes
    [7, 4], // extreme torque magnitudes
    [8, 3], // extreme angles (two packed uint12 values)
    [9, 2], // top dead spot angle
    [10, 2], // bottom dead spot angle
    [11, 2], // accumulated energy
] as const;

/**
 * Walk the optional fields the flags announce, in their fixed order, and
 * check the packet holds them all. Returns the crank data's offset, or null
 * when the packet carries none.
 */
function walkOptionalFields(value: DataView): number | null {
    const flags = value.getUint16(0, true);
    let length = 4;
    let crankOffset: number | null = null;
    for (const [bit, width] of OPTIONAL_FIELDS) {
        if (!(flags & (1 << bit))) continue;
        if (bit === CRANK_DATA_BIT) crankOffset = length;
        length += width;
    }
    requireLength(value, length);
    return crankOffset;
}

/**
 * Read instantaneous power from a Cycling Power Measurement characteristic.
 *
 * Bytes 0-1 are the flags field; bytes 2-3 are instantaneous power as a
 * signed 16-bit little-endian integer. Power is signed because trainers
 * report small negative values while coasting.
 *
 * @throws {RangeError} When a mandatory or flagged field is truncated.
 */
export function parsePowerMeasurement(value: DataView): number {
    walkOptionalFields(value);
    return value.getInt16(2, true);
}

/**
 * Decode cadence from the crank revolution data a power meter includes in
 * its Cycling Power Measurement.
 *
 * Crank data is encoded as in CSC, so this behaves like
 * `parseCadenceMeasurement`: thread `state` through successive calls, and
 * expect `null` for the first sample, a repeated event time, an implausible
 * result, or a packet without crank data — which leaves `state` unchanged.
 *
 * @throws {RangeError} When a mandatory or flagged field is truncated.
 */
export function parsePowerCadence(value: DataView, state: CadenceState): CadenceParseResult {
    const offset = walkOptionalFields(value);
    if (offset === null) return { rpm: null, state };
    return crankCadence(value.getUint16(offset, true), value.getUint16(offset + 2, true), state);
}
