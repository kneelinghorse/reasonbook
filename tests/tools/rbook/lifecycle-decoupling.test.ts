// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s94-m05 exercises unscheduled work and repair/activation through real handlers.
// ABOUTME: Store assertions prove no placeholder sprint, unsafe reopen, or lost audit/pointer state.
import Database from 'better-sqlite3';
import { createSeededRbookProject, type SeededRbookProject } from '../../helpers/seedRbookDb';
import { rbookMission } from '../../../src/tools/rbook/rbook-mission';
import { rbookMissionAdd } from '../../../src/tools/rbook/rbook-mission-add';
import { rbookMissionUpdate } from '../../../src/tools/rbook/rbook-mission-update';
import { rbookMissionStart } from '../../../src/tools/rbook/rbook-mission-start';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import { syncSprintTracking } from '../../../src/tools/rbook/sprint-tracking';

let project: SeededRbookProject;
let db: Database.Database;
beforeEach(async () => {
  project = await createSeededRbookProject({}, 'rbook-s94-m05-');
  db = new Database(project.dbPath);
});
afterEach(async () => {
  jest.restoreAllMocks();
  db.close();
  await project.cleanup();
});
function sprint(id: string, status = 'Active'): void {
  db.prepare('INSERT INTO sprints(id,title,status) VALUES(?,?,?)').run(id, id, status);
}
function mission(id: string, status: string, sprintId: string | null = null): void {
  db.prepare('INSERT INTO missions(id,name,status,sprint_id) VALUES(?,?,?,?)').run(
    id,
    id,
    status,
    sprintId
  );
}
function row(id: string): { status: string; name: string; sprint_id: string | null } {
  return db.prepare('SELECT status,name,sprint_id FROM missions WHERE id=?').get(id) as never;
}
const events = (): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM session_events').get() as { n: number }).n;

describe('optional sprint assignment', () => {
  it.each([0, 1, 2])('omission uses exactly one open sprint (%i open)', async (count) => {
    for (let i = 0; i < count; i++) sprint(`s${i}`, i ? 'Current' : 'active');
    const result = await rbookMission({
      action: 'add',
      missionId: 'm',
      name: 'Standalone',
      projectRoot: project.projectRoot,
    } as never);
    expect(result.success).toBe(true);
    expect(row('m').sprint_id).toBe(count === 1 ? 's0' : null);
    if (count === 2) expect(result.warnings?.join(' ')).toMatch(/multiple|more than one/i);
  });
  it('explicit NULL remains unscheduled even when a sprint is open', async () => {
    sprint('s');
    expect(
      (
        await rbookMission({
          action: 'add',
          missionId: 'm',
          name: 'Unscheduled',
          sprintId: null,
          projectRoot: project.projectRoot,
        } as never)
      ).success
    ).toBe(true);
    expect(row('m').sprint_id).toBeNull();
  });
  it.each(['', '  ', 123, true, [], {}])(
    'refuses invalid sprint %j before opening the store',
    async (value) => {
      const open = jest.spyOn(RbookDatabaseClient, 'create');
      const result = await rbookMission({
        action: 'add',
        missionId: 'm',
        name: 'M',
        sprintId: value,
        projectRoot: project.projectRoot,
      } as never);
      expect(result.success).toBe(false);
      expect(open).not.toHaveBeenCalled();
    }
  );
  it('does not mistake failed open-set discovery for an unscheduled choice', async () => {
    const original = RbookDatabaseClient.prototype.getMany;
    jest.spyOn(RbookDatabaseClient.prototype, 'getMany').mockImplementation(function (
      this: RbookDatabaseClient,
      sql,
      params
    ) {
      if (/FROM sprints/i.test(sql) && /UPPER\(status\)/i.test(sql))
        return {
          success: false,
          error: { code: 'DB_QUERY_FAILED', message: 'injected open-set failure' },
        };
      return original.call(this, sql, params);
    });
    const result = await rbookMissionAdd({
      missionId: 'm',
      name: 'M',
      projectRoot: project.projectRoot,
    } as never);
    expect(result.success).toBe(false);
    expect(row('m')).toBeUndefined();
  });
});

describe('unknown-status repair preserves history and terminal aliases', () => {
  it.each(['Queued', 'Deferred', 'Dropped'])(
    'repairs Archived into %s with an exact original-status event',
    async (status) => {
      mission('m', 'Archived');
      const result = await rbookMissionUpdate({
        missionId: 'm',
        fields: { status },
        projectRoot: project.projectRoot,
      } as never);
      expect(result.success).toBe(true);
      expect(row('m').status).toBe(status);
      const event = db
        .prepare("SELECT raw_event FROM session_events WHERE mission='m' AND action='update'")
        .get() as { raw_event: string };
      expect(JSON.parse(event.raw_event)).toMatchObject({
        previousStatus: 'Archived',
        newStatus: status,
      });
    }
  );
  it.each(['complete', 'completed', 'COMPLETED'])(
    'does not repair or restart completed alias %s',
    async (status) => {
      mission('m', status);
      const result = await rbookMissionUpdate({
        missionId: 'm',
        fields: { status: 'Queued' },
        projectRoot: project.projectRoot,
      });
      expect(result.error?.code).toBe('MISSION_INVALID_TRANSITION');
      expect(
        (await rbookMissionStart({ missionId: 'm', projectRoot: project.projectRoot })).success
      ).toBe(false);
      expect(row('m').status).toBe(status);
      expect(events()).toBe(0);
    }
  );
  it('rolls companion fields and status back when the required repair event fails', async () => {
    mission('m', 'Archived');
    db.exec(
      "CREATE TRIGGER reject_repair BEFORE INSERT ON session_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"
    );
    const result = await rbookMissionUpdate({
      missionId: 'm',
      fields: { status: 'Queued', name: 'Changed' },
      projectRoot: project.projectRoot,
    });
    expect(result.success).toBe(false);
    expect(row('m')).toMatchObject({ name: 'm', status: 'Archived' });
    expect(events()).toBe(0);
  });
  it('rechecks eligibility after a competing connection completes the mission before the write reservation', async () => {
    mission('m', 'Archived');
    const execute = RbookDatabaseClient.prototype.execute;
    let competed = false;
    jest.spyOn(RbookDatabaseClient.prototype, 'execute').mockImplementation(function (
      this: RbookDatabaseClient,
      sql,
      params
    ) {
      if (sql === 'BEGIN IMMEDIATE' && !competed) {
        competed = true;
        db.prepare("UPDATE missions SET status='Completed' WHERE id='m'").run();
      }
      return execute.call(this, sql, params);
    });
    const result = await rbookMissionUpdate({
      missionId: 'm',
      fields: { status: 'Queued', name: 'Changed' },
      projectRoot: project.projectRoot,
    });
    expect(competed).toBe(true);
    expect(result.success).toBe(false);
    expect(row('m')).toMatchObject({ name: 'm', status: 'Completed' });
    expect(events()).toBe(0);
  });
});

describe('parent activation and tracking', () => {
  it('activates a Planned parent and persists the pointer after commit', async () => {
    sprint('planned', 'Planned');
    mission('m', 'Queued', 'planned');
    expect(
      (await rbookMissionStart({ missionId: 'm', projectRoot: project.projectRoot })).success
    ).toBe(true);
    const context = JSON.parse(
      (
        db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
          content: string;
        }
      ).content
    );
    expect(context.sprint_tracking.current_sprint).toMatchObject({
      id: 'planned',
      status: 'Active',
    });
  });
  it('starts work without opening a second sprint or demoting the existing one', async () => {
    sprint('open');
    sprint('planned', 'Planned');
    mission('m', 'Queued', 'planned');
    const result = await rbookMissionStart({ missionId: 'm', projectRoot: project.projectRoot });
    expect(result.success).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/rbook_sprint.*update/);
    expect(db.prepare('SELECT id,status FROM sprints ORDER BY id').all()).toEqual([
      { id: 'open', status: 'Active' },
      { id: 'planned', status: 'Planned' },
    ]);
  });
  it('leaves prior context bytes intact when post-commit pointer discovery fails', async () => {
    sprint('planned', 'Planned');
    mission('m', 'Queued', 'planned');
    const content = '{"sprint_tracking":{"current_sprint":{"id":"prior"}}, "preserve":true}';
    db.prepare("UPDATE contexts SET content=? WHERE id='master_context'").run(content);
    const getOne = RbookDatabaseClient.prototype.getOne;
    jest.spyOn(RbookDatabaseClient.prototype, 'getOne').mockImplementation(function (
      this: RbookDatabaseClient,
      sql,
      params
    ) {
      if (/SELECT id, title, status, focus FROM sprints/.test(sql))
        return {
          success: false,
          error: { code: 'DB_QUERY_FAILED', message: 'pointer unavailable' },
        };
      return getOne.call(this, sql, params);
    });
    const result = await rbookMissionStart({ missionId: 'm', projectRoot: project.projectRoot });
    expect(result.success).toBe(true);
    expect(result.warnings?.join(' ')).toMatch(/sprint_tracking/);
    expect(
      (
        db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
          content: string;
        }
      ).content
    ).toBe(content);
    expect(row('m').status).toBe('In Progress');
  });
  it('still clears a pointer for a successfully empty open set', async () => {
    const opened = await RbookDatabaseClient.create({ dbPath: project.dbPath });
    if (!opened.data) throw new Error('open failed');
    try {
      const warnings: string[] = [];
      syncSprintTracking(opened.data, warnings);
      expect(warnings).toEqual([]);
    } finally {
      opened.data.close();
    }
    expect(
      JSON.parse(
        (
          db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
            content: string;
          }
        ).content
      ).sprint_tracking.current_sprint
    ).toBeNull();
  });
});

describe('remaining lifecycle seams', () => {
  it.each(['Active', 'Completed'])(
    'status and onboard keep unscheduled work visible beside a %s sprint',
    async (status) => {
      sprint('s', status);
      mission('scheduled', 'Completed', 's');
      mission('free', 'Queued');
      const { rbookMissionStatus } = await import('../../../src/tools/rbook/rbook-mission-status');
      const { rbookAgentOnboard } = await import('../../../src/tools/rbook/rbook-agent-onboard');
      expect(
        (await rbookMissionStatus({ projectRoot: project.projectRoot })).data?.queued.map(
          (m) => m.id
        )
      ).toContain('free');
      const onboard = await rbookAgentOnboard({ projectRoot: project.projectRoot });
      expect(onboard.data?.pendingMissions.map((m) => m.id)).toContain('free');
      expect(onboard.data?.orphans.orphanedMissions.some((m) => m.id === 'free')).toBe(false);
    }
  );
  it('canonical Completed filtering and show normalize a stored complete alias without editing it', async () => {
    mission('m', 'complete');
    const listed = await rbookMission({
      action: 'list',
      status: 'Completed',
      projectRoot: project.projectRoot,
    } as never);
    expect(listed.success).toBe(true);
    expect((listed.data as { missions: { id: string; status: string }[] }).missions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'm', status: 'Completed' })])
    );
    const shown = await rbookMission({
      action: 'show',
      missionId: 'm',
      projectRoot: project.projectRoot,
    } as never);
    expect((shown.data as { status: string }).status).toBe('Completed');
    expect(row('m').status).toBe('complete');
  });
  it.each([true, false])(
    'reports exact UTF-8 sizes of unchanged top-level sections (dryRun=%s)',
    async (dryRun) => {
      const { rbookContextCondense, formatContextCondenseForLLM } =
        await import('../../../src/tools/rbook/rbook-context-condense');
      const content = {
        project_identity: { description: '界'.repeat(12000) },
        working_memory: {},
        array: ['é'],
        scalar: 42,
        nullable: null,
      };
      const bytes = JSON.stringify(content);
      db.prepare("UPDATE contexts SET content=? WHERE id='master_context'").run(bytes);
      const result = await rbookContextCondense({
        contextType: 'master_context',
        strategy: 'conservative',
        targetSizePercent: 10,
        dryRun,
        projectRoot: project.projectRoot,
      });
      expect(result.success).toBe(true);
      const sizes = (result.data as unknown as { remainingSectionBytes: Record<string, number> })
        .remainingSectionBytes;
      expect(sizes).toEqual(
        Object.fromEntries(
          Object.entries(content).map(([key, value]) => [
            key,
            Buffer.byteLength(JSON.stringify(value), 'utf8'),
          ])
        )
      );
      expect(formatContextCondenseForLLM(result)).toMatch(/UTF-8/);
      if (dryRun)
        expect(
          (
            db.prepare("SELECT content FROM contexts WHERE id='master_context'").get() as {
              content: string;
            }
          ).content
        ).toBe(bytes);
    }
  );
  it('reopens carried work without losing its last carry anchor or lapsing at the next close', async () => {
    const { rbookNextSteps } = await import('../../../src/tools/rbook/rbook-next-steps');
    const { rbookSprintComplete } = await import('../../../src/tools/rbook/rbook-sprint-complete');
    const now = Date.now(),
      iso = (days: number) => new Date(now - days * 86400000).toISOString();
    for (let i = 1; i <= 5; i++) {
      sprint(`old${i}`, 'Completed');
      db.prepare('UPDATE sprints SET end_date=? WHERE id=?').run(iso(i + 2), `old${i}`);
    }
    sprint('closing');
    const id = Number(
      db
        .prepare(
          "INSERT INTO next_steps(content,status,created_at,resolved_at,carried_to_sprint) VALUES('Keep this','carried',?,?,'closing')"
        )
        .run(iso(45), iso(1)).lastInsertRowid
    );
    const reopened = await rbookNextSteps({
      nextStepAction: 'reopen',
      nextStepIds: [id],
      projectRoot: project.projectRoot,
    });
    expect(reopened.data?.affected).toBe(1);
    expect(
      db.prepare('SELECT status,resolved_at,carried_to_sprint FROM next_steps WHERE id=?').get(id)
    ).toEqual({ status: 'pending', resolved_at: iso(1), carried_to_sprint: null });
    expect(
      (
        await rbookSprintComplete({
          sprintId: 'closing',
          summary: 'Close fixture',
          projectRoot: project.projectRoot,
        })
      ).success
    ).toBe(true);
    expect(
      (db.prepare('SELECT status FROM next_steps WHERE id=?').get(id) as { status: string }).status
    ).toBe('pending');
  });
});

describe('actual process and initialization boundaries', () => {
  it('two processes starting different Planned parents cannot create two open sprints', async () => {
    const { spawn } = await import('child_process');
    const path = await import('path');
    sprint('left', 'Planned');
    sprint('right', 'Planned');
    mission('left-m', 'Queued', 'left');
    mission('right-m', 'Queued', 'right');
    const modulePath = path.resolve('src/tools/rbook/rbook-mission-start.ts');
    const source = String.raw`const fs=require('fs'),ts=require('typescript');require.extensions['.ts']=(m,f)=>m._compile(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,f);const {rbookMissionStart}=require(process.argv[1]);process.stdout.write('ready\n');process.stdin.once('data',async()=>{try{const result=await rbookMissionStart({missionId:process.argv[3],projectRoot:process.argv[2]});process.stdout.write(JSON.stringify(result)+'\n');process.exit(0);}catch(e){process.stderr.write(String(e));process.exit(1);}});`;
    const children = ['left-m', 'right-m'].map((id) => {
      const child = spawn(process.execPath, ['-e', source, modulePath, project.projectRoot, id], {
        cwd: process.cwd(),
        env: { ...process.env, RBOOK_PROJECT_ROOT: project.projectRoot },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let output = '',
        error = '';
      let readyResolve!: () => void;
      let readyReject!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
      });
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
        if (output.includes('ready\n')) readyResolve();
      });
      child.stderr.on('data', (chunk) => {
        error += String(chunk);
      });
      const done = new Promise<{ code: number | null; output: string; error: string }>((resolve) =>
        // s98-m08 (#660 item 7): 'close', not 'exit', which Node documents can fire before stdio closes.
        child.once('close', (code) => {
          if (!output.includes('ready\n')) readyReject(new Error(error));
          resolve({ code, output, error });
        })
      );
      return { child, ready, done };
    });
    try {
      await Promise.all(children.map((c) => c.ready));
      children.forEach((c) => c.child.stdin.end('go'));
      const results = await Promise.all(children.map((c) => c.done));
      for (const result of results) {
        expect(result.code).toBe(0);
        // s96-m10: match the whole answer, so a failure prints the child's error code and message.
        expect(JSON.parse(result.output.trim().split('\n').slice(-1)[0])).toMatchObject({
          success: true,
        });
      }
      expect(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM sprints WHERE UPPER(status) IN ('ACTIVE','CURRENT','IN PROGRESS')"
            )
            .get() as { n: number }
        ).n
      ).toBe(1);
      expect(db.prepare('SELECT status FROM missions ORDER BY id').all()).toEqual([
        { status: 'In Progress' },
        { status: 'In Progress' },
      ]);
    } finally {
      children.forEach((c) => {
        if (c.child.exitCode === null) c.child.kill();
      });
    }
  }, 20000);
  it.each([undefined, null, 'explicit'] as const)(
    'init preserves the %s initial mission assignment',
    async (requested) => {
      const { rbookProjectInit } = await import('../../../src/tools/rbook/rbook-project-init');
      sprint('explicit');
      const result = await rbookProjectInit({
        projectRoot: project.projectRoot,
        initialMissions: [
          {
            id: 'init-m',
            name: 'Init mission',
            ...(requested !== undefined ? { sprintId: requested } : {}),
            status: 'Queued',
          },
        ],
      } as never);
      expect(result.success).toBe(true);
      expect(row('init-m').sprint_id).toBe(requested === null ? null : 'explicit');
    }
  );
});

describe('legacy and failure controls', () => {
  it('sees a mission table created after an earlier missing-table call', async () => {
    const { RBOOK_SCHEMA } = await import('../../../src/tools/rbook/schema');
    db.exec('DROP TABLE missions');
    const missing = await rbookMissionAdd({
      missionId: 'm',
      name: 'M',
      sprintId: null,
      projectRoot: project.projectRoot,
    });
    expect(missing.success).toBe(false);
    db.exec(RBOOK_SCHEMA);
    expect(
      (
        await rbookMissionAdd({
          missionId: 'm',
          name: 'M',
          sprintId: null,
          projectRoot: project.projectRoot,
        })
      ).success
    ).toBe(true);
    expect(row('m').sprint_id).toBeNull();
  });
  it.each(['In Progress', 'Completed', 'Current', 'Blocked'])(
    'does not use repair to enter %s without lifecycle effects',
    async (status) => {
      mission('m', 'Archived');
      expect(
        (
          await rbookMissionUpdate({
            missionId: 'm',
            fields: { status },
            projectRoot: project.projectRoot,
          } as never)
        ).success
      ).toBe(false);
      expect(row('m').status).toBe('Archived');
      expect(events()).toBe(0);
    }
  );
  it('permits a field-only edit to an unknown status without relabeling it', async () => {
    mission('m', 'constructor');
    expect(
      (
        await rbookMissionUpdate({
          missionId: 'm',
          fields: { name: 'Correct name' },
          projectRoot: project.projectRoot,
        })
      ).success
    ).toBe(true);
    expect(row('m')).toMatchObject({ status: 'constructor', name: 'Correct name' });
    expect(events()).toBe(0);
  });
  it('does not write history when the repair UPDATE fails', async () => {
    mission('m', 'Archived');
    db.exec(
      "CREATE TRIGGER reject_update BEFORE UPDATE ON missions BEGIN SELECT RAISE(ABORT,'locked'); END"
    );
    expect(
      (
        await rbookMissionUpdate({
          missionId: 'm',
          fields: { status: 'Deferred' },
          projectRoot: project.projectRoot,
        })
      ).success
    ).toBe(false);
    expect(row('m').status).toBe('Archived');
    expect(events()).toBe(0);
  });
  it.each(['completed', 'dropped', 'carried'])(
    'reopen keeps only a carried anchor (%s)',
    async (status) => {
      const { rbookNextSteps } = await import('../../../src/tools/rbook/rbook-next-steps');
      const anchor = new Date(Date.now() - 86400000).toISOString();
      const id = Number(
        db
          .prepare(
            "INSERT INTO next_steps(content,status,created_at,resolved_at) VALUES('step',?,?,?)"
          )
          .run(status, anchor, anchor).lastInsertRowid
      );
      expect(
        (
          await rbookNextSteps({
            nextStepAction: 'reopen',
            nextStepIds: [id],
            projectRoot: project.projectRoot,
          })
        ).data?.affected
      ).toBe(1);
      expect(
        (
          db.prepare('SELECT resolved_at FROM next_steps WHERE id=?').get(id) as {
            resolved_at: string | null;
          }
        ).resolved_at
      ).toBe(status === 'carried' ? anchor : null);
    }
  );
});
