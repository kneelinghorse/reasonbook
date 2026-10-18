// SPDX-License-Identifier: Apache-2.0
// ABOUTME: What every answer from a copy of a shared record must say (s96-m12, ADR s96 §3, §5): each field in conflict
// ABOUTME: with its candidates, the states the cross-record checks find, and an id two copies created.

import { RbookDatabaseClient } from './client';
import { crossRecordFindings } from './record-checks';
import { openConflicts } from './record-settle';
import { storedTimeMs } from './stored-time';

/** ADR s96 §3: an id two copies created is named on every answer that names it, for 14 days. */
export const ALIAS_NOTICE_DAYS = 14;
const SHOWN_CONFLICTS = 3;

const brief = (value: unknown): string => {
  // Quoted as JSON, so the text "null" and a value of null read apart.
  const text = JSON.stringify(value) ?? 'null';
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
};

/** Every string a call's arguments hold, at any depth, so an id it names is found wherever it sits. */
function namedStrings(args: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof args === 'string') found.add(args);
  else if (Array.isArray(args)) for (const item of args) namedStrings(item, found);
  else if (args && typeof args === 'object')
    for (const value of Object.values(args as Record<string, unknown>)) namedStrings(value, found);
  return found;
}

/** The notices for one copy of a shared record, given the call's arguments. */
export function sharedRecordNotices(
  client: RbookDatabaseClient,
  args: unknown,
  now: number = Date.now()
): string[] {
  const notices: string[] = [];
  const conflicts = openConflicts(client);
  if (conflicts.length) {
    const shown = conflicts.slice(0, SHOWN_CONFLICTS).map((conflict) => {
      const name = conflict.recordId
        ? `${conflict.table} ${conflict.recordId}`
        : 'the project identity';
      const values = conflict.candidates
        .map(
          (candidate) =>
            `${brief(candidate.value)}${candidate.author ? ` (${candidate.author})` : ''}`
        )
        .join(', ');
      return `${name}'s ${conflict.field} shows ${brief(conflict.provisional)}, one of ${values}${conflict.ownerOnly ? " (only the owner's copy settles it)" : ''}`;
    });
    const more =
      conflicts.length > SHOWN_CONFLICTS ? `, and ${conflicts.length - SHOWN_CONFLICTS} more` : '';
    notices.push(
      `${conflicts.length} field(s) on this shared record hold values from copies that had not seen each other, so reads show a provisional value: ${shown.join('; ')}${more}. List them with rbook_db(action="conflicts") and keep one with rbook_db(action="settle").`
    );
  }
  const findings = crossRecordFindings(client);
  if (findings.length) {
    const more =
      findings.length > SHOWN_CONFLICTS ? ` And ${findings.length - SHOWN_CONFLICTS} more.` : '';
    notices.push(
      `${findings.length} state(s) of this shared record need a person: ${findings
        .slice(0, SHOWN_CONFLICTS)
        .map((finding) => finding.detail)
        .join(' ')}${more} rbook_db(action="conflicts") lists them all.`
    );
  }
  const named = namedStrings(args);
  if (named.size) {
    const since = new Date(now - ALIAS_NOTICE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const aliases = client.getMany<{
      entity: string;
      plain_id: string;
      renamed_id: string;
      renamed_at: string;
    }>(
      'SELECT entity, plain_id, renamed_id, renamed_at FROM record_aliases WHERE julianday(renamed_at) >= julianday(?) ORDER BY julianday(renamed_at)',
      [since]
    );
    for (const alias of aliases.success ? (aliases.data ?? []) : [])
      if (named.has(alias.plain_id)) {
        const until = new Date(
          storedTimeMs(alias.renamed_at) + ALIAS_NOTICE_DAYS * 24 * 60 * 60 * 1000
        )
          .toISOString()
          .slice(0, 10);
        notices.push(
          `${alias.plain_id} names two ${alias.entity}: ${alias.plain_id}, created first, and ${alias.renamed_id}, created on another copy that had not seen it. This notice shows until ${until}.`
        );
      }
  }
  return notices;
}

/** The notices for the copy at `dbPath`; a copy that cannot be read says so rather than staying quiet. */
export async function sharedRecordNoticesAt(dbPath: string, args: unknown): Promise<string[]> {
  const opened = await RbookDatabaseClient.create({ dbPath, readonly: true, replicaCheck: false });
  if (!opened.success || !opened.data)
    return [
      `This shared record could not be checked for conflicts: ${opened.error?.message ?? 'it could not be opened'}.`,
    ];
  try {
    return sharedRecordNotices(opened.data, args);
  } catch (error) {
    return [
      `This shared record could not be checked for conflicts: ${error instanceof Error ? error.message : String(error)}.`,
    ];
  } finally {
    opened.data.close();
  }
}
