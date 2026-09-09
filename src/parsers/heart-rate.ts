/**
 * Heart Rate Service (0x180D) — Heart Rate Measurement (0x2A37).
 */

/** Bit 0 of the flags byte: 0 = uint8 value, 1 = uint16 value. */
const FLAG_UINT16_FORMAT = 0x01;

/**
 * Read heart rate from a Heart Rate Measurement characteristic.
 *
 * The flags byte declares the value width, so the field cannot be read at a
 * fixed offset and size.
 */
export function parseHeartRateMeasurement(value: DataView): number {
    const flags = value.getUint8(0);
    if (flags & FLAG_UINT16_FORMAT) {
        return value.getUint16(1, true);
    }
    return value.getUint8(1);
}
