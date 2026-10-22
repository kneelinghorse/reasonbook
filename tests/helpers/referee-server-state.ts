// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Persist the reference host's off-volume state, every recorded head and recovery attempts.
// ABOUTME: Serialize host updates with library calls so restart preserves accepted uploads and cancellation.
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import path from 'path';
import type {
  RecoveryIntake,
  RecoveryMember,
  RecoverySnapshot,
  RbookToolError,
  RefereeOutcome,
  StreamHead,
} from '../../src/referee';

export type RefereeEngine = typeof import('../../src/referee');
export interface RefereeServerConfig {
  readonly root: string;
  readonly accounts: Readonly<Record<string, string>>;
  readonly projects: Readonly<Record<string, { readonly ownerAccountId: string }>>;
  readonly requestLimit?: number;
  readonly port?: number;
  readonly uploadLimit?: number;
  readonly publishLimit?: boolean;
  readonly addresses?: Readonly<Record<string, string>>;
  readonly reportedRecordProtocol?: number;
  readonly reportedLibraryVersion?: string;
  /** Explicit installed candidate module; omitted only for source-based tests. */
  readonly engineModule?: string;
}
export interface AcceptedUpload {
  readonly file: string;
  readonly accountId: string;
  readonly receipt: RecoveryIntake & {
    readonly recoveryId: string;
    readonly projectId: string;
    readonly sha256: string;
    readonly alreadyReceived: false;
  };
}
export interface RecoveryAttempt {
  readonly recoveryId: string;
  state: 'collecting' | 'cancelled' | 'hosted';
  readonly lostHead: StreamHead;
  readonly recordedHeads: readonly StreamHead[];
  readonly members: readonly RecoveryMember[];
  readonly uploads: AcceptedUpload[];
}
export interface SavedProject {
  head: StreamHead | null;
  shared: boolean;
  needsRecovery: RbookToolError | null;
  grants: Array<[string, string]>;
  known: string[];
  recordProjectId?: string;
  headHistory?: StreamHead[];
  formerRefereeReplicaIds?: string[];
  members?: RecoveryMember[];
  membersInvalid?: boolean;
  snapshots?: RecoverySnapshot[];
  recovery?: RecoveryAttempt | null;
}
export interface ProjectState extends Omit<SavedProject, 'grants' | 'known'> {
  readonly grants: Map<string, string>;
  readonly known: Set<string>;
  headHistory: StreamHead[];
  formerRefereeReplicaIds: string[];
  members: RecoveryMember[];
  membersInvalid: boolean;
  snapshots: RecoverySnapshot[];
  recovery: RecoveryAttempt | null;
  queue: Promise<unknown>;
}

/** Retain damaged/lost bytes and sidecars; never overwrite an earlier attempt's evidence. */
export function moveLostStore(root: string, projectId: string, store: string): string {
  const lost = path.join(root, 'referee-lost', projectId, `${randomUUID()}.sqlite`);
  mkdirSync(path.dirname(lost), { recursive: true });
  for (const suffix of ['', '-wal', '-shm'])
    if (existsSync(store + suffix)) renameSync(store + suffix, lost + suffix);
  return lost;
}

export function createHostState(config: RefereeServerConfig, engine: RefereeEngine) {
  const savedFile = path.join(config.root, 'server-state.json');
  let saved: Record<string, SavedProject> = {};
  try {
    saved = JSON.parse(readFileSync(savedFile, 'utf8')) as Record<string, SavedProject>;
    if (!saved || Array.isArray(saved) || typeof saved !== 'object')
      throw new Error('Invalid saved host state');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hasOwner = (
    id: string,
    members: readonly { memberId: string; role: string; accountId: string | null }[] | undefined
  ): boolean =>
    Array.isArray(members) &&
    members.some(
      (member) =>
        member?.memberId === 'owner' &&
        member.role === 'owner' &&
        member.accountId === config.projects[id].ownerAccountId
    );
  const state = new Map<string, ProjectState>(
    Object.keys(config.projects).map((id) => {
      const old = saved[id];
      return [
        id,
        {
          head: old?.head ?? null,
          shared: old?.shared ?? false,
          needsRecovery: old?.needsRecovery ?? null,
          grants: new Map(old?.grants ?? []),
          known: new Set(old?.known ?? []),
          recordProjectId: old?.recordProjectId,
          headHistory: old?.headHistory ?? (old?.head ? [old.head] : []),
          members: old?.members ?? [],
          // Older failed refreshes erased the list without an invalid marker.
          membersInvalid:
            old?.membersInvalid ?? (old?.shared === true && !hasOwner(id, old.members)),
          formerRefereeReplicaIds: old?.formerRefereeReplicaIds ?? [],
          snapshots: old?.snapshots ?? [],
          recovery: old?.recovery ?? null,
          queue: Promise.resolve(),
        },
      ];
    })
  );
  const save = () => {
    mkdirSync(config.root, { recursive: true });
    const output = Object.fromEntries(
      [...state].map(([id, project]) => {
        const { queue: _queue, ...rest } = project;
        return [id, { ...rest, grants: [...project.grants], known: [...project.known] }];
      })
    );
    const temporary = `${savedFile}.next`;
    writeFileSync(temporary, JSON.stringify(output));
    renameSync(temporary, savedFile);
  };
  const storeOf = (id: string) => path.join(config.root, 'referee', id, 'rbook.sqlite');
  const locate = (id: string) => ({
    storePath: storeOf(id),
    configDir: path.join(config.root, 'referee-config'),
    expectedHead: state.get(id)!.head,
  });
  const rememberHead = (project: ProjectState, head: StreamHead) => {
    project.head = head;
    if (
      !project.headHistory.some(
        (prior) =>
          prior.replicaId === head.replicaId && prior.seq === head.seq && prior.hash === head.hash
      )
    )
      project.headHistory.push(head);
  };
  const beginRecovery = (id: string): RecoveryAttempt | null => {
    const project = state.get(id)!;
    if (
      project.membersInvalid ||
      !project.head ||
      !project.recordProjectId ||
      !project.members.length
    )
      return null;
    moveLostStore(config.root, id, storeOf(id));
    project.recovery = {
      recoveryId: randomUUID(),
      state: 'collecting',
      lostHead: project.head,
      recordedHeads: project.headHistory.filter(
        (head) => head.replicaId === project.head!.replicaId
      ),
      members: [...project.members],
      uploads: [],
    };
    save();
    return project.recovery;
  };
  const refreshMembers = async (id: string, joining = false): Promise<RbookToolError | null> => {
    const project = state.get(id)!;
    let error: RbookToolError | null = null;
    const failed = (message: string): RbookToolError => ({
      code: engine.REFEREE_ERROR_CODES.FAILED,
      message,
      suggestion:
        'Check the installed referee engine and retry to refresh authenticated membership.',
    });
    try {
      const members = await engine.members(locate(id));
      if (!members.result.success) {
        // Creation has not joined yet; the host's carried bindings remain authoritative.
        if (joining && members.result.error?.code === engine.REFEREE_ERROR_CODES.NOT_READY)
          return null;
        error = members.result.error ?? failed('The referee did not return its membership.');
      } else if (
        !Array.isArray(members.result.data) ||
        !members.result.data.every(
          (member) =>
            member &&
            typeof member === 'object' &&
            typeof member.memberId === 'string' &&
            member.memberId.length > 0 &&
            typeof member.name === 'string' &&
            typeof member.role === 'string' &&
            member.role.length > 0 &&
            (member.accountId === null ||
              (typeof member.accountId === 'string' && member.accountId.length > 0))
        )
      ) {
        error = failed('The referee returned malformed membership.');
      } else if (!hasOwner(id, members.result.data)) {
        error = failed('The referee returned membership without the configured owner.');
      } else {
        project.members = members.result.data.filter(
          (member): member is typeof member & { accountId: string } =>
            typeof member.accountId === 'string'
        );
      }
    } catch (cause) {
      error = failed(`The referee membership refresh failed: ${String(cause)}`);
    }
    // Retain the last bindings as evidence, but never use them as a current empty/member census.
    project.membersInvalid = error !== null;
    save();
    return error;
  };
  const serialize = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const project = state.get(id)!;
    const run = project.queue.then(work, work);
    project.queue = run.catch(() => undefined);
    return run;
  };
  const serialized = <T>(
    id: string,
    call: () => Promise<RefereeOutcome<T>>
  ): Promise<RefereeOutcome<T>> =>
    serialize(id, async () => {
      const project = state.get(id)!;
      if (project.membersInvalid) {
        const error = await refreshMembers(id);
        if (error) {
          const refusal =
            error.code === engine.REFEREE_ERROR_CODES.NOT_READY
              ? {
                  ...error,
                  suggestion:
                    'Ask the project owner to discard this unfinished hand-in, then share the project again.',
                }
              : error;
          return { result: { success: false, error: refusal }, head: project.head };
        }
      }
      const outcome = await call();
      if (outcome.head) rememberHead(project, outcome.head);
      if (outcome.result.success && outcome.head) {
        // A first hand-in carries the record id separately from this host's registry id.
        const data = outcome.result.data as { joinRequest?: { projectId?: string } } | undefined;
        if (data?.joinRequest?.projectId) project.recordProjectId = data.joinRequest.projectId;
        const error = await refreshMembers(id, Boolean(data?.joinRequest));
        if (error) return { result: { success: false, error }, head: outcome.head };
      }
      if (
        project.shared &&
        outcome.result.error?.code === engine.REFEREE_ERROR_CODES.NEEDS_RECOVERY
      ) {
        project.needsRecovery = outcome.result.error;
        if (!project.recovery || project.recovery.state === 'hosted') beginRecovery(id);
      }
      save();
      return outcome;
    });
  return { state, save, storeOf, locate, rememberHead, beginRecovery, serialize, serialized };
}
export type HostState = ReturnType<typeof createHostState>;
