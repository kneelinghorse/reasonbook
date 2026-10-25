// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hookless readonly runtime checks avoid opening the project store when no runtime directory exists.
// ABOUTME: Absence is never cached, and existing runtimes retain identity, safety and error-order checks.

import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as harness from '../../../src/tools/rbook/harness-session';
import * as telemetry from '../../../src/tools/rbook/local-telemetry';
import {
  draftRuntimeDir,
  openDraftRuntime,
  pendingDeclines,
  retainDeclines,
  type DraftRuntime,
} from '../../../src/tools/rbook/draft-runtime';
import { reidentifyRbookTestStore, seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
let dbPath: string;
let env: NodeJS.ProcessEnv;
const opened: DraftRuntime[] = [];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-runtime-readonly-'));
  const root = path.join(tmp, 'project');
  dbPath = seedRbookDb(root, { projectName: 'readonly-runtime' });
  reidentifyRbookTestStore(root);
  env = { RBOOK_CONFIG_DIR: path.join(tmp, 'config') };
});

afterEach(() => {
  jest.restoreAllMocks();
  while (opened.length) opened.pop()!.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function open(readonly = false): DraftRuntime {
  const runtime = openDraftRuntime(dbPath, env, { readonly });
  if (!runtime) throw new Error('runtime unavailable');
  opened.push(runtime);
  return runtime;
}

it('does not open the store or walk file safety paths when a readonly runtime directory is absent', () => {
  const target = jest.spyOn(telemetry, 'targetForStore');
  const safety = jest.spyOn(telemetry, 'safeDestination');
  expect(openDraftRuntime(dbPath, env, { readonly: true })).toBeNull();
  expect(target).not.toHaveBeenCalled();
  expect(safety).not.toHaveBeenCalled();
  expect(fs.existsSync(draftRuntimeDir(env))).toBe(false);
});

it('sees a later-created runtime and its store-local declines after an earlier readonly miss', () => {
  expect(openDraftRuntime(dbPath, env, { readonly: true })).toBeNull();
  const writer = open();
  const at = Date.now();
  retainDeclines(writer, [7], at);
  expect(pendingDeclines(open(true))).toEqual([{ id: 7, at }]);
});

it('writable opens still create the absent runtime and read the store identity', () => {
  const target = jest.spyOn(telemetry, 'targetForStore');
  const runtime = open();
  expect(target).toHaveBeenCalledWith(dbPath);
  expect(fs.existsSync(runtime.path)).toBe(true);
});

it('resolves configuration once on a successful readonly open', () => {
  open();
  const directory = jest.spyOn(harness, 'runtimeDir');
  open(true);
  expect(directory).toHaveBeenCalledTimes(1);
});

it.each(['EACCES', 'ENOTDIR', 'EIO'])(
  '%s in the new directory probe falls through to the original identity and safety checks',
  (code) => {
    open();
    const dir = draftRuntimeDir(env);
    const stat = fs.statSync;
    const probeError = Object.assign(new Error('directory probe failed'), { code });
    jest.spyOn(fs, 'statSync').mockImplementation(((file, options) => {
      if (file === dir) throw probeError;
      return stat(file, options);
    }) as typeof fs.statSync);
    const target = jest.spyOn(telemetry, 'targetForStore');
    const safety = jest.spyOn(telemetry, 'safeDestination');
    expect(open(true)).toBeDefined();
    expect(target).toHaveBeenCalledWith(dbPath);
    expect(safety).toHaveBeenCalled();
  }
);

it('retains the original safety error instead of throwing a new non-ENOENT probe error', () => {
  open();
  const dir = draftRuntimeDir(env);
  const stat = fs.statSync;
  jest.spyOn(fs, 'statSync').mockImplementation(((file, options) => {
    if (file === dir) throw Object.assign(new Error('new probe error'), { code: 'EACCES' });
    return stat(file, options);
  }) as typeof fs.statSync);
  const originalError = new Error('original safety error');
  jest.spyOn(telemetry, 'safeDestination').mockImplementation(() => {
    throw originalError;
  });
  expect(() => openDraftRuntime(dbPath, env, { readonly: true })).toThrow(originalError);
});

it.each([undefined, 'ENOENT'])(
  'preserves invalid-store null before a config error (%s), and the error for a valid store',
  (code) => {
    const configError = Object.assign(new Error('configuration unavailable'), { code });
    jest.spyOn(harness, 'runtimeDir').mockImplementation(() => {
      throw configError;
    });
    expect(openDraftRuntime(path.join(tmp, 'missing.sqlite'), env, { readonly: true })).toBeNull();
    expect(() => openDraftRuntime(dbPath, env, { readonly: true })).toThrow(configError);
  }
);

it('keeps the existing-directory safety checks when configuration links into a project', () => {
  const unsafe = path.join(tmp, 'project', 'runtime', 'drafts');
  fs.mkdirSync(unsafe, { recursive: true });
  fs.symlinkSync(path.join(tmp, 'project'), env.RBOOK_CONFIG_DIR!);
  const safety = jest.spyOn(telemetry, 'safeDestination');
  expect(openDraftRuntime(dbPath, env, { readonly: true })).toBeNull();
  expect(safety).toHaveBeenCalled();
});

it('still refuses a linked runtime file in an existing safe directory', () => {
  const writer = open();
  const file = writer.path;
  writer.close();
  opened.pop();
  fs.renameSync(file, `${file}.elsewhere`);
  fs.symlinkSync(`${file}.elsewhere`, file);
  expect(openDraftRuntime(dbPath, env, { readonly: true })).toBeNull();
});
