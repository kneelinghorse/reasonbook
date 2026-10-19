// SPDX-License-Identifier: Apache-2.0
// ABOUTME: Lets a child process a test starts require the TypeScript source directly (s97-m09), as sync-far-end.js does,
// ABOUTME: so a second process runs the same code as the test without a build.
const fs = require('fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, file) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText,
    file
  );
