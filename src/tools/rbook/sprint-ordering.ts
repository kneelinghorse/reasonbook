// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Defines the one SQL ordering contract for sprint IDs across Reasonbook read paths.
// ABOUTME: Sorts sprint-N numerically while keeping legacy IDs and NULLs deterministic.

type SprintOrderDirection = 'ASC' | 'DESC';

const TRUSTED_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Build the comma-separated SQL keys that order a sprint-ID expression.
 *
 * Canonical `sprint-<digits>` IDs sort numerically and always precede legacy shapes. The raw
 * binary ID is both the deterministic fallback for legacy values and the tie-break for numeric
 * aliases such as `sprint-01` and `sprint-1`. NULL is kept last in either direction.
 *
 * Callers must pass a trusted SQL column expression, never user input.
 */
export function sprintIdOrderSql(expression: string, direction: SprintOrderDirection): string {
  if (!TRUSTED_SQL_IDENTIFIER.test(expression)) {
    throw new Error(`Invalid sprint-ID SQL expression: ${expression}`);
  }
  if (direction !== 'ASC' && direction !== 'DESC') {
    throw new Error(`Invalid sprint-ID sort direction: ${String(direction)}`);
  }

  // s96-m12 (ADR s96 §3): `sprint-N~K`, a sprint id two copies created, sorts as sprint N.
  const number = `CASE WHEN INSTR(${expression}, '~') > 0 THEN SUBSTR(${expression}, 8, INSTR(${expression}, '~') - 8) ELSE SUBSTR(${expression}, 8) END`;
  const canonical = `${expression} GLOB 'sprint-[0-9]*' AND ${number} NOT GLOB '*[^0-9]*' AND (INSTR(${expression}, '~') = 0 OR SUBSTR(${expression}, INSTR(${expression}, '~') + 1) GLOB '[0-9]*' AND SUBSTR(${expression}, INSTR(${expression}, '~') + 1) NOT GLOB '*[^0-9]*')`;

  return `CASE
        WHEN ${expression} IS NULL THEN 2
        WHEN ${canonical} THEN 0
        ELSE 1
      END ASC,
      CASE WHEN ${canonical} THEN CAST(${number} AS INTEGER) END ${direction},
      ${expression} COLLATE BINARY ${direction}`;
}
