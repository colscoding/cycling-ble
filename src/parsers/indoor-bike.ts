/**
 * Fitness Machine Service (0x1826) — Indoor Bike Data (0x2AD2).
 *
 * Many smart trainers and spin bikes report power and cadence only here, not
 * through the Cycling Power Service. This decodes notifications; the package
 * never writes to the FTMS control point, so there is no resistance or ERG
 * control.
 */

import { MAX_CADENCE_RPM } from './limits.js';

/**
 * Bit 0 is "More Data" and is the one inverted flag in the field: when it is
 * CLEAR, Instantaneous Speed is present.
 */
const FLAG_MORE_DATA = 1 << 0;
const FLAG_AVG_SPEED = 1 << 1;
const FLAG_INST_CADENCE = 1 << 2;
const FLAG_AVG_CADENCE = 1 << 3;
const FLAG_TOTAL_DISTANCE = 1 << 4;
/**
 * Resistance Level is skipped as 2 bytes (sint16), per FTMS v1.0. The later
 * GATT Specification Supplement lists it as uint8. The two cannot both be
 * right, and a trainer following the other reading would shift the power
 * field by one byte — unconfirmed against real hardware.
 */
const FLAG_RESISTANCE = 1 << 5;
const FLAG_INST_POWER = 1 << 6;

/** Instantaneous cadence is a uint16 carrying 0.5 rpm per unit. */
const CADENCE_RESOLUTION = 2;

/** Decoded Indoor Bike Data. A field is null when absent or implausible. */
export interface IndoorBikeParseResult {
    /** Instantaneous power in watts. */
    powerW: number | null;
    /** Instantaneous cadence in rpm. */
    cadenceRpm: number | null;
}

/**
 * Decode an Indoor Bike Data notification.
 *
 * The uint16 flags field declares which optional fields follow, in a fixed
 * order. Fields we do not use still have to be walked past to find the ones we
 * do, so every skip below is load-bearing.
 *
 * @throws {RangeError} When the flags announce a field the packet is too short
 * to hold.
 */
export function parseIndoorBikeData(value: DataView): IndoorBikeParseResult {
    const flags = value.getUint16(0, true);
    let offset = 2;

    let cadenceRpm: number | null = null;
    let powerW: number | null = null;

    if (!(flags & FLAG_MORE_DATA)) offset += 2; // instantaneous speed
    if (flags & FLAG_AVG_SPEED) offset += 2;

    if (flags & FLAG_INST_CADENCE) {
        // Unsigned, so only the ceiling needs checking.
        const raw = Math.round(value.getUint16(offset, true) / CADENCE_RESOLUTION);
        cadenceRpm = raw < MAX_CADENCE_RPM ? raw : null;
        offset += 2;
    }

    if (flags & FLAG_AVG_CADENCE) offset += 2;
    if (flags & FLAG_TOTAL_DISTANCE) offset += 3; // uint24
    if (flags & FLAG_RESISTANCE) offset += 2;

    if (flags & FLAG_INST_POWER) {
        powerW = value.getInt16(offset, true);
    }

    return { powerW, cadenceRpm };
}
