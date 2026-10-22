// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Resolve canonical-field citation candidates against explicit local temporal inventory.
// ABOUTME: This pure extractor is shared by persisted links, read fallback and frozen evaluation labels.

import { citationCandidates } from './decision-citations';
import { storedTimeMs } from './stored-time';

export type RecordKind = 'decision' | 'learning';
export type InventoryKind = RecordKind | 'constraint' | 'next_step' | 'feedback';
export interface CitationIdentity {
  readonly kind: string;
  readonly id: number;
  readonly created_at: string | null;
  readonly project_id: string | null;
}
export interface RecordLink {
  readonly from_kind: string;
  readonly from_id: number;
  readonly to_kind: RecordKind;
  readonly to_id: number;
  readonly resolution: 'typed' | 'bare';
}
export interface CitationDiscards {
  unknownTime: number;
  foreign: number;
  missing: number;
  ambiguous: number;
  unsupported: number;
  notEarlier: number;
}
export function canonicalRecordFields(kind: RecordKind, row: Record<string, unknown>): string[] {
  if (kind === 'learning') return typeof row.content === 'string' ? [row.content] : [];
  const fields: string[] = [];
  for (const key of ['decision_text', 'context_text', 'alternatives', 'consequences', 'deciders']) {
    const value = row[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (key === 'alternatives' || key === 'deciders') {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
          fields.push(...parsed);
          continue;
        }
      } catch {
        /* Historical malformed JSON remains one field, never a joined array. */
      }
    }
    fields.push(value);
  }
  return fields;
}

export function extractRecordLinkCandidates(
  fields: readonly string[],
  source: CitationIdentity,
  inventory: readonly (CitationIdentity & { kind: InventoryKind })[],
  localProjectId: string | null,
  options: { typedOnly?: boolean } = {}
): { links: RecordLink[]; discarded: CitationDiscards } {
  return createRecordLinkExtractor(inventory, localProjectId)(fields, source, options);
}

/** One inventory index for one read; never retained across reads of a changing store. */
export function createRecordLinkExtractor(
  inventory: readonly (CitationIdentity & { kind: InventoryKind })[],
  localProjectId: string | null
): (
  fields: readonly string[],
  source: CitationIdentity,
  options?: { typedOnly?: boolean }
) => { links: RecordLink[]; discarded: CitationDiscards } {
  const byId = new Map<number, (CitationIdentity & { kind: InventoryKind })[]>();
  for (const row of inventory) {
    const rows = byId.get(row.id);
    if (rows) rows.push(row);
    else byId.set(row.id, [row]);
  }
  return (fields, source, options = {}) => {
    const discarded: CitationDiscards = {
      unknownTime: 0,
      foreign: 0,
      missing: 0,
      ambiguous: 0,
      unsupported: 0,
      notEarlier: 0,
    };
    const links = new Map<string, RecordLink>();
    const local = (row: CitationIdentity): boolean =>
      row.project_id == null || (localProjectId !== null && row.project_id === localProjectId);
    const sourceTime = storedTimeMs(source.created_at);
    for (const field of fields)
      for (const candidate of citationCandidates(field)) {
        const { prefix, id } = candidate;
        if (prefix === 'blocked' || prefix === 'c' || prefix === 'n') {
          discarded.unsupported++;
          continue;
        }
        if (options.typedOnly && prefix === null) continue;
        if (!local(source)) {
          discarded.foreign++;
          continue;
        }
        if (!Number.isFinite(sourceTime)) {
          discarded.unknownTime++;
          continue;
        }
        const rows = byId.get(id) ?? [];
        const kind = prefix === 'd' ? 'decision' : prefix === 'l' ? 'learning' : null;
        if (!kind && rows.some((row) => !Number.isFinite(storedTimeMs(row.created_at)))) {
          discarded.unknownTime++;
          continue;
        }
        if (!kind && rows.length > 1) {
          discarded.ambiguous++;
          continue;
        }
        const target = kind ? rows.find((row) => row.kind === kind) : rows[0];
        if (!target) {
          discarded.missing++;
          continue;
        }
        if (target.kind !== 'decision' && target.kind !== 'learning') {
          discarded.unsupported++;
          continue;
        }
        if (!local(target)) {
          discarded.foreign++;
          continue;
        }
        const targetTime = storedTimeMs(target.created_at);
        if (!Number.isFinite(targetTime)) {
          discarded.unknownTime++;
          continue;
        }
        if (targetTime >= sourceTime) {
          discarded.notEarlier++;
          continue;
        }
        const key = `${target.kind}:${id}`;
        const resolution = kind ? 'typed' : 'bare';
        if (links.get(key)?.resolution !== 'typed')
          links.set(key, {
            from_kind: source.kind,
            from_id: source.id,
            to_kind: target.kind,
            to_id: id,
            resolution,
          });
      }
    return { links: [...links.values()], discarded };
  };
}
