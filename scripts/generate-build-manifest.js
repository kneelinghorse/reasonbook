#!/usr/bin/env node
// ABOUTME: Generates compiled-code and bounded source hashes for runtime and source freshness.
// ABOUTME: Accepts isolated project/output roots so tests never alter the real source or dist tree.

/**
 * Generate build manifest for MCP server staleness detection.
 *
 * Computes a SHA-256 hash of all compiled JS files in dist/ and writes
 * dist/.build-manifest.json with the hash + timestamp. Used by the server
 * health module to detect when running code is stale.
 *
 * Usage: node scripts/generate-build-manifest.js [--root <project>] [--dist <dir>]
 * Called automatically by `npm run build`. `--dist` points it at another directory, so a test can
 * run the real script without rewriting the real dist/.build-manifest.json (s92-m10).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ts = require('typescript');

// Load the shared source walk without relying on a previous build. This build-only process
// follows render-rules-pointer.js's source-loader pattern and exits after writing one manifest.
require.extensions['.ts'] = (mod, file) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: file,
  });
  mod._compile(outputText, file);
};
const { collectSrcMtimes, hashSrcFiles } = require('../src/utils/build-source.ts');
const rootFlag = process.argv.indexOf('--root');
const PROJECT_ROOT =
  rootFlag !== -1 && process.argv[rootFlag + 1]
    ? path.resolve(process.argv[rootFlag + 1])
    : path.resolve(__dirname, '..');
const distFlag = process.argv.indexOf('--dist');
const DIST_DIR =
  distFlag !== -1 && process.argv[distFlag + 1]
    ? path.resolve(process.argv[distFlag + 1])
    : path.join(PROJECT_ROOT, 'dist');
const MANIFEST_PATH = path.join(DIST_DIR, '.build-manifest.json');

/**
 * Recursively collect all .js files in a directory, sorted for determinism.
 */
function collectJsFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(fullPath));
    } else if (entry.name.endsWith('.js')) {
      results.push(fullPath);
    }
  }
  return results.sort();
}

async function main() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error('[build-manifest] dist/ not found — skipping manifest generation');
    process.exit(0);
  }

  const jsFiles = collectJsFiles(DIST_DIR);
  if (jsFiles.length === 0) {
    console.error('[build-manifest] No .js files found in dist/');
    process.exit(0);
  }

  // Compute composite hash of all JS file contents
  const hash = crypto.createHash('sha256');
  for (const filePath of jsFiles) {
    const content = fs.readFileSync(filePath);
    // Include relative path in hash so renames are detected
    const relPath = path.relative(DIST_DIR, filePath);
    hash.update(relPath);
    hash.update(content);
  }

  const manifest = {
    buildHash: hash.digest('hex'),
    buildTime: new Date().toISOString(),
    fileCount: jsFiles.length,
    srcHash: await hashSrcFiles(PROJECT_ROOT, await collectSrcMtimes(PROJECT_ROOT)),
  };

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.error(
    `[build-manifest] Generated: hash=${manifest.buildHash.slice(0, 12)}… files=${manifest.fileCount} time=${manifest.buildTime}`
  );
}

main().catch((error) => {
  console.error(`[build-manifest] ${error.message}`);
  process.exitCode = 1;
});
