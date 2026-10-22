// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The reference server (s97-m09, design §R4): the dashboard's half of the referee contract on loopback, built on
// ABOUTME: the same library, so where it and the dashboard disagree it shows the intended behaviour until both agree.
import { createReadStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { gunzipSync } from 'zlib';
import {
  applyJoinAnswer,
  archiveReferee,
  conflicts,
  createReferee,
  discardReferee,
  exportSnapshot,
  invite,
  makeFirstCopy,
  members,
  MIN_REQUEST_LIMIT_BYTES,
  peer,
  peers,
  recentChanges,
  REFEREE_ERROR_CODES,
  REFEREE_PROTOCOL,
  REFEREE_VERSION,
  refereeStatus,
  remove,
  setRole,
  waiting,
  type JoinAnswer,
  type RbookToolError,
  type RbookToolResult,
  type RefereeLocation,
  type RefereeOutcome,
  type StreamHead,
} from '../../src/referee';

export interface RefereeServerConfig {
  /** The volume: referee stores at <root>/referee/<projectId>/rbook.sqlite, bindings at <root>/referee-config. */
  readonly root: string;
  /** Bearer token → the account it authenticates. */
  readonly accounts: Readonly<Record<string, string>>;
  /** Registry project id → the account that owns it (user_projects.user_id). */
  readonly projects: Readonly<Record<string, { readonly ownerAccountId: string }>>;
  /** The request limit after decompression, published in the capability (D9). */
  readonly requestLimit?: number;
  /** The port to listen on, so a restarted server answers at the same address; any free one by default. */
  readonly port?: number;
  /** The owner's upload at handover, which the dashboard limits by its file limit, not the request limit (D2). */
  readonly uploadLimit?: number;
  /** False to leave the request limit out of the capability, as a dashboard before D9 does. */
  readonly publishLimit?: boolean;
  /** Project addresses, `user/project` (either scheme), to the registry id each resolves to. */
  readonly addresses?: Readonly<Record<string, string>>;
  /** The record protocol the capability reports, for a test of an older dashboard; the library's by default. */
  readonly reportedRecordProtocol?: number;
}

/** What the server keeps off the volume (D1: PostgreSQL there), so a restarted server picks it up. */
interface SavedProject {
  readonly head: StreamHead | null;
  readonly shared: boolean;
  readonly needsRecovery: RbookToolError | null;
  readonly grants: Array<[string, string]>;
  readonly known: string[];
}

interface ProjectState {
  /** The head the last library call returned, kept off the volume (D1: PostgreSQL there). */
  head: StreamHead | null;
  shared: boolean;
  /** The library's refusal that marked the store lost, answered again to every later call (D8). */
  needsRecovery: RbookToolError | null;
  /** Active direct shares: account → role. */
  readonly grants: Map<string, string>;
  /** Every account ever shared with: a removed one still reaches the library (D3). */
  readonly known: Set<string>;
  queue: Promise<unknown>;
}

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
};

/**
 * The server's own refusal, before any library call, in the dashboard's own error shape
 * ({ success: false, error: "<text>" }, cmos-dashboard's api-respond): its error is text, not the
 * engine's { code, message, suggestion }, so a client says it by its status (contract v1 D2).
 * `code` is this server's own, for tests.
 */
const status = (
  code: string,
  message: string,
  httpStatus: number,
  extra: Record<string, unknown> = {}
) => ({
  httpStatus,
  body: {
    success: false,
    error: message,
    hint: 'See the reference server contract.',
    code,
    ...extra,
  },
});

export function startRefereeServer(
  config: RefereeServerConfig
): Promise<{ server: http.Server; port: number }> {
  const limit = config.requestLimit ?? MIN_REQUEST_LIMIT_BYTES;
  const configDir = path.join(config.root, 'referee-config');
  const savedFile = path.join(config.root, 'server-state.json');
  let saved: Record<string, SavedProject> = {};
  try {
    saved = JSON.parse(readFileSync(savedFile, 'utf8')) as Record<string, SavedProject>;
  } catch {
    saved = {};
  }
  const state = new Map<string, ProjectState>(
    Object.keys(config.projects).map((id) => [
      id,
      {
        head: saved[id]?.head ?? null,
        shared: saved[id]?.shared ?? false,
        needsRecovery: saved[id]?.needsRecovery ?? null,
        grants: new Map(saved[id]?.grants ?? []),
        known: new Set(saved[id]?.known ?? []),
        queue: Promise.resolve(),
      },
    ])
  );
  const save = (): void => {
    mkdirSync(config.root, { recursive: true });
    writeFileSync(
      savedFile,
      JSON.stringify(
        Object.fromEntries(
          [...state].map(([id, project]) => [
            id,
            {
              head: project.head,
              shared: project.shared,
              needsRecovery: project.needsRecovery,
              grants: [...project.grants],
              known: [...project.known],
            },
          ])
        )
      )
    );
  };
  /** Peer calls taken, by method, and the largest request body after decompression: a test's view of paging. */
  const calls: Record<string, number> = {};
  let largestRequest = 0;
  const storeOf = (projectId: string) =>
    path.join(config.root, 'referee', projectId, 'rbook.sqlite');
  const locate = (projectId: string): RefereeLocation => ({
    storePath: storeOf(projectId),
    configDir,
    expectedHead: state.get(projectId)!.head,
  });

  /** Engine calls for one project run one at a time (D1), and every head they return is recorded. */
  function serialized<T>(
    projectId: string,
    call: () => Promise<RefereeOutcome<T>>
  ): Promise<RefereeOutcome<T>> {
    const project = state.get(projectId)!;
    const run = project.queue.then(call, call);
    project.queue = run.catch(() => undefined);
    return run.then((outcome) => {
      if (outcome.head) project.head = outcome.head;
      // Only a referee store the project has can be lost (D8): a late call after a discard is not one.
      if (project.shared && outcome.result.error?.code === REFEREE_ERROR_CODES.NEEDS_RECOVERY)
        project.needsRecovery = outcome.result.error;
      save();
      return outcome;
    });
  }

  const answer = (response: http.ServerResponse, result: RbookToolResult<unknown>): void =>
    json(response, refereeStatus(result), result);

  /** The request body, decompressed when gzip, refused past the published limit (D2). */
  async function body(
    request: http.IncomingMessage,
    limit: number
  ): Promise<Buffer | 'too large' | 'corrupt'> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > limit) return 'too large';
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks);
    if (request.headers['content-encoding'] !== 'gzip') return raw;
    try {
      return gunzipSync(raw, { maxOutputLength: limit });
    } catch (error) {
      // Past the limit after decompression is too large; anything else is a body that is not gzip.
      return (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE' ? 'too large' : 'corrupt';
    }
  }

  const server = http.createServer(async (request, response) => {
    // s98-m08: one request per connection. Under two concurrent full suites a client whose event
    // loop was starved sent a request on a connection this server had just closed as idle, and read
    // ECONNRESET ("Unknown network error" to the client under jest).
    response.setHeader('connection', 'close');
    try {
      const url = new URL(request.url ?? '/', 'http://referee.local');
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const account = token ? config.accounts[token] : undefined;
      if (!account)
        return json(response, 401, status('UNAUTHENTICATED', 'Sign in first.', 401).body);
      // An address resolves to its registry id, as the dashboard's messaging resolver answers it.
      if (request.method === 'GET' && url.pathname === '/api/messages/resolve') {
        const address = (url.searchParams.get('address') ?? '').replace(/^(?:rbook|cmos):\/\//, '');
        const projectId = config.addresses?.[address];
        return projectId
          ? json(response, 200, { success: true, resolved: { projectId } })
          : json(response, 404, status('NOT_FOUND', 'No project has that address.', 404).body);
      }
      if (request.method === 'GET' && url.pathname === '/api/projects/me')
        return json(response, 200, {
          success: true,
          data: {
            user: { id: account },
            projects: [...state.entries()]
              .filter(
                ([id, project]) =>
                  config.projects[id].ownerAccountId === account || project.known.has(account)
              )
              .map(([id, project]) => ({
                id,
                dashboardShared: project.shared,
                needsRecovery: project.needsRecovery !== null,
                referee: {
                  version: REFEREE_VERSION,
                  protocol:
                    config.reportedRecordProtocol === undefined
                      ? REFEREE_PROTOCOL
                      : { ...REFEREE_PROTOCOL, record: config.reportedRecordProtocol },
                  ...(config.publishLimit === false ? {} : { requestLimit: limit }),
                },
              })),
          },
        });
      const route = /^\/api\/(relay|test)\/projects\/([^/]+)\/(.+)$/.exec(url.pathname);
      const project = route ? state.get(route[2]) : undefined;
      if (!route || !project)
        return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
      const [, area, projectId, rest] = route;
      const owner = config.projects[projectId].ownerAccountId === account;
      const member = owner || project.grants.has(account);
      if (!owner && !member && !project.known.has(account))
        return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
      const upload = area === 'relay' && rest === 'referee';
      const incoming =
        request.method === 'POST'
          ? await body(request, upload ? (config.uploadLimit ?? 256 * 1024 * 1024) : limit)
          : Buffer.alloc(0);
      if (incoming === 'corrupt')
        return json(
          response,
          400,
          status('BAD_REQUEST', 'The request body is not gzip.', 400).body
        );
      if (incoming === 'too large')
        return json(
          response,
          413,
          status(
            'TOO_LARGE',
            `A request may hold at most ${limit} bytes after decompression.`,
            413,
            { limit }
          ).body
        );
      let body0: Record<string, unknown> = {};
      if (request.method === 'POST' && request.headers['content-type']?.includes('json'))
        try {
          body0 = incoming.length
            ? (JSON.parse(incoming.toString('utf8')) as Record<string, unknown>)
            : {};
        } catch {
          return json(
            response,
            400,
            status('BAD_REQUEST', 'The request body is not JSON.', 400).body
          );
        }
      const parsed = (): Record<string, unknown> => body0;

      if (area === 'relay' && rest === 'referee' && request.method === 'POST') {
        if (!owner) return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
        const upload = path.join(config.root, 'uploads', `${projectId}-${Date.now()}.sqlite`);
        mkdirSync(path.dirname(upload), { recursive: true });
        writeFileSync(upload, incoming);
        try {
          const created = await serialized(projectId, () =>
            createReferee(
              { storePath: storeOf(projectId), configDir },
              { copyFile: upload, ownerAccountId: account }
            )
          );
          if (created.result.success) {
            project.shared = true;
            project.needsRecovery = null;
            save();
          }
          return answer(response, created.result);
        } finally {
          rmSync(upload, { force: true });
        }
      }
      // A project with no referee store has nothing for the library to answer: it was never shared
      // through the dashboard, or its referee was discarded (critics, round 3).
      if (!project.shared && !(area === 'test' && (rest === 'head' || rest === 'requests')))
        return json(
          response,
          404,
          status('NOT_SHARED', 'This project is not shared through the dashboard.', 404).body
        );
      // A referee that never joined is thrown away, so the owner can hand in again (D6).
      if (area === 'relay' && rest === 'referee' && request.method === 'DELETE') {
        if (!owner) return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
        const discarded = await serialized(projectId, () => discardReferee(locate(projectId)));
        if (discarded.result.success) {
          project.shared = false;
          project.head = null;
          save();
        }
        return answer(response, discarded.result);
      }
      if (project.needsRecovery !== null)
        return json(response, 409, { success: false, error: project.needsRecovery });
      if (area === 'relay' && rest === 'referee/answer' && request.method === 'POST') {
        if (!owner) return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
        const applied = await serialized(projectId, () =>
          applyJoinAnswer(locate(projectId), parsed().answer as JoinAnswer)
        );
        return answer(response, applied.result);
      }
      if (area === 'relay' && rest === 'peer' && request.method === 'POST') {
        const call = parsed();
        calls[String(call.method)] = (calls[String(call.method)] ?? 0) + 1;
        largestRequest = Math.max(largestRequest, incoming.length);
        const outcome = await serialized(projectId, () =>
          peer(locate(projectId), String(call.method), call.params, {
            accountId: account,
            replicaId: String(call.replicaId),
          })
        );
        // The owner's copy holds the record again and synced here at the new epoch: archive (D6).
        if (outcome.movedBack) {
          const archived = await serialized(projectId, () =>
            archiveReferee(
              locate(projectId),
              path.join(config.root, 'archive', projectId, `${Date.now()}.sqlite`)
            )
          );
          if (archived.result.success) {
            project.shared = false;
            project.head = null;
            project.needsRecovery = null;
            save();
          }
        }
        return answer(response, outcome.result);
      }
      if (area === 'relay' && rest === 'first-copy' && request.method === 'GET') {
        if (!member) return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
        const file = path.join(config.root, 'first-copies', `${projectId}-${Date.now()}.sqlite`);
        mkdirSync(path.dirname(file), { recursive: true });
        const made = await serialized(projectId, () => makeFirstCopy(locate(projectId), file));
        if (!made.result.success) return answer(response, made.result);
        response.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': statSync(file).size,
        });
        createReadStream(file)
          .on('close', () => rmSync(file, { force: true }))
          .pipe(response);
        return;
      }
      // The dashboard's sharing page and views, as test controls (D4, D7): the owner shares and removes.
      if (area === 'test') {
        if (rest === 'shares' && request.method === 'POST' && owner) {
          const share = parsed();
          const invited = await serialized(projectId, () =>
            invite(locate(projectId), {
              accountId: String(share.accountId),
              name: String(share.name),
              role: share.role as string | undefined,
            })
          );
          // If the library refuses, the grant is not kept, and the page shows its reason (D4).
          if (invited.result.success) {
            project.grants.set(String(share.accountId), String(share.role ?? 'editor'));
            project.known.add(String(share.accountId));
            save();
          }
          return answer(response, invited.result);
        }
        // A role change on the sharing page calls setRole (D4, s97-m11).
        const roled = /^shares\/([^/]+)\/role$/.exec(rest);
        if (roled && request.method === 'POST' && owner) {
          const changed = await serialized(projectId, () =>
            setRole(locate(projectId), { accountId: roled[1], role: String(parsed().role) })
          );
          if (changed.result.success) {
            project.grants.set(roled[1], String(parsed().role));
            save();
          }
          return answer(response, changed.result);
        }
        const removing = /^shares\/(.+)$/.exec(rest);
        if (removing && request.method === 'DELETE' && owner) {
          const removed = await serialized(projectId, () =>
            remove(locate(projectId), { accountId: removing[1] })
          );
          if (removed.result.success) {
            project.grants.delete(removing[1]);
            save();
          }
          return answer(response, removed.result);
        }
        const views: Record<
          string,
          (location: RefereeLocation) => Promise<RefereeOutcome<unknown>>
        > = {
          members,
          changes: (location) =>
            recentChanges(location, { sinceChangeId: url.searchParams.get('since') }),
          conflicts,
          peers,
          waiting,
        };
        if (rest in views && request.method === 'GET' && member) {
          const viewed = await serialized(projectId, () => views[rest](locate(projectId)));
          return answer(response, viewed.result);
        }
        if (rest === 'export' && request.method === 'POST' && owner) {
          const file = path.join(config.root, 'exports', `${projectId}-${Date.now()}.sqlite`);
          mkdirSync(path.dirname(file), { recursive: true });
          const exported = await serialized(projectId, () =>
            exportSnapshot(locate(projectId), file)
          );
          return answer(
            response,
            exported.result.success ? { ...exported.result, data: { file } } : exported.result
          );
        }
        if (rest === 'head' && request.method === 'GET' && owner)
          return json(response, 200, { success: true, data: project.head });
        if (rest === 'requests' && request.method === 'GET' && owner)
          return json(response, 200, { success: true, data: { calls, largestRequest } });
      }
      return json(response, 404, status('NOT_FOUND', 'No such route.', 404).body);
    } catch (error) {
      json(
        response,
        500,
        status('SERVER_ERROR', error instanceof Error ? error.message : String(error), 500).body
      );
    }
  });
  return new Promise((resolve) => {
    server.listen(config.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

/** Run as its own process: the config file named first, the port said on the first line of stdout. */
export async function main(configFile: string): Promise<void> {
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as RefereeServerConfig;
  const { server, port } = await startRefereeServer(config);
  process.stdout.write(`${JSON.stringify({ port })}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  process.stdin.resume();
}
