/**
 * Cycling Speed and Cadence Service (0x1816) — CSC Measurement (0x2A5B).
 */

/** Cadence above this is treated as a decoding artefact rather than a rider. */
const MAX_CADENCE_RPM = 300;

/** Both the revolution counter and the event time are uint16 and wrap. */
const UINT16_MAX = 65536;

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
    lastCrankRevs: number | null;
    lastCrankTime: number | null;
}

/** What to pass on the first call after connecting. */
export const initialCadenceState: CadenceState = { lastCrankRevs: null, lastCrankTime: null };

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
 */
export function parseCadenceMeasurement(value: DataView, state: CadenceState): CadenceParseResult {
    const flags = value.getUint8(0);

    if (!(flags & FLAG_CRANK_DATA)) {
        return { rpm: null, state };
    }

    // Wheel data, when present, occupies 6 bytes between the flags and the
    // crank fields: a uint32 revolution count and a uint16 event time.
    const offset = flags & FLAG_WHEEL_DATA ? 7 : 1;

    const crankRevs = value.getUint16(offset, true);
    const crankTime = value.getUint16(offset + 2, true);

    const newState: CadenceState = { lastCrankRevs: crankRevs, lastCrankTime: crankTime };

    if (state.lastCrankRevs === null || state.lastCrankTime === null) {
        return { rpm: null, state: newState };
    }

    let revDelta = crankRevs - state.lastCrankRevs;
    let timeDelta = crankTime - state.lastCrankTime;
    if (revDelta < 0) revDelta += UINT16_MAX;
    if (timeDelta < 0) timeDelta += UINT16_MAX;

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
