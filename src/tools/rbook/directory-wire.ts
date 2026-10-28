// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Filters a fresh wire copy to the local edition without mutating the full contract.
// ABOUTME: Action applicability removes parameters whose only operations are unavailable.

import type { ToolDefinition } from '../../index';
import { DIRECTORY_HIDDEN_TOOLS, DIRECTORY_REMOVED_ACTIONS } from '../../edition';
import { RBOOK_ACTION_PARAMS } from './action-params';
import { DIRECTORY_WIRE_DESCRIPTIONS, DIRECTORY_WIRE_PARAMETERS } from './wire-descriptions';

export function directoryWire(definitions: ToolDefinition[]): ToolDefinition[] {
  return definitions
    .filter((tool) => !(DIRECTORY_HIDDEN_TOOLS as readonly string[]).includes(tool.name))
    .map((tool) => {
      const copy = structuredClone(tool);
      const properties = copy.inputSchema.properties ?? {};
      const action = properties.action as { enum?: string[] } | undefined;
      if (action?.enum) {
        action.enum = action.enum.filter(
          (value) => !DIRECTORY_REMOVED_ACTIONS[tool.name]?.includes(value)
        );
        const used = new Set(action.enum.flatMap((value) => RBOOK_ACTION_PARAMS[tool.name][value]));
        for (const name of Object.keys(properties)) {
          if (name !== 'action' && !used.has(name)) delete properties[name];
        }
      }
      for (const [name, description] of Object.entries(
        DIRECTORY_WIRE_PARAMETERS[tool.name] ?? {}
      )) {
        const property = properties[name];
        if (property && typeof property === 'object')
          properties[name] = { ...property, description };
      }
      if (copy.annotations) copy.annotations.openWorldHint = false;
      delete properties.acrossProjects;
      delete properties.fromDraft;
      if (copy.inputSchema.required) {
        copy.inputSchema.required = copy.inputSchema.required.filter((name) => name in properties);
      }
      copy.description = DIRECTORY_WIRE_DESCRIPTIONS[tool.name] ?? copy.description;
      return copy;
    });
}
