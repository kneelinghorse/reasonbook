// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Gates every exported legacy Reasonbook tool definition against a tracked owner/action inventory.
// ABOUTME: Also rejects pre-consolidation tool names anywhere in the root agent playbook.

/**
 * Sprint 88 m05 — inventory before deletion.
 *
 * Reasonbook registers 15 consolidated tools, but the barrel still exports 34 per-action tool
 * definitions. They are not orphans: every one describes a live action and is imported by the
 * public-mirror test suite. The operator explicitly directed that none be cut before this
 * inventory existed.
 *
 * Candidate discovery imports the real barrel and partitions definitions by object identity
 * against RBOOK_TOOL_DEFINITIONS. Reference discovery starts from `git ls-files -z` with NO
 * extension filter, then reads every text file it finds. That all-extension rule is load-bearing:
 * tests are public-mirror-exposed surface, and an extension-keyed list can silently miss an
 * importer in a different file type.
 */

import { LEGACY } from '../../../src/intelligence/legacy-compat';
import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { requiresPrivateEvidence } from '../../helpers/public-mirror';
import * as rbookTools from '../../../src/tools/rbook';
import { RBOOK_ACTION_PARAMS, RBOOK_TOOL_DEFINITIONS } from '../../../src/tools/rbook';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const PRIVATE = requiresPrivateEvidence({
  reason: 'private agent playbook and legacy-definition inventory artifact',
  paths: {
    agents: 'agents.md',
    // s93-m12: agents.md's architecture reference moved here; the gate follows its text.
    architecture: 'rbook/docs/architecture.md',
    inventory: 'rbook/reports/tool-definition-inventory.json',
  },
});

interface ToolDefinitionShape {
  readonly name: string;
  readonly inputSchema?: {
    readonly properties?: {
      readonly action?: { readonly enum?: readonly string[] };
    };
  };
}

interface InventoryEntry {
  readonly exportName: string;
  readonly legacyToolName: string;
  readonly ownerTool: string;
  readonly action: string;
  readonly testReferenceCount: number;
  readonly testFileCount: number;
  readonly barrelReExportCount: number;
  readonly disposition: 'retain';
}

interface InventoryArtifact {
  readonly operatorDirection: string;
  readonly dispositionPolicy: string;
  readonly method: {
    readonly trackedFileCommand: string;
    readonly auditCommand: string;
    readonly candidateRule: string;
  };
  readonly totals: {
    readonly exportedDefinitions: number;
    readonly registeredDefinitions: number;
    readonly inventoriedDefinitions: number;
    readonly testReferences: number;
    readonly uniqueTestFiles: number;
    readonly barrelReExports: number;
    readonly deletedThisSprint: number;
  };
  readonly entries: readonly InventoryEntry[];
}

interface DefinitionExport {
  readonly exportName: string;
  readonly definition: ToolDefinitionShape;
}

interface DefinitionDeclaration {
  readonly exportName: string;
  readonly file: string;
}

let trackedFilesCache: string[] | undefined;
function trackedFiles(): string[] {
  // s106-m05 (#1738): the whole tree's listing passed execFileSync's 1 MiB default.
  trackedFilesCache ??= execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  return trackedFilesCache;
}

const trackedTextCache = new Map<string, string | null>();
function readTrackedText(relativePath: string): string | null {
  const cached = trackedTextCache.get(relativePath);
  if (cached !== undefined || trackedTextCache.has(relativePath)) return cached ?? null;
  const bytes = fs.readFileSync(path.join(REPO_ROOT, relativePath));
  const text = bytes.includes(0) ? null : bytes.toString('utf8');
  trackedTextCache.set(relativePath, text);
  return text;
}

function exportedToolDefinitionNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text.endsWith('ToolDefinition')) {
          names.push(declaration.name.text);
        }
      }
    }
    if (ts.isExportSpecifier(node) && node.name.text.endsWith('ToolDefinition')) {
      names.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

let definitionDeclarationsCache: DefinitionDeclaration[] | undefined;
function definitionDeclarations(): DefinitionDeclaration[] {
  if (definitionDeclarationsCache) return definitionDeclarationsCache;
  const filesByExport = new Map<string, Set<string>>();
  for (const file of trackedFiles()) {
    const text = readTrackedText(file);
    if (text === null) continue;
    if (!text.includes('ToolDefinition')) continue;
    if (!/\bexport\s+(?:(?:const|let|var)\b|\{)/.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const exportName of exportedToolDefinitionNames(source)) {
      const files = filesByExport.get(exportName) ?? new Set<string>();
      files.add(file);
      filesByExport.set(exportName, files);
    }
  }
  definitionDeclarationsCache = [...filesByExport]
    .map(([exportName, files]) => ({ exportName, file: [...files].sort().join(', ') }))
    .sort((a, b) => a.exportName.localeCompare(b.exportName));
  return definitionDeclarationsCache;
}

let definitionExportsCache: DefinitionExport[] | undefined;
function definitionExports(): DefinitionExport[] {
  if (definitionExportsCache) return definitionExportsCache;
  const declarations = definitionDeclarations();
  const declarationNames = declarations.map(({ exportName }) => exportName);

  const barrel = Object.entries(rbookTools as Record<string, unknown>)
    .filter(([exportName]) => exportName.endsWith('ToolDefinition'))
    .sort(([a], [b]) => a.localeCompare(b));
  const barrelNames = barrel.map(([exportName]) => exportName);
  const coverage = inventoryCoverageFindings(declarationNames, barrelNames);
  if (coverage.length > 0) {
    throw new Error(
      `tracked source declarations and barrel exports differ: ${coverage.join('; ')}`
    );
  }

  definitionExportsCache = barrel
    .map(([exportName, value]) => {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as ToolDefinitionShape).name !== 'string'
      ) {
        throw new Error(`${exportName} is exported as a ToolDefinition but has no string name`);
      }
      return { exportName, definition: value as ToolDefinitionShape };
    })
    .sort((a, b) => a.exportName.localeCompare(b.exportName));
  return definitionExportsCache;
}

function inventoriedDefinitionExports(): DefinitionExport[] {
  const registered = new Set<unknown>(RBOOK_TOOL_DEFINITIONS);
  return definitionExports().filter(({ definition }) => !registered.has(definition));
}

const referenceStatsCache = new Map<
  string,
  { readonly referenceCount: number; readonly fileCount: number; readonly files: readonly string[] }
>();
function referenceStats(identifier: string): {
  readonly referenceCount: number;
  readonly fileCount: number;
  readonly files: readonly string[];
} {
  const cached = referenceStatsCache.get(identifier);
  if (cached) return cached;
  const token = new RegExp(`\\b${identifier}\\b`, 'g');
  const files: string[] = [];
  let referenceCount = 0;

  for (const file of trackedFiles()) {
    if (!file.startsWith('tests/')) continue;
    const text = readTrackedText(file);
    if (text === null) continue;
    const count = text.match(token)?.length ?? 0;
    if (count === 0) continue;
    referenceCount += count;
    files.push(file);
  }

  const stats = { referenceCount, fileCount: files.length, files };
  referenceStatsCache.set(identifier, stats);
  return stats;
}

function barrelReExportCount(identifier: string): number {
  const file = path.join(REPO_ROOT, 'src', 'tools', 'rbook', 'index.ts');
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true
  );
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isExportSpecifier(node) && node.name.text === identifier) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

function readInventory(): InventoryArtifact {
  const inventory = JSON.parse(
    fs.readFileSync(PRIVATE.paths.inventory, 'utf8')
  ) as InventoryArtifact;
  // The inventory is frozen evidence. Only translate its symbol and module-path names.
  const currentName = (value: string) => value.split(LEGACY.recordDirectory).join('rbook');
  return {
    ...inventory,
    method: { ...inventory.method, auditCommand: currentName(inventory.method.auditCommand) },
    entries: inventory.entries.map((entry) => ({
      ...entry,
      exportName: currentName(entry.exportName),
      legacyToolName: currentName(entry.legacyToolName),
      ownerTool: currentName(entry.ownerTool),
    })),
  };
}

function inventoryCoverageFindings(
  actualNames: readonly string[],
  inventoryNames: readonly string[]
): string[] {
  const actual = new Set(actualNames);
  const inventory = new Set(inventoryNames);
  const findings: string[] = [];
  for (const name of actual) {
    if (!inventory.has(name)) findings.push(`missing inventory entry: ${name}`);
  }
  for (const name of inventory) {
    if (!actual.has(name)) findings.push(`stale inventory entry: ${name}`);
  }
  if (inventory.size !== inventoryNames.length) findings.push('duplicate inventory exportName');
  return findings.sort();
}

const REGISTERED_ACTIONS = new Map<string, ReadonlySet<string>>(
  RBOOK_TOOL_DEFINITIONS.map((definition) => {
    const actionEnum = (definition.inputSchema as ToolDefinitionShape['inputSchema'])?.properties
      ?.action?.enum;
    return [definition.name, new Set(actionEnum ?? [])] as const;
  })
);

const REGISTERED_TOOL_NAMES = new Set(REGISTERED_ACTIONS.keys());
const RBOOK_NAME_RE = /\brbook_[a-z][a-z0-9_]*\b/g;
const RBOOK_CALL_RE = /\b(rbook_[a-z][a-z0-9_]*)\s*\(/g;
const ACTION_RE = /^\s*action\s*[:=]\s*["'`]([a-z_]+)["'`]/;

const UNREGISTERED_OPERATION_NAMES = new Set<string>();
for (const [tool, actions] of REGISTERED_ACTIONS) {
  const legacyBase = tool === 'rbook_mission_transition' ? 'rbook_mission' : tool;
  for (const action of actions) {
    UNREGISTERED_OPERATION_NAMES.add(`${legacyBase}_${action}`);
  }
}

function invalidAgentToolNames(markdown: string): string[] {
  const violations: string[] = [];
  markdown.split('\n').forEach((line, index) => {
    const callOffsets = new Set<number>();
    RBOOK_CALL_RE.lastIndex = 0;
    let call: RegExpExecArray | null;
    while ((call = RBOOK_CALL_RE.exec(line)) !== null) {
      callOffsets.add(call.index);
      const token = call[1];
      if (!REGISTERED_TOOL_NAMES.has(token)) {
        violations.push(`agents.md:${index + 1} names unregistered tool "${token}"`);
        continue;
      }
      const action = line.slice(call.index + call[0].length).match(ACTION_RE)?.[1];
      if (action && !REGISTERED_ACTIONS.get(token)?.has(action)) {
        violations.push(`agents.md:${index + 1} calls ${token} with invalid action "${action}"`);
      }
    }

    RBOOK_NAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RBOOK_NAME_RE.exec(line)) !== null) {
      const token = match[0];
      if (callOffsets.has(match.index)) continue;
      if (REGISTERED_TOOL_NAMES.has(token)) continue;
      if (!UNREGISTERED_OPERATION_NAMES.has(token)) continue;
      violations.push(`agents.md:${index + 1} names unregistered tool "${token}"`);
    }
  });
  return violations;
}

describe('s88-m05 legacy tool-definition inventory', () => {
  it('derives the measured 49 = 15 registered + 34 inventoried population', () => {
    expect(definitionExports()).toHaveLength(49);
    expect(RBOOK_TOOL_DEFINITIONS).toHaveLength(15);
    expect(inventoriedDefinitionExports()).toHaveLength(34);
  });

  it('starts reference discovery from every git-tracked extension, not an extension-keyed list', () => {
    const files = trackedFiles();
    expect(files).toContain('README.md');
    expect(files).toContain('package.json');
    expect(files.some((file) => file.endsWith('.js'))).toBe(true);
    expect(files.some((file) => file.endsWith('.sql'))).toBe(true);
    expect(files.some((file) => file.endsWith('.ts'))).toBe(true);
  });

  it('discovers exported definition declarations structurally before resolving the barrel', () => {
    const source = ts.createSourceFile(
      'probe.template',
      'export const rbookProbeToolDefinition = { name: "rbook_probe" };',
      ts.ScriptTarget.Latest,
      true
    );
    expect(exportedToolDefinitionNames(source)).toEqual(['rbookProbeToolDefinition']);
    expect(definitionDeclarations()).toHaveLength(49);
  });

  it('keeps its two private inputs together, with a visible public-mirror scope', () => {
    expect([0, Object.keys(PRIVATE.relativePaths).length]).toContain(
      PRIVATE.availableRelativePaths.length
    );
    if (PRIVATE.isPublicMirror) {
      expect(Object.values(PRIVATE.paths).map((file) => fs.existsSync(file))).toEqual([
        false,
        false,
      ]);
    }
  });

  PRIVATE.describe('private inventory evidence', () => {
    it('tracks every unregistered export with its live owner/action and measured references', () => {
      expect(fs.existsSync(PRIVATE.paths.inventory)).toBe(true);
      const artifact = readInventory();
      const actual = inventoriedDefinitionExports();
      const actualNames = actual.map(({ exportName }) => exportName);
      const rows = [...artifact.entries].sort((a, b) => a.exportName.localeCompare(b.exportName));

      expect(
        inventoryCoverageFindings(
          actualNames,
          rows.map(({ exportName }) => exportName)
        )
      ).toEqual([]);
      expect(new Set(rows.map(({ exportName }) => exportName)).size).toBe(rows.length);

      for (const row of rows) {
        const definition = actual.find(
          ({ exportName }) => exportName === row.exportName
        )!.definition;
        const stats = referenceStats(row.exportName);
        expect(row.legacyToolName).toBe(definition.name);
        expect(REGISTERED_ACTIONS.get(row.ownerTool)?.has(row.action)).toBe(true);
        expect(RBOOK_ACTION_PARAMS[row.ownerTool]?.[row.action]).toBeDefined();
        const legacyBase =
          row.ownerTool === 'rbook_mission_transition' ? 'rbook_mission' : row.ownerTool;
        expect(row.legacyToolName).toBe(`${legacyBase}_${row.action}`);
        expect(row.testReferenceCount).toBe(stats.referenceCount);
        expect(row.testFileCount).toBe(stats.fileCount);
        expect(row.barrelReExportCount).toBe(barrelReExportCount(row.exportName));
        expect(row.disposition).toBe('retain');
      }

      const allTestFiles = new Set(
        rows.flatMap(({ exportName }) => referenceStats(exportName).files)
      );
      const totals = {
        exportedDefinitions: definitionExports().length,
        registeredDefinitions: RBOOK_TOOL_DEFINITIONS.length,
        inventoriedDefinitions: rows.length,
        testReferences: rows.reduce((sum, row) => sum + row.testReferenceCount, 0),
        uniqueTestFiles: allTestFiles.size,
        barrelReExports: rows.reduce((sum, row) => sum + row.barrelReExportCount, 0),
        deletedThisSprint: 0,
      };
      expect(artifact.totals).toEqual(totals);
      expect(totals).toEqual({
        exportedDefinitions: 49,
        registeredDefinitions: 15,
        inventoriedDefinitions: 34,
        testReferences: 232,
        uniqueTestFiles: 30,
        barrelReExports: 34,
        deletedThisSprint: 0,
      });
    });

    it('publishes the operator direction and the reproducible all-extension audit command', () => {
      expect(fs.existsSync(PRIVATE.paths.inventory)).toBe(true);
      const artifact = readInventory();
      expect(artifact.operatorDirection).toContain(
        'sprint88, i want to know more about it before cutting'
      );
      expect(artifact.dispositionPolicy).toMatch(/zero exports deleted/i);
      expect(artifact.method.trackedFileCommand).toBe('git ls-files -z');
      expect(artifact.method.auditCommand).toBe(
        'npx jest --runTestsByPath tests/tools/rbook/tool-definition-inventory.test.ts --runInBand --coverage=false'
      );
      expect(artifact.method.candidateRule).toMatch(/object identity/i);
    });
  });

  it('the inventory gate is falsifiable: omitting one derived export is detected', () => {
    const actualNames = inventoriedDefinitionExports().map(({ exportName }) => exportName);
    const plantedOmission = actualNames.slice(1);
    expect(inventoryCoverageFindings(actualNames, plantedOmission)).toEqual([
      `missing inventory entry: ${actualNames[0]}`,
    ]);
  });
});

PRIVATE.describe('s88-m05 agents.md registered-tool-name gate', () => {
  it('agents.md names only registered Reasonbook tools', () => {
    expect(invalidAgentToolNames(fs.readFileSync(PRIVATE.paths.agents, 'utf8'))).toEqual([]);
  });

  it('the architecture reference moved out of agents.md names only registered Reasonbook tools too', () => {
    expect(invalidAgentToolNames(fs.readFileSync(PRIVATE.paths.architecture, 'utf8'))).toEqual([]);
  });

  it('the gate positively fires on the pre-consolidation rbook_sprint_complete name', () => {
    expect(invalidAgentToolNames('Call rbook_sprint_complete before release.')).toEqual([
      'agents.md:1 names unregistered tool "rbook_sprint_complete"',
    ]);
  });

  it('does not mistake non-tool Reasonbook vocabulary for a retired operation name', () => {
    expect(invalidAgentToolNames('Fields: rbook_address; table: rbook_sessions.')).toEqual([]);
  });

  it('rejects an arbitrary call-shaped fake while accepting a registered owner/action call', () => {
    expect(invalidAgentToolNames('Call rbook_totally_fake(action="run").')).toEqual([
      'agents.md:1 names unregistered tool "rbook_totally_fake"',
    ]);
    expect(invalidAgentToolNames('Call rbook_sprint(action="complete").')).toEqual([]);
  });
});
