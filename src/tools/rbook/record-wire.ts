// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The sync wire (ADR s96 §7): the far end answers one JSON line per request after a banner line, and the near
// ABOUTME: end turns any pair of streams, such as an SSH command's, into a peer an exchange can use.

import { createInterface } from 'readline';
import type { Readable, Writable } from 'stream';
import type { RbookDatabaseClient } from './client';
import { changesSince } from './record-apply';
import { applyAndEmbed } from './record-apply-embed';
import { chainsAt } from './record-chain';
import { hello, SYNC_PROTOCOL, type Peer } from './record-exchange';
import { recordExchangeFailed } from './record-peers';
import { admitSuccessor } from './record-admit-successor';
import { reblockSelf, takeSuccessor } from './record-successor';
import type { LoggedChange } from './record-standing';
import type { RbookToolResult } from './types';

/** The far end's first line: who it is and the protocol it speaks, before any request. */
export const WIRE_BANNER = 'reasonbook-sync';

interface Request {
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** One line per message; a line is never split, so a reader can wait for whole lines. */
function send(output: Writable, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}

type Opener = <T>(step: (client: RbookDatabaseClient) => T) => Promise<Awaited<T>>;

/**
 * The far end of a sync: answer each request against this copy, one line each, until the input
 * ends. `open` runs each step against a client opened for it, and `unchecked` against one its copy
 * check does not refuse, for the steps that put a refused copy right (s96-m13). `extra` adds methods,
 * such as a join's.
 */
export async function serveSync(
  input: Readable,
  output: Writable,
  open: Opener,
  extra: Readonly<Record<string, (params: unknown) => Promise<unknown>>> = {},
  unchecked: Opener = open
): Promise<void> {
  // The near end going away ends this far end; a write it can no longer take must not crash it.
  output.on('error', () => undefined);
  send(output, { banner: WIRE_BANNER, protocol: SYNC_PROTOCOL });
  const methods: Readonly<Record<string, (params: unknown) => Promise<unknown>>> = {
    // Reads open without the check: a refused copy still says who it is and what it holds.
    hello: () => unchecked((client) => hello(client)),
    chains: (at) => unchecked((client) => chainsAt(client, at as Record<string, number>)),
    changesSince: (marks) =>
      unchecked((client) => changesSince(client, marks as Record<string, number>)),
    apply: (params) => {
      const { changes, judge, catchUp } = params as {
        changes: LoggedChange[];
        judge?: boolean;
        catchUp?: boolean;
      };
      // A copy its check refuses takes in nothing: it re-identifies first (ADR s96 §9). A catch-up
      // opens without the check, which the merge makes itself (record-token.ts). What the merge made
      // live is embedded once it commits.
      return (catchUp ? unchecked : open)((client) =>
        applyAndEmbed(client, changes, { judge, catchUp })
      );
    },
    admitSuccessor: (params) => open((client) => admitSuccessor(client, params as never)),
    reblockSelf: () => open((client) => reblockSelf(client)),
    takeSuccessor: (params) => unchecked((client) => takeSuccessor(client, params as never)),
    failed: (params) => {
      const { replicaId, error } = params as { replicaId: string; error: string };
      return unchecked((client) => recordExchangeFailed(client, replicaId, error));
    },
    ...extra,
  };
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      send(output, { id: null, error: { message: 'A request was not one line of JSON.' } });
      continue;
    }
    const method = methods[request.method];
    if (!method) {
      send(output, { id: request.id, error: { message: `No sync method ${request.method}.` } });
      continue;
    }
    try {
      send(output, { id: request.id, result: await method(request.params) });
    } catch (error) {
      send(output, {
        id: request.id,
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}

/** A peer at the far end of two streams, once its banner names the protocol this copy speaks. */
export interface WirePeer extends Peer {
  /** Call a method the far end adds, such as a join's. */
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}

/**
 * The near end: wait for the banner, then send each request as one line and match each answer by
 * its id. A far end that closes, answers out of turn or speaks another protocol is an error, never
 * a guess. `timeoutMs` bounds each wait.
 */
export async function wirePeer(
  name: string,
  input: Readable,
  output: Writable,
  close: () => void,
  timeoutMs = 120_000
): Promise<WirePeer> {
  const lines = createInterface({ input, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const next = async (what: string): Promise<Record<string, unknown>> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${name} did not answer ${what} within ${timeoutMs / 1000} s.`)),
        timeoutMs
      );
    });
    try {
      const line = await Promise.race([lines.next(), timeout]);
      if (line.done) throw new Error(`${name} closed the connection before it answered ${what}.`);
      try {
        return JSON.parse(line.value) as Record<string, unknown>;
      } catch {
        throw new Error(
          `${name} did not answer as a Reasonbook sync: its remote command is not one.`
        );
      }
    } finally {
      clearTimeout(timer);
    }
  };
  const banner = await next('the handshake');
  if (banner.banner !== WIRE_BANNER)
    throw new Error(`${name} did not answer as a Reasonbook sync: its remote command is not one.`);
  if (banner.protocol !== SYNC_PROTOCOL)
    throw new Error(
      `${name} speaks sync protocol ${String(banner.protocol)} and this copy speaks ${SYNC_PROTOCOL}: install the same Reasonbook release on both machines.`
    );
  // A far end that went away fails the next write with EPIPE on the stream. The error is kept,
  // never left unhandled to end this process, and the call reports the closed connection.
  let writeError: Error | null = null;
  output.on('error', (error: Error) => {
    writeError = error;
  });
  let id = 0;
  const call = async (method: string, params?: unknown): Promise<unknown> => {
    if (writeError)
      throw new Error(`${name} closed the connection before ${method}: ${writeError.message}`);
    id += 1;
    send(output, { id, method, params });
    const answer = await next(method);
    if (answer.id !== id) throw new Error(`${name} answered out of turn, so the exchange stopped.`);
    if (answer.error)
      throw new Error(`${name}: ${String((answer.error as { message?: unknown }).message)}`);
    return answer.result;
  };
  return {
    name,
    call,
    close,
    hello: () => call('hello') as ReturnType<Peer['hello']>,
    chains: (at) => call('chains', at) as ReturnType<Peer['chains']>,
    changesSince: (marks) => call('changesSince', marks) as ReturnType<Peer['changesSince']>,
    apply: (changes, options = {}) =>
      call('apply', { changes, ...options }) as Promise<RbookToolResult<never>>,
    admitSuccessor: (input) => call('admitSuccessor', input) as ReturnType<Peer['admitSuccessor']>,
    reblockSelf: () => call('reblockSelf') as ReturnType<Peer['reblockSelf']>,
    takeSuccessor: (input) => call('takeSuccessor', input) as ReturnType<Peer['takeSuccessor']>,
    failed: async (input) => {
      await call('failed', input);
    },
  };
}
