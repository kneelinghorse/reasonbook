// SPDX-License-Identifier: Apache-2.0
// ABOUTME: A recovery plan names all conflicting fills, waiting copies and third-party evidence before confirmation.
// ABOUTME: Only host-recorded chain hashes authorize the lost referee's stream; every other row remains evidence.
import { createHash } from 'crypto';
import { validAuthorName } from '../intelligence/user-author';
import { canonicalJson } from '../tools/rbook/record-capture';
import { authorityValue } from '../tools/rbook/record-authority';
import { chainHashOf } from '../tools/rbook/record-chain';
import { OWNER_MEMBER } from '../tools/rbook/record-membership';
import { mergeSetAsideCuts, type ReplicaCuts } from '../tools/rbook/record-member-cuts';
import type { LoggedChange, Member } from '../tools/rbook/record-standing';
import { storedTimeMs } from '../tools/rbook/stored-time';
import { invalidRecovery, validateHead, type RecoveryFile } from './recovery-inputs';
import type { RecoveryLocation, RecoveryPlan, RecoveryPlanInput } from './recovery-types';

export function recoveryInputs(input: RecoveryPlanInput) {
  return [...input.uploads, ...(input.snapshots ?? [])];
}

function validate(input: RecoveryPlanInput, files: readonly RecoveryFile[]): void {
  validateHead(input.lostHead);
  for (const head of input.recordedHeads) {
    validateHead(head);
    if (head.replicaId !== input.lostHead.replicaId || head.seq > input.lostHead.seq)
      invalidRecovery(
        'Recorded head history must belong to the lost referee and end no later than its last head.'
      );
  }
  const ids = new Set<string>();
  const accounts = new Set<string>();
  for (const member of input.members) {
    if (
      !member.memberId ||
      !member.accountId ||
      validAuthorName(member.name) !== member.name ||
      !['owner', 'editor', 'removed'].includes(member.role) ||
      ids.has(member.memberId) ||
      accounts.has(member.accountId)
    )
      invalidRecovery(
        'Recovery members need distinct member ids and accounts, valid names and roles.'
      );
    ids.add(member.memberId);
    accounts.add(member.accountId);
  }
  const owner = input.members.find((member) => member.memberId === OWNER_MEMBER);
  if (!owner || owner.role !== 'owner' || owner.accountId !== input.ownerAccountId)
    invalidRecovery('The confirmed owner member must bind the host-authenticated owner account.');
  for (const file of files) {
    if (!file.caller) {
      if (!file.takenAt || !Number.isFinite(storedTimeMs(file.takenAt)))
        invalidRecovery(`Snapshot ${file.file} needs a valid capture time.`);
      continue;
    }
    const member = input.members.find((known) => known.memberId === file.memberId);
    if (!member || member.accountId !== file.caller.accountId || member.role === 'removed')
      invalidRecovery(
        `Upload ${file.file} is not bound to its authenticated account's active member.`
      );
  }
  if (new Set(files.map((file) => file.file)).size !== files.length)
    invalidRecovery('Each recovery input file is listed once.');
  for (const member of input.dropMembers ?? [])
    if (member === OWNER_MEMBER || !ids.has(member))
      invalidRecovery(
        'Drop members by known member id; drop individual owner copies instead of the owner.'
      );
}

/** Membership uses the verified union reach, never an uploaded copy's unverified tail context. */
function recoveryCopies(
  base: RecoveryFile,
  changes: readonly LoggedChange[],
  input: RecoveryPlanInput,
  adoptedPrefix: number
): {
  copies: Map<string, Member>;
  people: Map<string, { role: string; cuts?: Record<string, number> }>;
} {
  const prefixes = new Map<string, number>();
  for (const change of changes)
    if (change.replica_seq === (prefixes.get(change.replica_id) ?? 0) + 1)
      prefixes.set(change.replica_id, change.replica_seq);
  const copies = new Map<string, Member>();
  const people = new Map<string, { role: string; cuts?: Record<string, number> }>();
  const dropped: Record<string, number> = {};
  const setAsideCuts = new Map<string, ReplicaCuts>();
  for (const term of base.context.terms) {
    copies.set(term.replicaId, {
      replicaId: term.replicaId,
      block: term.block,
      role: 'owner',
      member: OWNER_MEMBER,
    });
    if (term.change) Object.assign(dropped, authorityValue(term.change).dropped ?? {});
    const reach = Math.min(
      term.cut,
      prefixes.get(term.replicaId) ?? 0,
      term.replicaId === input.lostHead.replicaId ? adoptedPrefix : Infinity
    );
    for (const change of changes) {
      if (change.replica_id !== term.replicaId || change.replica_seq > reach) continue;
      if (change.kind === 'member') {
        const person = String(change.entity_id);
        const value = JSON.parse(change.value ?? '{}');
        people.set(person, value);
        setAsideCuts.set(
          person,
          mergeSetAsideCuts(setAsideCuts.get(person) ?? {}, value.setAsideCuts)
        );
      } else if (change.kind === 'replica_joined') {
        const value = JSON.parse(change.value ?? '{}') as {
          block: number;
          role: string;
          member?: string;
          previous?: string;
        };
        const replicaId = String(change.entity_id);
        copies.set(replicaId, {
          replicaId,
          block: Number(value.block),
          role: String(value.role),
          ...(value.member ? { member: value.member } : {}),
          ...(value.previous ? { previous: value.previous } : {}),
        });
      }
    }
  }
  for (const [memberId, person] of people)
    if (person.role !== 'removed' && !input.members.some((member) => member.memberId === memberId))
      invalidRecovery(`Active member ${memberId} has no confirmed account binding.`);
  for (const [replicaId, copy] of copies) {
    const person = copy.member ? people.get(copy.member) : undefined;
    if (person?.role === 'removed')
      copies.set(replicaId, { ...copy, role: 'removed', cut: person.cuts?.[replicaId] ?? 0 });
    else if (person) copies.set(replicaId, { ...copy, role: person.role });
  }
  for (const [person, cuts] of setAsideCuts)
    for (const [replicaId, cut] of Object.entries(cuts)) {
      const copy = copies.get(replicaId);
      if (copy?.member === person)
        copies.set(replicaId, { ...copy, cut: Math.min(copy.cut ?? Infinity, cut) });
    }
  for (const term of base.context.terms)
    if (term.ended === 'recovery') dropped[term.replicaId] = term.cut;
  for (const [replicaId, cut] of Object.entries(dropped)) {
    const copy = copies.get(replicaId);
    if (copy) copies.set(replicaId, { ...copy, cut: Math.min(copy.cut ?? Infinity, cut) });
  }
  return { copies, people };
}

/** One union retaining every fill; the plan refuses publication if any input disagrees. */
export function recoveryUnion(files: readonly RecoveryFile[]): {
  changes: LoggedChange[];
  clashes: RecoveryPlan['clashes'];
} {
  const slots = new Map<string, { change: LoggedChange; file: RecoveryFile }>();
  const ids = new Map<string, { change: LoggedChange; file: RecoveryFile }>();
  const clashes: Array<RecoveryPlan['clashes'][number]> = [];
  for (const file of files)
    for (const change of file.changes) {
      const key = `${change.replica_id}\0${change.replica_seq}`;
      const held = slots.get(key) ?? ids.get(change.change_id);
      if (held && canonicalJson(held.change) !== canonicalJson(change))
        clashes.push({
          replicaId: change.replica_id,
          seq: change.replica_seq,
          left: { file: held.file.file, accountId: held.file.caller?.accountId ?? null },
          right: { file: file.file, accountId: file.caller?.accountId ?? null },
        });
      if (!slots.has(key)) slots.set(key, { change, file });
      if (!ids.has(change.change_id)) ids.set(change.change_id, { change, file });
    }
  return {
    changes: [...slots.values()]
      .map(({ change }) => change)
      .sort((a, b) => a.replica_id.localeCompare(b.replica_id) || a.replica_seq - b.replica_seq),
    clashes,
  };
}

export function makeRecoveryPlan(
  location: RecoveryLocation,
  input: RecoveryPlanInput,
  files: readonly RecoveryFile[]
): RecoveryPlan {
  validate(input, files);
  const snapshots = files
    .filter((file) => !file.caller)
    .sort(
      (a, b) => storedTimeMs(b.takenAt) - storedTimeMs(a.takenAt) || a.file.localeCompare(b.file)
    );
  const total = (file: RecoveryFile) =>
    Object.values(file.marks).reduce((sum, mark) => sum + mark, 0);
  const ownerUploads = files
    .filter((file) => file.caller?.accountId === input.ownerAccountId)
    .sort(
      (a, b) =>
        b.lostPrefix - a.lostPrefix ||
        total(b) - total(a) ||
        a.replicaId.localeCompare(b.replicaId) ||
        a.file.localeCompare(b.file)
    );
  const base = snapshots[0] ?? ownerUploads[0];
  if (!base) invalidRecovery('Recovery needs a host snapshot or an upload from the owner.');
  const { changes, clashes } = recoveryUnion(files);
  const oldStream = changes.filter((change) => change.replica_id === input.lostHead.replicaId);
  const adoptedPrefix = clashes.length
    ? 0
    : Math.max(
        0,
        ...[...input.recordedHeads, input.lostHead]
          .filter((head) => head.hash !== null && chainHashOf(oldStream, head.seq) === head.hash)
          .map((head) => head.seq)
      );
  const evidenceCopies = new Map<string, Member>();
  for (const file of files)
    for (const member of [...file.context.members.values(), ...file.context.unseen.values()])
      evidenceCopies.set(member.replicaId, member);
  const { copies, people } = recoveryCopies(base, changes, input, adoptedPrefix);
  const memberReconciliation: RecoveryPlan['memberReconciliation'] = input.members
    .filter(
      (member) =>
        member.memberId !== OWNER_MEMBER && people.get(member.memberId)?.role !== member.role
    )
    .map((member) => {
      const fromRole = people.get(member.memberId)?.role ?? null;
      return {
        memberId: member.memberId,
        name: member.name,
        fromRole,
        role: fromRole === 'removed' ? 'removed' : member.role,
        action: fromRole === 'removed' ? 'keep_removed' : 'write',
      };
    });
  // An authenticated upload or an explicit drop can name an unseen copy. Its unverified
  // admission never retires a trusted predecessor or creates a missing-copy obligation.
  for (const file of files.filter((entry) => entry.caller))
    if (!copies.has(file.replicaId))
      copies.set(file.replicaId, {
        replicaId: file.replicaId,
        block: file.context.ownBlock,
        role: input.members.find((member) => member.memberId === file.memberId)!.role,
        member: file.memberId,
      });
  for (const id of input.dropCopies ?? []) {
    const evidence = evidenceCopies.get(id);
    if (!copies.has(id) && evidence)
      copies.set(id, {
        replicaId: id,
        block: evidence.block,
        role: evidence.role,
        member: evidence.member,
      });
  }
  const succeeded = new Set([...copies.values()].map((member) => member.previous).filter(Boolean));
  const arrived = new Set(files.filter((file) => file.caller).map((file) => file.replicaId));
  for (const id of input.dropCopies ?? [])
    if (!copies.has(id) || id === input.lostHead.replicaId)
      invalidRecovery(`Copy ${id} is not a member copy this recovery can drop.`);
  const members = input.members.map((member) => ({
    ...member,
    copies: [...copies.values()]
      .filter(
        (copy) =>
          (copy.member ?? (copy.role === 'owner' ? OWNER_MEMBER : '')) === member.memberId &&
          copy.replicaId !== input.lostHead.replicaId &&
          !succeeded.has(copy.replicaId) &&
          copy.cut === undefined &&
          member.role !== 'removed'
      )
      .map((copy) => ({
        replicaId: copy.replicaId,
        in: arrived.has(copy.replicaId),
        dropped:
          (input.dropMembers ?? []).includes(member.memberId) ||
          (input.dropCopies ?? []).includes(copy.replicaId),
      }))
      .sort((a, b) => a.replicaId.localeCompare(b.replicaId)),
  }));
  const waiting = members
    .flatMap((member) =>
      member.copies.filter((copy) => !copy.in && !copy.dropped).map((copy) => copy.replicaId)
    )
    .sort();
  const thirdPartyStreams: Array<RecoveryPlan['thirdPartyStreams'][number]> = [];
  for (const file of files.filter((entry) => entry.caller))
    for (const [replicaId, end] of Object.entries(file.marks)) {
      if (replicaId === input.lostHead.replicaId) continue;
      const copy = copies.get(replicaId) ?? evidenceCopies.get(replicaId);
      const memberId = copy?.member ?? (copy?.role === 'owner' ? OWNER_MEMBER : null);
      const ownEnd = Math.max(
        base.caller ? 0 : (base.marks[replicaId] ?? 0),
        ...files
          .filter((entry) => entry.caller && entry.memberId === memberId)
          .map((entry) => entry.marks[replicaId] ?? 0)
      );
      if (end > ownEnd)
        thirdPartyStreams.push({
          file: file.file,
          accountId: file.caller!.accountId,
          replicaId,
          memberId,
          fromSeq: ownEnd + 1,
          toSeq: end,
        });
    }
  const tailMembership = oldStream.filter(
    (change) =>
      change.replica_seq > adoptedPrefix && ['member', 'replica_joined'].includes(change.kind)
  );
  const count = Math.max(0, input.lostHead.seq - adoptedPrefix);
  const plan = {
    base: { file: base.file, kind: base.caller ? ('upload' as const) : ('snapshot' as const) },
    members,
    waiting,
    clashes,
    adoptedPrefix,
    loss: {
      count,
      lowerBound: true as const,
      summary: `At least ${count} change(s) of the lost referee are not adopted as authority; the host records its head after a commit.`,
    },
    thirdPartyStreams,
    tailMembership,
    memberReconciliation,
    ready: !waiting.length && !clashes.length,
  };
  const planHash = createHash('sha256')
    .update(
      canonicalJson({
        projectId: location.projectId,
        lostHead: input.lostHead,
        recordedHeads: input.recordedHeads,
        ownerAccountId: input.ownerAccountId,
        members: input.members,
        dropMembers: input.dropMembers ?? [],
        dropCopies: input.dropCopies ?? [],
        files: files.map(({ file, sha256, caller, takenAt }) => ({
          file,
          sha256,
          caller,
          takenAt,
        })),
        plan,
      })
    )
    .digest('hex');
  return { ...plan, planHash };
}
