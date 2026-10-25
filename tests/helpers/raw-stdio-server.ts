// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Drives raw JSON-RPC stdio so dual-era acceptance does not inherit client negotiation.
// ABOUTME: Tracks exactly one owned child and fails malformed output or unanswered requests loudly.

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { pathToFileURL } from 'url';

export class RawStdioServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<number | null>;
  roots: string[] = [];
  rootsCalls = 0;
  answerRoots = true;
  stderr = '';
  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();

  constructor(
    serverPath: string,
    cwd: string,
    env: Record<string, string>,
    args: string[] = [],
    private readonly requestTimeoutMs = 10000
  ) {
    this.child = spawn(process.execPath, [serverPath, ...args], { cwd, env, stdio: 'pipe' });
    this.exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code) =>
      this.fail(new Error(`Server exited ${code}: ${this.stderr}`))
    );
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method === 'roots/list') {
          this.rootsCalls += 1;
          if (!this.answerRoots) return;
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              roots: this.roots.map((root) => ({ uri: pathToFileURL(root).href })),
            },
          });
        } else if (message.id !== undefined) {
          const request = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(JSON.stringify(message.error)));
          else request?.resolve(message.result);
        }
      } catch (error) {
        this.fail(error as Error);
      }
    });
  }

  private fail(error: Error): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private write(message: unknown): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.nextId;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out: ${this.stderr}`));
        }, this.requestTimeoutMs);
        this.pending.set(id, { resolve, reject });
        this.write({ jsonrpc: '2.0', id, method, params });
      });
    } finally {
      clearTimeout(timer);
    }
  }

  notify(method: string): void {
    this.write({ jsonrpc: '2.0', method });
  }

  async close(signal?: NodeJS.Signals): Promise<number | null> {
    if (signal) this.child.kill(signal);
    else this.child.stdin.end();
    const guard = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    try {
      return await this.exited;
    } finally {
      clearTimeout(guard);
    }
  }
}
