// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m04 Part A — the published JSON inputSchema must state exactly what its zod schema
// ABOUTME: states, including nested bounds, required keys and nulls across all 15 tool schemas.

/**
 * Sprint 86 m04 Part A — "say only what you know", enforced on the PUBLISHED SCHEMA.
 *
 * THE DEFECT CLASS. Every Reasonbook tool states its input contract TWICE — once as a zod schema and once
 * as a JSON inputSchema that ships to npm and reaches every MCP host. Nothing kept the two in step,
 * so the published half drifted into saying things the server does not do.
 *
 * ── MEASURED PRE-FIX RED BASELINE (2026-08-11, by revert-run-restore against a clean worktree of
 *    b4fea88) — 45 violations across 6 legs, 15 tools / 37 numeric declarations / 221 properties:
 *
 *      type             30   a zod `.int()` publishing `number`
 *      array-item-type   3   nextStepIds[], constraintIds[], decisionIds[] — same defect, in items
 *      minimum           4   a `.positive()` publishing no `minimum`
 *      maximum           0   (no live instance — proven to fire by fixture, at the bottom)
 *      enum              3   rbook_decisions.status, rbook_learnings.category, rbook_learnings.status
 *      strict            5   zod/JSON disagreeing on whether unknown keys are accepted
 *      key-set           0   (no live instance — proven to fire by fixture)
 *
 * TWO LEGS MEASURE HIGHER THAN THE BUILD PLAN STATED, and the measured figures govern. The plan
 * said 2 minimums and 3 stricts; both counts were TOP-LEVEL ONLY. The 2 extra minimums are ARRAY
 * ELEMENTS (`rbook_context.nextStepIds[]`, `constraintIds[]`), whose `.positive()` element published
 * no `minimum`; the 2 extra stricts are NESTED OBJECTS (`rbook_project.initialSprint`,
 * `initialMissions[]`), which are `.strict()` in zod while publishing neither their properties nor
 * `additionalProperties`. The nested pair is the mirror image of the three root cases: there zod was
 * open and the JSON closed, here zod is closed and the JSON says nothing. Their fix publishes the
 * sub-shape TRANSCRIBED from the zod schema alongside `additionalProperties: false` — publishing the
 * closedness WITHOUT the keys would have said "no keys are accepted", the same defect inverted.
 *
 * THE ENUM LEG IS THE ONE THAT MATTERS MOST. `rbook_learnings.status` forbade callers from naming
 * `stale` — a value Reasonbook ITSELF writes at staleness-detection.ts:494-499, and which exists in 246
 * rows across 7 of 18 registered stores (measured per-store before any edit). `rbook_decisions` never
 * had this bug, and that asymmetry is the evidence the enum was wrong rather than the data.
 *
 * At the s86 baseline the consolidated schemas were never parsed at runtime. s98-m09 adds whole-
 * schema validation at dispatch, so extra constraints in zod now refuse documented calls. Lengths,
 * item counts, required keys and nullable types therefore join the original parity checks.
 *
 * DERIVED LOCATORS, NO NAME MAP. A tool's zod schema is resolved from its own name by rule —
 * `rbook_agent_onboard` → `rbook-agent-onboard.ts` → `rbookAgentOnboardSchema` — and a tool whose
 * schema cannot be resolved FAILS LOUDLY. A hand-written tool→schema map would be an allowlist by
 * another spelling: the one tool someone forgot to add would be the one that drifts.
 *
 * ── VACUITY FLOOR ─────────────────────────────────────────────────────────────────────────────
 * A walker that silently stops walking reports zero violations and looks like success. The floor
 * (>=15 tools, >=37 numeric declarations, >=190 properties) fails instead. Modelled on
 * tests/tools/rbook/agent-prompt-tool-names.test.ts.
 *
 * ── FALSE-NEGATIVE PROFILE ────────────────────────────────────────────────────────────────────
 *  1. IT COMPARES DECLARATIONS, NOT BEHAVIOUR. `integer` on both sides says nothing about whether
 *     the handler floors a float before binding it into `LIMIT ?`. It does not (measured).
 *  2. UNWRAPPING IS FINITE. ZodOptional/ZodNullable/ZodDefault/ZodPipe are unwrapped. Input JSON
 *     rendering supplies types and length bounds; unrepresentable nodes render as unconstrained,
 *     so a future exotic wrapper needs a fixture before its inner constraints can be claimed.
 *  3. DECLARED OBJECTS AND ARRAY ITEMS ARE WALKED RECURSIVELY. Object members inside unions and
 *     record-value schemas are not walked; only their declared types and nullability are compared.
 *  4. IT CANNOT SEE A MISSING CONSTRAINT ON BOTH SIDES. If neither side declares a `maximum`, the
 *     gate is green; whether one is warranted is a design question no parity rule can answer.
 *  5. IT COMPARES DECLARED SHAPES, SO AN UNDECLARED SUB-SHAPE IS A KEY-SET FAILURE, NOT A GAP.
 *     Part A briefly exempted nested objects publishing no `properties`; Part B declared the last
 *     one (`rbook_context.arrayUpdates`) and the exemption was deleted rather than left standing —
 *     an exemption nothing reaches is indistinguishable from one that silently starts reaching
 *     something.
 */

import * as path from 'path';
import { z } from 'zod';
import type { $ZodChecks } from 'zod/v4/core';

import { RBOOK_TOOL_DEFINITIONS } from '../../src/tools/rbook/index';

/** One divergence between the two declarations of a single key. */
interface Violation {
  readonly tool: string;
  readonly key: string;
  readonly leg:
    | 'type'
    | 'array-item-type'
    | 'minimum'
    | 'maximum'
    | 'enum'
    | 'strict'
    | 'key-set'
    | 'minLength'
    | 'maxLength'
    | 'minItems'
    | 'maxItems'
    | 'required';
  readonly detail: string;
}

interface JsonProp {
  type?: string | readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: readonly string[];
  anyOf?: readonly JsonProp[];
  enum?: readonly unknown[];
  items?: JsonProp;
  properties?: Record<string, JsonProp>;
  additionalProperties?: boolean;
}

interface JsonSchema {
  properties?: Record<string, JsonProp>;
  additionalProperties?: boolean;
  required?: readonly string[];
}

/** Nullable unions and JSON type arrays state the same input types. */
function inputTypes(json: JsonProp): string[] {
  const types = Array.isArray(json.type) ? json.type : json.type ? [json.type] : [];
  return [...new Set([...types, ...(json.anyOf ?? []).flatMap(inputTypes)])].sort();
}

/**
 * Resolve a tool's ZodObject from its NAME, by rule (build plan CORRECTION 8).
 * `rbook_agent_onboard` → `src/tools/rbook/rbook-agent-onboard.ts` → export `rbookAgentOnboardSchema`.
 */
function resolveSchema(toolName: string): z.ZodObject<Record<string, z.ZodType>> {
  const file = 'rbook-' + toolName.replace(/^rbook_/, '').replace(/_/g, '-');
  const exportName = toolName.replace(/_(\w)/g, (_m, c: string) => c.toUpperCase()) + 'Schema';
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(path.join('../../src/tools/rbook', file)) as Record<string, unknown>;
  const schema = mod[exportName];
  if (!schema || !(schema instanceof z.ZodObject)) {
    throw new Error(
      `schema-parity: cannot resolve a ZodObject for ${toolName} — expected export ` +
        `\`${exportName}\` from src/tools/rbook/${file}.ts. The locator is DERIVED from the tool ` +
        `name on purpose; do not add a name map, fix the naming or the export.`
    );
  }
  return schema as z.ZodObject<Record<string, z.ZodType>>;
}

/** Strip Optional/Nullable/Default/Pipe to the base node. */
function baseOf(node: z.core.$ZodType): z.core.$ZodType {
  let cur = node;
  for (let i = 0; i < 20; i++) {
    if (
      cur instanceof z.ZodOptional ||
      cur instanceof z.ZodNullable ||
      cur instanceof z.ZodDefault
    ) {
      cur = cur.unwrap();
      continue;
    }
    if (cur instanceof z.ZodPipe) {
      cur = cur.in;
      continue;
    }
    return cur;
  }
  return cur;
}

interface NumberFacts {
  readonly isInt: boolean;
  readonly min?: number;
  readonly max?: number;
}

/** Zod 4 stores explicit numeric bounds in documented core checks, separate from int formats. */
function numberFacts(node: z.ZodNumber): NumberFacts {
  const isInt = node.isInt;
  let min: number | undefined;
  let max: number | undefined;
  for (const check of node._zod.def.checks ?? []) {
    const c = (check as $ZodChecks)._zod.def;
    if (c.check === 'greater_than' && typeof c.value === 'number') {
      const effective = c.inclusive === false ? (isInt ? c.value + 1 : c.value) : c.value;
      min = min === undefined ? effective : Math.max(min, effective);
    }
    if (c.check === 'less_than' && typeof c.value === 'number') {
      const effective = c.inclusive === false ? (isInt ? c.value - 1 : c.value) : c.value;
      max = max === undefined ? effective : Math.min(max, effective);
    }
  }
  return { isInt, min, max };
}

interface WalkTotals {
  tools: number;
  numericDeclarations: number;
  properties: number;
}

/** Compare one zod node against one JSON property. Pushes into `violations`. */
function compareNode(
  tool: string,
  key: string,
  zodNode: z.core.$ZodType,
  json: JsonProp,
  violations: Violation[],
  totals: WalkTotals,
  isItem = false
): void {
  const base = baseOf(zodNode);
  const leg = isItem ? 'array-item-type' : 'type';
  const rendered = z.toJSONSchema(zodNode, { io: 'input', unrepresentable: 'any' }) as JsonProp;
  const bounds = z.toJSONSchema(base, { io: 'input', unrepresentable: 'any' }) as JsonProp;
  for (const bound of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (bounds[bound] !== json[bound]) {
      violations.push({
        tool,
        key,
        leg: bound,
        detail: `zod ${bounds[bound]} vs published ${json[bound]}`,
      });
    }
  }

  // Compare the wrapped input before any type-specific return, including nullable numbers.
  const expected = inputTypes(rendered);
  if (expected.length > 0) {
    const published = inputTypes(json);
    if (JSON.stringify(published) !== JSON.stringify(expected)) {
      violations.push({
        tool,
        key,
        leg,
        detail: `zod types [${expected}] vs published [${published}]`,
      });
    }
  }

  if (base instanceof z.ZodNumber) {
    totals.numericDeclarations += 1;
    const facts = numberFacts(base);
    // (ii) minimum parity.
    if (facts.min !== undefined && json.minimum !== facts.min) {
      violations.push({
        tool,
        key,
        leg: 'minimum',
        detail: `zod min ${facts.min} vs published minimum ${json.minimum ?? '(absent)'}`,
      });
    }
    // (iii) maximum parity. Preventive — no live instance, proven red by fixture.
    if (facts.max !== undefined && json.maximum !== facts.max) {
      violations.push({
        tool,
        key,
        leg: 'maximum',
        detail: `zod max ${facts.max} vs published maximum ${json.maximum ?? '(absent)'}`,
      });
    }
    return;
  }

  // (iv) enum parity, in BOTH directions.
  if (base instanceof z.ZodEnum) {
    const zodValues = [...base.options].sort();
    const jsonValues = [...((json.enum ?? []) as string[])].sort();
    if (json.enum === undefined) {
      violations.push({
        tool,
        key,
        leg: 'enum',
        detail: `zod enum [${zodValues}] but no JSON enum`,
      });
    } else if (JSON.stringify(zodValues) !== JSON.stringify(jsonValues)) {
      violations.push({
        tool,
        key,
        leg: 'enum',
        detail: `zod [${zodValues}] vs published [${jsonValues}]`,
      });
    }
    return;
  }
  if (base instanceof z.ZodString && json.enum !== undefined) {
    violations.push({
      tool,
      key,
      leg: 'enum',
      detail:
        `zod is a plain string but the published schema declares enum [${json.enum}] — an ` +
        `enforcement the server does not perform`,
    });
    return;
  }

  // Recurse into array elements.
  if (base instanceof z.ZodArray) {
    const element = base.element;
    if (json.items) {
      compareNode(tool, `${key}[]`, element, json.items, violations, totals, true);
    }
    return;
  }

  // (v) strict parity on nested objects.
  if (base instanceof z.ZodObject) {
    compareObject(tool, key, base, json, violations, totals);
  }
}

/** (v) + (vi) for one object level: unknown-keys parity and key-set equality. */
function compareObject(
  tool: string,
  prefix: string,
  zodObject: z.ZodObject<Record<string, z.ZodType>>,
  json: JsonSchema,
  violations: Violation[],
  totals: WalkTotals
): void {
  // z.unknown() accepts explicit undefined but its containing object still requires the key.
  const required =
    z.toJSONSchema(zodObject, { io: 'input', unrepresentable: 'any' }).required ?? [];
  const publishedRequired = [...(json.required ?? [])].sort();
  if (JSON.stringify([...required].sort()) !== JSON.stringify(publishedRequired)) {
    violations.push({
      tool,
      key: prefix || '(root)',
      leg: 'required',
      detail: `zod [${required}] vs published [${publishedRequired}]`,
    });
  }
  const strict = zodObject.def.catchall instanceof z.ZodNever;
  const closed = json.additionalProperties === false;
  if (strict !== closed) {
    violations.push({
      tool,
      key: prefix || '(root)',
      leg: 'strict',
      detail: `zod strict=${strict} vs published additionalProperties=${json.additionalProperties}`,
    });
  }

  const shape = zodObject.shape;
  const zodKeys = Object.keys(shape);
  const jsonKeys = Object.keys(json.properties ?? {});

  // (vi) key-set equality, BOTH directions, UNCONDITIONALLY — including nested objects.
  //
  // This was briefly carved out for nested objects publishing no `properties` at all, because
  // Part A could not fix the one remaining instance. Part B removed it: `rbook_context.arrayUpdates`
  // now declares its two real keys, so no such object exists and the carve-out was dead. It is
  // deleted rather than left as a standing exemption — an exemption nothing reaches is
  // indistinguishable from one that silently starts reaching something.
  for (const k of zodKeys) {
    if (!jsonKeys.includes(k)) {
      violations.push({
        tool,
        key: prefix ? `${prefix}.${k}` : k,
        leg: 'key-set',
        detail: 'declared in zod, absent from the published schema',
      });
    }
  }
  for (const k of jsonKeys) {
    if (!zodKeys.includes(k)) {
      violations.push({
        tool,
        key: prefix ? `${prefix}.${k}` : k,
        leg: 'key-set',
        detail: 'published but absent from zod',
      });
    }
  }

  for (const k of zodKeys) {
    const jsonProp = (json.properties ?? {})[k];
    if (!jsonProp) continue;
    totals.properties += 1;
    compareNode(tool, prefix ? `${prefix}.${k}` : k, shape[k], jsonProp, violations, totals);
  }
}

/**
 * Compare ONE synthetic zod/JSON pair. Used only by the fixture tests below, so the `maximum` and
 * `key-set` legs — which have ZERO live instances — are proven to fire rather than assumed to.
 * A leg that is green because the tree happens to contain no violation is indistinguishable from a
 * leg that is green because it never runs.
 */
export function comparePair(
  name: string,
  zodObject: z.ZodObject<Record<string, z.ZodType>>,
  json: JsonSchema
): Violation[] {
  const violations: Violation[] = [];
  const totals: WalkTotals = { tools: 0, numericDeclarations: 0, properties: 0 };
  compareObject(name, '', zodObject, json, violations, totals);
  return violations;
}

function walkAll(): { violations: Violation[]; totals: WalkTotals } {
  const violations: Violation[] = [];
  const totals: WalkTotals = { tools: 0, numericDeclarations: 0, properties: 0 };
  for (const def of RBOOK_TOOL_DEFINITIONS) {
    const schema = resolveSchema(def.name);
    const json = def.inputSchema as unknown as JsonSchema;
    totals.tools += 1;
    compareObject(def.name, '', schema, json, violations, totals);
  }
  return { violations, totals };
}

describe('Zod 4 introspection preserves the guard', () => {
  const numericTypes = [
    ['integer', z.number().int()],
    ['number', z.number()],
  ] as const;

  it.each(numericTypes)('accepts matching nullable %s declarations', (type, node) => {
    expect(
      comparePair('nullable-number', z.object({ value: node.nullable().optional() }), {
        properties: { value: { type: [type, 'null'] } },
      })
    ).toEqual([]);
  });

  it.each(numericTypes)('catches omitted null on a nullable %s declaration', (type, node) => {
    expect(
      comparePair('missing-null', z.object({ value: node.nullable().optional() }), {
        properties: { value: { type } },
      }).map((finding) => finding.leg)
    ).toEqual(['type']);
  });

  it.each(numericTypes)('catches a %s published as a string or nullable number', (type, node) => {
    for (const published of ['string', [type, 'null']]) {
      expect(
        comparePair('wrong-number-type', z.object({ value: node.optional() }), {
          properties: { value: { type: published } },
        }).map((finding) => finding.leg)
      ).toEqual(['type']);
    }
  });

  it.each([
    ['minLength', z.string().min(2), 'string'],
    ['maxLength', z.string().max(2), 'string'],
    ['minItems', z.array(z.string()).min(2), 'array'],
    ['maxItems', z.array(z.string()).max(2), 'array'],
  ] as const)('detects %s omitted, invented or changed on either side', (bound, node, type) => {
    const schema = z.object({ value: node.optional() });
    const property = { type, ...(type === 'array' ? { items: { type: 'string' } } : {}) };
    expect(
      comparePair('green', schema, { properties: { value: { ...property, [bound]: 2 } } })
    ).toEqual([]);
    for (const value of [undefined, 3]) {
      expect(
        comparePair('red', schema, { properties: { value: { ...property, [bound]: value } } }).map(
          (finding) => finding.leg
        )
      ).toContain(bound);
    }
    const unbounded = z.object({
      value: (type === 'array' ? z.array(z.string()) : z.string()).optional(),
    });
    expect(
      comparePair('json-only', unbounded, {
        properties: { value: { ...property, [bound]: 2 } },
      }).map((finding) => finding.leg)
    ).toContain(bound);
  });

  it('checks required unknown keys inside array items without treating undefined as omission', () => {
    const schema = z.object({
      rows: z.array(z.object({ value: z.unknown(), optional: z.string().optional() })).optional(),
    });
    const item = {
      type: 'object',
      properties: { value: {}, optional: { type: 'string' } },
      required: ['value'],
    };
    expect(
      comparePair('green', schema, { properties: { rows: { type: 'array', items: item } } })
    ).toEqual([]);
    for (const required of [[], ['optional', 'value']]) {
      expect(
        comparePair('red', schema, {
          properties: { rows: { type: 'array', items: { ...item, required } } },
        }).map((finding) => `${finding.leg}:${finding.key}`)
      ).toContain('required:rows[]');
    }
  });

  it.each([
    [z.array(z.string()), { type: 'array', items: { type: 'string' } }],
    [z.object({}), { type: 'object', properties: {} }],
    [z.record(z.string(), z.unknown()), { type: 'object' }],
  ] as const)(
    'keeps nullable array and object contracts visible in both directions',
    (node, json) => {
      const nullable = { ...json, type: [json.type, 'null'] };
      expect(
        comparePair('green', z.object({ value: node.nullable().optional() }), {
          properties: { value: nullable },
        })
      ).toEqual([]);
      expect(
        comparePair('missing-null', z.object({ value: node.nullable().optional() }), {
          properties: { value: json },
        }).map((finding) => finding.leg)
      ).toContain('type');
      expect(
        comparePair('extra-null', z.object({ value: node.optional() }), {
          properties: { value: nullable },
        }).map((finding) => finding.leg)
      ).toContain('type');
    }
  );

  it('detects every constraint leg after unwrapping and reading array elements', () => {
    const schema = z
      .object({
        count: z.number().int().positive().max(50).default(1),
        ids: z.array(z.number().int().positive()),
        mode: z.enum(['a', 'b']).optional(),
      })
      .strict();
    const failures = comparePair('mutated', schema, {
      properties: {
        count: { type: 'number' },
        ids: { type: 'array', items: { type: 'number' } },
        mode: { type: 'string', enum: ['a'] },
        invented: { type: 'string' },
      },
    });
    expect([...new Set(failures.map((finding) => finding.leg))].sort()).toEqual(
      [
        'type',
        'array-item-type',
        'minimum',
        'maximum',
        'enum',
        'strict',
        'key-set',
        'required',
      ].sort()
    );
  });

  it('checks nullable string declarations in both directions and unwraps transform inputs', () => {
    const schema = z.object({
      sprintId: z.string().nullable().optional(),
      plain: z.string().transform((v) => v),
    });
    expect(
      comparePair('green', schema, {
        required: ['plain'],
        properties: {
          sprintId: { type: ['string', 'null'] },
          plain: { type: 'string' },
        },
      })
    ).toEqual([]);
    expect(
      comparePair('red', schema, {
        required: ['plain'],
        properties: {
          sprintId: { type: 'string' },
          plain: { type: ['string', 'null'] },
        },
      }).map((finding) => `${finding.leg}:${finding.key}`)
    ).toEqual(['type:sprintId', 'type:plain']);
  });
});

describe('published JSON inputSchema ↔ zod parity (s86-m04 Part A)', () => {
  const { violations, totals } = walkAll();
  const byLeg = (leg: Violation['leg']) => violations.filter((v) => v.leg === leg);

  it('reports its full violation set BY LEG and BY NAME (printed, so a baseline is checkable)', () => {
    const legs: Violation['leg'][] = [
      'type',
      'array-item-type',
      'minimum',
      'maximum',
      'enum',
      'strict',
      'key-set',
      'minLength',
      'maxLength',
      'minItems',
      'maxItems',
      'required',
    ];
    // eslint-disable-next-line no-console
    console.log(
      `\n[s86-m04] schema parity — ${totals.tools} tools, ${totals.numericDeclarations} numeric ` +
        `declarations, ${totals.properties} properties compared\n` +
        legs
          .map((leg) => {
            const hits = byLeg(leg);
            return (
              `  ${leg}: ${hits.length}` +
              (hits.length
                ? '\n' + hits.map((v) => `      ${v.tool}.${v.key} — ${v.detail}`).join('\n')
                : '')
            );
          })
          .join('\n')
    );
    expect(totals.tools).toBe(15);
  });

  it('walks every tool, resolving each schema from its NAME with no hand-written map', () => {
    expect(totals.tools).toBe(15);
    for (const def of RBOOK_TOOL_DEFINITIONS) {
      expect(() => resolveSchema(def.name)).not.toThrow();
    }
  });

  it('VACUITY FLOOR — a walker that stopped walking must fail here, not report zero', () => {
    // Deleting the body of compareObject's property loop drops these to 0 and fails, rather than
    // producing an empty violation list that reads as success.
    expect(totals.tools).toBeGreaterThanOrEqual(15);
    expect(totals.numericDeclarations).toBeGreaterThanOrEqual(37);
    expect(totals.properties).toBeGreaterThanOrEqual(190);
  });

  it('(i) every zod .int() publishes integer, and nothing else does', () => {
    expect(byLeg('type').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(i-array) every zod .int() ARRAY ELEMENT publishes items.type integer', () => {
    expect(byLeg('array-item-type').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(ii) every zod minimum is published, with .positive() on an integer meaning minimum 1', () => {
    expect(byLeg('minimum').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(iii) every zod maximum is published', () => {
    expect(byLeg('maximum').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(iv) enum membership agrees in BOTH directions', () => {
    expect(byLeg('enum').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(v) zod .strict() ⇔ published additionalProperties:false, recursing into nested objects', () => {
    expect(byLeg('strict').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it('(vi) key sets agree in BOTH directions — no JSON-only key, no zod-only key', () => {
    expect(byLeg('key-set').map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
  });

  it.each(['minLength', 'maxLength', 'minItems', 'maxItems', 'required'] as const)(
    '%s agrees at every declared object and array depth',
    (leg) => {
      expect(byLeg(leg).map((v) => `${v.tool}.${v.key}: ${v.detail}`)).toEqual([]);
    }
  );

  it('the three genuinely non-integer params still publish number, by name', () => {
    // A blanket number→integer replace breaks exactly these three. Asserted by name so the sweep
    // cannot quietly take them with it.
    const props = (name: string) =>
      (RBOOK_TOOL_DEFINITIONS.find((t) => t.name === name)!.inputSchema as unknown as JsonSchema)
        .properties!;
    expect(props('rbook_sprint').targetSizePercent.type).toBe('number');
    expect(props('rbook_context').targetSizePercent.type).toBe('number');
    expect(props('rbook_context').recencyWeight.type).toBe('number');
  });
});

describe('the two legs with no live instance are proven to fire (s86-m04 Part A)', () => {
  it('(iii) maximum — a zod .max() the published schema omits is caught', () => {
    const zodSchema = z.object({ limit: z.number().int().max(50).optional() }).strict();
    const green = comparePair('fixture', zodSchema, {
      properties: { limit: { type: 'integer', maximum: 50 } },
      additionalProperties: false,
    });
    expect(green).toEqual([]);

    const red = comparePair('fixture', zodSchema, {
      properties: { limit: { type: 'integer' } },
      additionalProperties: false,
    });
    expect(red.map((v) => `${v.leg}:${v.key}`)).toContain('maximum:limit');

    // …and a DISAGREEING maximum is caught too, not just an absent one.
    const mismatched = comparePair('fixture', zodSchema, {
      properties: { limit: { type: 'integer', maximum: 100 } },
      additionalProperties: false,
    });
    expect(mismatched.map((v) => `${v.leg}:${v.key}`)).toContain('maximum:limit');
  });

  it('(vi) key-set — a JSON-only key and a zod-only key are BOTH caught', () => {
    const zodSchema = z.object({ a: z.string().optional() }).strict();

    const zodOnly = comparePair('fixture', zodSchema, {
      properties: { b: { type: 'string' } },
      additionalProperties: false,
    });
    // `a` is declared in zod but never published; `b` is published but not in zod. BOTH directions.
    expect(
      zodOnly
        .filter((v) => v.leg === 'key-set')
        .map((v) => v.key)
        .sort()
    ).toEqual(['a', 'b']);

    const agreed = comparePair('fixture', zodSchema, {
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    });
    expect(agreed.filter((v) => v.leg === 'key-set')).toEqual([]);
  });
});

describe('arrayUpdates states ONE thing in all three places (s86-m04 Part B)', () => {
  it('zod, the published schema, and the handler type agree on the same two keys', () => {
    // The pre-fix state was three MUTUALLY INCONSISTENT statements about one parameter: zod named
    // four keys, the published JSON named none at all, and the handler accepted two. A caller who
    // passed `decisions_made` alone got INVALID_PARAMETER from an error whose own suggestion told
    // them to pass `decisions_made`.
    const zodKeys = Object.keys(
      (
        resolveSchema('rbook_context').shape.arrayUpdates as z.ZodOptional<
          z.ZodObject<Record<string, z.ZodType>>
        >
      ).unwrap().shape
    ).sort();
    const jsonKeys = Object.keys(
      (
        RBOOK_TOOL_DEFINITIONS.find((t) => t.name === 'rbook_context')!
          .inputSchema as unknown as JsonSchema
      ).properties!.arrayUpdates.properties ?? {}
    ).sort();

    expect(zodKeys).toEqual(['constraints', 'context_notes']);
    expect(jsonKeys).toEqual(['constraints', 'context_notes']);
    expect(jsonKeys).toEqual(zodKeys);
  });

  it('the published arrayUpdates object is NOT closed — its zod object is `strip`', () => {
    // Closing it would manufacture a fresh strict-parity divergence of exactly the kind leg (v)
    // exists to catch, inside the fix for a different one.
    const json = (
      RBOOK_TOOL_DEFINITIONS.find((t) => t.name === 'rbook_context')!
        .inputSchema as unknown as JsonSchema
    ).properties!.arrayUpdates;
    expect(json.additionalProperties).toBeUndefined();
  });
});
