// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s96-m14 — the import's pure rules: how one differing field is classified, the stable id an import derives for a
// ABOUTME: row, and how a copy's values read in the record's ids, each rule pinned on its own so a change to it fails here.
import { describe, expect, it } from '@jest/globals';
import { classifyField, type FieldInput } from '../../../src/tools/rbook/record-import-fields';
import { encodeTime } from 'ulid';
import {
  entityStates,
  importedStable,
  namesWaiting,
  textInRecord,
  translated,
  walkImports,
} from '../../../src/tools/rbook/record-import-ids';

const field = (overrides: Partial<FieldInput>): FieldInput => ({
  table: 'missions',
  field: 'name',
  copy: 'Copy',
  owner: 'Record',
  base: undefined,
  root: 'Record',
  heldBefore: false,
  appendsLogged: new Set(),
  ...overrides,
});

describe('a plain field', () => {
  it('against a base: one side changed takes that side, both changed is raised; with none, raised', () => {
    expect(classifyField(field({ copy: 'Same', owner: 'Same' }))).toEqual({ kind: 'same' });
    expect(classifyField(field({ base: 'Copy' }))).toEqual({ kind: 'owner' });
    expect(classifyField(field({ base: 'Record' }))).toEqual({ kind: 'copy', write: 'Copy' });
    expect(classifyField(field({ base: 'Neither' }))).toEqual({ kind: 'raise', write: 'Copy' });
    expect(classifyField(field({}))).toEqual({ kind: 'raise', write: 'Copy' });
  });

  it('a value the record has held since sharing is the record having changed it', () => {
    expect(classifyField(field({ heldBefore: true }))).toEqual({ kind: 'held' });
  });

  it('an author the copy never recorded is no other author; one it did record is compared', () => {
    expect(classifyField(field({ field: 'author_name', copy: null }))).toEqual({ kind: 'owner' });
    expect(classifyField(field({ field: 'author_name', copy: 'Darryl' }))).toEqual({
      kind: 'raise',
      write: 'Darryl',
    });
  });

  it('a review time comes in only when the copy holds the later one', () => {
    const at = (copy: string | null, owner: string | null) =>
      classifyField(field({ table: 'learnings', field: 'last_reviewed_at', copy, owner }));
    expect(at('2026-05-02 00:00:00', '2026-05-01T00:00:00Z')).toEqual({
      kind: 'copy',
      write: '2026-05-02 00:00:00',
    });
    expect(at('2026-04-30T00:00:00Z', '2026-05-01T00:00:00Z')).toEqual({ kind: 'owner' });
    // The same moment written two ways is no later.
    expect(at('2026-05-01 00:00:00', '2026-05-01T00:00:00Z')).toEqual({ kind: 'owner' });
    expect(at('2026-05-01 00:00:00', null)).toEqual({
      kind: 'copy',
      write: '2026-05-01 00:00:00',
    });
    expect(at(null, '2026-05-01T00:00:00Z')).toEqual({ kind: 'owner' });
  });
});

describe('a flag', () => {
  const flag = (copy: number, owner: number, base?: number) =>
    classifyField(
      field({ table: 'learnings', field: 'evergreen', copy, owner, base, root: owner })
    );

  it('against a base, the side that changed it decides, a cleared flag included', () => {
    expect(flag(0, 1, 1)).toEqual({ kind: 'copy', write: 0 });
    expect(flag(1, 0, 0)).toEqual({ kind: 'copy', write: 1 });
    expect(flag(0, 1, 0)).toEqual({ kind: 'owner' });
  });

  it('with no base is never raised: an added flag wins, and one the copy cleared is kept as the record holds it', () => {
    expect(flag(1, 0)).toEqual({ kind: 'copy', write: 1 });
    expect(flag(0, 1)).toEqual({ kind: 'kept' });
  });
});

describe('appended text', () => {
  const notes = (copy: string, owner: string, extra: Partial<FieldInput> = {}) =>
    classifyField(field({ field: 'notes', copy, owner, root: owner, ...extra }));

  it("the copy's text extending the record's is an addition; the record's extending the copy's is the record's", () => {
    expect(notes('A. B.', 'A.')).toEqual({ kind: 'copy', write: 'A. B.' });
    expect(notes('A.', 'A. B.')).toEqual({ kind: 'owner' });
  });

  it("what both added after a common start is kept from both, the record's first, once", () => {
    expect(notes('A. Copy.', 'A. Record.', { root: 'A.' })).toEqual({
      kind: 'copy',
      write: 'A. Record. Copy.',
    });
    expect(notes('A. Copy.', 'A. Record. Copy.', { root: 'A.' })).toEqual({ kind: 'owner' });
    expect(
      notes('A. Copy.', 'A. Record.', { root: 'A.', appendsLogged: new Set(['" Copy."']) })
    ).toEqual({ kind: 'owner' });
  });

  it('a base names the common start, and a side that kept it decides as for a plain field', () => {
    expect(notes('A. Copy.', 'A. Record.', { base: 'A.', root: 'Z.' })).toEqual({
      kind: 'copy',
      write: 'A. Record. Copy.',
    });
    expect(notes('A.', 'Cleared', { base: 'A.' })).toEqual({ kind: 'owner' });
    expect(notes('Rewritten.', 'A.', { base: 'A.' })).toEqual({
      kind: 'copy',
      write: 'Rewritten.',
    });
  });

  it('a rewrite, or both writing it from empty, is raised', () => {
    expect(notes('Copy rewrote.', 'A. Record.', { root: 'A.' })).toEqual({
      kind: 'raise',
      write: 'Copy rewrote.',
    });
    expect(notes('Copy.', 'Record.', { root: '' })).toEqual({ kind: 'raise', write: 'Copy.' });
  });
});

describe('appended items', () => {
  const captures = (copy: unknown[], owner: unknown[], root: unknown[]) =>
    classifyField(
      field({
        table: 'sessions',
        field: 'captures',
        copy: JSON.stringify(copy),
        owner: JSON.stringify(owner),
        root: JSON.stringify(root),
      })
    );

  it('keep each side’s items after a common start, the record’s first, and never twice', () => {
    expect(captures([{ a: 1 }, { c: 3 }], [{ a: 1 }, { b: 2 }], [{ a: 1 }])).toEqual({
      kind: 'copy',
      write: JSON.stringify([{ a: 1 }, { b: 2 }, { c: 3 }]),
    });
    expect(captures([{ a: 1 }, { c: 3 }], [{ a: 1 }, { b: 2 }, { c: 3 }], [{ a: 1 }])).toEqual({
      kind: 'owner',
    });
  });
});

describe('the stable id an import derives', () => {
  it('is the same for one row on one copy and import, and differs by copy, attempt and row', () => {
    const id = (identity: string, replica: string, attempt: number) =>
      importedStable(
        'p-shared',
        'missions',
        identity,
        replica,
        attempt,
        Date.parse('2026-05-01T00:00:00Z')
      );
    expect(id('key:c-m09', 'r1', 0)).toBe(id('key:c-m09', 'r1', 0));
    expect(id('key:c-m09', 'r1', 0)).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(
      new Set([
        id('key:c-m09', 'r1', 0),
        id('key:c-m09', 'r2', 0),
        id('key:c-m09', 'r1', 1),
        id('key:c-m10', 'r1', 0),
      ]).size
    ).toBe(4);
    // Its time is the row's, as a ULID's is.
    expect(id('key:c-m09', 'r1', 0).slice(0, 10)).toBe(
      encodeTime(Date.parse('2026-05-01T00:00:00Z'), 10)
    );
  });
});

describe('an earlier import, a refused one, and one that waits', () => {
  const derive = (attempt: number) => `id-${attempt}`;
  const row = { id: 'x' };

  it('is the attempt the table holds, found past attempts whose create was refused', () => {
    expect(
      walkImports(
        derive,
        new Map([['id-2', row]]),
        new Map([
          ['id-0', 'refused'],
          ['id-1', 'refused'],
          ['id-2', 'live'],
        ])
      )
    ).toEqual({ found: row });
  });

  it('waits on an attempt whose create waits for a verdict, is held or quarantined, rather than bringing the row again', () => {
    for (const state of ['pending', 'held', 'quarantined'] as const)
      expect(
        walkImports(
          derive,
          new Map(),
          new Map([
            ['id-0', 'refused'],
            ['id-1', state],
          ])
        )
      ).toEqual({ waiting: true });
  });

  it('reads an entity whose changes arrived before its create as held, so a row naming it waits', () => {
    const states = entityStates(
      [
        { id: 'made', kind: 'create', txn: 't1' },
        { id: 'made', kind: 'set', txn: 't2' },
        { id: 'early', kind: 'set', txn: 't3' },
      ],
      () => 'refused'
    );
    expect(Object.fromEntries(states)).toEqual({ made: 'refused', early: 'held' });
  });

  it('leaves a new import the first attempt the log never named, so no entity is created twice', () => {
    expect(walkImports(derive, new Map(), new Map())).toEqual({ next: 0 });
    expect(
      walkImports(
        derive,
        new Map(),
        new Map([
          ['id-0', 'refused'],
          ['id-1', 'refused'],
        ])
      )
    ).toEqual({ next: 2 });
  });
});

describe("a copy's values in the record's ids", () => {
  const ids = new Map([
    [
      'missions',
      new Map<string, string | null>([
        ['i-m02', 'i-m02~i1'],
        ['i-m03', null],
      ]),
    ],
    [
      'strategic_decisions',
      new Map<string, string | null>([
        ['2', '1000001'],
        ['3', '3'],
      ]),
    ],
  ]) as Parameters<typeof translated>[2];
  const holds = (table: string, id: string) => table === 'missions' && id === 'gone-on-copy';

  it('a reference takes the id its row has here, one to a row left out or held nowhere is emptied and named', () => {
    const decision = (missionId: string) =>
      translated(
        'strategic_decisions',
        { id: 4, mission_id: missionId, superseded_by: 2 },
        ids,
        holds
      );
    expect(decision('i-m02')).toEqual({
      values: { id: 4, mission_id: 'i-m02~i1', superseded_by: 1000001 },
      unheld: [],
      cites: [],
    });
    expect(decision('i-m03').unheld).toEqual([{ column: 'mission_id', names: 'missions:i-m03' }]);
    expect(decision('i-m03').values.mission_id).toBeNull();
    // A row the copy deleted and the record holds stays named.
    expect(decision('gone-on-copy').values.mission_id).toBe('gone-on-copy');
    expect(decision('never-held').unheld).toEqual([
      { column: 'mission_id', names: 'missions:never-held' },
    ]);
  });

  it('names the first row a row names that waits, by a reference or a single-id citation, and leaves a text citing one as the copy wrote it', () => {
    const waits = (table: string, id: string) =>
      (table === 'missions' && id === 'c-m09') || (table === 'strategic_decisions' && id === '2');
    expect(namesWaiting('strategic_decisions', { mission_id: 'c-m09' }, waits)).toBe(
      'missions:c-m09'
    );
    expect(namesWaiting('strategic_decisions', { decision_text: 'Follows d:2.' }, waits)).toBe(
      'strategic_decisions:2'
    );
    // A range keeps its numbers, so it names no row one at a time.
    expect(namesWaiting('strategic_decisions', { decision_text: 'See d:1-3.' }, waits)).toBeNull();
    expect(namesWaiting('strategic_decisions', { mission_id: 'i-m01' }, waits)).toBeNull();
    const citing = translated(
      'strategic_decisions',
      { id: 4, decision_text: 'Follows d:2.' },
      ids,
      holds,
      waits
    );
    expect(citing.values.decision_text).toBe('Follows d:2.');
    expect(citing.unheld).toEqual([
      { column: 'decision_text', names: 'strategic_decisions:2', waits: true },
    ]);
  });

  it("reads a numbered row's text in the record's ids for matching, where an import wrote its citations", () => {
    expect(textInRecord('strategic_decisions', { decision_text: 'Follows d:2.' }, ids)).toBe(
      'Follows d:1000001.'
    );
    // A next step's text keeps its citations as written: the import never rewrites them.
    expect(textInRecord('next_steps', { content: 'After d:2.' }, ids)).toBe('After d:2.');
    expect(textInRecord('missions', { name: 'No text field' }, ids)).toBeNull();
  });

  it("rewrites every citation form the link extractor reads, in a decision's every text field and a learning's content", () => {
    const moved = new Map([
      ['strategic_decisions', new Map<string, string | null>([['2', '1000001']])],
      ['learnings', new Map<string, string | null>([['3', '1000002']])],
      ['constraints', new Map<string, string | null>([['4', '1000003']])],
      ['next_steps', new Map<string, string | null>([['5', '1000004']])],
    ]) as Parameters<typeof translated>[2];
    const decision = translated(
      'strategic_decisions',
      {
        id: 9,
        decision_text: 'Per d:2.',
        context_text: 'See l:3.',
        alternatives: 'See c:4.',
        consequences: 'Per n:5, then.',
      },
      moved,
      () => false
    ).values;
    expect(decision).toMatchObject({
      decision_text: 'Per d:1000001.',
      context_text: 'See l:1000002.',
      alternatives: 'See c:1000003.',
      consequences: 'Per n:1000004, then.',
    });
    expect(
      translated('learnings', { id: 8, content: 'Learned from decision #2.' }, moved, () => false)
        .values.content
    ).toBe('Learned from decision #1000001.');
  });

  it('a single-id citation of a row whose number moved takes the new number; a range and an untyped #N keep theirs', () => {
    const text = (decision_text: string) =>
      translated('strategic_decisions', { id: 4, decision_text }, ids, holds).values.decision_text;
    expect(text('Builds on decision #2 and d:2.')).toBe(
      'Builds on decision #1000001 and d:1000001.'
    );
    expect(text('See d:3. Step #2 stays.')).toBe('See d:3. Step #2 stays.');
    expect(text('Decisions #2-#3 hold.')).toBe('Decisions #2-#3 hold.');
  });
});
