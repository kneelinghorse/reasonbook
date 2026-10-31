// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s106-m01 — close measures 11 (misuse refusals by tool, action and refused field) and 12
// ABOUTME: (identity lookups over 100 ms). Tools and actions are published names or `unknown`.

import { toolNameSuffix } from '../../intelligence/legacy-compat';
import type { TelemetryRecord } from './local-telemetry';
import { RBOOK_TOOL_DEFINITIONS } from './index';

/** The refusals counted as misuse: the call broke the tool's published contract. */
const MISUSE_CODES: ReadonlySet<string> = new Set([
  'INVALID_PARAMETER',
  'MISSING_PARAMETER',
  'INVALID_ACTION',
]);
/** The identity lookup's budget before s105-m03; a lookup past it then filed its row anonymously. */
const SLOW_LOOKUP_MS = 100;

export const MISUSE_COUNTING_RULES = {
  misuse:
    "Measure 11. Rows: MCP rows in the window, both bounds inclusive, from each selected store's own bucket. Misuse: a refusal coded INVALID_PARAMETER, MISSING_PARAMETER or INVALID_ACTION. Counted by tool, action and refusedField; a legacy cmos_x name counts as rbook_x, and a tool or action the full edition does not publish counts as unknown. A stored refusedField is kept when it is a parameter name the full edition publishes for that tool, or the marker unknown or unspecified; any other stored value counts as unspecified. The writer records unknown for an INVALID_PARAMETER naming a supplied key the tool does not publish. refusedField is null when the row carries none, as rows written before s106-m01 do; unmeasuredField counts those rows.",
  lookups:
    'Measure 12. Rows: the same MCP rows. over100 counts rows whose lookupMs exceeds 100. measured counts rows with a lookupMs, noLookup rows whose call named no store, and unmeasured rows written before s106-m01, which are never counted as zero. maxMs is the largest measured lookupMs.',
  anonymousBound:
    "Both measures repeat their counts over the anonymous bucket (projectId unattributed, its key from telemetryKey) for the same window, read once per export. It holds every refusal made before resolution without a projectRoot and every row whose identity lookup failed, so up to that many more rows may belong to the selected stores: a bound beside each count, never added to it. On each side, available is false when a bucket yields no readable row and no readable empty monthly file (on the store side, any selected store's bucket); its counts are then a lower bound, not a measurement. A bucket that is only partly unreadable stays available: a store's warnings count in coverage.diagnosticCount, and the anonymous bucket's appear only in the human report.",
} as const;

interface PublishedTool {
  readonly name: string;
  readonly inputSchema: {
    readonly properties?: Readonly<Record<string, unknown>> & {
      readonly action?: { readonly enum?: unknown };
    };
  };
}

/** Each published tool's actions and parameter names; a tool without an action publishes none. */
const PUBLISHED: ReadonlyMap<
  string,
  { readonly actions: readonly unknown[]; readonly parameters: readonly string[] }
> = new Map(
  (RBOOK_TOOL_DEFINITIONS as unknown as readonly PublishedTool[]).map((tool) => {
    const properties = tool.inputSchema.properties ?? {};
    const values = properties.action?.enum;
    return [
      tool.name,
      { actions: Array.isArray(values) ? values : [], parameters: Object.keys(properties) },
    ];
  })
);
const MARKERS: ReadonlySet<string> = new Set(['unknown', 'unspecified']);

function publishedTool(tool: string): string {
  const suffix = toolNameSuffix(tool);
  return suffix !== null && PUBLISHED.has(`rbook_${suffix}`) ? `rbook_${suffix}` : 'unknown';
}

/** Ascending, with null last, so the same rows always list in the same order. */
function compare(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const mcpRows = (records: readonly TelemetryRecord[]) =>
  records.filter((record) => record.surface === 'mcp');

/** Measure 11 over one set of rows: the selected stores', or the anonymous bucket's as their bound. */
export function misuseMeasure(records: readonly TelemetryRecord[]) {
  const rows = mcpRows(records);
  const counts = new Map<
    string,
    { tool: string; action: string | null; refusedField: string | null; refusals: number }
  >();
  let refusals = 0;
  let unmeasuredField = 0;
  for (const record of rows) {
    if (record.refused === null || !MISUSE_CODES.has(record.refused)) continue;
    refusals++;
    const tool = publishedTool(record.tool);
    const published = PUBLISHED.get(tool);
    const action =
      record.action === null
        ? null
        : (published?.actions ?? []).includes(record.action)
          ? record.action
          : 'unknown';
    // The writer names only published parameters and the two markers; checking again here keeps
    // the export's vocabulary closed whatever code wrote the row.
    const stored = typeof record.refusedField === 'string' ? record.refusedField : null;
    const refusedField =
      stored === null || MARKERS.has(stored) || published?.parameters.includes(stored)
        ? stored
        : 'unspecified';
    if (refusedField === null) unmeasuredField++;
    const key = JSON.stringify([tool, action, refusedField]);
    const entry = counts.get(key) ?? { tool, action, refusedField, refusals: 0 };
    entry.refusals++;
    counts.set(key, entry);
  }
  const byField = [...counts.values()].sort(
    (a, b) =>
      b.refusals - a.refusals ||
      compare(a.tool, b.tool) ||
      compare(a.action, b.action) ||
      compare(a.refusedField, b.refusedField)
  );
  return { rows: rows.length, refusals, unmeasuredField, byField };
}

/** Measure 12 over one set of rows; a row with no lookupMs is unmeasured, never a zero. */
export function lookupMeasure(records: readonly TelemetryRecord[]) {
  const rows = mcpRows(records);
  const measured = rows.flatMap((record) =>
    typeof record.lookupMs === 'number' ? [record.lookupMs] : []
  );
  return {
    rows: rows.length,
    measured: measured.length,
    noLookup: rows.filter((record) => record.lookupMs === null).length,
    unmeasured: rows.filter((record) => record.lookupMs === undefined).length,
    over100: measured.filter((ms) => ms > SLOW_LOOKUP_MS).length,
    maxMs: measured.length ? measured.reduce((a, b) => Math.max(a, b)) : null,
  };
}
