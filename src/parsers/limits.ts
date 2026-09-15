/**
 * Plausibility limits shared by the two cadence decoders.
 *
 * Not protocol constants: nothing in CSC or FTMS defines these. They are this
 * package's policy about what to believe, kept in one place so the two
 * decoders cannot drift into disagreeing about the same question.
 */

/** Cadence at or above this is treated as a decoding artefact, not a rider. */
export const MAX_CADENCE_RPM = 300;
