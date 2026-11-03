// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s109-m01 (#917) — lsof's warning that it could not reach another file system no longer refuses a
// ABOUTME: move; one about the record's own device, any other stderr, or a slow first check still refuses.
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import childProcess from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { migrateProject } from '../../src/cli/migrate';
import { assertNoOpenFiles } from '../../src/cli/migrate-guard';
import { readLsofStderr } from '../../src/cli/migrate-open-files';
import { LEGACY } from '../../src/intelligence/legacy-compat';
import { seedLegacyMigrationStore } from '../helpers/legacyMigrationStore';

let tmp: string;
let root: string;
let home: string;
let record: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-migrate-open-files-'));
  root = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  seedLegacyMigrationStore(root);
  record = path.join(root, LEGACY.recordDirectory);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const options = () => ({
  projectRoot: root,
  env: { HOME: home },
  apply: true,
  checkProcesses: false,
});

/** lsof's device for a folder, as its "assuming dev=" line prints one: 32 bits, in hex. */
const deviceOf = (folder: string) =>
  BigInt.asUintN(32, fs.statSync(folder, { bigint: true }).dev).toString(16);

/** The warning lsof printed on 2026-11-01 for an unreachable SMB mount, for this mount and device. */
const warning = (mount: string, device?: string) =>
  [
    `lsof: WARNING: can't stat() smbfs file system ${mount}`,
    '      Output information may be incomplete.',
    ...(device ? [`      assuming "dev=${device}" from mount table`] : []),
  ].join('\n');

/**
 * The real lsof runs, so a holder is still found; its stderr is this one. With slowFirst, the first
 * call takes 3.5 s by the clock the check reads.
 */
function lsofSays(stderr: string, slowFirst = false): { calls: () => number } {
  const spawnSync = childProcess.spawnSync;
  let calls = 0;
  let skew = 0;
  const now = Date.now.bind(Date);
  jest.spyOn(Date, 'now').mockImplementation(() => now() + skew);
  jest.spyOn(childProcess, 'spawnSync').mockImplementation(((
    command: string,
    args: string[],
    opts: any
  ) => {
    const result = spawnSync(command, args, opts);
    if (command !== 'lsof') return result;
    calls += 1;
    if (slowFirst && calls === 1) skew += 3_500;
    return { ...result, stderr: `${stderr}\n` };
  }) as any);
  return { calls: () => calls };
}

const another = () => (BigInt(`0x${deviceOf(record)}`) ^ 0x10n).toString(16);

describe("lsof's stderr: only warnings about another device pass", () => {
  it("moves the record past a warning about another device, as on this Mac's SMB mount", async () => {
    lsofSays(warning('/Volumes/mac-studio', another()));
    const result = await migrateProject(options());
    expect({ success: result.success, error: result.error }).toEqual({
      success: true,
      error: undefined,
    });
    expect(fs.existsSync(path.join(root, 'rbook/db/rbook.sqlite'))).toBe(true);
  });

  it('passes a warning about a mount whose path holds spaces, on another device', () => {
    lsofSays(warning('/Volumes/Shared Drive (2)', another()));
    expect(() => assertNoOpenFiles(record)).not.toThrow();
  });

  it("refuses a warning about the record's own device, and two warnings when one is about it", () => {
    lsofSays(warning('/System/Volumes/Data', deviceOf(record)));
    expect(() => assertNoOpenFiles(record)).toThrow(
      `Cannot establish that no other process has files in ${record} open`
    );
    jest.restoreAllMocks();
    lsofSays(
      `${warning('/Volumes/mac-studio', another())}\n${warning('/Volumes/data', deviceOf(path.join(record, 'db')))}`
    );
    expect(() => assertNoOpenFiles(record)).toThrow('Cannot establish');
  });

  it('pairs a device line only with its own warning: one without it refuses on macOS', () => {
    // The device line that follows the second warning is not the first one's.
    lsofSays(`${warning('/Volumes/first')}\n${warning('/Volumes/second', another())}`);
    if (process.platform === 'darwin')
      expect(() => assertNoOpenFiles(record)).toThrow('Cannot establish');
    else expect(() => assertNoOpenFiles(record)).not.toThrow();
  });

  it("refuses an unknown line and quotes lsof's first line, on one line", () => {
    lsofSays('lsof: status error on /x: Permission denied\n  more detail');
    expect(() => assertNoOpenFiles(record)).toThrow(
      'lsof said "lsof: status error on /x: Permission denied"'
    );
    jest.restoreAllMocks();
    // A known warning followed by a line no warning holds refuses too.
    lsofSays(`${warning('/Volumes/mac-studio', another())}\nlsof: can't read kernel name list`);
    expect(() => assertNoOpenFiles(record)).toThrow('Cannot establish');
  });

  it('refuses a slow first check with an accepted warning before the lock, naming the mount', async () => {
    // A stall seen at the first check would run again at the final one, under the record's
    // exclusive lock, where clients wait 5 s and hooks 250 ms.
    const lsof = lsofSays(warning('/Volumes/mac-studio', another()), true);
    const result = await migrateProject(options());
    expect(result).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('/Volumes/mac-studio') },
    });
    expect(result.error?.message).toContain('took');
    // Refused at the first check: no backup was taken under the lock, and nothing moved.
    expect(lsof.calls()).toBe(1);
    expect(fs.existsSync(path.join(record, 'db', 'snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.startsWith('.rbook-migration'))).toEqual([]);
  });

  it('the dry run lists a warning about the record’s own device, and changes nothing', async () => {
    lsofSays(warning('/System/Volumes/Data', deviceOf(record)));
    // This machine's own process list is left out, so only the open-file check decides.
    const result = await migrateProject({
      projectRoot: root,
      env: { HOME: home },
      checkProcesses: false,
    });
    expect(result.data?.blocked).toEqual([expect.stringContaining('Cannot establish')]);
    expect(fs.existsSync(path.join(root, 'rbook'))).toBe(false);
  });
});

describe("the device rules, read from lsof's stderr directly (build critic A, note 1)", () => {
  const head = (mount: string) => `lsof: WARNING: can't stat() smbfs file system ${mount}`;
  const dev = (hex: string) => `      assuming "dev=${hex}" from mount table`;

  it("compares devices as lsof prints them, 32 bits unsigned, though darwin's stat gives a signed one", () => {
    // darwin's dev_t is signed: a stat of -2147483646 is lsof's 80000002.
    expect(
      readLsofStderr(`${head('/Volumes/x')}\n${dev('80000002')}`, [-2147483646n], '/r')
    ).toEqual({
      ok: false,
      line: head('/Volumes/x'),
    });
    expect(
      readLsofStderr(`${head('/Volumes/x')}\n${dev('80000003')}`, [-2147483646n], '/r').ok
    ).toBe(true);
  });

  it("refuses a warning about the store folder's device, as about the record folder's", () => {
    expect(readLsofStderr(`${head('/Volumes/db')}\n${dev('2a')}`, [0x10n, 0x2an], '/r').ok).toBe(
      false
    );
  });

  it('refuses a warning with two device lines, and quotes the line it refused', () => {
    expect(
      readLsofStderr(`${head('/Volumes/x')}\n${dev('2a')}\n${dev('2b')}`, [0x10n], '/r')
    ).toEqual({
      ok: false,
      line: dev('2b').trim(),
    });
    // Another device's warning first, then the record's own: the record's is the one quoted.
    expect(
      readLsofStderr(
        `${head('/Volumes/other')}\n${dev('2a')}\n${head('/System/Volumes/Data')}\n${dev('10')}`,
        [0x10n],
        '/r'
      )
    ).toEqual({ ok: false, line: head('/System/Volumes/Data') });
  });

  it('quotes the unknown line after an accepted warning, not the warning', () => {
    expect(
      readLsofStderr(
        `${head('/Volumes/x')}\n${dev('2a')}\nlsof: can't read kernel name list`,
        [0x10n],
        '/r'
      )
    ).toEqual({ ok: false, line: "lsof: can't read kernel name list" });
  });

  it('passes a slow first check that printed no warning: only a stall beside a warning refuses', () => {
    lsofSays('', true);
    expect(() => assertNoOpenFiles(record, undefined, { refuseSlowWarnings: true })).not.toThrow();
  });
});
