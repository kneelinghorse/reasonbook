// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read eligible persisted citation edges or explicit typed fallback on old stores.
// ABOUTME: Every read revalidates time, origin and current collisions with no negative cache.
import {
  canonicalRecordFields,
  extractRecordLinkCandidates,
  type RecordLink,
  type CitationDiscards,
} from './record-link-extractor';
import {
  loadLinkInventory,
  requireLinkSuccess,
  withoutSelfLinks,
  type RecordLinkReader,
} from './record-link-store';
import { inspectRecordLinkSchema } from './record-link-schema';

/** available means a usable graph, including the explicit-only compatibility fallback. */
export function readRecordLinks(reader: RecordLinkReader): {
  available: boolean;
  mode: 'persisted' | 'typed-fallback' | 'error';
  links: RecordLink[];
  warnings: string[];
  discarded: CitationDiscards;
} {
  const discarded: CitationDiscards = {
    unknownTime: 0,
    foreign: 0,
    missing: 0,
    ambiguous: 0,
    unsupported: 0,
    notEarlier: 0,
  };
  const add = (counts: CitationDiscards): void => {
    for (const key of Object.keys(discarded) as (keyof CitationDiscards)[])
      discarded[key] += counts[key];
  };
  try {
    const state = inspectRecordLinkSchema(reader);
    const inventory = loadLinkInventory(reader);
    const links: RecordLink[] = [];
    if (!state.table || state.marker !== '1') {
      for (const source of inventory.sources) {
        const parsed = extractRecordLinkCandidates(
          canonicalRecordFields(source.kind, source.fields),
          source,
          inventory.identities,
          inventory.localProjectId,
          { typedOnly: true }
        );
        links.push(...withoutSelfLinks(parsed.links, source));
        add(parsed.discarded);
      }
      return { available: true, mode: 'typed-fallback', links, warnings: [], discarded };
    }
    const stored =
      requireLinkSuccess(
        reader.getMany<RecordLink>('SELECT * FROM record_links'),
        'persisted citation graph'
      ) ?? [];
    const sources = new Map(
      inventory.sources.map((source) => [`${source.kind}:${source.id}`, source])
    );
    for (const edge of stored) {
      const source = sources.get(`${edge.from_kind}:${edge.from_id}`);
      if (!source) {
        discarded.missing++;
        continue;
      }
      const text =
        edge.resolution === 'bare'
          ? `#${edge.to_id}`
          : `${edge.to_kind === 'decision' ? 'd' : 'l'}:${edge.to_id}`;
      const parsed = extractRecordLinkCandidates(
        [text],
        source,
        inventory.identities,
        inventory.localProjectId
      );
      add(parsed.discarded);
      if (
        parsed.links.some((valid) => valid.to_kind === edge.to_kind && valid.to_id === edge.to_id)
      )
        links.push(edge);
    }
    return { available: true, mode: 'persisted', links, warnings: [], discarded };
  } catch (error) {
    return {
      available: false,
      mode: 'error',
      links: [],
      warnings: [
        `RECORD_LINKS_READ_FAILED: ${error instanceof Error ? error.message : String(error)}. Citation expansion is unavailable until this query or schema is repaired.`,
      ],
      discarded,
    };
  }
}
