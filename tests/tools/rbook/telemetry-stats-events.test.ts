// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Measure use attribution without silently discarding pid records or crediting other sessions.
// ABOUTME: Pin digest cost and unchanged-store pair denominators across compactions and legacy records.

import {
  eventStatistics,
  EVENT_COUNTING_RULES,
} from '../../../src/tools/rbook/telemetry-stats-events';
import type { TelemetryRecord } from '../../../src/tools/rbook/local-telemetry';

const now = Date.now();
const a = 'aaaaaaaaaaaaaaaa';
const b = 'bbbbbbbbbbbbbbbb';
type Input = Partial<TelemetryRecord> & { source?: 'startup' | 'resume' | 'clear' | 'compact' };
function record(offset: number, partial: Input = {}): TelemetryRecord {
  return {
    ts: new Date(now + offset).toISOString(),
    session: a,
    surface: 'hook',
    client: 'test',
    tool: 'hook session-start',
    action: null,
    mode: 'read',
    ok: true,
    refused: null,
    failOpen: null,
    ambient: 'on',
    ...partial,
  };
}
const use = (offset: number, partial: Input = {}) =>
  record(offset, {
    surface: 'mcp',
    tool: 'rbook_decisions',
    action: 'record',
    mode: 'write',
    ...partial,
  });
const digest = (offset: number, partial: Input = {}) =>
  record(offset, {
    charsInjected: 100,
    digestHash: 'a'.repeat(64),
    source: 'startup',
    ...partial,
  });

describe('honest use attribution and digest denominators', () => {
  it('exposes successful pid uses even without an injection, and excludes unsuccessful uses', () => {
    const stats = eventStatistics([
      {
        target: 'store',
        records: [
          record(0, { idsInjected: ['l:532'] }),
          use(1, { session: 'pid:1234abcd:2:3', idsCited: ['l:532', 'd:9', 'd:9'] }),
          use(2, {
            session: 'pid:1234abcd:3:4',
            tool: 'rbook_learnings',
            action: 'show',
            mode: 'read',
            idsReturned: ['l:532'],
          }),
          use(3, { session: null, idsCited: ['n:7'] }),
          use(4, { session: 'pid:1234abcd:4:5', idsCited: ['l:532'], ok: false }),
          use(5, { session: 'pid:1234abcd:5:6', idsCited: ['l:532'], refused: 'NO' }),
          use(6, { session: 'pid:1234abcd:6:7', idsCited: ['l:532'], failOpen: 'error' }),
          use(7, {
            session: 'pid:1234abcd:7:8',
            idsReturned: ['l:532'],
            action: 'list',
            mode: 'read',
          }),
        ],
      },
    ]);
    expect(stats).toMatchObject({
      citeThrough: { digest: { injected: 1, used: 0, ratio: 0 } },
      unjoinableUses: {
        records: 3,
        pidKeyedRecords: 2,
        otherUnkeyedRecords: 1,
        items: [
          { target: 'store', id: 'l:532', records: 2 },
          { target: 'store', id: 'd:9', records: 1 },
          { target: 'store', id: 'n:7', records: 1 },
        ],
      },
    });
  });

  it('reports later cross-session references separately while preserving same-store later-use joins', () => {
    const stats = eventStatistics([
      {
        target: 'store',
        records: [
          use(-1, { session: b, idsCited: ['d:1622'] }), // earlier is not a reference to exposure
          record(0, { idsInjected: ['d:1622', 'd:1', 'd:2'] }),
          record(0, { session: b, idsInjected: ['d:1'] }),
          use(1, { session: b, idsCited: ['d:1622', 'd:1'] }),
          use(2, { session: `ext:${a}`, idsCited: ['d:2'] }),
          use(3, { session: b, idsCited: ['d:1622'], ok: false }),
        ],
      },
      { target: 'other-store', records: [use(4, { session: b, idsCited: ['d:2'] })] },
    ]);
    expect(stats).toMatchObject({
      citeThrough: { digest: { injected: 4, used: 2, ratio: 0.5 } },
      crossSessionReferences: {
        records: 1,
        items: [{ target: 'store', id: 'd:1622', records: 1 }],
      },
    });
  });

  it('separates emitted injections, compact costs and legacy source from noncompact sessions', () => {
    const stats = eventStatistics([
      {
        target: 'store',
        records: [
          digest(0),
          digest(1, { source: 'resume', charsInjected: 120 }),
          digest(2, { source: 'compact', charsInjected: 80 }),
          digest(3, { source: 'clear', session: b, charsInjected: 200 }),
          digest(4, { source: undefined, charsInjected: 50 }),
          digest(5, { source: 'startup', session: null, charsInjected: 30 }),
          record(6, { tool: 'hook prompt', charsInjected: 20 }),
          digest(7, { charsInjected: 0 }),
        ],
      },
    ]);
    expect(stats.injection).toMatchObject({
      characters: 600,
      injections: 7,
      meanCharactersPerInjection: 600 / 7,
      sessions: 2,
      unkeyedCharacters: 30,
      meanCharactersPerSession: 285,
      digest: {
        characters: 580,
        injections: 6,
        meanCharactersPerInjection: 580 / 6,
        nonCompactSessions: 2,
        nonCompactCharacters: 420,
        meanCharactersPerNonCompactSession: 210,
        nonCompactInjections: 4,
        unkeyedNonCompactCharacters: 30,
        compactInjections: 1,
        compactCharacters: 80,
        unknownSourceInjections: 1,
        unknownSourceCharacters: 50,
      },
    });
  });

  it('returns unavailable denominators for legacy-only source or empty emission', () => {
    expect(
      eventStatistics([{ target: 'store', records: [digest(0, { source: undefined })] }]).injection
    ).toMatchObject({
      digest: {
        nonCompactSessions: 0,
        meanCharactersPerNonCompactSession: null,
        unknownSourceInjections: 1,
      },
    });
    expect(eventStatistics([]).injection).toMatchObject({
      injections: 0,
      meanCharactersPerInjection: null,
      comparableDigestPairs: 0,
      stableDigestRatio: null,
    });
  });

  it('uses consecutive same-store hashes across days and sessions, excluding intervening successful writes', () => {
    const stats = eventStatistics([
      {
        target: 'store',
        records: [
          digest(0),
          digest(86_400_000, { session: b }), // cross-day, cross-session match
          use(86_400_001, { session: 'pid:1234abcd:4:5' }),
          digest(86_400_002), // equal, but a successful pid write intervened
          use(86_400_003, { ok: false }),
          use(86_400_004, { refused: 'NO' }),
          use(86_400_005, { failOpen: 'error' }),
          digest(86_400_006, { session: null }), // failed calls do not invalidate unchanged store
          digest(86_400_007, { digestHash: 'b'.repeat(64) }),
          digest(86_400_008), // non-consecutive old hash is not a stable pair
        ].reverse(),
      }, // timestamps, not input array grouping, determine order
      { target: 'other-store', records: [use(1), digest(2)] },
    ]);
    expect(stats.injection).toMatchObject({
      stableDigestPairs: 2,
      comparableDigestPairs: 4,
      writeSeparatedDigestPairs: 1,
      stableDigestRatio: 0.5,
    });
  });

  it('does not bridge a missing hash or treat an unsuccessful digest as emitted stability evidence', () => {
    const stats = eventStatistics([
      {
        target: 'store',
        records: [
          digest(0),
          digest(1, { digestHash: undefined }),
          digest(2),
          digest(3, { ok: false, digestHash: 'b'.repeat(64) }),
          digest(4),
        ],
      },
    ]);
    expect(stats.injection).toMatchObject({
      stableDigestPairs: 1,
      comparableDigestPairs: 1,
      missingHashDigestPairs: 2,
    });
  });

  it('publishes limitations that keep observed references from claiming behavioral use or causality', () => {
    const rules = JSON.stringify(EVENT_COUNTING_RULES).toLowerCase();
    for (const limitation of [
      'unmeasured',
      'bare #n',
      'inflates',
      'draft expiry',
      'time text',
      'consecutive',
      'unknown',
    ])
      expect(rules).toContain(limitation);
  });
});
