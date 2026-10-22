// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A copy reached through the dashboard (s97-m10, design §R2): the referee's peer route over HTTPS, signed with
// ABOUTME: this project's credentials, paging apply and changesSince by whole transactions within the published limit.

import os from 'os';
import { DashboardClient, resolveDashboardBaseUrl } from './dashboard-client';
import { createError, createSuccess } from './errors';
import type { ApplyReport } from './record-apply';
import { PROTOCOL_VERSION } from './record-changes';
import type { Hello, Peer } from './record-exchange';
import { dashboardName, type DashboardRoute } from './record-dashboard-route';
import { DASHBOARD_LIMIT_FLOOR, pagesOf } from './record-pages';
import type { LoggedChange } from './record-standing';
import type { WirePeer } from './record-wire';
import { REPLICA_ERROR_CODES, ReplicaRefusal } from './replica-identity';
import type { RbookToolError, RbookToolResult } from './types';

/** Room left in each request for the envelope around its changes. */
const ENVELOPE_BYTES = 64 * 1024;
/** The most one sync takes in from the dashboard's stream; a far larger record than any measured (#1495). */
const MAX_STREAM_BYTES = 1024 * 1024 * 1024;

export interface DashboardPeerOptions {
  /** The project folder whose credentials sign each call (decision #832). */
  readonly projectRoot: string;
  /** This copy's replica now: a successor taken mid-exchange calls under its new identity. */
  readonly replicaIdNow: () => Promise<string>;
  /** The record protocol this copy says it writes; tests name a newer one. */
  readonly recordProtocol?: number;
  /** The most one sync takes in from the stream; tests name a small one. */
  readonly maxStreamBytes?: number;
  /**
   * s100-m01 (#717 item 2): whether this copy was told its member was removed, as its review keeps
   * it: the dashboard lists no project for a removed member's account, so its 404 ends the route.
   */
  readonly removedHere?: () => Promise<boolean>;
}

/** A refusal of the exchange, with its remedy named where it is authored. */
const refusal = (said: { readonly message: string; readonly suggestion: string }): ReplicaRefusal =>
  new ReplicaRefusal({ code: REPLICA_ERROR_CODES.EXCHANGE_REFUSED, ...said });

const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Why this machine sends a route's dashboard no sign-in, or null (critics, round 1). A copy's routes
 * travel with its store file, so only the dashboard this machine is set to use gets its key, and only
 * over HTTPS, or on this machine itself.
 */
function signInProblem(route: DashboardRoute): string | null {
  let target: URL;
  let configured: URL;
  try {
    target = new URL(route.url);
    configured = new URL(resolveDashboardBaseUrl());
  } catch {
    return `its route names "${route.url}", which is not a web address`;
  }
  if (target.origin !== configured.origin)
    return `its route names ${target.host}, and this machine signs in only to ${configured.host}`;
  // A route names a dashboard, never a place on it: every call is built from the origin alone.
  if (target.pathname.replace(/\/$/, '') || target.search || target.hash || target.username)
    return `its route names a place on the dashboard ("${route.url}"), and a route names the dashboard alone`;
  if (target.protocol !== 'https:' && !LOOPBACK.has(target.hostname))
    return `${target.host} is not reached over HTTPS`;
  return null;
}

/** The dashboard's own words in an error it answered, if any, kept short. */
function saidBy(body: unknown): string {
  const said = (body as { error?: unknown } | null)?.error;
  return typeof said === 'string' && said.trim() ? ` ("${said.trim().slice(0, 200)}")` : '';
}

/** The dashboard's own answer to a call it did not hand to the referee, said as a person reads it. */
function dashboardRefusal(name: string, status: number, body: unknown): ReplicaRefusal {
  const limit = (body as { limit?: unknown } | null)?.limit;
  const said = saidBy(body);
  if (status === 401)
    return refusal({
      message: `${name} did not accept this machine's sign-in${said}, so nothing was exchanged.`,
      suggestion:
        'Sign in again with rbook_auth(action="login_init"), then rbook_auth(action="login_complete"), and sync again.',
    });
  if (status === 404)
    return refusal({
      message: `${name} knows no such shared project for this account${said}, so nothing was exchanged.`,
      suggestion:
        'Check that the project is shared with you on the dashboard; if it is, the owner can share it again.',
    });
  if (status === 413)
    return refusal({
      message: `${name} refused a request as too large${typeof limit === 'number' ? ` (its limit is ${limit} bytes)` : ''}, so the sync stopped.`,
      suggestion:
        'Sync again; this copy sends smaller pages once it reads the limit the dashboard publishes.',
    });
  if (status === 409)
    return refusal({
      message: `${name} says this project is archived there, or that its shared record there needs recovery${said}, so nothing was exchanged.`,
      suggestion:
        "Your copy keeps everything it holds. The project's page on the dashboard says which, and the owner decides what happens next.",
    });
  if (status === 503)
    return refusal({
      message: `${name} is busy or unavailable just now${said}, so nothing was exchanged.`,
      suggestion: 'Sync again in a few minutes; a whole exchange repeats safely.',
    });
  return refusal({
    message: `${name} answered ${status}${said}${status >= 500 ? ', so it could not take the call just now' : ''}, and nothing was exchanged.`,
    suggestion:
      'Sync again later; a whole exchange repeats safely, and a duplicate changes nothing.',
  });
}

/**
 * Whether a body is the referee's answer (contract v1 D2): a success, or a refusal whose error names
 * its code. The dashboard's own errors say `{ success: false, error: "<text>" }`, and are said by their
 * status instead (critics, round 1).
 */
function isAnswer(body: unknown): body is RbookToolResult<unknown> {
  if (typeof body !== 'object' || body === null) return false;
  const { success, error } = body as { success?: unknown; error?: unknown };
  return (
    success === true ||
    (success === false &&
      typeof error === 'object' &&
      error !== null &&
      typeof (error as { code?: unknown }).code === 'string')
  );
}

/**
 * The reports of one delivery's pages as one (critics, round 1): what each merge took in adds up, while
 * what is held, in conflict or found is the whole record's after the last page.
 */
export function mergePageReports(sum: ApplyReport | null, page: ApplyReport): ApplyReport {
  if (!sum) return page;
  return {
    stored: sum.stored + page.stored,
    duplicates: sum.duplicates + page.duplicates,
    judged: sum.judged + page.judged,
    recomputed: sum.recomputed + page.recomputed,
    held: page.held,
    conflicts: page.conflicts,
    checks: page.checks,
    folded: sum.folded + page.folded,
    newlyLive: [...sum.newlyLive, ...page.newlyLive],
    notes: [...sum.notes, ...page.notes],
    newerProtocol: sum.newerProtocol + page.newerProtocol,
  };
}

/** A failure this copy reports to the dashboard, without this machine's home folder in it. */
export function withoutHome(text: string, home: string = os.homedir()): string {
  return home && home !== '/' ? text.split(home).join('~') : text;
}

/**
 * s97-m11: this machine's client for a dashboard, under the rules every call to it keeps (#1496):
 * only the dashboard this machine is set to use, over https unless on loopback, built from its origin
 * alone, and never with a password. `route` is the dashboard a copy keeps a route to, if any.
 */
export async function dashboardClientFor(
  projectRoot: string,
  route: DashboardRoute | null = null
): Promise<DashboardClient> {
  const target: DashboardRoute = route ?? {
    kind: 'dashboard',
    url: new URL(resolveDashboardBaseUrl()).origin,
    projectId: '',
  };
  const name = dashboardName(target);
  const unsafe = signInProblem(target);
  if (unsafe)
    throw refusal({
      message: `This copy sends ${name} no sign-in, since ${unsafe}; nothing was sent.`,
      suggestion:
        'If the project moved to that dashboard, set RBOOK_DASHBOARD_URL to its https address, run rbook_auth(action="login_init"), then rbook_auth(action="login_complete"); if this copy came from elsewhere, join the project again from your own dashboard.',
    });
  const resolved = await DashboardClient.fromEnvForProject(projectRoot, {
    baseUrl: new URL(target.url).origin,
  });
  if (!resolved.success || !resolved.data)
    throw refusal({
      message: `This machine has no sign-in for ${name}, so it cannot reach it: ${resolved.error?.message ?? 'no credentials'}`,
      suggestion:
        'Sign in on this machine with rbook_auth(action="login_init"), then rbook_auth(action="login_complete"), and try again.',
    });
  // A call to the dashboard sends a key, never a password (critics, round 1).
  if (resolved.data.keySource === 'password-fallback')
    throw refusal({
      message: `This machine signs in to ${name} with a password, which Reasonbook does not send to it.`,
      suggestion:
        'Sign in on this machine with rbook_auth(action="login_init"), then rbook_auth(action="login_complete"), and try again.',
    });
  return resolved.data.client;
}

/**
 * s97-m11: a relay call's answer, read as contract v1 D2 says: an engine-shaped body is the referee's
 * answer whatever the status, and anything else is the dashboard's own, said by its status.
 */
export function relayAnswer<T>(
  name: string,
  sent: RbookToolResult<{ status: number; body: unknown }>
): RbookToolResult<T> {
  if (!sent.success || !sent.data)
    throw refusal({
      message: `${name} could not be reached: ${sent.error?.message ?? 'no answer'}`,
      suggestion:
        'Your copy keeps everything it holds. Try again once the dashboard answers; a step repeats safely.',
    });
  if (isAnswer(sent.data.body)) return sent.data.body as RbookToolResult<T>;
  throw dashboardRefusal(name, sent.data.status, sent.data.body);
}

/**
 * The project's referee on a dashboard, as a peer the exchange runs against unchanged. Each call
 * signs with this project's credentials and names this copy's replica as it is then. A refusal the
 * referee answers keeps its code and remedy; one the dashboard answers itself says what to do.
 */
export async function dashboardPeer(
  route: DashboardRoute,
  options: DashboardPeerOptions
): Promise<WirePeer> {
  const name = dashboardName(route);
  const client = await dashboardClientFor(options.projectRoot, route);

  const call = async (method: string, params?: unknown): Promise<RbookToolResult<unknown>> => {
    const replicaId = await options.replicaIdNow();
    const sent = await client.relayPeerCall(route.projectId, { method, params, replicaId });
    if (!sent.success || !sent.data)
      throw refusal({
        message: `${name} could not be reached: ${sent.error?.message ?? 'no answer'}`,
        suggestion:
          'Your changes stay on this copy. Sync again once the dashboard answers; the review shows each failed try and when they started.',
      });
    // A project the dashboard lists but no longer shares through itself moved back to its owner's
    // copy: this copy's route there has ended (s97-m11). The 404 may come in the engine's shape, as
    // the dashboard's relay answers NOT_SHARED for a project with no referee store (its s62-m05).
    if (sent.data.status === 404) {
      const sharing = await client.dashboardSharing(route.projectId);
      if (sharing.success && sharing.data?.listed && sharing.data.shared === false)
        throw new ReplicaRefusal({
          code: REPLICA_ERROR_CODES.ROUTE_ENDED,
          message: `${name} no longer shares this project: its owner moved it back to their own copy.`,
          suggestion:
            "This copy keeps everything it holds, and now syncs with the owner's copy directly: reasonbook sync --ssh <host> --remote-root <folder>, or a bundle.",
        });
      // s100-m01 (#717 item 2): a removed member's account is listed no project row at all, so the
      // list cannot say the project moved back; the removal this copy was told of says the route
      // serves it nothing, and it ends here too. A copy told of none keeps its route, as one signed
      // in to another account must.
      if (sharing.success && !sharing.data?.listed && (await options.removedHere?.()))
        throw new ReplicaRefusal({
          code: REPLICA_ERROR_CODES.ROUTE_ENDED,
          message: `${name} no longer serves this project to this copy, whose member was removed, so this copy forgets its route there.`,
          suggestion:
            "This copy keeps everything it holds, and syncs with no copy now; whether the project is shared with you again is the owner's to decide.",
        });
    }
    if (isAnswer(sent.data.body)) return sent.data.body;
    throw dashboardRefusal(name, sent.data.status, sent.data.body);
  };
  const value = async <T>(method: string, params?: unknown): Promise<T> => {
    const answer = await call(method, params);
    if (!answer.success) throw new ReplicaRefusal(answer.error as RbookToolError);
    return answer.data as T;
  };

  let budget: number | null = null;
  const budgetNow = async (): Promise<number> => {
    if (budget === null) {
      const published = await client.refereeRequestLimit(route.projectId);
      budget =
        (published.success && published.data ? published.data : DASHBOARD_LIMIT_FLOOR) -
        ENVELOPE_BYTES;
    }
    return budget;
  };

  return {
    name,
    call: (method, params) => value(method, params),
    close: () => undefined,
    hello: () =>
      value<Hello>('hello', { recordProtocol: options.recordProtocol ?? PROTOCOL_VERSION }),
    chains: (at) => value('chains', at),
    // The referee's stream comes back a page at a time; each page holds whole transactions.
    changesSince: async (marks) => {
      const limit = await budgetNow();
      const since: Record<string, number> = { ...marks };
      const all: LoggedChange[] = [];
      let taken = 0;
      for (;;) {
        const page = await value<{ changes: LoggedChange[]; more: boolean } | LoggedChange[]>(
          'changesSince',
          { marks: since, maxBytes: limit }
        );
        if (Array.isArray(page)) return [...all, ...page];
        all.push(...page.changes);
        if (!page.more) return all;
        // Past the cap, what came so far is a prefix of whole transactions: it is applied, and the
        // next sync takes up the rest from there (critics, round 2).
        taken += JSON.stringify(page.changes).length;
        if (taken > (options.maxStreamBytes ?? MAX_STREAM_BYTES)) return all;
        let moved = false;
        for (const change of page.changes)
          if (change.replica_seq > (since[change.replica_id] ?? 0)) {
            since[change.replica_id] = change.replica_seq;
            moved = true;
          }
        if (!moved)
          throw refusal({
            message: `${name} said more changes wait but sent none, so the sync stopped.`,
            suggestion:
              'Sync again; if this repeats, report it with the dashboard address and the time.',
          });
      }
    },
    // This copy's changes go a page at a time, every page but the last saying more follow. A
    // transaction larger than a page stays here with what follows it; the pages before it go, saying
    // more follow, so a catch-up they belong to stays unconfirmed (critics, round 1).
    apply: async (changes, flags = {}) => {
      const limit = await budgetNow();
      const { pages, oversized } = pagesOf(changes, limit);
      let report: ApplyReport | null = null;
      const warnings: string[] = [];
      for (const [index, page] of pages.entries()) {
        const answer = await call('apply', {
          changes: page,
          ...flags,
          ...(oversized || index < pages.length - 1 ? { more: true } : {}),
        });
        if (!answer.success) return answer as RbookToolResult<ApplyReport>;
        report = mergePageReports(report, answer.data as ApplyReport);
        warnings.push(...(answer.warnings ?? []));
      }
      if (oversized)
        return createError<ApplyReport>({
          code: REPLICA_ERROR_CODES.TRANSACTION_TOO_LARGE,
          message: `Transaction ${oversized.txnId} holds ${oversized.bytes} bytes of changes, more than the ${limit} ${name} takes in one request, so it and what this copy wrote after it stay here.`,
          suggestion:
            "Nothing is lost: it stays on this copy with what this copy wrote after it. Reasonbook sends no transaction larger than the dashboard's request limit; report this with the size above.",
        });
      return createSuccess(report!, warnings);
    },
    admitSuccessor: (input) => call('admitSuccessor', input) as ReturnType<Peer['admitSuccessor']>,
    reblockSelf: () => call('reblockSelf') as ReturnType<Peer['reblockSelf']>,
    takeSuccessor: (input) => call('takeSuccessor', input) as ReturnType<Peer['takeSuccessor']>,
    failed: async (input) => {
      await call('failed', { ...input, error: withoutHome(input.error) });
    },
  };
}
