// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Hermetic loopback dashboard scenarios for the suggestion-oracle EXTERNAL axes.
// ABOUTME: Keeps server, scratch, environment and credential side effects behind explicit calls.

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo, Socket } from 'net';

export interface DashboardRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly matchedScenario: boolean;
}
export interface ExpectedDashboardRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string;
}
export type DashboardResponseBody =
  | Readonly<{ type: 'json'; value: unknown }>
  | Readonly<{ type: 'text'; value: string; contentType?: string }>;

export interface HttpScenario {
  readonly kind: 'http';
  readonly expected: ExpectedDashboardRequest;
  readonly status: number;
  readonly body: DashboardResponseBody;
}
export interface SocketDisconnectScenario {
  readonly kind: 'socket-disconnect';
  readonly expected: ExpectedDashboardRequest;
}
export type DeviceTerminalOutcome = 'expired_token' | 'access_denied' | 'approved';

export interface DeviceTerminalScenario {
  readonly kind: 'device-terminal';
  readonly expectedAuthorization: string;
  readonly outcome: DeviceTerminalOutcome;
  readonly errorDescription?: string;
  readonly deviceCode?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  readonly expiresIn?: number;
}
export interface DeviceCodeErrorScenario {
  readonly kind: 'device-code-error';
  readonly expectedAuthorization: string;
  readonly status: number;
  readonly body: DashboardResponseBody;
}
export interface MessageResolveSuccessScenario {
  readonly kind: 'message-resolve-success';
  readonly expectedAuthorization: string;
  readonly resolved: Readonly<{
    userId?: string;
    username?: string;
    displayName?: string;
    projectId?: string;
    projectName?: string;
    projectSlug?: string;
  }>;
}
export interface MessageNotFoundScenario {
  readonly kind: 'message-not-found';
  readonly expectedAuthorization: string;
}

export type DashboardScenario =
  | HttpScenario
  | Readonly<{ kind: 'http-sequence'; steps: readonly HttpScenario[] }>
  | SocketDisconnectScenario
  | DeviceTerminalScenario
  | DeviceCodeErrorScenario
  | MessageResolveSuccessScenario
  | MessageNotFoundScenario;

export interface DashboardDouble {
  readonly origin: string;
  readonly scratchRoot: string;
  readonly requests: readonly DashboardRequest[];
  setScenario(scenario: DashboardScenario): void;
  clearRequests(): void;
  close(): Promise<void>;
}
export interface UserCredentialSpec {
  readonly keyId: string;
  readonly key: string;
  readonly label?: string;
  readonly issuedAt?: string;
  readonly lastUsedAt?: string;
}
export interface PendingRevokeSpec {
  readonly key: string;
  readonly keyId: string;
  readonly revokeAt: string;
}
export interface ProjectCredentialSpec {
  readonly key: string;
  readonly keyId: string;
  readonly parentKeyId: string;
  readonly label?: string;
  readonly issuedAt?: string;
  readonly lastUsedAt?: string;
  readonly pendingRevoke?: PendingRevokeSpec;
}
export interface SeedTempCredentialsOptions {
  readonly configDir: string;
  readonly projectRoot: string;
  readonly userKeys?: readonly UserCredentialSpec[];
  readonly projectKey?: ProjectCredentialSpec;
  readonly now?: string;
}

function sendBody(
  response: http.ServerResponse,
  status: number,
  body: DashboardResponseBody
): void {
  if (body.type === 'json') {
    const encoded = JSON.stringify(body.value);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(encoded === undefined ? '' : encoded);
    return;
  }

  response.writeHead(status, {
    'Content-Type': body.contentType ?? 'text/plain; charset=utf-8',
  });
  response.end(body.value);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  sendBody(response, status, { type: 'json', value });
}

function routePath(url: string): string {
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function handleScenario(
  scenario: Exclude<DashboardScenario, { kind: 'http-sequence' }> | undefined,
  origin: string,
  request: http.IncomingMessage,
  response: http.ServerResponse
): boolean {
  if (!scenario) {
    sendJson(response, 404, { error: 'No dashboard-double scenario is configured' });
    return false;
  }

  const method = request.method ?? '';
  const url = request.url ?? '';
  const pathname = routePath(url);
  const authorization = String(request.headers.authorization ?? '');
  const matchesExpected = (expected: ExpectedDashboardRequest): boolean =>
    method === expected.method &&
    pathname === expected.path &&
    authorization === expected.authorization;

  if (scenario.kind === 'http' && matchesExpected(scenario.expected)) {
    sendBody(response, scenario.status, scenario.body);
    return true;
  }

  if (scenario.kind === 'socket-disconnect' && matchesExpected(scenario.expected)) {
    request.socket.destroy();
    return true;
  }

  if (scenario.kind === 'device-terminal') {
    if (
      method === 'POST' &&
      pathname === '/api/auth/device/code' &&
      authorization === scenario.expectedAuthorization
    ) {
      sendJson(response, 200, {
        deviceCode: scenario.deviceCode ?? 'device-code-test',
        userCode: scenario.userCode ?? 'USER-CODE',
        verificationUri: scenario.verificationUri ?? `${origin}/verify`,
        expiresIn: scenario.expiresIn ?? 60,
        interval: 0,
      });
      return true;
    }
    if (
      scenario.outcome === 'approved' &&
      method === 'GET' &&
      pathname === '/api/projects/me' &&
      authorization === 'Bearer cmk_replay_approved'
    ) {
      // s96-m02: a completed sign-in asks who it is (the dashboard's H3), so author names can
      // default to the account's username.
      sendJson(response, 200, {
        success: true,
        data: { projects: [], totalCount: 0, user: { id: 'replay-user', username: 'replay' } },
      });
      return true;
    }
    if (
      method === 'POST' &&
      pathname === '/api/auth/device/token' &&
      authorization === scenario.expectedAuthorization
    ) {
      if (scenario.outcome === 'approved') {
        sendJson(response, 200, {
          key: 'cmk_replay_approved',
          keyId: 'replay-approved-key',
          label: 'suggestion replay approved',
        });
        return true;
      }
      sendJson(response, 400, {
        error: scenario.outcome,
        ...(scenario.errorDescription === undefined
          ? {}
          : { error_description: scenario.errorDescription }),
      });
      return true;
    }
  }

  if (
    scenario.kind === 'device-code-error' &&
    method === 'POST' &&
    pathname === '/api/auth/device/code' &&
    authorization === scenario.expectedAuthorization
  ) {
    sendBody(response, scenario.status, scenario.body);
    return true;
  }

  if (
    scenario.kind === 'message-resolve-success' &&
    method === 'GET' &&
    pathname === '/api/messages/resolve' &&
    authorization === scenario.expectedAuthorization
  ) {
    sendJson(response, 200, { success: true, resolved: scenario.resolved });
    return true;
  }

  if (
    scenario.kind === 'message-not-found' &&
    method === 'GET' &&
    authorization === scenario.expectedAuthorization
  ) {
    if (pathname === '/api/messages') {
      sendJson(response, 200, { messages: [], unreadCount: 0, totalCount: 0 });
      return true;
    }
    if (pathname.startsWith('/api/messages/') && pathname !== '/api/messages/resolve') {
      sendJson(response, 404, { error: 'message not found' });
      return true;
    }
  }

  sendJson(response, 404, { error: `Unstubbed dashboard route ${method} ${url}` });
  return false;
}

function realTempRoot(): string {
  return fs.realpathSync(os.tmpdir());
}

function assertTempDescendant(candidate: string, label: string): string {
  const realCandidate = fs.realpathSync(candidate);
  const relative = path.relative(realTempRoot(), realCandidate);
  if (
    relative.length === 0 ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`${label} must be a descendant of the real os.tmpdir(): ${realCandidate}`);
  }
  return realCandidate;
}

/** Start the server and create scratch state only when the caller explicitly asks for it. */
export async function startDashboardDouble(
  initialScenario?: DashboardScenario
): Promise<DashboardDouble> {
  const scratchRoot = fs.mkdtempSync(path.join(realTempRoot(), 'rbook-suggestion-external-'));
  const requests: DashboardRequest[] = [];
  const sockets = new Set<Socket>();
  let scenario = initialScenario;
  let sequenceIndex = 0;
  let origin = '';
  let closed = false;

  const server = http.createServer((request, response) => {
    const method = request.method ?? '';
    const url = request.url ?? '';
    const authorization = String(request.headers.authorization ?? '');
    const current = scenario?.kind === 'http-sequence' ? scenario.steps[sequenceIndex] : scenario;
    const matchedScenario = handleScenario(current, origin, request, response);
    if (matchedScenario && scenario?.kind === 'http-sequence') sequenceIndex++;
    requests.push({
      method,
      url,
      authorization,
      matchedScenario,
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  try {
    await new Promise<void>((resolve, reject) => {
      const rejectListen = (error: Error): void => reject(error);
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', rejectListen);
        resolve();
      });
    });
  } catch (error) {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    throw error;
  }

  const address = server.address() as AddressInfo;
  if (address.address !== '127.0.0.1' || address.port <= 0) {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    throw new Error(`Dashboard double bound to an unsafe address: ${JSON.stringify(address)}`);
  }
  origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    scratchRoot,
    requests,
    setScenario(nextScenario: DashboardScenario): void {
      scenario = nextScenario;
      sequenceIndex = 0;
    },
    clearRequests(): void {
      requests.length = 0;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          for (const socket of sockets) socket.destroy();
        });
      } finally {
        fs.rmSync(scratchRoot, { recursive: true, force: true });
      }
    },
  };
}

/** Write a complete CredentialStore v1 file without touching the operator's credential store. */
export function seedTempCredentials(options: SeedTempCredentialsOptions): string {
  fs.mkdirSync(options.configDir, { recursive: true });
  const configDir = assertTempDescendant(options.configDir, 'configDir');
  const projectRoot = assertTempDescendant(options.projectRoot, 'projectRoot');
  const now = options.now ?? new Date().toISOString();
  const credentialsPath = path.join(configDir, 'credentials.json');
  const temporaryPath = path.join(
    configDir,
    `.credentials.json.${process.pid}.${Date.now()}.temporary`
  );

  const userScopedKeys = Object.fromEntries(
    (options.userKeys ?? []).map((spec) => [
      spec.keyId,
      {
        key: spec.key,
        label: spec.label ?? `suggestion oracle ${spec.keyId}`,
        issuedAt: spec.issuedAt ?? now,
        lastUsedAt: spec.lastUsedAt ?? now,
      },
    ])
  );
  const projectKeys = options.projectKey
    ? {
        [projectRoot]: {
          key: options.projectKey.key,
          keyId: options.projectKey.keyId,
          parentKeyId: options.projectKey.parentKeyId,
          label: options.projectKey.label ?? `suggestion oracle ${options.projectKey.keyId}`,
          issuedAt: options.projectKey.issuedAt ?? now,
          lastUsedAt: options.projectKey.lastUsedAt ?? now,
          ...(options.projectKey.pendingRevoke
            ? { pendingRevoke: options.projectKey.pendingRevoke }
            : {}),
        },
      }
    : {};
  const contents = `${JSON.stringify(
    { version: 1, userScopedKeys, projectKeys, updatedAt: now },
    null,
    2
  )}\n`;

  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, credentialsPath);
    fs.chmodSync(credentialsPath, 0o600);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }

  return credentialsPath;
}
