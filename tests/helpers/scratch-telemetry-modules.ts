// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Loads the two telemetry modules from scratch-instrumented source inside a test's own process.
// ABOUTME: Overrides stand in for chosen requires, so a test injects faults without touching shipped code.
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import { instrumentTelemetrySource } from './telemetry-failure-evidence';
import type { TelemetryInstrumentation } from './telemetry-observation-records';

const repo = path.resolve(__dirname, '../..');

/** Emit into `root/compiled`; every other module is the test's own, so shared state stays shared. */
export function scratchModules(
  root: string,
  overrides: Record<string, unknown> = {},
  options: TelemetryInstrumentation = {}
) {
  const cache = new Map<string, any>();
  const load = (relative: string): any => {
    if (cache.has(relative)) return cache.get(relative);
    const source = path.join(repo, 'src', relative);
    const emitted = path.join(root, 'compiled', relative.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(emitted), { recursive: true });
    fs.writeFileSync(
      emitted,
      ts.transpileModule(
        instrumentTelemetrySource(relative, fs.readFileSync(source, 'utf8'), options),
        {
          compilerOptions: {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            esModuleInterop: true,
          },
        }
      ).outputText
    );
    const module = { exports: {} };
    cache.set(relative, module.exports);
    const localRequire = (id: string) => {
      if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id];
      if (id === './local-telemetry') return load('tools/rbook/local-telemetry.ts');
      return require(id.startsWith('.') ? path.resolve(path.dirname(source), id) : id);
    };
    new Function('require', 'module', 'exports', fs.readFileSync(emitted, 'utf8'))(
      localRequire,
      module,
      module.exports
    );
    return module.exports;
  };
  return {
    local: load(
      'tools/rbook/local-telemetry.ts'
    ) as typeof import('../../src/tools/rbook/local-telemetry'),
    call: load(
      'tools/rbook/telemetry-call.ts'
    ) as typeof import('../../src/tools/rbook/telemetry-call'),
  };
}
