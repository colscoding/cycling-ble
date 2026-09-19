/**
 * Heart Rate Service (0x180D) — Heart Rate Measurement (0x2A37).
 */

import { requireLength } from './length.js';

/** Bit 0 of the flags byte: 0 = uint8 value, 1 = uint16 value. */
const FLAG_UINT16_FORMAT = 0x01;
const FLAG_ENERGY_EXPENDED = 0x08;
const FLAG_RR_INTERVALS = 0x10;

/**
 * Read heart rate from a Heart Rate Measurement characteristic.
 *
 * The flags byte declares the value width, so the field cannot be read at a
 * fixed offset and size.
 *
 * @throws {RangeError} When a declared field or RR interval is truncated.
 */
export function parseHeartRateMeasurement(value: DataView): number {
    const flags = value.getUint8(0);
    let length = flags & FLAG_UINT16_FORMAT ? 3 : 2;
    if (flags & FLAG_ENERGY_EXPENDED) length += 2;
    if (flags & FLAG_RR_INTERVALS) {
        // Presence means at least one uint16 interval; all remaining intervals
        // must also be complete, even though we only report heart rate.
        requireLength(value, length + 2);
        if ((value.byteLength - length) % 2 !== 0) throw new RangeError('Truncated RR interval');
    }
    requireLength(value, length);
    if (flags & FLAG_UINT16_FORMAT) {
        return value.getUint16(1, true);
    }
    return value.getUint8(1);
}
