-- ---------------------------------------------------------------------------
-- 006: record the size of the Clifford+T decomposition, not only its T figures.
--
-- resource_estimates was written when the Clifford+T numbers were read off a
-- per-gate table, and it kept the three a budget can be declared against:
-- two-qubit count, T count, T depth. The compiler now builds the decomposition
-- before estimating, so those three are measurements — and the total gate count
-- of the decomposed circuit is a measurement too, and the one a reader needs to
-- tell "this artifact is 36 gates" from "this artifact is 36 T gates".
--
-- Nullable rather than defaulted: rows written before this migration were never
-- given a figure, and inventing a zero for them would say the decomposition was
-- empty. NULL says what is true — this job predates the column.
-- ---------------------------------------------------------------------------

alter table resource_estimates add column clifford_gate_count integer;
