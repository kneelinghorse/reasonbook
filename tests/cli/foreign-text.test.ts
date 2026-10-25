// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Foreign record values cannot create terminal controls or extra lines in CLI answers.
// ABOUTME: Structured reports stay raw; generated layout and existing provenance fences survive.

import { afterEach, expect, it, jest } from '@jest/globals';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as core from '../../src/cli/core';
import { confirmedText, exchangeText } from '../../src/cli/sync-moves';
import { runSignals } from '../../src/cli/signals';
import { runSync } from '../../src/cli/sync';
import { runJoinDashboard } from '../../src/cli/dashboard';
import { importText, runImport } from '../../src/cli/import';
import { waitingLines } from '../../src/cli/import-waits';
import * as registered from '../../src/intelligence/registered-stores-readonly';
import * as portfolio from '../../src/tools/rbook/portfolio-signals';
import * as sync from '../../src/tools/rbook/record-sync';
import * as locks from '../../src/tools/rbook/record-sync-trigger';
import * as dashboard from '../../src/tools/rbook/record-dashboard-join';
import * as imports from '../../src/tools/rbook/record-import';
import type { ImportReport } from '../../src/tools/rbook/record-import';
import type { SignalsReport } from '../../src/signals';

const hostile = '\u001b[2K\b\u0085\u009bname\nFORGED LINE ' + 'x'.repeat(1000);
// eslint-disable-next-line no-control-regex -- C0/C1 witness permits only generated LF.
const controls = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const noForgedLine = (text: string) => {
  expect(text).not.toMatch(controls);
  expect(text).not.toMatch(/^FORGED LINE/m);
  expect(text).not.toContain('x'.repeat(301));
};
afterEach(() => {
  jest.restoreAllMocks();
});

function io() {
  let stdout = '';
  const stderr: string[] = [];
  return {
    env: process.env,
    cwd: path.join(os.tmpdir(), 'foreign-cli-project'),
    readStdin: async () => '',
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr.push(text);
    },
    out: () => stdout,
    err: () => stderr.join('\n'),
  };
}

it('the common one-line renderer strips C0/C1, flattens whitespace and caps each value', () => {
  const rendered = core.oneLine(hostile, 80);
  noForgedLine(rendered);
  expect(rendered).not.toContain('\n');
  expect(rendered.length).toBeLessThanOrEqual(80);
  expect(rendered).toContain('name FORGED LINE');
});

it('removes directional overrides and zero-width spaces without breaking joined text', () => {
  const controls = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b';
  const joined = '👩\u200d💻 می\u200cروم 🏴\u{e0067}\u{e0062}\u{e007f}';
  expect(core.oneLine(`left${controls}right ${joined}`)).toBe(`leftright ${joined}`);
});

it('confirmation and exchange text cannot be rewritten by peer identifiers or summaries', () => {
  noForgedLine(
    confirmedText({
      isAuthority: false,
      authority: hostile,
      epoch: 2,
      next: { authority: hostile },
    } as never)
  );
  noForgedLine(
    exchangeText({
      caughtUp: { copy: 'local', authority: hostile, confirmed: false },
      reidentified: { block: 2, summary: hostile },
      reblocked: [{ replicaId: hostile, block: 3 }],
      sent: 0,
      received: 0,
      conflicts: 0,
    } as never)
  );
});

it('signals text caps every foreign value while JSON preserves ids and names', async () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../fixtures/brief/three-reports.json'), 'utf8')
  );
  const report: SignalsReport = {
    ...fixture.reports[0],
    project: { id: hostile, name: hostile },
    signals: [{ kind: 'missions_blocked', available: true, count: 1, ids: [hostile] }],
  };
  jest.spyOn(registered, 'listRegisteredStoresReadOnly').mockReturnValue([]);
  jest.spyOn(portfolio, 'signalsAcrossProjects').mockResolvedValue({
    projects: [{ report }],
    errors: [{ projectId: hostile, storePath: hostile, error: hostile }],
  } as never);
  const text = io();
  expect(await runSignals([], text)).toBe(0);
  noForgedLine(text.out());
  expect(text.out()).toContain('⟪untrusted, from proj:');
  expect(text.out()).toContain('⟪/untrusted⟫');
  const json = io();
  expect(await runSignals(['--format', 'json'], json)).toBe(0);
  expect(JSON.parse(json.out()).reports[0].signals[0].ids).toEqual([hostile]);
  expect(JSON.parse(json.out()).reports[0].project.name).toBe(hostile);
});

it('sync names and errors keep one generated line per peer', async () => {
  jest.spyOn(core, 'resolveCliProject').mockReturnValue({
    kind: 'store',
    projectRoot: '/unused',
    dbPath: '/unused/rbook/db/rbook.sqlite',
    source: 'explicit',
  });
  jest.spyOn(locks, 'withSyncLock').mockImplementation(async (_file, task) => task());
  jest.spyOn(sync, 'syncPeers').mockResolvedValue({
    success: true,
    data: {
      peers: [
        { name: hostile, replicaId: 'one', error: hostile },
        { name: 'second', replicaId: 'two', error: 'unavailable' },
      ],
    },
  } as never);
  const text = io();
  expect(await runSync([], text)).toBe(0);
  noForgedLine(text.out());
  expect(text.out().trimEnd().split('\n')).toHaveLength(2);
});

it('dashboard join renders the member and dashboard as inert values', async () => {
  jest.spyOn(dashboard, 'joinThroughDashboard').mockResolvedValue({
    success: true,
    data: {
      dashboard: hostile,
      joined: { member: hostile, block: 2 },
      sync: {},
    },
    warnings: [hostile],
  } as never);
  const text = io();
  expect(await runJoinDashboard('rbook://owner/project', { into: text.cwd }, text)).toBe(0);
  noForgedLine(text.out());
  noForgedLine(text.err());
});

it('import row references and copy paths cannot forge lines in the dry-run report', () => {
  const table = {
    table: 'missions',
    absent: false,
    lacked: [],
    copyRows: 1,
    targetRows: 1,
    identical: 0,
    ownerChanged: 0,
    ownerOnly: 0,
    heldBefore: 0,
    copyChanged: [],
    conflicts: [],
    inConflict: [],
    alreadyRaised: [],
    flagKept: [],
    linkDiffers: [],
    own: [],
    deletedOnOwner: [],
    included: [],
    createdOnBoth: [],
    leftOut: [],
    broughtTwice: [],
    waiting: [hostile],
    waitingOnCreate: [hostile],
    inRecord: [],
    perhapsIn: [{ id: hostile, as: [hostile] }],
    heldBack: [{ id: hostile, names: hostile }],
  };
  noForgedLine(waitingLines([table] as never).join('\n'));
  const report = {
    from: hostile,
    store: hostile,
    base: hostile,
    marker: null,
    tables: [table],
    ownRows: 0,
    includedRows: 0,
    differing: 0,
    flagged: 0,
    alreadyIn: [],
    applied: null,
  } as unknown as ImportReport;
  noForgedLine(importText(report));
  expect(report.from).toBe(hostile);
  const hidden = 'a\u202eb\u200bc\u200dd\u200ce\u{e0067}';
  table.copyChanged.push({
    table: 'missions',
    id: 'm\u2066',
    field: 'notes',
    copy: hidden,
    owner: 'plain',
  } as never);
  const before = JSON.stringify(report);
  const diff = importText(report);
  expect(diff).toContain('m\\u2066');
  expect(diff).toContain('a\\u202eb\\u200bc\\u200dd\\u200ce\\udb40\\udc67');
  expect(diff).not.toContain(hidden);
  expect(JSON.stringify(report)).toBe(before);
});

it.each([undefined, `reasonbook import --from ${hostile} --include missions:${hostile} --apply`])(
  'an import replay instruction cannot expose unsafe arguments (%s)',
  (again) => {
    const report = {
      from: '/copy',
      store: `/copy/${hostile}`,
      base: null,
      marker: null,
      tables: [],
      ownRows: 1,
      includedRows: 0,
      differing: 0,
      flagged: 0,
      alreadyIn: [],
      applied: null,
    } as unknown as ImportReport;
    const before = JSON.stringify(report);
    const text = importText(report, again);
    noForgedLine(text);
    expect(text).toContain('original reasonbook import command with --apply');
    expect(text).toContain('arguments omitted');
    expect(JSON.stringify(report)).toBe(before);
  }
);

const replayReport = (store: string): ImportReport =>
  ({
    from: '/copy',
    store,
    base: null,
    marker: null,
    tables: [],
    ownRows: 1,
    includedRows: 0,
    differing: 0,
    flagged: 0,
    alreadyIn: [],
    applied: null,
  }) as unknown as ImportReport;

it('an emitted short import command preserves every shell argument and repeated include', async () => {
  const from = '/copy $HOME/owner';
  const target = "/owner's project";
  jest.spyOn(core, 'resolveCliProject').mockReturnValue({
    kind: 'store',
    projectRoot: target,
    dbPath: '/unused/rbook.sqlite',
    source: 'explicit',
  });
  jest
    .spyOn(sync, 'storeOpener')
    .mockReturnValue((async (step: (client: unknown) => unknown) => step({})) as sync.Opener);
  jest.spyOn(imports, 'importCopy').mockResolvedValue({ success: true, data: replayReport(from) });
  const text = io();
  expect(
    await runImport(
      [
        '--from',
        from,
        '--include',
        'missions:i-m03',
        '--include',
        'session_missions:s1|i-m03',
        '--project-root',
        target,
      ],
      text
    )
  ).toBe(0);
  const match = /bring them in with (reasonbook import .*)\.$/m.exec(text.out());
  expect(match).not.toBeNull();
  const command = match![1];
  expect(command.length).toBeLessThanOrEqual(300);
  expect(text.out()).not.toContain('arguments omitted');
  const words = execFileSync(
    'bash',
    ['-c', `printf '%s\\n' ${command.replace(/^reasonbook /, '')}`],
    {
      encoding: 'utf8',
    }
  )
    .trimEnd()
    .split('\n');
  expect(words).toEqual([
    'import',
    '--from',
    from,
    '--include',
    'missions:i-m03,session_missions:s1|i-m03',
    '--project-root',
    target,
    '--apply',
  ]);
});

it.each([
  ['fallback', 300],
  ['fallback', 301],
  ['supplied', 300],
  ['supplied', 301],
] as const)(
  'a %s replay command of %i safe characters respects the display boundary',
  (kind, length) => {
    const fixed = 'reasonbook import --from  --apply';
    const store = '/' + 'x'.repeat(length - fixed.length - 1);
    const command = `reasonbook import --from ${store} --apply`;
    expect(command.length).toBe(length);
    const report = replayReport(store);
    const before = JSON.stringify(report);
    const text = importText(report, kind === 'supplied' ? command : undefined);
    if (length === 300) {
      expect(text).toContain(`bring them in with ${command}.`);
      expect(text).not.toContain('arguments omitted');
    } else {
      expect(text).toContain('original reasonbook import command with --apply (arguments omitted');
      expect(text).not.toContain(command);
    }
    expect(JSON.stringify(report)).toBe(before);
  }
);
