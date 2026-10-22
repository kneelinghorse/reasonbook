// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Enumerates the published dispatch constraints with the sprint-98 predicate's counting rule.
// ABOUTME: Builds a single violating JSON call per constraint without a hand-maintained tool list.

import { RBOOK_TOOL_DEFINITIONS } from '../../src/tools/rbook';
import { RBOOK_ACTION_PARAMS } from '../../src/tools/rbook/action-params';
import { toWireDefinition } from '../../src/tools/rbook/wire-definition';

export interface SchemaNode {
  type?: string | readonly string[];
  enum?: readonly unknown[];
  required?: readonly string[];
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  additionalProperties?: boolean;
  description?: string;
  [key: string]: unknown;
}

export interface DispatchConstraint {
  tool: string;
  param: string;
  path: string;
  kind: string;
  value: unknown;
  node: SchemaNode;
  root: SchemaNode;
}

const bounds = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;

/** Same (tool, JSON pointer, keyword) predicate as the retained plan-time predicate.js. */
export function dispatchConstraints(): DispatchConstraint[] {
  const rows: DispatchConstraint[] = [];
  for (const full of RBOOK_TOOL_DEFINITIONS) {
    const root = toWireDefinition(full).inputSchema as unknown as SchemaNode;
    const tool = full.name;
    const add = (param: string, path: string, kind: string, value: unknown, node: SchemaNode) =>
      rows.push({ tool, param, path, kind, value, node, root });
    const walk = (param: string, node: SchemaNode, pointer: string, isRoot: boolean): void => {
      if (node.enum && !(isRoot && param === 'action'))
        add(param, pointer, 'enum', node.enum, node);
      if (isRoot && node.type === 'integer') add(param, pointer, 'integer', node.type, node);
      if (!isRoot && node.type !== undefined) add(param, pointer, 'nested-type', node.type, node);
      for (const key of bounds)
        if (node[key] !== undefined) add(param, pointer, key, node[key], node);
      for (const key of node.required ?? []) add(param, pointer, 'nested-required', key, node);
      if (node.additionalProperties === false) add(param, pointer, 'nested-closed', false, node);
      if (node.items) walk(param, node.items, `${pointer}/items`, false);
      for (const [key, child] of Object.entries(node.properties ?? {}))
        walk(param, child, `${pointer}/properties/${key}`, false);
    };
    for (const key of root.required ?? [])
      if (key !== 'action') add(key, `/required/${key}`, 'required', true, root);
    for (const [param, node] of Object.entries(root.properties ?? {})) {
      walk(param, node, `/${param}`, true);
      const fullRoot = full.inputSchema as unknown as SchemaNode;
      const text = [fullRoot.properties?.[param]?.description ?? '', node.description ?? ''].join(
        ' | '
      );
      if (/\b(required|requires|needs)\b/i.test(text))
        add(param, `/${param}#description`, 'desc-required', text, node);
      const bound = text.match(/\b(?:max|at most)\s+(\d+)/i);
      if (
        bound &&
        Number(node.maximum) !== Number(bound[1]) &&
        Number(node.maxItems) !== Number(bound[1])
      )
        add(param, `/${param}#description`, 'desc-bound', text, node);
    }
  }
  return rows;
}

export const constraintKey = (row: DispatchConstraint): string =>
  `${row.tool} ${row.path} ${row.kind}${row.kind === 'nested-required' ? `:${String(row.value)}` : ''}`;

function sample(node: SchemaNode): unknown {
  if (node.enum) return node.enum[0];
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case 'object':
      return Object.fromEntries(
        (node.required ?? []).map((key) => [key, sample(node.properties![key])])
      );
    case 'array':
      return Array.from({ length: Math.max(1, Number(node.minItems ?? 0)) }, () =>
        sample(node.items ?? {})
      );
    case 'integer':
    case 'number':
      return Number(node.minimum ?? 1);
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return 'x'.repeat(Math.max(1, Number(node.minLength ?? 0)));
  }
}

function valuePath(pointer: string): (string | number)[] {
  return pointer
    .split('/')
    .slice(1)
    .filter((part) => part !== 'properties')
    .map((part) => (part === 'items' ? 0 : part));
}

/** Undefined means this row admits every JSON type, so no malformed JSON specimen exists. */
export function violatingCall(row: DispatchConstraint): Record<string, unknown> | undefined {
  if (row.kind.startsWith('desc-'))
    throw new Error('Description promises use their action-specific handler cases.');
  const args = sample(row.root) as Record<string, unknown>;
  const map = RBOOK_ACTION_PARAMS[row.tool as keyof typeof RBOOK_ACTION_PARAMS] as
    | Record<string, readonly string[]>
    | undefined;
  if (row.root.properties?.action) {
    args.action =
      Object.entries(map ?? {}).find(([, keys]) => keys.includes(row.param))?.[0] ??
      row.root.properties.action.enum![0];
  }
  if (row.kind === 'required') {
    delete args[row.param];
    return args;
  }
  const parts = valuePath(row.path);
  let target = args;
  let node = row.root;
  for (const part of parts.slice(0, -1)) {
    node = typeof part === 'number' ? node.items! : node.properties![part];
    if (target[part] === undefined) target[part] = sample(node);
    target = target[part] as Record<string, unknown>;
  }
  const key = parts[parts.length - 1];
  let invalid: unknown;
  switch (row.kind) {
    case 'integer':
      invalid = 1.5;
      break;
    case 'minimum':
      invalid = Number(row.value) - 1;
      break;
    case 'maximum':
      invalid = Number(row.value) + 1;
      break;
    case 'minLength':
      invalid = 'x'.repeat(Math.max(0, Number(row.value) - 1));
      break;
    case 'maxLength':
      invalid = 'x'.repeat(Number(row.value) + 1);
      break;
    case 'minItems':
      invalid = Array.from({ length: Math.max(0, Number(row.value) - 1) }, () =>
        sample(row.node.items!)
      );
      break;
    case 'maxItems':
      invalid = Array.from({ length: Number(row.value) + 1 }, () => sample(row.node.items!));
      break;
    case 'enum':
      invalid = '__not_a_declared_value__';
      break;
    case 'nested-closed':
      invalid = { ...(sample(row.node) as object), __undeclared: true };
      break;
    case 'nested-required': {
      invalid = sample(row.node);
      delete (invalid as Record<string, unknown>)[String(row.value)];
      break;
    }
    case 'nested-type': {
      const types = Array.isArray(row.value) ? row.value : [row.value];
      const specimens: Record<string, unknown> = {
        string: 'wrong',
        number: 1.5,
        boolean: true,
        object: {},
        array: [],
        null: null,
      };
      const type = Object.keys(specimens).find(
        (candidate) =>
          !types.includes(candidate) && !(candidate === 'number' && types.includes('integer'))
      );
      if (type === undefined) return undefined;
      invalid = specimens[type];
      break;
    }
    default:
      throw new Error(`No violating specimen for ${constraintKey(row)}`);
  }
  target[key] = invalid;
  return args;
}
