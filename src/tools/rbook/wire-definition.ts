// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The definition as tools/list sends it (s92-m08): the same schema with WIRE_TEXT's short text, and a
// ABOUTME: tool or parameter WIRE_TEXT does not name throws, so its long text cannot ship by accident.

import { WIRE_TEXT } from './wire-descriptions';

interface DefinitionShape {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { readonly properties?: Readonly<Record<string, unknown>> };
}

/** Drop every `description` below the top level: the short form has no room for sub-shapes. */
function withoutNestedDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNestedDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key, child]) => !(key === 'description' && typeof child === 'string'))
      .map(([key, child]) => [key, withoutNestedDescriptions(child)])
  );
}

/**
 * The definition as tools/list sends it: the same schema, with the short text. A tool or
 * parameter missing from WIRE_TEXT throws, so a new one cannot ship its long text by accident.
 */
export function toWireDefinition<T extends DefinitionShape>(definition: T): T {
  const text = WIRE_TEXT[definition.name];
  if (!text) throw new Error(`No wire text for tool ${definition.name}`);
  const properties = definition.inputSchema.properties ?? {};
  const wireProperties: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (!(name in text.parameters)) {
      throw new Error(`No wire text for ${definition.name}.${name}`);
    }
    const hint = text.parameters[name];
    const stripped = withoutNestedDescriptions(property) as Record<string, unknown>;
    wireProperties[name] = hint === null ? stripped : { ...stripped, description: hint };
  }
  return {
    ...definition,
    description: text.description,
    inputSchema: { ...definition.inputSchema, properties: wireProperties },
  };
}
