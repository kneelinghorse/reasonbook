// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Reaching the reference server from a test (s97-m09): start it in its own process, and a test-only peer that
// ABOUTME: sends each exchange call to its peer route; the client's own HTTPS peer is s97-m10's.
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { createInterface } from 'readline';
import type { Hello, Peer } from '../../src/tools/rbook/record-exchange';
import { ReplicaRefusal } from '../../src/tools/rbook/replica-identity';
import type { RbookToolResult } from '../../src/tools/rbook/types';
import type { RefereeServerConfig } from './referee-server';

export interface RunningServer {
  readonly url: string;
  readonly child: ChildProcess;
  readonly engine: {
    readonly path: string;
    readonly version: string;
    readonly protocol: { readonly wire: number; readonly record: number };
  };
  stop(): Promise<void>;
}

/**
 * s98-m08: keeps what the network said each time a test's fetch failed, with how long the call had
 * run. Under jest the dashboard client reads every fetch failure as "Unknown network error", because
 * the error comes from another realm and fails its instanceof check, so a test prints these beside
 * the refusal. Install in beforeAll, empty in beforeEach, and restore in afterAll.
 */
export function recordNetworkFailures(): { readonly failures: string[]; restore(): void } {
  const failures: string[] = [];
  const realFetch = global.fetch;
  global.fetch = (async (...args: Parameters<typeof fetch>) => {
    const started = Date.now();
    try {
      return await realFetch(...args);
    } catch (error) {
      const failed = error as {
        name?: string;
        message?: string;
        cause?: { code?: string; message?: string };
      };
      const cause = failed.cause
        ? ` (${failed.cause.code ?? ''} ${failed.cause.message ?? ''})`
        : '';
      failures.push(`${failed.name}: ${failed.message}${cause} after ${Date.now() - started} ms`);
      throw error;
    }
  }) as typeof fetch;
  return {
    failures,
    restore: () => {
      global.fetch = realFetch;
    },
  };
}

/** Start the reference server in its own process, as a client meets the dashboard: by URL only. */
export async function spawnRefereeServer(
  dir: string,
  config: RefereeServerConfig
): Promise<RunningServer> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'referee-server.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const child = spawn(process.execPath, [path.join(__dirname, 'referee-server-main.js'), file], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RBOOK_CONFIG_DIR: path.join(dir, 'server-home-config') },
  });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const first = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', resolve);
    child.once('exit', (code) =>
      reject(new Error(`the reference server exited (${code}): ${stderr}`))
    );
  });
  const { port, engine } = JSON.parse(first) as {
    port: number;
    engine: { path: string; version: string; protocol: { wire: number; record: number } };
  };
  return {
    url: `http://127.0.0.1:${port}`,
    child,
    engine,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export async function request<T = unknown>(
  server: Pick<RunningServer, 'url'>,
  route: string,
  options: {
    token?: string;
    method?: string;
    json?: unknown;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: RbookToolResult<T> }> {
  const response = await fetch(`${server.url}${route}`, {
    method: options.method ?? (options.json !== undefined || options.body ? 'POST' : 'GET'),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ?? (options.json !== undefined ? JSON.stringify(options.json) : undefined),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as RbookToolResult<T> };
}

/** A test-only peer over the reference server's peer route; each call names the copy's replica as it is now. */
export function httpPeer(
  server: Pick<RunningServer, 'url'>,
  projectId: string,
  token: string,
  replicaIdNow: () => Promise<string>,
  helloNow: () => Promise<Hello>
): Peer {
  const run = async (method: string, params?: unknown): Promise<RbookToolResult<unknown>> => {
    const replicaId = await replicaIdNow();
    return (
      await request(server, `/api/relay/projects/${projectId}/peer`, {
        token,
        json: { method, params, replicaId },
      })
    ).body;
  };
  const value = async (method: string, params?: unknown) => {
    const answer = await run(method, params);
    if (!answer.success) throw new ReplicaRefusal(answer.error!);
    return answer.data as never;
  };
  return {
    name: 'the reference server',
    hello: async () => {
      const own = await helloNow();
      return value('hello', {
        recordProtocol: own.recordProtocol,
        libraryVersion: own.libraryVersion,
        reads: own.reads,
      });
    },
    chains: (at) => value('chains', at),
    changesSince: (marks) => value('changesSince', marks),
    apply: (changes, options = {}) => run('apply', { changes, ...options }) as never,
    admitSuccessor: (input) => run('admitSuccessor', input) as never,
    reblockSelf: () => run('reblockSelf') as never,
    takeSuccessor: (input) => run('takeSuccessor', input) as never,
    failed: async (input) => {
      await run('failed', input);
    },
  };
}
