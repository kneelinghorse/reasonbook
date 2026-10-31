import { LEGACY } from '../src/intelligence/legacy-compat';
import { afterEach, beforeAll, beforeEach, describe, expect, test, jest } from '@jest/globals';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createSeededRbookProject } from './helpers/seedRbookDb';

type LoadedModule = Awaited<ReturnType<typeof loadIndexModule>>;

async function loadIndexModule() {
  jest.resetModules();

  const existingSigint = process.listeners('SIGINT');
  const existingSigterm = process.listeners('SIGTERM');

  const mockServer = {
    setRequestHandler: jest.fn(),
    setNotificationHandler: jest.fn(),
    connect: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
    // s93-m11 (#606 b): a client that declared no capabilities, so roots/list is never sent.
    getClientCapabilities: jest.fn(() => undefined),
    listRoots: jest.fn(async () => ({ roots: [] })),
  };
  const serverCtor = jest.fn(() => mockServer);

  const errorCode = {
    InternalError: 'internal_error',
    MethodNotFound: 'method_not_found',
  };

  class ProtocolError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }

  jest.doMock('@modelcontextprotocol/server', () => ({
    Server: serverCtor,
    ProtocolErrorCode: errorCode,
    ProtocolError: ProtocolError,
    CLIENT_INFO_META_KEY: 'io.modelcontextprotocol/clientInfo',
    PROTOCOL_VERSION_META_KEY: 'io.modelcontextprotocol/protocolVersion',
  }));
  const serveStdioMock = jest.fn((factory: () => unknown, _options?: unknown) => {
    factory();
    return { close: mockServer.close };
  });
  jest.doMock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: serveStdioMock }));

  // s77-m03: the boot-time tokenizer preload was removed from initializeServer(),
  // so the #714/#721 cold-load flake (Sprint 70 m01 mocked it away) no longer
  // exists — startup never touches the tokenizer. The Claude tokenizer now loads
  // lazily on first count(), which these logging/wiring tests never trigger, so no
  // stub is needed.
  const indexModule = await import('../src/index');
  const { ErrorHandler } = await import('../src/errors/handler');
  const { MissionProtocolError } = await import('../src/errors/mission-error');

  // Sprint 70 m01: stub the real startup runners by default so initializeServer()
  // does ZERO real I/O. Left real, they open the shared-RBOOK_CONFIG_DIR registry
  // SQLite (WAL-contended across the many parallel jest workers) and read the
  // credential store — under heavy concurrent load that blew the 5000ms test
  // timeout and its late-settling promises bled console output into sibling tests
  // (the #714/#721 flaky). Tests that assert a specific runner's behavior override
  // these AFTER loadIndexModule() returns; jest.resetModules() in afterEach drops
  // the singleton, so no reset is needed here.
  indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
    totalBefore: 0,
    pruned: 0,
    remaining: 0,
    error: null,
  }));
  indexModule.__test__.setStartupProjectKeyRecoveryRunner(async () => ({
    checked: false,
    status: 'skipped-no-project',
    message: 'test-stub: project key recovery skipped',
  }));
  indexModule.__test__.setStartupCredentialCheckRunner(async () => ({
    status: 'has-user-scoped-keys',
    warned: false,
    userScopedKeyCount: 0,
    dashboardConfigured: false,
  }));
  indexModule.__test__.setStartupBundledEnvCheckRunner(() => ({
    installedFromNpm: false,
    envFilePath: null,
    envFileBundled: false,
  }));

  const newSigint = process
    .listeners('SIGINT')
    .filter((listener) => !existingSigint.includes(listener));
  const newSigterm = process
    .listeners('SIGTERM')
    .filter((listener) => !existingSigterm.includes(listener));

  const cleanup = () => {
    for (const listener of newSigint) {
      process.removeListener('SIGINT', listener);
    }
    for (const listener of newSigterm) {
      process.removeListener('SIGTERM', listener);
    }
  };

  return {
    indexModule,
    mockServer,
    serverCtor,
    serveStdioMock,
    ErrorHandler,
    MissionProtocolError,
    newSigint,
    newSigterm,
    cleanup,
  };
}

/**
 * s92-m10 — the first import of src/index compiles its whole module graph through ts-jest. Charged
 * to the first test, that took 70 s under a full-suite run (about 0.4 s alone) and blew the test's
 * timeout. Pay it here, under its own timeout, so every test is timed for what it does. The import
 * registers SIGINT/SIGTERM handlers; remove them so no test sees this module's listeners.
 */
beforeAll(async () => {
  const before = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM'),
  };
  await import('../src/index');
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    for (const listener of process.listeners(signal)) {
      if (!before[signal].includes(listener)) process.removeListener(signal, listener);
    }
  }
  jest.resetModules();
}, 180_000);

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.resetModules();
  jest.restoreAllMocks();
});

const createMockContext = () =>
  ({
    defaultModel: 'claude',
    loader: {},
    registryParser: {} as any,
    packCombiner: {} as any,
    listDomainsTool: {} as any,
    createMissionTool: {} as any,
    combinePacksTool: {} as any,
    optimizeTokensTool: {} as any,
    splitMissionTool: {} as any,
    suggestSplitsTool: {} as any,
    tokenCounter: {} as any,
  }) as any;

/** Set RBOOK_DEBUG for one test (undefined unsets it) and return the restore step. */
function withDebugEnv(value: string | undefined): () => void {
  const saved = process.env.RBOOK_DEBUG;
  if (value === undefined) delete process.env.RBOOK_DEBUG;
  else process.env.RBOOK_DEBUG = value;
  return () => {
    if (saved === undefined) delete process.env.RBOOK_DEBUG;
    else process.env.RBOOK_DEBUG = saved;
  };
}

test('dotenv preserves an explicitly cleared new setting while retaining other empty-value behavior', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-dotenv-'));
  const legacyKey = `${LEGACY.envPrefix}DASHBOARD_API_KEY`;
  const keys = [
    'RBOOK_PROJECT_ROOT',
    'RBOOK_DASHBOARD_API_KEY',
    'RBOOK_MODEL_CACHE_DIR',
    legacyKey,
  ] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  const unrelated = process.env.DOTENV_UNRELATED_FIXTURE;
  let loaded: LoadedModule | undefined;
  try {
    await fs.writeFile(
      path.join(root, '.env'),
      [
        'RBOOK_DASHBOARD_API_KEY=new-file-value',
        `${legacyKey}=legacy-file-value`,
        'RBOOK_MODEL_CACHE_DIR=/fixture/cache',
        'DOTENV_UNRELATED_FIXTURE=file-value',
      ].join('\n')
    );
    process.env.RBOOK_PROJECT_ROOT = root;
    process.env.RBOOK_DASHBOARD_API_KEY = '';
    process.env[legacyKey] = '';
    delete process.env.RBOOK_MODEL_CACHE_DIR;
    process.env.DOTENV_UNRELATED_FIXTURE = '';
    loaded = await loadIndexModule();
    expect(process.env.RBOOK_DASHBOARD_API_KEY).toBe('');
    expect(process.env[legacyKey]).toBe('legacy-file-value');
    expect(process.env.RBOOK_MODEL_CACHE_DIR).toBe('/fixture/cache');
    expect(process.env.DOTENV_UNRELATED_FIXTURE).toBe('file-value');
  } finally {
    loaded?.cleanup();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (unrelated === undefined) delete process.env.DOTENV_UNRELATED_FIXTURE;
    else process.env.DOTENV_UNRELATED_FIXTURE = unrelated;
    await fs.rm(root, { recursive: true, force: true });
  }
});

// s94-m07: these four callers must not ask an explicit or modern caller for roots.
// A blocked client must not hold an otherwise valid local tool response hostage.
const ROOTS_PATHS = [
  ['resolver', 'rbook_decisions', { action: 'list' }],
  ['onboard', 'rbook_agent_onboard', {}],
  ['review', 'rbook_review', {}],
  ['message whoami', 'rbook_message', { action: 'whoami' }],
  [
    'message send',
    'rbook_message',
    {
      action: 'send',
      targetAddress: 'rbook://test/peer',
      type: 'status_update',
      summary: 'Fixture only',
      body: 'Test fixture',
    },
  ],
  ['message list', 'rbook_message', { action: 'list' }],
] as const;

for (const [mode, explicit] of [
  ['2025-11-25', true],
  ['2026-07-28', true],
  ['2026-07-28', false],
] as const) {
  test.each(ROOTS_PATHS)(
    `roots precedence: %s, protocol=${mode}, explicit=${explicit}`,
    async (_label, name, args) => {
      const moduleData = await loadIndexModule();
      const { indexModule, mockServer } = moduleData;
      const root = path.join(os.tmpdir(), `rbook-roots-boundary-${process.pid}`);
      const resolvedBy = explicit ? 'explicit' : 'cwd';
      const sender = await import('../src/intelligence/sender-context');
      const rbook = await import('../src/tools/rbook');
      const review = await import('../src/tools/rbook/review-presentation');
      const uploads = await import('../src/tools/rbook/dashboard-upload-scheduler');
      const previousRole = process.env.RBOOK_AGENT_ROLE;
      delete process.env.RBOOK_AGENT_ROLE;
      jest.spyOn(sender, 'resolveSenderContext').mockResolvedValue({
        projectRoot: root,
        source: resolvedBy,
        candidates: [],
        dashboardProjectId: '5ea6fbd5-35a6-43f0-a23d-68ab20c4d6f2',
        rbookAddress: 'rbook://test/roots',
      });
      jest.spyOn(uploads, 'observeDashboardUploadProject').mockResolvedValue(undefined);
      const result = { success: true, data: {} };
      jest.spyOn(rbook, 'rbookDecisions').mockResolvedValue(result as never);
      jest.spyOn(rbook, 'formatDecisionsForLLM').mockReturnValue('Fixture ready');
      jest.spyOn(rbook, 'rbookAgentOnboard').mockResolvedValue(result as never);
      jest.spyOn(rbook, 'formatAgentOnboardForLLM').mockReturnValue('Fixture ready');
      jest
        .spyOn(review, 'rbookReviewPresentation')
        .mockResolvedValue({ result, text: 'Fixture ready' } as never);
      jest.spyOn(rbook, 'rbookMessage').mockResolvedValue(result as never);
      jest.spyOn(rbook, 'getWhoamiDiagnostics').mockResolvedValue({
        success: true,
        data: { resolved: { projectRoot: root, source: resolvedBy } },
      } as never);
      jest.spyOn(rbook, 'formatMessageForLLM').mockReturnValue('Fixture ready');
      mockServer.getClientCapabilities.mockReturnValue({ roots: { listChanged: true } } as never);
      Object.assign(mockServer, { getNegotiatedProtocolVersion: () => mode });
      let releaseRoots!: (value: { roots: never[] }) => void;
      const blockedRoots = new Promise<{ roots: never[] }>((resolve) => {
        releaseRoots = resolve;
      });
      mockServer.listRoots.mockImplementation(() => blockedRoots);
      indexModule.registerToolHandlers(createMockContext());
      const handler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: unknown,
        ctx?: unknown
      ) => Promise<{ isError?: boolean }>;
      const pending = handler(
        { params: { name, arguments: { ...args, ...(explicit ? { projectRoot: root } : {}) } } },
        {
          mcpReq: {
            envelope:
              mode === '2026-07-28'
                ? {
                    'io.modelcontextprotocol/protocolVersion': mode,
                    'io.modelcontextprotocol/clientInfo': { name: 'roots-fixture', version: '1' },
                    'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: true } },
                  }
                : undefined,
          },
        }
      );
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(mockServer.listRoots).not.toHaveBeenCalled();
        expect((await pending).isError).not.toBe(true);
      } finally {
        // Release only during cleanup; a failing old implementation never leaves a pending timer.
        releaseRoots({ roots: [] });
        await pending.catch(() => undefined);
        if (previousRole === undefined) delete process.env.RBOOK_AGENT_ROLE;
        else process.env.RBOOK_AGENT_ROLE = previousRole;
        moduleData.cleanup();
      }
    }
  );
}

describe('Mission Protocol entry lifecycle', () => {
  test('initializeServer logs initialization details and returns context', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // s92-m07: these diagnostics are behind RBOOK_DEBUG=1 (a normal start writes two lines).
    const restoreDebug = withDebugEnv('1');

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));

    try {
      const result = await moduleData.indexModule.__test__.initializeServer();

      expect(result).toBe(context);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Initializing MCP server'));
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Reasonbook bundled seed schema version: 2.1')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Roots support: probed on first call')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Sender attribution self-test: cwd -> /tmp/current-project')
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
      restoreDebug();
    }
  });

  test('initializeServer logs "pruned N stale entries" when startup prune finds drift', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // s92-m07: these diagnostics are behind RBOOK_DEBUG=1 (a normal start writes two lines).
    const restoreDebug = withDebugEnv('1');

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    moduleData.indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
      totalBefore: 12,
      pruned: 7,
      remaining: 5,
      error: null,
    }));

    try {
      await moduleData.indexModule.__test__.initializeServer();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('pruned 7 stale entries from project registry')
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('(5 remaining)'));
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetStartupRegistryPruneRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
      restoreDebug();
    }
  });

  test('initializeServer logs healthy state when startup prune finds nothing to remove', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // s92-m07: these diagnostics are behind RBOOK_DEBUG=1 (a normal start writes two lines).
    const restoreDebug = withDebugEnv('1');

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    moduleData.indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
      totalBefore: 3,
      pruned: 0,
      remaining: 3,
      error: null,
    }));

    try {
      await moduleData.indexModule.__test__.initializeServer();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Project registry healthy: 3 entries, no stale entries pruned')
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetStartupRegistryPruneRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
      restoreDebug();
    }
  });

  /**
   * s86-m06 — both attribution-failure statuses are logged at [WARN], not [INFO].
   *
   * The status they replaced fell into the catch-all else arm and was logged at [INFO]
   * alongside genuinely uninteresting skips ("no project", "not registered"). In either of
   * these two states auto-recovery is structurally impossible until the operator acts, so
   * INFO understated it — and the single message it carried named a cause that is false in
   * one of the two. Driven through the existing runner seam, one status per case.
   */
  test.each(['skipped-no-user-scoped-key' as const, 'skipped-unattributable-credential' as const])(
    'initializeServer logs project-key recovery status %s at [WARN]',
    async (status) => {
      const moduleData = await loadIndexModule();
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const context = createMockContext();
      moduleData.indexModule.__test__.setContextBuilder(async () => context);
      moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
        projectRoot: '/tmp/current-project',
        source: 'cwd',
        errorCode: null,
        warning: null,
      }));
      moduleData.indexModule.__test__.setStartupProjectKeyRecoveryRunner(async () => ({
        checked: true,
        status,
        message: 'attribution unavailable for this credential',
      }));

      try {
        await moduleData.indexModule.__test__.initializeServer();

        expect(consoleSpy).toHaveBeenCalledWith(
          expect.stringContaining(`[WARN] Project key recovery: ${status}`)
        );
        // And NOT at INFO — the catch-all arm it used to fall into.
        expect(consoleSpy).not.toHaveBeenCalledWith(
          expect.stringContaining(`[INFO] Project key recovery: ${status}`)
        );
      } finally {
        moduleData.cleanup();
        moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
        moduleData.indexModule.__test__.resetStartupProjectKeyRecoveryRunner();
        moduleData.indexModule.__test__.resetContextBuilder();
        consoleSpy.mockRestore();
      }
    }
  );

  test('initializeServer emits a soft WARN when registry prune errors but continues startup', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    moduleData.indexModule.__test__.setStartupRegistryPruneRunner(async () => ({
      totalBefore: null,
      pruned: 0,
      remaining: null,
      error: 'registry file locked',
    }));

    try {
      const result = await moduleData.indexModule.__test__.initializeServer();
      expect(result).toBe(context);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Registry prune skipped: registry file locked')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('continuing startup with unpruned registry')
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetStartupRegistryPruneRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer emits a P0 warning when attribution self-test flags install-root risk', async () => {
    const moduleData = await loadIndexModule();
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const context = createMockContext();
    moduleData.indexModule.__test__.setContextBuilder(async () => context);
    moduleData.indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: null,
      source: null,
      errorCode: 'SENDER_UNRESOLVABLE',
      warning:
        'SERVER_INSTALL_ROOT would have been the implicit sender. Remediation: run from the client project or rely on advertised MCP roots.',
    }));

    try {
      await moduleData.indexModule.__test__.initializeServer();

      // s92-m07: a warning stays visible without RBOOK_DEBUG; the [INFO] self-test line does not.
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[P0] Sender attribution self-test warning')
      );
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('SERVER_INSTALL_ROOT'));
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Sender attribution self-test: unresolved (SENDER_UNRESOLVABLE)')
      );
      expect(consoleSpy.mock.calls.filter((call) => String(call[0]).startsWith('[INFO]'))).toEqual(
        []
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetStartupAttributionSelfTestRunner();
      moduleData.indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
    }
  });

  test('initializeServer wraps failures with mission error', async () => {
    const moduleData = await loadIndexModule();
    const failure = new Error('registry unavailable');
    const wrapped = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'failed',
      context: { module: 'server' },
    });

    moduleData.indexModule.__test__.setContextBuilder(async () => {
      throw failure;
    });
    const handleSpy = jest.spyOn(moduleData.ErrorHandler, 'handle').mockReturnValue(wrapped);

    try {
      await expect(moduleData.indexModule.__test__.initializeServer()).rejects.toBe(wrapped);
      expect(handleSpy).toHaveBeenCalledWith(
        failure,
        'server.initialize',
        { module: 'server' },
        expect.objectContaining({ rethrow: false })
      );
    } finally {
      moduleData.cleanup();
      moduleData.indexModule.__test__.resetContextBuilder();
      handleSpy.mockRestore();
    }
  });

  test('registerToolHandlers registers list handler and sanitizes execution errors', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-index-sanitize-error-'));

    const definitions = [{ name: 'demo_tool' }];
    const definitionsSpy = jest
      .spyOn(indexModule, 'getToolDefinitions')
      .mockReturnValue(definitions as any);

    const context = createMockContext();
    const executionError = new Error('boom');
    const rbookBarrel = await import('../src/tools/rbook');
    const handlerSpy = jest.spyOn(rbookBarrel, 'rbookProject').mockRejectedValue(executionError);

    const missionError = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'wrapped',
      context: { module: 'server', correlationId: 'cid-123' },
    });
    const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockReturnValue(missionError);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      indexModule.__test__.registerToolHandlers(context);

      expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);
      const listHandler = mockServer.setRequestHandler.mock.calls[0][1] as () => any;
      const listResponse = await listHandler();
      expect(Array.isArray(listResponse.tools)).toBe(true);
      expect(listResponse.tools.length).toBeGreaterThan(0);

      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<any>;
      // The sanitizer must still bound a handler crash after whole-schema validation. Every
      // supplied key (including off-action keys) is valid so this reaches the throwing handler.
      const validArgs = {
        action: 'init',
        projectRoot,
        projectName: 'Fixture',
        projectId: 'fixture',
        tracelabProjectId: 'fixture',
        initialSprint: {},
        initialMissions: [],
        name: 'Fixture',
        setAsDefault: false,
        prune: false,
        validate: false,
        projectType: 'build',
        instances: [],
        statusFilter: [],
        itemType: 'mission',
      };
      expect(Object.keys(validArgs).length).toBeGreaterThan(10);
      const result = await callHandler({
        params: {
          name: 'rbook_project',
          arguments: validArgs,
        },
      });

      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          success: false,
          error: { code: 'TOOL_EXECUTION_ERROR' },
        },
      });
      expect((result.content[0] as { text: string }).text).toContain('correlationId=cid-123');

      expect(handleSpy).toHaveBeenCalledTimes(1);
      const [errorArg, operationArg, contextArg] = handleSpy.mock.calls[0];
      expect(errorArg).toBe(executionError);
      expect(operationArg).toBe('server.execute_tool');
      expect(contextArg).toMatchObject({
        module: 'server',
        data: expect.objectContaining({
          tool: 'rbook_project',
          args: expect.objectContaining({ projectName: 'Fixture' }),
        }),
      });
      expect(Object.keys(contextArg?.data?.args as object)).toHaveLength(10);
    } finally {
      moduleData.cleanup();
      await fs.rm(projectRoot, { recursive: true, force: true });
      definitionsSpy.mockRestore();
      consoleSpy.mockRestore();
      handleSpy.mockRestore();
      handlerSpy.mockRestore();
    }
  });

  test('the actual MCP boundary records reads, refusals and protocol failures once each', async () => {
    const project = await createSeededRbookProject(
      {
        dashboardProjectId: '9d485daa-e9fc-4e8b-ae67-9a928daec94d',
        rbookAddress: 'rbook://test/observation',
        owner: 'test',
      },
      'rbook-observation-'
    );
    const config = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-observation-config-'));
    const previous = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = config;
    const moduleData = await loadIndexModule();
    try {
      const { indexModule, mockServer } = moduleData;
      const telemetry = await import('../src/tools/rbook/local-telemetry');
      indexModule.__test__.registerToolHandlers(createMockContext());
      const handler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<any>;
      const args = { projectRoot: project.projectRoot };
      const read = await handler({
        params: { name: 'rbook_context', arguments: { ...args, action: 'next_steps' } },
      });
      expect(read.isError).toBe(false);
      const refusal = await handler({
        params: { name: 'rbook_decisions', arguments: { ...args, action: 'show', decisionId: -1 } },
      });
      expect(refusal.isError).toBe(true);
      await expect(
        handler({ params: { name: 'nonexistent_tool', arguments: args } })
      ).rejects.toThrow();
      const target = telemetry.targetForStore(
        path.join(project.projectRoot, 'rbook/db/rbook.sqlite')
      );
      const records = telemetry.readTelemetry(target!);
      expect(records).toHaveLength(3);
      expect(records.map((row) => row.ok)).toEqual([true, false, false]);
      expect(records[2].refused).toBe('PROTOCOL_ERROR');
      // whoami resolves outside resolveToolSenderContext: the authoritative response stamp
      // must still attribute the observation, with no explicit projectRoot argument.
      const cwd = jest.spyOn(process, 'cwd').mockReturnValue(project.projectRoot);
      try {
        const whoami = await handler({
          params: { name: 'rbook_message', arguments: { action: 'whoami' } },
        });
        expect(whoami.structuredContent?.error).toBeUndefined();
        expect(telemetry.readTelemetry(target!)).toHaveLength(4);
      } finally {
        cwd.mockRestore();
      }
    } finally {
      moduleData.cleanup();
      if (previous === undefined) delete process.env.RBOOK_CONFIG_DIR;
      else process.env.RBOOK_CONFIG_DIR = previous;
      await project.cleanup();
      await fs.rm(config, { recursive: true, force: true });
    }
  });

  // s106-m01, practice 4's real-store positive fire: the real dispatch writes both instruments, and
  // close measure 11 counts a misuse refusal by the parameter it named, with a refusal made before
  // resolution and naming no project counted in the anonymous bound beside it.
  test('the actual MCP boundary feeds close measures 11 and 12 and their anonymous bound', async () => {
    const project = await createSeededRbookProject(
      {
        dashboardProjectId: '0b0c9b5e-6b8e-4b8f-9d0a-6d1f3e2a7c41',
        rbookAddress: 'rbook://test/misuse',
        owner: 'test',
      },
      'rbook-misuse-'
    );
    const config = await fs.mkdtemp(path.join(os.tmpdir(), 'rbook-misuse-config-'));
    const previous = process.env.RBOOK_CONFIG_DIR;
    process.env.RBOOK_CONFIG_DIR = config;
    const moduleData = await loadIndexModule();
    try {
      const { indexModule, mockServer } = moduleData;
      const telemetry = await import('../src/tools/rbook/local-telemetry');
      const stats = await import('../src/tools/rbook/telemetry-stats');
      indexModule.__test__.registerToolHandlers(createMockContext());
      const handler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<any>;
      const since = new Date(Date.now() - 1000).toISOString();
      const missing = await handler({
        params: {
          name: 'rbook_decisions',
          arguments: { projectRoot: project.projectRoot, action: 'show' },
        },
      });
      expect(missing.structuredContent.error).toMatchObject({
        code: 'MISSING_PARAMETER',
        field: 'decisionId',
      });
      const unknown = await handler({
        params: { name: 'rbook_decisions', arguments: { action: 'show', privateKey: 1 } },
      });
      expect(unknown.structuredContent.error).toMatchObject({
        code: 'INVALID_PARAMETER',
        field: 'privateKey',
      });
      const until = new Date(Date.now() + 1000).toISOString();

      const target = telemetry.targetForStore(
        path.join(project.projectRoot, 'rbook/db/rbook.sqlite')
      )!;
      const rows = telemetry.readTelemetry(target);
      expect(rows).toEqual([
        expect.objectContaining({ refused: 'MISSING_PARAMETER', refusedField: 'decisionId' }),
      ]);
      expect(Number.isSafeInteger(rows[0].lookupMs)).toBe(true);
      const anonymous = telemetry.readTelemetry(telemetry.unattributedTarget());
      expect(anonymous).toEqual([
        expect.objectContaining({
          refused: 'INVALID_PARAMETER',
          refusedField: 'unknown',
          lookupMs: null,
        }),
      ]);
      expect(JSON.stringify(anonymous)).not.toContain('privateKey');

      const window = { since, until, baselineSince: since, baselineUntil: until };
      const exported = stats.exportTelemetryStats(
        await stats.collectTelemetryStats([project.projectRoot], window, process.env)
      );
      expect(exported.misuse).toMatchObject({
        rows: 1,
        refusals: 1,
        byField: [
          { tool: 'rbook_decisions', action: 'show', refusedField: 'decisionId', refusals: 1 },
        ],
        anonymous: {
          available: true,
          refusals: 1,
          byField: [
            { tool: 'rbook_decisions', action: 'show', refusedField: 'unknown', refusals: 1 },
          ],
        },
      });
      expect(exported.lookups).toMatchObject({
        rows: 1,
        measured: 1,
        anonymous: { rows: 1, noLookup: 1 },
      });
    } finally {
      moduleData.cleanup();
      if (previous === undefined) delete process.env.RBOOK_CONFIG_DIR;
      else process.env.RBOOK_CONFIG_DIR = previous;
      await project.cleanup();
      await fs.rm(config, { recursive: true, force: true });
    }
  });

  test('registerToolHandlers preserves MethodNotFound for an unknown tool', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;
    const context = createMockContext();
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');

    try {
      indexModule.__test__.registerToolHandlers(context);

      expect(mockServer.setRequestHandler).toHaveBeenCalledTimes(2);
      const listHandler = mockServer.setRequestHandler.mock.calls[0][1] as () => any;
      const listResponse = await listHandler();
      expect(Array.isArray(listResponse.tools)).toBe(true);
      expect(listResponse.tools.length).toBeGreaterThan(0);

      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<unknown>;
      await expect(
        callHandler({
          params: {
            name: 'unknown_tool',
            arguments: { projectRoot: 12345 },
          },
        })
      ).rejects.toMatchObject({
        code: 'method_not_found',
        message: 'Unknown tool: unknown_tool',
      });

      expect(handleSpy).not.toHaveBeenCalled();
    } finally {
      moduleData.cleanup();
      handleSpy.mockRestore();
    }
  });

  test('registerToolHandlers refuses a non-object envelope before invoking a handler', async () => {
    const project = await createSeededRbookProject({}, 'rbook-index-non-object-error-');
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;
    const context = createMockContext();
    const originalCwd = process.cwd;
    process.cwd = () => project.projectRoot;

    const executionError = new Error('explode');
    const rbookBarrel = await import('../src/tools/rbook');
    const handlerSpy = jest.spyOn(rbookBarrel, 'rbookStatus').mockRejectedValue(executionError);
    const missionError = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'wrapped',
      context: { module: 'server' },
    });

    const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockReturnValue(missionError);

    try {
      indexModule.__test__.registerToolHandlers(context);
      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<any>;

      const result = await callHandler({
        params: {
          name: 'rbook_status',
          arguments: 'non-object arguments',
        },
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: 'INVALID_PARAMETER', field: 'arguments' } },
      });

      expect(handlerSpy).not.toHaveBeenCalled();
      expect(handleSpy).not.toHaveBeenCalled();
    } finally {
      process.cwd = originalCwd;
      moduleData.cleanup();
      await project.cleanup();
      handlerSpy.mockRestore();
      handleSpy.mockRestore();
    }
  });

  // Sprint 74 m03: a write-path handler that throws an unhandled (non-ProtocolError)
  // exception must surface a structured RbookToolResult error (code+message+
  // suggestion) as an isError result — never a bare JSON-RPC -32603 that swallows
  // the real cause. Reported by aquex.ai (msg aa124685): forceComplete + capture
  // crashed with a bare -32603 'Tool execution failed' and no actionable detail.
  test('buildToolExecutionErrorResult wraps an unhandled exception as a structured isError result (not a throw)', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule } = moduleData;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const result = indexModule.buildToolExecutionErrorResult(
        'rbook_sprint',
        { action: 'complete', forceComplete: true },
        new Error('SQLITE_CONSTRAINT: stable_event_id is not unique')
      );

      // Returned, not thrown; flagged as an error result.
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      // Carries the machine code, the REAL underlying message, and a suggestion —
      // not the generic 'Tool execution failed' that toPublicError would substitute.
      expect(text).toContain('TOOL_EXECUTION_ERROR');
      expect(text).toContain('SQLITE_CONSTRAINT: stable_event_id is not unique');
      expect(text).toMatch(/Suggestion:/);

      const structured = result.structuredContent as {
        success: boolean;
        error: { code: string; message: string; suggestion: string };
      };
      expect(structured.success).toBe(false);
      expect(structured.error.code).toBe('TOOL_EXECUTION_ERROR');
      expect(structured.error.message).toContain('rbook_sprint');
      expect(structured.error.message).toContain('SQLITE_CONSTRAINT');
      expect(structured.error.suggestion.length).toBeGreaterThan(0);
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
    }
  });

  test.each(['rbook_sprint', 'rbook_session'])(
    'CallTool handler returns a structured isError result (no bare -32603) when the %s write handler throws',
    async (toolName) => {
      const project = await createSeededRbookProject({}, 'rbook-index-write-error-');
      const moduleData = await loadIndexModule();
      const { indexModule, mockServer } = moduleData;
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      // Force the cross-module handler to throw a plain (non-ProtocolError) exception,
      // simulating the aquex.ai store-specific write crash.
      const rbookBarrel = await import('../src/tools/rbook');
      const handlerName = toolName === 'rbook_sprint' ? 'rbookSprint' : 'rbookSession';
      const handlerSpy = jest
        .spyOn(rbookBarrel, handlerName as 'rbookSprint' | 'rbookSession')
        .mockRejectedValue(new Error('simulated store-specific write crash') as never);

      const context = createMockContext();
      try {
        indexModule.__test__.registerToolHandlers(context);
        const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
          request: any
        ) => Promise<any>;

        const request =
          toolName === 'rbook_sprint'
            ? {
                params: {
                  name: 'rbook_sprint',
                  arguments: {
                    action: 'complete',
                    sprintId: 'sprint-1',
                    forceComplete: true,
                    projectRoot: project.projectRoot,
                  },
                },
              }
            : {
                params: {
                  name: 'rbook_session',
                  arguments: {
                    action: 'capture',
                    category: 'decision',
                    content: 'x',
                    projectRoot: project.projectRoot,
                  },
                },
              };

        // Must RESOLVE to a structured error result, NOT reject with an ProtocolError.
        const result = await callHandler(request);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('TOOL_EXECUTION_ERROR');
        expect(text).toContain('simulated store-specific write crash');
        expect(text).toMatch(/Suggestion:/);
      } finally {
        moduleData.cleanup();
        await project.cleanup();
        handlerSpy.mockRestore();
        consoleSpy.mockRestore();
      }
    }
  );

  test('CallTool handler preserves request-local identity disclosure when the selected handler throws', async () => {
    const project = await createSeededRbookProject({}, 'rbook-index-disclosure-error-');
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer } = moduleData;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const rbookBarrel = await import('../src/tools/rbook');
    const { recordProjectIdentityDisclosure } =
      await import('../src/tools/rbook/tool-call-context');
    const disclosure =
      'store="/tmp/identityless.sqlite" has NO RECORDED project identity; fallback only';
    const primitiveDisclosure =
      'store="/tmp/primitive.sqlite" has NO RECORDED project identity; fallback only';
    const sharedError = new Error('simulated throw after getProjectId');
    let invocation = 0;
    const handlerSpy = jest.spyOn(rbookBarrel, 'rbookContext').mockImplementation(async () => {
      invocation += 1;
      if (invocation === 1) recordProjectIdentityDisclosure(disclosure);
      if (invocation === 3) {
        recordProjectIdentityDisclosure(primitiveDisclosure);
        throw 'simulated primitive throw';
      }
      throw sharedError;
    });

    try {
      indexModule.__test__.registerToolHandlers(createMockContext());
      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<any>;
      const result = await callHandler({
        params: {
          name: 'rbook_context',
          arguments: {
            action: 'view',
            contextType: 'project_context',
            projectRoot: project.projectRoot,
          },
        },
      });

      expect(result.isError).toBe(true);
      expect((result.structuredContent as { warnings?: string[] }).warnings).toEqual([disclosure]);
      expect((result.content[0] as { text: string }).text).toContain(disclosure);

      const secondResult = await callHandler({
        params: {
          name: 'rbook_context',
          arguments: {
            action: 'view',
            contextType: 'project_context',
            projectRoot: project.projectRoot,
          },
        },
      });

      expect(secondResult.isError).toBe(true);
      expect((secondResult.structuredContent as { warnings?: string[] }).warnings).toBeUndefined();
      expect((secondResult.content[0] as { text: string }).text).not.toContain(disclosure);

      const primitiveResult = await callHandler({
        params: {
          name: 'rbook_context',
          arguments: {
            action: 'view',
            contextType: 'project_context',
            projectRoot: project.projectRoot,
          },
        },
      });
      expect((primitiveResult.structuredContent as { warnings?: string[] }).warnings).toEqual([
        primitiveDisclosure,
      ]);
      expect(primitiveResult.isError).toBe(true);
      expect((primitiveResult.content[0] as { text: string }).text).toContain(
        'simulated primitive throw'
      );
      expect((primitiveResult.content[0] as { text: string }).text).toContain(primitiveDisclosure);
    } finally {
      moduleData.cleanup();
      await project.cleanup();
      handlerSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  test('parallel CallTool failures keep disclosures isolated when handlers throw the same Error object', async () => {
    const [projectA, projectB] = await Promise.all([
      createSeededRbookProject({}, 'rbook-index-parallel-a-'),
      createSeededRbookProject({}, 'rbook-index-parallel-b-'),
    ]);
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer } = moduleData;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const rbookBarrel = await import('../src/tools/rbook');
    const { recordProjectIdentityDisclosure } =
      await import('../src/tools/rbook/tool-call-context');
    const sharedError = new Error('simulated parallel shared error');
    const disclosures = {
      project_context: 'store="/tmp/a.sqlite" has NO RECORDED project identity',
      master_context: 'store="/tmp/b.sqlite" has NO RECORDED project identity',
    } as const;
    let entered = 0;
    let releaseBoth!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const handlerSpy = jest
      .spyOn(rbookBarrel, 'rbookContext')
      .mockImplementation(async (params) => {
        const contextType = params.contextType as keyof typeof disclosures;
        recordProjectIdentityDisclosure(disclosures[contextType]);
        entered += 1;
        if (entered === 2) releaseBoth();
        await bothEntered;
        throw sharedError;
      });

    try {
      indexModule.__test__.registerToolHandlers(createMockContext());
      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<any>;
      const call = (contextType: keyof typeof disclosures, projectRoot: string) =>
        callHandler({
          params: {
            name: 'rbook_context',
            arguments: { action: 'view', contextType, projectRoot },
          },
        });

      const [resultA, resultB] = await Promise.all([
        call('project_context', projectA.projectRoot),
        call('master_context', projectB.projectRoot),
      ]);

      expect((resultA.structuredContent as { warnings?: string[] }).warnings).toEqual([
        disclosures.project_context,
      ]);
      expect((resultB.structuredContent as { warnings?: string[] }).warnings).toEqual([
        disclosures.master_context,
      ]);
      expect((resultA.content[0] as { text: string }).text).not.toContain(
        disclosures.master_context
      );
      expect((resultB.content[0] as { text: string }).text).not.toContain(
        disclosures.project_context
      );
    } finally {
      moduleData.cleanup();
      await Promise.all([projectA.cleanup(), projectB.cleanup()]);
      handlerSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  test('registerToolHandlers reports when server context is missing', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, ErrorHandler } = moduleData;
    const handleSpy = jest.spyOn(ErrorHandler, 'handle');

    try {
      indexModule.__test__.registerToolHandlers(null as unknown as any);
      const callHandler = mockServer.setRequestHandler.mock.calls[1][1] as (
        request: any
      ) => Promise<unknown>;

      await expect(
        callHandler({ params: { name: 'rbook_project_list', arguments: {} } })
      ).rejects.toMatchObject({
        code: 'internal_error',
        message: 'Server context not initialized',
      });

      expect(handleSpy).not.toHaveBeenCalled();
    } finally {
      moduleData.cleanup();
      handleSpy.mockRestore();
    }
  });

  test.each([
    ['without RBOOK_DEBUG: exactly the two startup lines', undefined],
    ['with RBOOK_DEBUG=1: the diagnostics come back', '1'],
  ])('main connects the server and logs its startup (%s)', async (_label, debug) => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, serveStdioMock } = moduleData;
    const context = createMockContext();
    indexModule.__test__.setContextBuilder(async () => context);
    indexModule.__test__.setStartupAttributionSelfTestRunner(async () => ({
      projectRoot: '/tmp/current-project',
      source: 'cwd',
      errorCode: null,
      warning: null,
    }));
    // Never resolve the real working directory (the repository's own store) from a test.
    indexModule.__test__.setStartupProjectDescriber(
      async () => 'project: /tmp/current-project (from the working directory)'
    );
    const restoreDebug = withDebugEnv(debug);
    // s92-m10: these two lines describe a healthy start. A checkout with no dist/ build (the CI
    // quality job runs the suite before building) adds the real missing-manifest WARN, which
    // tests/server-health.test.ts covers; it is not this test's subject.
    const serverHealth = await import('../src/server-health');
    jest.spyOn(serverHealth, 'initServerHealth').mockImplementation(() => {});

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await indexModule.__test__.main([]);

      expect(mockServer.setRequestHandler).toHaveBeenCalled();
      expect(moduleData.serverCtor.mock.calls).toContainEqual([
        expect.anything(),
        expect.objectContaining({
          capabilities: {
            tools: {},
            prompts: {},
            experimental: { 'codex/sandbox-state-meta': {} },
          },
        }),
      ]);
      expect(mockServer.setRequestHandler.mock.calls.map(([schema]) => schema)).toEqual(
        expect.arrayContaining(['prompts/list', 'prompts/get'])
      );
      expect(moduleData.serveStdioMock).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ legacy: 'serve' })
      );
      expect(mockServer.connect).not.toHaveBeenCalled();
      expect(serveStdioMock).toHaveBeenCalledTimes(1);
      const lines = consoleSpy.mock.calls.map((call) => String(call[0]));
      const { version } = JSON.parse(
        await fs.readFile(path.resolve(__dirname, '../package.json'), 'utf8')
      ) as { version: string };
      const startup = [
        `[reasonbook] v${version} ready on stdio (${indexModule.getToolDefinitions().length} tools)`,
        '[reasonbook] project: /tmp/current-project (from the working directory)',
      ];
      if (debug) {
        expect(lines).toEqual(expect.arrayContaining(startup));
        expect(lines).toContainEqual(expect.stringContaining('rbook MCP server running on stdio'));
        expect(lines.length).toBeGreaterThan(10);
      } else {
        expect(lines).toEqual(startup);
      }
    } finally {
      moduleData.cleanup();
      indexModule.__test__.resetStartupAttributionSelfTestRunner();
      indexModule.__test__.resetStartupProjectDescriber();
      indexModule.__test__.resetContextBuilder();
      consoleSpy.mockRestore();
      restoreDebug();
    }
  });

  test.each([
    ['-h', 0],
    ['--help', 0],
    ['--f9-unknown', 1],
    ['-Z', 1],
  ])('direct server entry %s exits before any startup or store work', async (arg, code) => {
    const moduleData = await loadIndexModule();
    const { indexModule, serveStdioMock } = moduleData;
    const builder = jest.fn(async () => {
      throw new Error('startup must stay untouched');
    });
    indexModule.__test__.setContextBuilder(builder);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await indexModule.__test__.main([String(arg)]);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(code);
      expect(builder).not.toHaveBeenCalled();
      expect(serveStdioMock).not.toHaveBeenCalled();
      if (code === 0) expect(out).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
      else expect(err).toHaveBeenCalledWith(expect.stringMatching(/unknown option.*--help/i));
    } finally {
      moduleData.cleanup();
      indexModule.__test__.resetContextBuilder();
      exitSpy.mockRestore();
      out.mockRestore();
      err.mockRestore();
      log.mockRestore();
    }
  });

  test('main routes --whoami through the CLI runner and skips stdio startup', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, mockServer, serveStdioMock } = moduleData;
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', originalArgv[1] ?? 'index.js', '--whoami'];

    const runner = jest.fn(async () => 0);
    indexModule.__test__.setWhoamiCliRunner(runner);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await indexModule.__test__.main();

      expect(runner).toHaveBeenCalledTimes(1);
      expect(mockServer.connect).not.toHaveBeenCalled();
      expect(serveStdioMock).not.toHaveBeenCalled();
    } finally {
      process.argv = originalArgv;
      moduleData.cleanup();
      indexModule.__test__.resetWhoamiCliRunner();
      consoleSpy.mockRestore();
    }
  });

  test('main exits non-zero when --whoami runner reports fail-closed', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule } = moduleData;
    const originalArgv = process.argv;
    process.argv = [originalArgv[0] ?? 'node', originalArgv[1] ?? 'index.js', '--whoami'];

    indexModule.__test__.setWhoamiCliRunner(async () => 1);
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(indexModule.__test__.main()).rejects.toThrow('exit:1');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.argv = originalArgv;
      moduleData.cleanup();
      indexModule.__test__.resetWhoamiCliRunner();
      exitSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  test('main handles startup failures via ErrorHandler and exits', async () => {
    const moduleData = await loadIndexModule();
    const { indexModule, ErrorHandler } = moduleData;
    const failure = new Error('init failure');

    const missionError = new moduleData.MissionProtocolError({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'startup failed',
      context: { module: 'server' },
    });
    indexModule.__test__.setContextBuilder(async () => {
      throw failure;
    });

    const handleSpy = jest.spyOn(ErrorHandler, 'handle').mockReturnValue(missionError);
    const publicSpy = jest.spyOn(ErrorHandler, 'toPublicError').mockReturnValue({
      code: 'INTERNAL_UNEXPECTED',
      category: 'internal',
      message: 'Mission Protocol server startup failed.',
      correlationId: 'cid-xyz',
      retryable: false,
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await indexModule.__test__.main([]);

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Server startup failed (correlationId=cid-xyz)')
      );
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
      indexModule.__test__.resetContextBuilder();
      handleSpy.mockRestore();
      publicSpy.mockRestore();
    }
  });

  test('SIGINT handler attempts graceful shutdown and exits', async () => {
    const moduleData = await loadIndexModule();
    const { mockServer, newSigint } = moduleData;

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const handler = newSigint[newSigint.length - 1];
      expect(handler).toBeDefined();
      await expect(handler?.({} as any)).rejects.toThrow('exit:0');
      expect(mockServer.close).toHaveBeenCalled();
      // s93-m11 (#606 i): a quiet shutdown, like the quiet startup — the line is RBOOK_DEBUG only.
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Received SIGINT, shutting down gracefully')
      );
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  test('SIGTERM handler attempts graceful shutdown and exits', async () => {
    const moduleData = await loadIndexModule();
    const { mockServer, newSigterm } = moduleData;

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const handler = newSigterm[newSigterm.length - 1];
      expect(handler).toBeDefined();
      await expect(handler?.({} as any)).rejects.toThrow('exit:0');
      expect(mockServer.close).toHaveBeenCalled();
      // s93-m11 (#606 i): a quiet shutdown, like the quiet startup — the line is RBOOK_DEBUG only.
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Received SIGTERM, shutting down gracefully')
      );
    } finally {
      moduleData.cleanup();
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe('runStartupRegistryPrune (real implementation)', () => {
  const ENV_KEY = 'RBOOK_CONFIG_DIR';
  let savedEnv: string | undefined;
  let configDir: string;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'startup-prune-'));
    process.env[ENV_KEY] = configDir;
  });

  afterEach(async () => {
    if (savedEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = savedEnv;
    }
    await fs.rm(configDir, { recursive: true, force: true });
  });

  test('drops entries whose rbook database is missing and reports counts', async () => {
    jest.resetModules();
    const { ProjectGraphRegistry } = await import('../src/intelligence/project-graph-registry');
    const indexModule = await import('../src/index');

    ProjectGraphRegistry.resetInstance();
    const liveProject = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
    await fs.mkdir(path.join(liveProject, 'rbook', 'db'), { recursive: true });
    await fs.writeFile(path.join(liveProject, 'rbook', 'db', 'rbook.sqlite'), '');

    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(liveProject);

    const deadProject = await fs.mkdtemp(path.join(os.tmpdir(), 'dead-'));
    await fs.mkdir(path.join(deadProject, 'rbook', 'db'), { recursive: true });
    await fs.writeFile(path.join(deadProject, 'rbook', 'db', 'rbook.sqlite'), '');
    registry.registerStore(deadProject);
    await fs.rm(deadProject, { recursive: true, force: true });

    try {
      const result = await indexModule.__test__.runStartupRegistryPrune();
      expect(result.error).toBeNull();
      expect(result.totalBefore).toBe(2);
      expect(result.pruned).toBe(1);
      expect(result.remaining).toBe(1);
    } finally {
      await fs.rm(liveProject, { recursive: true, force: true });
      ProjectGraphRegistry.resetInstance();
    }
  });

  test('reports zero pruned on a clean registry', async () => {
    jest.resetModules();
    const { ProjectGraphRegistry } = await import('../src/intelligence/project-graph-registry');
    const indexModule = await import('../src/index');

    ProjectGraphRegistry.resetInstance();
    const liveProject = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'));
    await fs.mkdir(path.join(liveProject, 'rbook', 'db'), { recursive: true });
    await fs.writeFile(path.join(liveProject, 'rbook', 'db', 'rbook.sqlite'), '');

    const registry = await ProjectGraphRegistry.create();
    registry.registerStore(liveProject);

    try {
      const result = await indexModule.__test__.runStartupRegistryPrune();
      expect(result.error).toBeNull();
      expect(result.pruned).toBe(0);
      expect(result.remaining).toBe(1);
    } finally {
      await fs.rm(liveProject, { recursive: true, force: true });
      ProjectGraphRegistry.resetInstance();
    }
  });
});

describe('runStartupBundledEnvCheck (Sprint 62 m02)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bundled-env-check-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  test('reports installedFromNpm=false for a dev-tree path', async () => {
    const indexModule = await import('../src/index');
    // Use a tmpdir that does NOT contain a node_modules segment.
    const result = indexModule.__test__.runStartupBundledEnvCheck(tmpRoot);
    expect(result.installedFromNpm).toBe(false);
    expect(result.envFileBundled).toBe(false);
    expect(result.envFilePath).toBeNull();
  });

  test('reports envFileBundled=true when running from node_modules with a .env present', async () => {
    const indexModule = await import('../src/index');
    const fakeInstallRoot = path.join(tmpRoot, 'node_modules', '@aquex', 'reasonbook');
    await fs.mkdir(fakeInstallRoot, { recursive: true });
    await fs.writeFile(
      path.join(fakeInstallRoot, '.env'),
      'RBOOK_DASHBOARD_API_KEY=cmk_should_never_have_shipped\n'
    );

    const result = indexModule.__test__.runStartupBundledEnvCheck(fakeInstallRoot);
    expect(result.installedFromNpm).toBe(true);
    expect(result.envFileBundled).toBe(true);
    expect(result.envFilePath).toBe(path.join(fakeInstallRoot, '.env'));
  });

  test('reports envFileBundled=false when running from node_modules without a .env', async () => {
    const indexModule = await import('../src/index');
    const fakeInstallRoot = path.join(tmpRoot, 'node_modules', '@aquex', 'reasonbook');
    await fs.mkdir(fakeInstallRoot, { recursive: true });
    // No .env created.

    const result = indexModule.__test__.runStartupBundledEnvCheck(fakeInstallRoot);
    expect(result.installedFromNpm).toBe(true);
    expect(result.envFileBundled).toBe(false);
    expect(result.envFilePath).toBe(path.join(fakeInstallRoot, '.env'));
  });

  test('never throws on a non-existent install root', async () => {
    const indexModule = await import('../src/index');
    const ghost = path.join(tmpRoot, 'node_modules', 'does-not-exist');
    expect(() => indexModule.__test__.runStartupBundledEnvCheck(ghost)).not.toThrow();
    const result = indexModule.__test__.runStartupBundledEnvCheck(ghost);
    expect(result.installedFromNpm).toBe(true);
    expect(result.envFileBundled).toBe(false);
  });
});
