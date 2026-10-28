// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The edition marker overrides inherited configuration on cold and ready launches.
// ABOUTME: Unknown modes fail before starting an installer or server, even when the server is disabled.

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { copiedPlugin, fixture, node, packageCode, version } from './fixtures';

describe('plugin edition transport', () => {
  let root: string;
  beforeEach(() => {
    root = fixture();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function run(marker: string | null, inherited: string | undefined, ready: boolean) {
    const plugin = copiedPlugin(root);
    if (marker !== null) fs.writeFileSync(path.join(plugin, 'EDITION'), marker);
    const url = (name: string) =>
      JSON.stringify(pathToFileURL(path.join(plugin, 'hooks', name)).href);
    const env = { RBOOK_CONFIG_DIR: path.join(root, 'config'), RBOOK_EDITION: inherited, PATH: '' };
    const result = node(`import fs from 'node:fs';import path from 'node:path';
      import {run} from ${url('run.mjs')};
      import {createContext} from ${url('install-state.mjs')};
      import {runInstall} from ${url('install-worker.mjs')};
      const env=${JSON.stringify(env)};
      ${ready ? `const ctx=createContext({version:${JSON.stringify(version)},dataRoot:path.join(env.RBOOK_CONFIG_DIR,'plugins'),configDir:env.RBOOK_CONFIG_DIR,shared:true});await runInstall(ctx,{installPackage:async candidate=>{${packageCode('candidate')}}});` : ''}
      let launched=0,installing=0,mode=null;const errors=[];
      const code=await run(['serve','--install-root','shared'],{
        env,launch:async (_bin,_args,options)=>{launched++;mode=options.env.RBOOK_EDITION ?? null;return 0},
        serveInstalling:async (_ctx,options)=>{installing++;mode=options.env.RBOOK_EDITION ?? null;return 0},
        startInstaller:()=>{throw new Error('unexpected installer')},writeError:text=>errors.push(text)
      });console.log(JSON.stringify({code,launched,installing,mode,errors}));`);
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  }

  it.each([false, true])('marker wins over inherited full mode, ready=%s', (ready) => {
    expect(run('directory\n', 'full', ready)).toMatchObject({
      code: 0,
      mode: 'directory',
      launched: Number(ready),
      installing: Number(!ready),
    });
  });
  it('valid marker wins even over an invalid inherited mode', () => {
    expect(run('directory\n', 'typo', false)).toMatchObject({ code: 0, mode: 'directory' });
  });
  it.each([
    ['typo', 'full'],
    [null, 'typo'],
    ['', 'full'],
  ])('refuses unknown marker/env %s/%s before launch', (marker, inherited) => {
    const result = run(marker, inherited ?? undefined, false);
    expect(result).toMatchObject({ code: 1, launched: 0, installing: 0 });
    expect(result.errors.join('')).toMatch(/edition/i);
  });
  it('keeps an unmarked full plugin in full mode', () => {
    expect(run(null, undefined, true)).toMatchObject({ code: 0, mode: null, launched: 1 });
  });

  it('the bootstrap accessor keeps the new edition setting free of an invented legacy alias', () => {
    const plugin = copiedPlugin(root);
    const url = pathToFileURL(path.join(plugin, 'hooks', 'legacy-compat.mjs')).href;
    const result = node(`import {getSetting} from ${JSON.stringify(url)};
      console.log(JSON.stringify([
        getSetting('RBOOK_EDITION',{CMOS_EDITION:'directory'}) ?? null,
        getSetting('RBOOK_EDITION',{RBOOK_EDITION:'',CMOS_EDITION:'directory'}),
        getSetting('RBOOK_EDITION',{RBOOK_EDITION:'full',CMOS_EDITION:'directory'})
      ]));`);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, '', 'full']);
  });
});
