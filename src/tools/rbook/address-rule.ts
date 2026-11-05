// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s110-m01 — the rule an address a write sets must meet, so no stored address refuses every lookup.
// ABOUTME: The empty address stays writable; only an address a readable registered store holds counts as taken.

import * as path from 'path';
import { normalizeAddressScheme } from '../../intelligence/legacy-compat';
import { readStoredProjectAddress } from '../../intelligence/project-address';
import { ProjectGraphRegistry } from '../../intelligence/project-graph-registry';
import { listRegisteredStoresReadOnly } from '../../intelligence/registered-stores-readonly';

/** The dashboard's slug grammar (routes/projects.ts:951 in its source); its usernames share it. */
export const SLUG_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The two lower-case schemes and two segments; `normalizeAddressScheme` is case-sensitive. */
const ADDRESS_FORM = /^(?:rbook|cmos):\/\/([^/]*)\/([^/]*)$/;

export interface AddressVerdict {
  /** Why the address may not be written; absent when it may. */
  readonly refused?: string;
  /** Registered stores the duplicate check could not read, each named. */
  readonly warnings: readonly string[];
}

/**
 * Whether a write may set `address` on the store at `storeDbPath`, whose owner is `owner`
 * (resolveLocalOwner's: metadata.owner, else dashboard_username). Applied only to an address a call
 * sets, never to an identity a writer re-serializes (critic A1, B1):
 * - `''` is always writable: the seed stores it while the owner is unknown, and a member's copy keeps it;
 * - otherwise `rbook://` or `cmos://` in lower case, nothing around it, and two segments: the owner,
 *   which equals `owner` (or, with no owner known, fits the username grammar), and a slug in the
 *   dashboard's grammar, which the local reader's looser pattern also reads;
 * - and not another active registered store's address, since two stores holding one address refuse
 *   every lookup of it. A store whose identity cannot be read is skipped with a warning naming it:
 *   refusing on it would make every seed and heal on the machine write '' (critic A3, NB2).
 */
export function checkAddressWrite(
  storeDbPath: string,
  address: unknown,
  owner: string | null,
  /**
   * False only for the identity a read derives in memory, which stores nothing: a pin-only read never
   * opens another project's store (pin-scope-gate.test.ts), so the duplicate check runs on writes and
   * on the heal preview whoami reports.
   */
  options: { readonly checkTaken: boolean } = { checkTaken: true }
): AddressVerdict {
  if (address === '') return { warnings: [] };
  const refuse = (why: string): AddressVerdict => ({ refused: why, warnings: [] });
  if (typeof address !== 'string') return refuse(`an address is a string, not ${typeof address}`);
  if (address !== address.trim()) return refuse('it has spaces around it');
  const form = ADDRESS_FORM.exec(address);
  if (!form) return refuse('it is not rbook://<owner>/<project>, with the scheme in lower case');
  const [, ownerSegment, slug] = form;
  if (!SLUG_GRAMMAR.test(slug))
    return refuse(
      `its project part '${slug}' is not a dashboard slug: lower-case letters and digits, with single hyphens between them`
    );
  if (owner !== null && ownerSegment !== owner)
    return refuse(`its owner part '${ownerSegment}' is not this project's owner, '${owner}'`);
  if (owner === null && !SLUG_GRAMMAR.test(ownerSegment))
    return refuse(
      `its owner part '${ownerSegment}' is not a dashboard username: lower-case letters and digits, with single hyphens between them`
    );
  return options.checkTaken
    ? duplicateVerdict(storeDbPath, normalizeAddressScheme(address))
    : { warnings: [] };
}

/** The registered store, other than this one, that holds `address`, read without writing any. */
function duplicateVerdict(storeDbPath: string, address: string): AddressVerdict {
  const warnings: string[] = [];
  const ownRoot = path.resolve(storeDbPath, '..', '..', '..');
  let rows: ReturnType<typeof listRegisteredStoresReadOnly>;
  try {
    rows = listRegisteredStoresReadOnly();
  } catch (error) {
    return {
      warnings: [
        `The registered projects could not be listed (${error instanceof Error ? error.message : String(error)}), so no check was made that another project already holds ${address}.`,
      ],
    };
  }
  for (const row of rows) {
    if (ProjectGraphRegistry.isSameFolder(row.store_path, ownRoot)) continue;
    const stored = readStoredProjectAddress(row.store_path);
    if (!stored.identity)
      warnings.push(
        `The address of the registered project at ${row.store_path} could not be read (${stored.error}), so the check that no other project holds ${address} skipped it.`
      );
    else if (stored.identity.address === address)
      return {
        refused: `the registered project at ${row.store_path} already holds it, and two projects with one address make every lookup of it fail`,
        warnings,
      };
  }
  return { warnings };
}

/**
 * s110-m01: the previous-address list a rename writes (m03), validated on write: a JSON array of
 * addresses, stored in rbook:// form, each in the dashboard's grammar, none twice, and never the
 * current address, so a lookup of the current address can never be refused as an old one.
 */
export function checkPreviousAddresses(
  list: unknown,
  current: string
): { readonly addresses: readonly string[] } | { readonly refused: string } {
  if (!Array.isArray(list)) return { refused: 'the previous addresses are not a list' };
  const own = normalizeAddressScheme(current);
  const addresses: string[] = [];
  for (const entry of list as unknown[]) {
    const form = typeof entry === 'string' ? ADDRESS_FORM.exec(entry) : null;
    if (!form || !SLUG_GRAMMAR.test(form[1]) || !SLUG_GRAMMAR.test(form[2]))
      return { refused: `${JSON.stringify(entry)} is not an rbook://<owner>/<project> address` };
    const address = normalizeAddressScheme(entry as string);
    if (address === own) return { refused: `${address} is the current address` };
    if (addresses.includes(address)) return { refused: `${address} is listed twice` };
    addresses.push(address);
  }
  return { addresses };
}
