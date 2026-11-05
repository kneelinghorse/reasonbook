// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — an address a write sets meets the dashboard's grammar, this store's owner and no other
// ABOUTME: store's address; the empty address stays writable, and a renamed project's old address is refused by name.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LEGACY } from '../../../src/intelligence/legacy-compat';
import * as projectAddress from '../../../src/intelligence/project-address';
import { resolveRegisteredAddress } from '../../../src/intelligence/project-address';
import { validateProject } from '../../../src/intelligence/sender-context';
import { ProjectGraphRegistry } from '../../../src/intelligence/project-graph-registry';
import { RbookDetector } from '../../../src/intelligence/rbook-detector';
import { checkAddressWrite } from '../../../src/tools/rbook/address-rule';
import { RbookDatabaseClient } from '../../../src/tools/rbook/client';
import {
  ensureProjectIdentityRow,
  patchProjectIdentity,
  previewUnknownRbookAddressHeal,
  readProjectIdentity,
} from '../../../src/tools/rbook/project-identity';
import {
  rbookContextUpdateProjectIdentity,
  rbookContextViewProjectIdentity,
} from '../../../src/tools/rbook/rbook-context-project-identity';
import { call, useMachine } from '../../helpers/replica-fixture';
import { exchange, joinedCopy, ownerCopy } from '../../helpers/shared-copies';
import { seedRbookDb } from '../../helpers/seedRbookDb';

let tmp: string;
const savedConfig = process.env.RBOOK_CONFIG_DIR;

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rbook-address-rule-')));
  process.env.RBOOK_CONFIG_DIR = path.join(tmp, 'config');
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
});

afterEach(() => {
  ProjectGraphRegistry.resetInstance();
  RbookDetector.resetInstance();
  if (savedConfig === undefined) delete process.env.RBOOK_CONFIG_DIR;
  else process.env.RBOOK_CONFIG_DIR = savedConfig;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const dbOf = (root: string): string => path.join(root, 'rbook', 'db', 'rbook.sqlite');

function sql(root: string, statement: string, ...args: unknown[]): void {
  const db = new Database(dbOf(root));
  try {
    db.prepare(statement).run(...args);
  } finally {
    db.close();
  }
  RbookDetector.resetInstance();
}

/** The stored identity row, raw: the address under its storage key, and every other field. */
function storedIdentity(root: string): Record<string, unknown> | undefined {
  const db = new Database(dbOf(root), { readonly: true });
  try {
    const row = db.prepare("SELECT content FROM contexts WHERE id = 'project_identity'").get() as
      | { content: string }
      | undefined;
    return row ? (JSON.parse(row.content) as Record<string, unknown>) : undefined;
  } finally {
    db.close();
  }
}

/** A project in `<tmp>/<name>`, registered in the scratch registry, with these metadata keys. */
async function store(
  name: string,
  options: { owner?: string | null; address?: string; slug?: string; projectName?: string } = {}
): Promise<string> {
  const root = path.join(tmp, name);
  seedRbookDb(root, {
    projectId: `id-${name}`,
    projectName: options.projectName ?? name,
    slug: options.slug ?? name,
    owner: options.owner === undefined ? 'derek' : options.owner,
    rbookAddress: options.address ?? '',
  });
  (await ProjectGraphRegistry.create()).registerStore(root);
  return root;
}

const update = (root: string, fieldUpdates: Array<{ path: string; value: unknown }>) =>
  rbookContextUpdateProjectIdentity({ projectRoot: root, fieldUpdates });

const REASONS: Record<string, RegExp> = {
  'a dotted slug': /not a dashboard slug/,
  'upper case and an underscore': /not a dashboard slug/,
  'an upper-case scheme': /scheme in lower case/,
  'a padded value': /spaces around it/,
  'another owner': /not this project's owner/,
  'a third segment': /is not rbook:\/\/<owner>\/<project>/,
  'a value that is not a string': /is a string/,
};

describe('identity updates refuse an address that would break lookups (R, row 9)', () => {
  // At 7d7a3c28 each of these succeeded: the dotted address was stored and then every rbook:// lookup
  // on the machine refused ("unreadable registered identity could hide a duplicate").
  it.each([
    ['a dotted slug', 'rbook://derek/reasonbook.pro'],
    ['upper case and an underscore', 'rbook://derek/Reasonbook_Pro'],
    ['an upper-case scheme', 'RBOOK://derek/reasonbook-pro'],
    ['a padded value', ' rbook://derek/reasonbook-pro '],
    ['another owner', 'rbook://someone-else/reasonbook-pro'],
    ['a third segment', 'rbook://derek/reasonbook-pro/extra'],
    ['a value that is not a string', { owner: 'derek' }],
  ])('refuses %s and writes none of the call fields', async (_case, value) => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const before = storedIdentity(root);
    const result = await update(root, [
      { path: 'description', value: 'written only if the whole call is' },
      { path: 'rbook_address', value },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PARAMETER');
    expect(result.error?.field).toBe('rbook_address');
    expect(result.error?.suggestion).toMatch(/rbook:\/\/derek\//);
    // Each refusal names its own reason, so the remedy is the right one.
    expect(result.error?.message).toMatch(REASONS[_case]);
    expect(storedIdentity(root)).toEqual(before);
  });

  // With a value that passes the rule, only the path check stands between the call and an address
  // stored as an object, which the reader rejects, refusing every lookup on the machine.
  it('refuses a two-level rbook_address path, which would store an object', async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const before = storedIdentity(root);
    const result = await update(root, [
      { path: 'rbook_address.x', value: 'rbook://derek/alpha-two' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.field).toBe('rbook_address.x');
    expect(result.error?.message).toMatch(/one value/);
    expect(storedIdentity(root)).toEqual(before);
  });

  // At 7d7a3c28 this answered success with fieldsUpdated ["cmos_address"] and changed nothing.
  it('refuses the cmos_address path, naming rbook_address', async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const before = storedIdentity(root);
    for (const fieldPath of ['cmos_address', 'cmos_address.x']) {
      const result = await update(root, [{ path: fieldPath, value: 'cmos://derek/beta' }]);
      expect(result.success).toBe(false);
      expect(result.error?.message).toMatch(/rbook_address/);
    }
    expect(storedIdentity(root)).toEqual(before);
  });

  it('takes a lower-case address of this owner, in either scheme', async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    for (const value of ['rbook://derek/alpha-two', 'cmos://derek/alpha-three']) {
      const result = await update(root, [{ path: 'rbook_address', value }]);
      expect(result.success).toBe(true);
    }
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('cmos://derek/alpha-three');
  });

  it('with no owner known, takes an owner segment in the username grammar only', async () => {
    const root = await store('alpha', { owner: null });
    expect(
      (await update(root, [{ path: 'rbook_address', value: 'rbook://Bad_Owner/x' }])).success
    ).toBe(false);
    expect(
      (await update(root, [{ path: 'rbook_address', value: 'rbook://alice/x' }])).success
    ).toBe(true);
  });

  it('refuses through the dispatcher too', async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const answer = await call('rbook_context', {
      action: 'update',
      contextType: 'project_identity',
      projectRoot: root,
      fieldUpdates: [{ path: 'rbook_address', value: 'rbook://derek/reasonbook.pro' }],
    });
    expect(answer.success).toBe(false);
    expect(answer.error?.code).toBe('INVALID_PARAMETER');
  });
});

describe('an address another registered store holds is refused (critic A2, N3; A3, NB2)', () => {
  it('names the store that holds it', async () => {
    const holder = await store('holder', { address: 'rbook://derek/widget' });
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const result = await update(root, [{ path: 'rbook_address', value: 'cmos://derek/widget' }]);
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain(holder);
  });

  it('skips a store it cannot read, with a warning naming it, and still refuses a readable holder', async () => {
    const holder = await store('holder', { address: 'rbook://derek/widget' });
    const moving = await store('moving', { address: 'rbook://derek/gadget' });
    fs.writeFileSync(path.join(moving, '.rbook-migration.json'), '{}');
    const root = await store('alpha', { address: 'rbook://derek/alpha' });

    const taken = await update(root, [{ path: 'rbook_address', value: 'rbook://derek/widget' }]);
    expect(taken.success).toBe(false);
    expect(taken.error?.message).toContain(holder);

    // Refusing on an unreadable store would make every seed and heal on the machine write ''.
    const free = await update(root, [{ path: 'rbook_address', value: 'rbook://derek/gadget' }]);
    expect(free.success).toBe(true);
    expect(free.warnings).toContainEqual(expect.stringContaining(moving));
  });

  // Critic round 1 (a note): a user-set address (Sprint 65 m02) that predates the rule, re-sent with
  // another field, sets nothing new, so the call is not refused as a whole.
  it('takes a call that re-sends the address the store already holds', async () => {
    const root = await store('fork', { address: 'rbook://acme/widget-fork' });
    const result = await update(root, [
      { path: 'description', value: 'A fork.' },
      { path: 'rbook_address', value: 'rbook://acme/widget-fork' },
    ]);
    expect(result.success).toBe(true);
    expect(storedIdentity(root)?.description).toBe('A fork.');
  });

  // m03's re-run of a half-done rename checks the address the store already holds; only the skip of
  // the store's own registry row keeps that from reading as another store's.
  // Critic round 2, V1: a re-send after another rbook_address entry in the same call is judged against
  // the address the store will hold then, so the call is refused before its first write.
  it('refuses a re-send that follows another address entry, writing none of the call fields', async () => {
    const root = await store('fork', { address: 'rbook://acme/widget-fork' });
    const before = storedIdentity(root);
    const result = await update(root, [
      { path: 'description', value: 'changed' },
      { path: 'rbook_address', value: 'rbook://derek/fork-two' },
      { path: 'rbook_address', value: 'rbook://acme/widget-fork' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/widget-fork/);
    expect(storedIdentity(root)).toEqual(before);
  });

  it("never counts the store's own registry row as another store holding the address", async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    expect(checkAddressWrite(dbOf(root), 'rbook://derek/alpha', 'derek')).toEqual({ warnings: [] });
    const other = await store('beta', { address: 'rbook://derek/beta' });
    expect(checkAddressWrite(dbOf(other), 'rbook://derek/alpha', 'derek').refused).toContain(root);
  });

  it("keeps this store's own address writable", async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    expect(
      (await update(root, [{ path: 'rbook_address', value: 'rbook://derek/alpha' }])).success
    ).toBe(true);
  });
});

describe('the other two places that set an address keep to the rule', () => {
  async function opened<T>(root: string, use: (client: RbookDatabaseClient) => T): Promise<T> {
    const result = await RbookDatabaseClient.create({ dbPath: dbOf(root) });
    if (!result.success || !result.data) throw new Error(result.error?.message);
    try {
      return use(result.data);
    } finally {
      result.data.close();
    }
  }

  it('patchProjectIdentity keeps the current address and writes the other fields, saying why', async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const warnings: string[] = [];
    const written = await opened(root, (client) =>
      patchProjectIdentity(
        client,
        { rbook_address: 'rbook://derek/alpha.two', description: 'kept' },
        warnings
      )
    );
    expect(written).toBe(true);
    // The same address, re-serialized in its storage scheme.
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('cmos://derek/alpha');
    expect(storedIdentity(root)?.description).toBe('kept');
    expect(warnings).toContainEqual(
      expect.stringMatching(/rbook:\/\/derek\/alpha\.two was not stored/)
    );
  });

  // pin-scope-gate.test.ts: a pin-only read never opens another project's store, so the identity a
  // read derives for a store with no row skips the duplicate check; the write that stores it checks.
  it("a read of a store with no identity row opens no other project's store; storing it does", async () => {
    await store('holder', { address: 'rbook://derek/widget' });
    const root = await store('widget', { slug: 'widget' });
    sql(root, "DELETE FROM contexts WHERE id = 'project_identity'");
    const reads = jest.spyOn(projectAddress, 'readStoredProjectAddress');
    try {
      const derived = await opened(root, (client) => readProjectIdentity(client));
      expect(derived?.rbook_address).toBe('rbook://derek/widget');
      expect(reads).not.toHaveBeenCalled();
      // Critic round 4, X1: the dispatcher's sender resolution on a read (heal: false) derives the
      // same way, so it opens no other store either.
      await validateProject(root, { heal: false });
      expect(reads).not.toHaveBeenCalled();
      const seeded = await opened(root, (client) => ensureProjectIdentityRow(client));
      expect(reads).toHaveBeenCalled();
      expect(seeded.warnings).toContainEqual(expect.stringMatching(/already holds it/));
      expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('');
    } finally {
      reads.mockRestore();
    }
  });

  // Critic round 3, W1: whoami's preview predicts what the send will store, so for a store with no
  // row whose address another store holds, the preview and the send agree that the send fails closed.
  it('the preview and the send agree on a store with no row whose address is taken', async () => {
    await store('holder', { address: 'rbook://derek/widget' });
    const root = await store('widget', { slug: 'widget' });
    sql(root, "DELETE FROM contexts WHERE id = 'project_identity'");
    sql(
      root,
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', '0f5f04b2-7e66-4390-a492-c2f5f8f1757f')"
    );
    const preview = await validateProject(root, { heal: 'preview' });
    expect(storedIdentity(root)).toBeUndefined();
    const send = await validateProject(root, { heal: true });
    expect(preview.hasValidSenderIdentity).toBe(false);
    expect(send.hasValidSenderIdentity).toBe(false);
    expect(preview.rejectReason).toBe(send.rejectReason);
    expect(preview.rejectReason).toMatch(/already holds it/);
  });

  // Only a stored address counts as already held: a store with no row has only the identity a read
  // derives, never checked as taken, so re-sending it is checked, and a refused call writes nothing.
  it("checks a re-sent address that only an unstored identity carries, writing none of the call's fields", async () => {
    await store('holder', { address: 'rbook://derek/widget' });
    const root = await store('widget', { slug: 'widget' });
    sql(root, "DELETE FROM contexts WHERE id = 'project_identity'");
    const result = await update(root, [
      { path: 'description', value: 'written only if the whole call is' },
      { path: 'rbook_address', value: 'rbook://derek/widget' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.message).toMatch(/already holds it/);
    expect(storedIdentity(root)?.description ?? '').not.toBe('written only if the whole call is');
  });

  // Critic A2, N1: whoami reports the heal preview, so it must never predict an address the heal
  // would refuse.
  it('the heal preview predicts no address the rule refuses, and says why', async () => {
    const root = await store('dotted', {
      address: '',
      slug: 'placeholder',
      projectName: 'aquex.ai',
    });
    sql(root, "DELETE FROM metadata WHERE key = 'dashboard_slug'");
    const preview = await opened(root, (client) => previewUnknownRbookAddressHeal(client));
    expect(preview.next).toBeNull();
    expect(preview.refused).toMatch(/rbook:\/\/derek\/aquex\.ai/);
  });

  it("a send's identity check heals nothing the rule refuses, and its reason says why", async () => {
    const root = await store('dotted', {
      address: '',
      slug: 'placeholder',
      projectName: 'aquex.ai',
    });
    sql(root, "DELETE FROM metadata WHERE key = 'dashboard_slug'");
    sql(
      root,
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('dashboard_project_id', '0f5f04b2-7e66-4390-a492-c2f5f8f1757f')"
    );
    for (const heal of [true, 'preview'] as const) {
      const result = await validateProject(root, { heal });
      expect(result.hasValidSenderIdentity).toBe(false);
      expect(result.healed).toBeUndefined();
      expect(result.rejectReason).toMatch(/rbook:\/\/derek\/aquex\.ai was not stored/);
    }
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('');
  });
});

describe('regression guards: writes 4.11.0 accepts that store nothing wrong (critic A1, B1)', () => {
  it("a store shaped like cmos-handoff-demo's (no owner, address '') takes a description update", async () => {
    const root = await store('handoff', { owner: null, address: '' });
    const result = await update(root, [{ path: 'description', value: 'A handoff demo.' }]);
    expect(result.success).toBe(true);
    expect(storedIdentity(root)?.description).toBe('A handoff demo.');
  });

  it("the empty address stays writable, as a member's copy and an unknown owner keep it", async () => {
    const root = await store('alpha', { address: 'rbook://derek/alpha' });
    const result = await update(root, [{ path: 'rbook_address', value: '' }]);
    expect(result.success).toBe(true);
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('');
  });

  // A member's copy changes no identity itself (only the owner's copy does); it takes the owner's
  // identity update at a sync, through record-settle's writer, and keeps its own address ''.
  it("a member's copy takes an update", async () => {
    const owner = await ownerCopy(tmp);
    const member = await joinedCopy(tmp, owner, 'Darryl');
    useMachine(tmp, owner.machine);
    const answer = await call('rbook_context', {
      action: 'update',
      contextType: 'project_identity',
      projectRoot: owner.root,
      fieldUpdates: [{ path: 'description', value: 'Changed on the owner copy.' }],
    });
    expect(answer.error).toBeUndefined();
    await exchange(tmp, owner, member);
    expect(storedIdentity(member.root)?.description).toBe('Changed on the owner copy.');
    expect(storedIdentity(member.root)?.[LEGACY.identityAddressKey]).toBe('');
  });

  function unseeded(name: string, keys: Record<string, string | null>): string {
    const root = path.join(tmp, name);
    seedRbookDb(root, { projectId: `id-${name}`, projectName: name, owner: null });
    sql(root, "DELETE FROM contexts WHERE id = 'project_identity'");
    for (const [key, value] of Object.entries(keys))
      if (value === null) sql(root, 'DELETE FROM metadata WHERE key = ?', key);
      else sql(root, 'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', key, value);
    return root;
  }

  it("a seed with an unknown owner stores ''", async () => {
    const root = unseeded('nobody', {});
    const view = await rbookContextViewProjectIdentity({ projectRoot: root });
    expect(view.success).toBe(true);
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('');
  });

  it('a store with only dashboard_username seeds rbook://<it>/<slug>', async () => {
    const root = unseeded('widget', { dashboard_username: 'alice', dashboard_slug: 'widget' });
    const view = await rbookContextViewProjectIdentity({ projectRoot: root });
    expect(view.data?.projectIdentity.rbook_address).toBe('rbook://alice/widget');
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('cmos://alice/widget');
  });

  // The seed's own fix: at 7d7a3c28 a dotted name with no stored slug seeded rbook://derek/aquex.ai.
  it("a seed whose address would break lookups stores '' and says why", async () => {
    const root = unseeded('dotted', {
      owner: 'derek',
      dashboard_slug: null,
      project_name: 'aquex.ai',
    });
    const view = await rbookContextViewProjectIdentity({ projectRoot: root });
    expect(view.success).toBe(true);
    expect(storedIdentity(root)?.[LEGACY.identityAddressKey]).toBe('');
    expect(view.warnings).toContainEqual(expect.stringMatching(/rbook:\/\/derek\/aquex\.ai/));
  });
});

describe("a renamed project's old address is refused, naming the new one (R, task 4)", () => {
  async function renamed(name: string, address: string, previous: unknown): Promise<string> {
    const root = await store(name, { address });
    sql(
      root,
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('previous_rbook_addresses', ?)",
      typeof previous === 'string' ? previous : JSON.stringify(previous)
    );
    return root;
  }

  // At 7d7a3c28 it said only "0 matching active registered stores".
  it('names the current address, through the lookup and through the dispatcher', async () => {
    await renamed('pro', 'rbook://derek/reasonbook-pro', ['cmos://derek/cmos-mcp-pro']);
    const registry = await ProjectGraphRegistry.create();
    const lookup = resolveRegisteredAddress('rbook://derek/cmos-mcp-pro', registry);
    expect('error' in lookup && lookup.error).toMatch(/rbook:\/\/derek\/reasonbook-pro/);
    const answer = await call('rbook_review', { projectRoot: 'rbook://derek/cmos-mcp-pro' });
    expect(answer.success).toBe(false);
    expect(answer.error?.message).toMatch(/rbook:\/\/derek\/reasonbook-pro/);
  });

  it('names both when two stores list the same previous address', async () => {
    await renamed('one', 'rbook://derek/one', ['rbook://derek/old']);
    await renamed('two', 'rbook://derek/two', ['rbook://derek/old']);
    const lookup = resolveRegisteredAddress(
      'rbook://derek/old',
      await ProjectGraphRegistry.create()
    );
    expect('error' in lookup && lookup.error).toMatch(/rbook:\/\/derek\/one/);
    expect('error' in lookup && lookup.error).toMatch(/rbook:\/\/derek\/two/);
  });

  it('skips a malformed list with a note, never counting it an unreadable identity', async () => {
    const broken = await renamed('broken', 'rbook://derek/broken', '{not json');
    await renamed('pro', 'rbook://derek/reasonbook-pro', ['rbook://derek/cmos-mcp-pro']);
    const registry = await ProjectGraphRegistry.create();
    const old = resolveRegisteredAddress('rbook://derek/cmos-mcp-pro', registry);
    expect('error' in old && old.error).toMatch(/rbook:\/\/derek\/reasonbook-pro/);
    expect('error' in old && old.error).toContain(broken);
    // An exact address still resolves while the malformed list sits there.
    expect(resolveRegisteredAddress('rbook://derek/broken', registry)).toEqual({
      projectRoot: broken,
    });
  });

  it('an exact address wins over a previous one', async () => {
    const current = await store('current', { address: 'rbook://derek/shared-name' });
    await renamed('pro', 'rbook://derek/reasonbook-pro', ['rbook://derek/shared-name']);
    expect(
      resolveRegisteredAddress('rbook://derek/shared-name', await ProjectGraphRegistry.create())
    ).toEqual({ projectRoot: current });
  });
});
