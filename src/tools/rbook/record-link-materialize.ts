// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Repair derived citation edges using persisted source text and a complete collision inventory.
// ABOUTME: All writes are synchronous and belong to the caller's transaction, including delayed sync repair.

import type { RbookDatabaseClient } from './client';
import {
  canonicalRecordFields,
  extractRecordLinkCandidates,
  type RecordLink,
  type CitationDiscards,
} from './record-link-extractor';
import {
  requireLinkSuccess,
  withoutSelfLinks,
  type LinkInventory,
  type StoredLinkSource,
} from './record-link-store';

export function repairLinkSources(
  client: RbookDatabaseClient,
  inventory: LinkInventory,
  sources: readonly StoredLinkSource[]
): { linksChanged: number; linkCount: number; discarded: CitationDiscards } {
  let linksChanged = 0,
    linkCount = 0;
  const discarded: CitationDiscards = {
    unknownTime: 0,
    foreign: 0,
    missing: 0,
    ambiguous: 0,
    unsupported: 0,
    notEarlier: 0,
  };
  for (const source of sources) {
    const parsed = extractRecordLinkCandidates(
      canonicalRecordFields(source.kind, source.fields),
      source,
      inventory.identities,
      inventory.localProjectId
    );
    parsed.links = withoutSelfLinks(parsed.links, source);
    for (const key of Object.keys(discarded) as (keyof CitationDiscards)[])
      discarded[key] += parsed.discarded[key];
    const previous =
      requireLinkSuccess(
        client.getMany<RecordLink>('SELECT * FROM record_links WHERE from_kind=? AND from_id=?', [
          source.kind,
          source.id,
        ]),
        'existing required links'
      ) ?? [];
    const key = (edge: RecordLink): string => `${edge.to_kind}:${edge.to_id}`;
    const wanted = new Map(parsed.links.map((edge) => [key(edge), edge]));
    for (const edge of previous)
      if (!wanted.has(key(edge))) {
        const result = requireLinkSuccess(
          client.execute(
            'DELETE FROM record_links WHERE from_kind=? AND from_id=? AND to_kind=? AND to_id=?',
            [source.kind, source.id, edge.to_kind, edge.to_id]
          ),
          'remove ineligible required link'
        );
        linksChanged += result?.changes ?? 0;
      }
    for (const edge of parsed.links) {
      const result = requireLinkSuccess(
        client.execute(
          `INSERT INTO record_links (from_kind,from_id,to_kind,to_id,resolution) VALUES(?,?,?,?,?)
        ON CONFLICT(from_kind,from_id,to_kind,to_id) DO UPDATE SET resolution=excluded.resolution
        WHERE record_links.resolution<>excluded.resolution`,
          [source.kind, source.id, edge.to_kind, edge.to_id, edge.resolution]
        ),
        'write required citation link'
      );
      linksChanged += result?.changes ?? 0;
    }
    linkCount += parsed.links.length;
  }
  return { linksChanged, linkCount, discarded };
}
