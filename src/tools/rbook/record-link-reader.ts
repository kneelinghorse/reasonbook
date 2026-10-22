// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Read eligible persisted citation edges or explicit typed fallback on old stores.
// ABOUTME: Every read revalidates time, origin and current collisions with no negative cache.
import {
  canonicalRecordFields,
  createRecordLinkExtractor,
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

/**
 * s97-m01: whether a field could hold a citation. Every candidate the extractor reads is a match of
 * decision-citations.ts's CITATION in the field with code, links and URLs overwritten by dots of
 * the same length, so its `[dlcn]:` and first digit, or its `#` and first digit, stand in the field
 * as written. A field with neither cites nothing, and the narrowed read skips it unparsed.
 */
const MAY_CITE = /[dlcn]:[1-9]|#[1-9]/i;

/**
 * available means a usable graph, including the explicit-only compatibility fallback.
 *
 * s97-m01: with `toDecisions`, only the links to those decisions are read, the same links the full
 * read returns for them: persisted edges to other targets are not checked, and in the fallback a
 * record whose fields hold no citation at all is not parsed ({@link MAY_CITE}). Its `discarded`
 * then counts only what that narrower read looked at.
 */
export function readRecordLinks(
  reader: RecordLinkReader,
  options: { readonly toDecisions?: ReadonlySet<number> } = {}
): {
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
    const extract = createRecordLinkExtractor(inventory.identities, inventory.localProjectId);
    const links: RecordLink[] = [];
    const targets = options.toDecisions;
    const wanted = (link: { to_kind: string; to_id: number }): boolean =>
      !targets || (link.to_kind === 'decision' && targets.has(link.to_id));
    if (!state.table || state.marker !== '1') {
      for (const source of inventory.sources) {
        const fields = canonicalRecordFields(source.kind, source.fields);
        if (targets && !fields.some((field) => MAY_CITE.test(field))) continue;
        const parsed = extract(fields, source, { typedOnly: true });
        links.push(...withoutSelfLinks(parsed.links, source).filter(wanted));
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
      if (!wanted(edge)) continue;
      const source = sources.get(`${edge.from_kind}:${edge.from_id}`);
      if (!source) {
        discarded.missing++;
        continue;
      }
      const text =
        edge.resolution === 'bare'
          ? `#${edge.to_id}`
          : `${edge.to_kind === 'decision' ? 'd' : 'l'}:${edge.to_id}`;
      const parsed = extract([text], source);
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
