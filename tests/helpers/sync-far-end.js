// SPDX-License-Identifier: Apache-2.0
// ABOUTME: The reasonbook CLI run from its TypeScript source, as a stand-in ssh's remote command runs it: a test of the
// ABOUTME: SSH transport then needs no build, and reaches it by absolute paths alone, as the bare PATH requires.
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

require('../../src/cli').main(process.argv.slice(2));
