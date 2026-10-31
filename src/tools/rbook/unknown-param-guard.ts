// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Boundary refusal for a top-level parameter the tool's published schema does not declare.
// ABOUTME: Names the nested wrapper the key belongs under when the tool publishes one.

import { RBOOK_ACTION_PARAMS } from './action-params';
import { RBOOK_ERROR_CODES } from './errors';
import type { RbookToolError } from './types';

/**
 * s91-m02 — every published tool schema declares `additionalProperties: false`, and until this
 * guard nothing enforced it: `src/index.ts` spreads every wire key into the router params, so a
 * misplaced key was dropped silently and the call reported success without it (reported defect 3).
 * A refusal, not a warning: a warning on a successful call is read as success (the s86 lesson).
 *
 * Scope: the TOP LEVEL of all fifteen tools. Keys inside `fields` are refused by the two update
 * handlers; `arrayUpdates`/`fieldUpdates` already refuse by name; `domainFields` is a free record
 * by design; `evidence` entries and `initialSprint`/`initialMissions` are not enforced here.
 */

interface SchemaPropertyLike {
  readonly type?: unknown;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly items?: { readonly properties?: Readonly<Record<string, unknown>> };
}

interface ToolSchemaLike {
  readonly properties?: Readonly<Record<string, SchemaPropertyLike | undefined>>;
}

/** Where a misplaced key actually belongs: a nested object property, or each entry of an array. */
function findWrapper(
  properties: Readonly<Record<string, SchemaPropertyLike | undefined>>,
  key: string
): { name: string; kind: 'object' | 'array' } | null {
  for (const [name, property] of Object.entries(properties)) {
    if (property?.properties && key in property.properties) return { name, kind: 'object' };
    if (property?.items?.properties && key in property.items.properties) {
      return { name, kind: 'array' };
    }
  }
  return null;
}

/**
 * The first provided top-level key that the tool's published schema does not declare, as a
 * refusal — or `null` when every key is declared. Provided-key order is preserved so the same
 * request always names the same key.
 */
export function findUnknownTopLevelParam(
  toolName: string,
  inputSchema: unknown,
  params: unknown
): RbookToolError | null {
  const properties = (inputSchema as ToolSchemaLike | undefined)?.properties;
  if (!properties || typeof params !== 'object' || params === null) return null;

  const unknownKey = Object.keys(params).find(
    (key) => !Object.prototype.hasOwnProperty.call(properties, key)
  );
  if (unknownKey === undefined) return null;

  const wrapper = findWrapper(properties, unknownKey);
  const actions = wrapper
    ? Object.entries(RBOOK_ACTION_PARAMS[toolName] ?? {})
        .filter(([, applicable]) => applicable.includes(wrapper.name))
        .map(([action]) => action)
    : [];
  const actionClause = actions.length > 0 ? `for action=${actions.join('|')} ` : '';
  const placement =
    wrapper?.kind === 'array'
      ? `inside each \`${wrapper.name}\` entry`
      : `under \`${wrapper?.name ?? ''}\``;
  // s106-m02: "remove it" drops what the agent meant, such as context's `limit` for `searchLimit`.
  // The rule: published parameters whose names end with the unknown key, case-insensitive, all of
  // them when several match, and only those the call's action uses (the applicability contract).
  // An empty key would match every name, so it suggests none.
  const action = (params as Record<string, unknown>).action;
  const map = RBOOK_ACTION_PARAMS[toolName];
  const used =
    typeof action === 'string' && map && Object.prototype.hasOwnProperty.call(map, action)
      ? map[action]
      : undefined;
  const meant =
    unknownKey === ''
      ? []
      : Object.keys(properties).filter(
          (name) =>
            name.toLowerCase().endsWith(unknownKey.toLowerCase()) &&
            (used === undefined || used.includes(name))
        );
  const didYouMean =
    meant.length === 0
      ? ''
      : ` Did you mean ${meant
          .map((name) => `\`${name}\``)
          .join(', ')
          .replace(/, ([^,]*)$/, ' or $1')}? If not, remove it.`;

  return {
    code: RBOOK_ERROR_CODES.INVALID_PARAMETER,
    message: `Unknown parameter '${unknownKey}' for ${toolName}`,
    field: unknownKey,
    providedValue: (params as Record<string, unknown>)[unknownKey],
    validValues: Object.keys(properties),
    suggestion: wrapper
      ? `\`${unknownKey}\` is not a top-level parameter of ${toolName}; ${actionClause}it belongs ${placement}.`
      : didYouMean
        ? `\`${unknownKey}\` is not a parameter of ${toolName}.${didYouMean} The published parameters are listed in validValues.`
        : `\`${unknownKey}\` is not a parameter of ${toolName}; remove it. The published parameters are listed in validValues.`,
  };
}
