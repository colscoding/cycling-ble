/**
 * Cycling Power Service (0x1818) — Cycling Power Measurement (0x2A63).
 */

/**
 * Read instantaneous power from a Cycling Power Measurement characteristic.
 *
 * Bytes 0-1 are the flags field; bytes 2-3 are instantaneous power as a
 * signed 16-bit little-endian integer. Power is signed because trainers
 * report small negative values while coasting.
 *
 * @throws {RangeError} When the packet is shorter than 4 bytes.
 */
export function parsePowerMeasurement(value: DataView): number {
    return value.getInt16(2, true);
}
