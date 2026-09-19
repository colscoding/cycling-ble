/**
 * Cycling Speed and Cadence Service (0x1816) — CSC Measurement (0x2A5B).
 */

import { MAX_CADENCE_RPM } from './limits.js';
import { requireLength } from './length.js';

/**
 * How many values a uint16 holds — one more than its maximum. Both the
 * revolution counter and the event time are uint16 and wrap, and correcting a
 * wrap means adding the range, not the maximum.
 */
const UINT16_RANGE = 65536;

/** Crank event time is expressed in 1/1024 second units. */
const CRANK_TIME_RESOLUTION = 1024;

/** Flags bit 0: wheel revolution data present (6 bytes, skipped). */
const FLAG_WHEEL_DATA = 0x01;

/** Flags bit 1: crank revolution data present. */
const FLAG_CRANK_DATA = 0x02;

/**
 * Carried between notifications. CSC reports cumulative counters, so RPM only
 * exists as a delta between two samples.
 */
export interface CadenceState {
    readonly lastCrankRevs: number | null;
    readonly lastCrankTime: number | null;
}

/**
 * What to pass on the first call after connecting.
 *
 * Frozen, and readonly in the type. This is one object shared by every caller
 * in the process, so a consumer writing to it would move the starting point
 * for all the others. Each call returns fresh state rather than mutating.
 */
export const initialCadenceState: CadenceState = Object.freeze({
    lastCrankRevs: null,
    lastCrankTime: null,
});

export interface CadenceParseResult {
    /** Cadence in rpm, or null when a value cannot be derived from this sample. */
    rpm: number | null;
    /** State to pass to the next call. */
    state: CadenceState;
}

/**
 * Decode cadence from a CSC Measurement characteristic.
 *
 * Returns `null` rather than throwing whenever a sample yields no usable
 * value: the first sample after connecting, a packet without crank data, a
 * repeated event time, or an implausible result.
 *
 * A stopped crank usually repeats its last event, which leaves no time delta
 * to divide by, so pedalling stopping shows up as readings stopping. A sensor
 * that instead advances the event time without a new revolution has timed a
 * window the rider did not pedal through: that yields a genuine 0 rpm, and is
 * reported as one.
 *
 * @throws {RangeError} When the packet is too short for the fields its flags
 * announce. That is a malformed packet, not an unusable sample.
 */
export function parseCadenceMeasurement(value: DataView, state: CadenceState): CadenceParseResult {
    const flags = value.getUint8(0);
    const offset = flags & FLAG_WHEEL_DATA ? 7 : 1;
    requireLength(value, offset + (flags & FLAG_CRANK_DATA ? 4 : 0));

    if (!(flags & FLAG_CRANK_DATA)) {
        return { rpm: null, state };
    }

    // Wheel data, when present, occupies 6 bytes between the flags and the
    // crank fields: a uint32 revolution count and a uint16 event time.
    const crankRevs = value.getUint16(offset, true);
    const crankTime = value.getUint16(offset + 2, true);

    const newState: CadenceState = { lastCrankRevs: crankRevs, lastCrankTime: crankTime };

    if (state.lastCrankRevs === null || state.lastCrankTime === null) {
        return { rpm: null, state: newState };
    }

    let revDelta = crankRevs - state.lastCrankRevs;
    let timeDelta = crankTime - state.lastCrankTime;
    if (revDelta < 0) revDelta += UINT16_RANGE;
    if (timeDelta < 0) timeDelta += UINT16_RANGE;

    if (timeDelta <= 0) {
        return { rpm: null, state: newState };
    }

    // Both deltas are corrected to non-negative above and timeDelta is known
    // positive, so rpm cannot come out negative — only implausibly large.
    const rpm = Math.round((revDelta / (timeDelta / CRANK_TIME_RESOLUTION)) * 60);
    if (rpm >= MAX_CADENCE_RPM) {
        return { rpm: null, state: newState };
    }

    return { rpm, state: newState };
}
