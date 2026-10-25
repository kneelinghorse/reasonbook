// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Start the reference server in its own process and retain evidence for failed network calls.
// ABOUTME: Provide a test-only peer over its routes; the client's own HTTPS peer is s97-m10's.
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
  diagnostics(): {
    readonly pid: number | null;
    readonly url: string | null;
    /** Parent-observed spawn attempt; readiness and runtime metadata come from the child. */
    readonly startedAt: string;
    readonly readyAt: string | null;
    readonly exitedAt: string | null;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    readonly stopRequestedAt: string | null;
    readonly runtime: {
      readonly nodeVersion: string;
      readonly v8Version: string;
      readonly execArgv: readonly string[];
    } | null;
    readonly stderr: string;
    readonly stderrTruncated: boolean;
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
  const startedAt = new Date().toISOString();
  // Test-child containment after a Node 24 V8 concurrent baseline compiler crash under load;
  // this neither changes the product runtime nor claims to fix the underlying native crash.
  const child = spawn(
    process.execPath,
    ['--no-concurrent-sparkplug', path.join(__dirname, 'referee-server-main.js'), file],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, RBOOK_CONFIG_DIR: path.join(dir, 'server-home-config') },
    }
  );
  let url: string | null = null;
  let readyAt: string | null = null;
  let exitedAt: string | null = null;
  let stopRequestedAt: string | null = null;
  let runtime: ReturnType<RunningServer['diagnostics']>['runtime'] = null;
  let stderr = '';
  let stderrTruncated = false;
  const diagnostics: RunningServer['diagnostics'] = () => ({
    pid: child.pid ?? null,
    url,
    startedAt,
    readyAt,
    exitedAt,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    stopRequestedAt,
    runtime,
    stderr,
    stderrTruncated,
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 8192) {
      stderr = stderr.slice(-8192);
      stderrTruncated = true;
    }
  });
  child.once('exit', () => {
    exitedAt = new Date().toISOString();
  });
  const first = await new Promise<string>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', resolve);
    child.once('error', (error) =>
      reject(new Error(`${error.message}; reference server: ${JSON.stringify(diagnostics())}`))
    );
    child.once('exit', () =>
      reject(
        new Error(`the reference server exited; reference server: ${JSON.stringify(diagnostics())}`)
      )
    );
  });
  const ready = JSON.parse(first) as {
    port: number;
    engine: RunningServer['engine'];
    runtime: NonNullable<ReturnType<RunningServer['diagnostics']>['runtime']>;
    readyAt: string;
  };
  url = `http://127.0.0.1:${ready.port}`;
  readyAt = ready.readyAt;
  runtime = ready.runtime;
  return {
    url,
    child,
    engine: ready.engine,
    diagnostics,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        stopRequestedAt ??= new Date().toISOString();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

export async function request<T = unknown>(
  server: Pick<RunningServer, 'url'> & Partial<Pick<RunningServer, 'diagnostics'>>,
  route: string,
  options: {
    token?: string;
    method?: string;
    json?: unknown;
    body?: Buffer;
    headers?: Record<string, string>;
  } = {}
): Promise<{ status: number; body: RbookToolResult<T> }> {
  try {
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
  } catch (error) {
    if (!server.diagnostics) throw error;
    const failed = error as {
      name?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    const cause = failed.cause ? ` (${failed.cause.code ?? ''} ${failed.cause.message ?? ''})` : '';
    throw Object.assign(
      new Error(
        `${failed.name}: ${failed.message}${cause}; reference server: ${JSON.stringify(server.diagnostics())}`
      ),
      { cause: error }
    );
  }
}

/** A test-only peer over the reference server's peer route; each call names the copy's replica as it is now. */
export function httpPeer(
  server: Pick<RunningServer, 'url'> & Partial<Pick<RunningServer, 'diagnostics'>>,
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
