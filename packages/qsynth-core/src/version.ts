/**
 * Compiler version, recorded in every artifact, report and job row.
 *
 * It is part of the artifact text, so bumping it changes content hashes — deliberately.
 * Two artifacts with the same hash must have been produced by the same compiler from the
 * same spec; "same output, different compiler" is a claim nothing here can support.
 *
 * Bump the minor when output changes shape, the patch when only behaviour behind an
 * unchanged output changes.
 */
export const COMPILER_VERSION = '1.0.0';
