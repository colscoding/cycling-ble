/**
 * Cycling Power Service (0x1818) — Cycling Power Measurement (0x2A63).
 */

import { requireLength } from './length.js';

/** Presence flag and total field width, per Cycling Power Measurement. */
const OPTIONAL_FIELDS = [
    [0, 1], // pedal power balance
    [2, 2], // accumulated torque
    [4, 6], // wheel revolutions and event time
    [5, 4], // crank revolutions and event time
    [6, 4], // extreme force magnitudes
    [7, 4], // extreme torque magnitudes
    [8, 3], // extreme angles (two packed uint12 values)
    [9, 2], // top dead spot angle
    [10, 2], // bottom dead spot angle
    [11, 2], // accumulated energy
] as const;

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
    const flags = value.getUint16(0, true);
    let length = 4;
    for (const [bit, width] of OPTIONAL_FIELDS) {
        if (flags & (1 << bit)) length += width;
    }
    requireLength(value, length);
    return value.getInt16(2, true);
}
