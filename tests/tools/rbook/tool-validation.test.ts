// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Pins normalization and error remedies without opening stores or loading the MCP server.
// ABOUTME: Covers all published schema roots and preserves accepted arbitrary JSON and nested keys.

import { z } from 'zod';
import { RBOOK_TOOL_DEFINITIONS } from '../../../src/tools/rbook';
import { RBOOK_TOOL_SCHEMAS } from '../../../src/tools/rbook/tool-schemas';
import { validateRbookArguments } from '../../../src/tools/rbook/tool-validation';

it('requires a schema for every published tool, including every actionless tool', () => {
  expect(Object.keys(RBOOK_TOOL_SCHEMAS).sort()).toEqual(
    RBOOK_TOOL_DEFINITIONS.map((d) => d.name).sort()
  );
});

it('removes every non-nullable top-level null and preserves every legitimate null', () => {
  let omitted = 0;
  const retained: string[] = [];
  for (const [name, schema] of Object.entries(RBOOK_TOOL_SCHEMAS)) {
    for (const [key, node] of Object.entries(schema.shape)) {
      if (key === 'action') continue;
      const args: Record<string, unknown> = { [key]: null };
      if (schema.shape.action) args.action = (schema.shape.action as z.ZodEnum).options[0];
      if (name === 'rbook_mission_transition' && key !== 'missionId') args.missionId = 'm';
      const result = validateRbookArguments(schema, args);
      if ((node as z.ZodType).safeParse(null).success) {
        expect(result.success).toBe(true);
        expect(result.data![key]).toBeNull();
        retained.push(`${name}.${key}`);
      } else {
        if (key === 'missionId' && name === 'rbook_mission_transition') {
          expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field: key });
        } else {
          expect(result.success).toBe(true);
          expect(Object.prototype.hasOwnProperty.call(result.data, key)).toBe(false);
        }
        omitted++;
      }
      expect(args[key]).toBeNull();
    }
  }
  expect(omitted).toBeGreaterThan(200);
  expect(retained.sort()).toEqual(['rbook_db.value', 'rbook_mission.sprintId']);
});

it('validates without stripping open nested objects or mutating the caller', () => {
  const args = {
    action: 'update',
    fieldUpdates: [{ path: 'description', value: { nested: null }, extra: 'keep' }],
  };
  const result = validateRbookArguments(RBOOK_TOOL_SCHEMAS.rbook_context, args);
  expect(result.success).toBe(true);
  expect(result.data).toEqual(args);
  expect(result.data!.fieldUpdates).toBe(args.fieldUpdates);
});

it.each([
  ['rbook_db', { action: 'snapshot', maxSnapshots: 0 }, 'maxSnapshots', />0/],
  ['rbook_mission', { action: 'list', limit: 101 }, 'limit', /100/],
  ['rbook_db', { action: 'snapshot', listOnly: 'false' }, 'listOnly', /boolean/],
  ['rbook_mission', { action: 'list', context: 2 }, 'context', /string.*object|object.*string/],
  ['rbook_mission', { action: 'update', fields: { name: null } }, 'fields.name', /string/],
  ['rbook_context', { action: 'update', fieldUpdates: [null] }, 'fieldUpdates.0', /object/],
  ['rbook_context', { action: 'update', unknown: null }, 'unknown', /Unrecognized/],
] as const)('names the expected type or bound for %s', (name, args, field, remedy) => {
  const result = validateRbookArguments(RBOOK_TOOL_SCHEMAS[name], args);
  expect(result.error).toMatchObject({ code: 'INVALID_PARAMETER', field });
  expect(result.error!.suggestion).toMatch(remedy);
});

it.each([null, 1, 'args', []])('refuses non-object argument envelopes: %p', (args) => {
  expect(validateRbookArguments(RBOOK_TOOL_SCHEMAS.rbook_review, args).error).toMatchObject({
    code: 'INVALID_PARAMETER',
    field: 'arguments',
    suggestion: 'Valid values: a JSON object',
  });
});

it('omitted arguments work on actionless tools and enums keep their actual valid values', () => {
  expect(validateRbookArguments(RBOOK_TOOL_SCHEMAS.rbook_review, undefined).data).toEqual({});
  expect(
    validateRbookArguments(RBOOK_TOOL_SCHEMAS.rbook_session, {
      action: 'capture',
      category: 'Learning',
    }).error
  ).toMatchObject({
    field: 'category',
    validValues: ['decision', 'learning', 'constraint', 'context', 'next-step'],
  });
});
