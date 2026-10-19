// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Which baseline a copy goes by (s97-m10, design fact 24): the first it holds whose value names the replica
// ABOUTME: that wrote it, so a member's forged one changes no copy. A leaf module, since the identity checks read it too.

/**
 * s97-m10 (design fact 24): the record's baseline, the first this copy holds whose value names the
 * replica that wrote it. A member's forged one, naming another copy or arriving after the share's
 * own, is not it; every copy holds the share's own first, from the share or the copy it joined from.
 */
export const BASELINE_QUERY = `SELECT * FROM record_changes WHERE kind = 'baseline'
  AND replica_id = CASE WHEN json_valid(value) THEN json_extract(value, '$.authority') END
  ORDER BY rowid LIMIT 1`;
