// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Run the reference host over loopback against source or an explicitly installed referee engine.
// ABOUTME: Preserve ordinary hosting routes while recovery state and routes live in focused helpers.
import {
  createReadStream,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import http from 'http';
import path from 'path';
import type { JoinAnswer, RbookToolResult } from '../../src/referee';
import { body, json, status } from './referee-server-http';
import {
  createHostState,
  type RefereeEngine,
  type RefereeServerConfig,
} from './referee-server-state';
import { recoveryOffer, recoveryRoute } from './referee-server-recovery';
import { archiveMovedBack, reconcileCarriedMembers } from './referee-server-members';
import { refereeViews } from './referee-server-views';
export type { RefereeServerConfig } from './referee-server-state';

export function startRefereeServer(config: RefereeServerConfig): Promise<{
  server: http.Server;
  port: number;
  engine: { path: string; version: string; protocol: { wire: number; record: number } };
}> {
  const enginePath = realpathSync(require.resolve(config.engineModule ?? '../../src/referee'));
  const engine = require(enginePath) as RefereeEngine;
  const {
    applyJoinAnswer,
    createReferee,
    discardReferee,
    exportSnapshot,
    invite,
    makeFirstCopy,
    MIN_REQUEST_LIMIT_BYTES,
    peer,
    REFEREE_PROTOCOL,
    REFEREE_VERSION,
    refereeStatus,
    remove,
    setRole,
  } = engine;
  const limit = config.requestLimit ?? MIN_REQUEST_LIMIT_BYTES;
  const configDir = path.join(config.root, 'referee-config');
  const host = createHostState(config, engine);
  const { state, save, storeOf, locate, serialized } = host;
  const calls: Record<string, number> = {};
  let largestRequest = 0;
  const answer = (response: http.ServerResponse, result: RbookToolResult<unknown>): void =>
    json(response, refereeStatus(result), result);

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
                  version: config.reportedLibraryVersion ?? REFEREE_VERSION,
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
      // Recovery permissions are settled before any potentially large body is consumed.
      const recovery = rest === 'recovery' || rest.startsWith('recovery/');
      if (
        recovery &&
        (!member ||
          ((area === 'test' || rest === 'recovery/confirm' || request.method === 'DELETE') &&
            !owner))
      )
        return json(response, 404, status('NOT_FOUND', 'No such project.', 404).body);
      const upload = area === 'relay' && (rest === 'referee' || rest === 'recovery/copy');
      const bodyLimit = upload ? (config.uploadLimit ?? 256 * 1024 * 1024) : limit;
      const incoming = request.method === 'POST' ? await body(request, bodyLimit) : Buffer.alloc(0);
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
            `A request may hold at most ${bodyLimit} bytes after decompression.`,
            413,
            { limit: bodyLimit }
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
              {
                copyFile: upload,
                ownerAccountId: account,
                members: project.members.map(({ memberId, accountId }) => ({
                  memberId,
                  accountId,
                })),
                formerRefereeReplicaIds: project.formerRefereeReplicaIds,
              }
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
      // The host's grant is independent of the archived record; preserve the binding for re-share.
      const revokedWhileUnshared = /^shares\/(.+)$/.exec(rest);
      if (
        !project.shared &&
        area === 'test' &&
        revokedWhileUnshared &&
        request.method === 'DELETE' &&
        owner
      ) {
        project.grants.delete(revokedWhileUnshared[1]);
        save();
        return json(response, 200, { success: true });
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
        // The library permits only never-joined stores; an invalid cache must not block this reset.
        const discarded = await host.serialize(projectId, async () => {
          const outcome = await discardReferee(locate(projectId));
          if (outcome.result.success) {
            project.shared = false;
            project.head = null;
            project.membersInvalid = false;
            save();
          }
          return outcome;
        });
        return answer(response, discarded.result);
      }
      if (
        await recoveryRoute(
          {
            area,
            rest,
            method: request.method ?? 'GET',
            url,
            projectId,
            account,
            owner,
            incoming,
            parsed: parsed(),
            response,
          },
          host,
          engine,
          config
        )
      )
        return;
      const collecting = recoveryOffer(host, engine, projectId);
      if (collecting) return answer(response, collecting);
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
        const outcome = await serialized(projectId, async () => {
          const caller = { accountId: account, replicaId: String(call.replicaId) };
          const refused = await reconcileCarriedMembers(host, engine, config, projectId, caller);
          return refused ?? peer(locate(projectId), String(call.method), call.params, caller);
        });
        // The owner's copy holds the record again and synced here at the new epoch: archive (D6).
        if (outcome.movedBack) await archiveMovedBack(host, engine, config, projectId, outcome);
        return answer(response, recoveryOffer(host, engine, projectId) ?? outcome.result);
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
        if (rest === 'set-aside' && request.method === 'POST' && owner) {
          const cut = await serialized(projectId, () =>
            engine.setAside(locate(projectId), {
              replicaId: String(parsed().replicaId ?? ''),
              confirmGone: parsed().confirmGone === true,
            })
          );
          return answer(response, cut.result);
        }
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
        const views = refereeViews(engine, url);
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
      resolve({
        server,
        port: typeof address === 'object' && address ? address.port : 0,
        engine: { path: enginePath, version: REFEREE_VERSION, protocol: REFEREE_PROTOCOL },
      });
    });
  });
}

/** Run as its own process: the config file named first, the port said on the first line of stdout. */
export async function main(configFile: string): Promise<void> {
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as RefereeServerConfig;
  const { server, port, engine } = await startRefereeServer(config);
  process.stdout.write(
    `${JSON.stringify({
      port,
      engine,
      readyAt: new Date().toISOString(),
      runtime: {
        nodeVersion: process.version,
        v8Version: process.versions.v8,
        execArgv: process.execArgv,
      },
    })}\n`
  );
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.stdin.on('end', stop);
  process.stdin.resume();
}
