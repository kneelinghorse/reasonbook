// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A packed @aquex/reasonbook/referee consumer checks all declarations with modern module resolution.
// ABOUTME: Consumers install only Reasonbook; its public types must bring their own declaration dependencies.

/**
 * Compile the actual tarball with skipLibCheck: false under Node16 and bundler. The consumer
 * declares only Reasonbook, never @types/better-sqlite3; any required types must arrive through
 * the package's production dependencies. Negative checks reject accidental any exports.
 */

import { afterAll, beforeAll, expect, it } from '@jest/globals';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PROTOCOL_VERSION } from '../../src/tools/rbook/record-protocol';
import { installPackedArtifact } from './packed-artifact';

const REPO_ROOT = path.resolve(__dirname, '../..');
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const CONSUMER = `import {
  applyJoinAnswer,
  conflicts,
  createReferee,
  exportSnapshot,
  invite,
  makeFirstCopy,
  members,
  migrate,
  MIN_REQUEST_LIMIT_BYTES,
  PEER_METHODS,
  peer,
  peers,
  recentChanges,
  REFEREE_ERROR_CODES,
  REFEREE_PROTOCOL,
  REFEREE_VERSION,
  refereeStatus,
  remove,
  waiting,
  type Caller,
  type HostedMember,
  type JoinAnswer,
  type JoinRequest,
  type RefereeLocation,
  type RefereeOutcome,
  type StreamHead,
} from '@aquex/reasonbook/referee';

export async function relay(
  location: RefereeLocation,
  body: { method: string; params: unknown; replicaId: string },
  accountId: string
): Promise<{ status: number; body: unknown; head: StreamHead | null }> {
  const caller: Caller = { accountId, replicaId: body.replicaId };
  const outcome: RefereeOutcome<unknown> = await peer(location, body.method, body.params, caller);
  return { status: refereeStatus(outcome.result), body: outcome.result, head: outcome.head };
}

export async function handIn(storePath: string, configDir: string, copyFile: string, ownerAccountId: string) {
  const created = await createReferee({ storePath, configDir }, { copyFile, ownerAccountId });
  const request: JoinRequest | undefined = created.result.data?.joinRequest;
  return { request, head: created.head };
}

export async function admin(location: RefereeLocation, answer: JoinAnswer): Promise<HostedMember[]> {
  await applyJoinAnswer(location, answer);
  await invite(location, { accountId: 'a', name: 'n', role: 'editor' });
  await remove(location, { accountId: 'a' });
  await makeFirstCopy(location, '/tmp/first.sqlite');
  await exportSnapshot(location, '/tmp/export.sqlite');
  await migrate(location);
  await recentChanges(location, { sinceChangeId: null, limit: 10 });
  await conflicts(location);
  await peers(location);
  await waiting(location);
  return (await members(location)).result.data ?? [];
}

export const facts = {
  version: REFEREE_VERSION as string,
  wire: REFEREE_PROTOCOL.wire as number,
  limit: MIN_REQUEST_LIMIT_BYTES as number,
  recovery: REFEREE_ERROR_CODES.NEEDS_RECOVERY as 'REFEREE_NEEDS_RECOVERY',
  methods: PEER_METHODS as readonly string[],
};

// @ts-expect-error a head's sequence is a number, which a resolved type knows
export const wrongHead: StreamHead = { replicaId: 'r', seq: 'one', hash: null };
// @ts-expect-error a caller names its replica
export const wrongCaller: Caller = { accountId: 'a' };
`;

let artifact: ReturnType<typeof installPackedArtifact>;
beforeAll(() => {
  artifact = installPackedArtifact(REPO_ROOT, mkTmp);
}, 600000);

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    lib: ['ES2022'],
    strict: true,
    esModuleInterop: true,
    skipLibCheck: false,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
    noEmit: true,
    types: [],
  },
  include: ['src/**/*'],
};

it.each(['node16', 'bundler'] as const)(
  '%s checks declarations and runtime',
  (resolution) => {
    const consumerPackage = JSON.parse(
      fs.readFileSync(path.join(artifact.hostDir, 'package.json'), 'utf8')
    );
    expect(Object.keys(consumerPackage.dependencies)).toEqual(['@aquex/reasonbook']);
    expect(consumerPackage.devDependencies).toBeUndefined();
    const hash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(artifact.tarball))
      .digest('hex');
    process.stdout.write(`[s97-m09] packed ${path.basename(artifact.tarball)} sha256 ${hash}\n`);
    fs.mkdirSync(path.join(artifact.hostDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(artifact.hostDir, 'src', 'use-referee.ts'), CONSUMER);
    fs.writeFileSync(
      path.join(artifact.hostDir, 'tsconfig.json'),
      JSON.stringify(
        {
          ...TSCONFIG,
          compilerOptions: {
            ...TSCONFIG.compilerOptions,
            module: resolution === 'node16' ? 'Node16' : 'ESNext',
            moduleResolution: resolution,
          },
        },
        null,
        2
      )
    );
    const tsc = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', artifact.hostDir],
      { encoding: 'utf8' }
    );
    expect({ status: tsc.status, out: `${tsc.stdout}${tsc.stderr}` }).toEqual({
      status: 0,
      out: '',
    });

    // At runtime Node resolves the subpath through exports; loading it starts no server.
    const probe = spawnSync(
      process.execPath,
      [
        '-e',
        `const r = require('@aquex/reasonbook/referee');
       r.members({ storePath: ${JSON.stringify(path.join(artifact.hostDir, 'none', 'rbook.sqlite'))}, configDir: ${JSON.stringify(path.join(artifact.hostDir, 'config'))}, expectedHead: null })
         .then((outcome) => process.stdout.write(JSON.stringify({ version: r.REFEREE_VERSION, protocol: r.REFEREE_PROTOCOL, code: outcome.result.error.code, head: outcome.head })));`,
      ],
      { cwd: artifact.hostDir, encoding: 'utf8', timeout: 60000 }
    );
    expect(probe.status).toBe(0);
    const version = (
      JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    expect(JSON.parse(probe.stdout)).toEqual({
      version,
      // Compare the installed artifact's advertised maximum with the source being packed.
      protocol: { wire: 1, record: PROTOCOL_VERSION },
      code: 'REFEREE_NEEDS_RECOVERY',
      head: null,
    });
  },
  600000
);
