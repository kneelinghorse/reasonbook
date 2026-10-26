#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# ABOUTME: Append-only mirror of this PRIVATE tree's committed source (minus PRIVATE_PATHS and
# ABOUTME: nested private-source exclusions) to github.com/kneelinghorse/reasonbook, with a leak-guard.
#
# Strategy (s73 design §3, decisions #812/#819): this repo stays private and is the sole npm-publish
# source; the public repo is a CODE mirror of everything except PRIVATE_PATHS and DOCS_EXCLUDES.
# APPEND-ONLY — it never force-pushes and never rewrites history. `package.json` is already the
# canonical public form (set by m04), so this script COPIES it; it does not rewrite name/version.
#
# Usage:
#   DRY_RUN=1 scripts/mirror-to-public.sh v1.1.0      # stage + leak-check + commit, NO push (verify first)
#   scripts/mirror-to-public.sh v1.1.0                # real mirror: atomically push main + tag
#   DOCS_ONLY=1 scripts/mirror-to-public.sh v1.1.0    # after a release: push a docs-only change to main
#
# Env overrides:
#   PUBLIC_REMOTE   default git@github.com:kneelinghorse/reasonbook.git (point at a local --bare repo to test)
#   PUBLIC_BRANCH   default main
#   DRY_RUN=1       stage, leak-check, commit locally, print the staged tree, then stop before push
#   DRY_RUN_KEEP=1  with DRY_RUN=1 only, retain the sanitized checkout and print DRY_RUN_TREE=<path>
#   DOCS_ONLY=1     the release tag already exists: refuse unless every public path changed since it is
#                   one no install runs (docs/, top-level *.md, plugins/*/README.md, tests/, scripts/),
#                   then push main only and leave the tag where npm shipped it
set -euo pipefail

PUBLIC_REMOTE="${PUBLIC_REMOTE:-git@github.com:kneelinghorse/reasonbook.git}"
PUBLIC_BRANCH="${PUBLIC_BRANCH:-main}"
if [[ "${DRY_RUN_KEEP:-0}" == "1" && "${DRY_RUN:-0}" != "1" ]]; then
  echo "ERROR: DRY_RUN_KEEP requires DRY_RUN=1" >&2
  exit 1
fi

# Top-level paths that must NEVER reach the public repo. The leak-assert below is load-bearing.
PRIVATE_PATHS=( cmos rbook analysis artifacts tmp SESSIONS.jsonl agents.md CLAUDE.md ecosystem.config.js )

# Nested private-source exclusions under otherwise-public trees: the private npm-publish workflow,
# sprint planning, an internal strategy survey, and the private dashboard's PG-mirror schema (moat).
# s77-m09 purged the stale pre-Great-Deletion docs (mission-protocol/domain-pack/quality/versioning/
# extension/intelligence guides, the discovery/ snapshots, and the whitepaper); s80-m08 also
# deleted docs/specs/project-registry-system.md — it described the JSON ProjectRegistry that 2.1.0
# removed. The only genuine public reference left under docs/ is getting-started.md (the
# authoritative per-action tool reference is the generated top-level TOOL_REFERENCE.md).
DOCS_EXCLUDES=(
  .github/workflows/publish.yml
  .github/workflows/finalize-reasonbook-npm.yml
  docs/specs/sprint-15-revised-missions.md
  docs/specs/phase2-pg-mirror-schema.md
  docs/survey-2026-03-29.md
)

VERSION="${1:?usage: mirror-to-public.sh vX.Y.Z}"
[[ "$VERSION" == v* ]] || { echo "ERROR: version must look like vX.Y.Z (got '$VERSION')"; exit 1; }
SEMVER="${VERSION#v}"

REPO_ROOT="$(git rev-parse --show-toplevel)"; cd "$REPO_ROOT"
[[ -z "$(git status --porcelain)" ]] || { echo "ERROR: working tree is dirty — commit the release first (the mirror ships git archive HEAD)"; exit 1; }
PKG_VERSION="$(node -p "require('./package.json').version")"
[[ "$SEMVER" == "$PKG_VERSION" ]] || { echo "ERROR: tag $VERSION != package.json version $PKG_VERSION"; exit 1; }

if [[ "${DOCS_ONLY:-0}" == "1" ]]; then
  git rev-parse --verify --quiet "$VERSION^{commit}" >/dev/null || { echo "ERROR: DOCS_ONLY needs the released tag $VERSION in this repository"; exit 1; }
  while IFS= read -r changed; do
    excluded=0
    for p in "${PRIVATE_PATHS[@]}" "${DOCS_EXCLUDES[@]}"; do
      [[ "$changed" == "$p" || "$changed" == "$p/"* ]] && { excluded=1; break; }
    done
    # Nothing an install runs: docs, top-level and plugin READMEs, tests, and repository scripts.
    [[ "$excluded" == "1" || "$changed" == docs/* || "$changed" == tests/* || "$changed" == scripts/* ]] && continue
    [[ "$changed" != */* && "$changed" == *.md ]] && continue
    [[ "$changed" == plugins/*/README.md && "$changed" != plugins/*/*/* ]] && continue
    echo "ERROR: DOCS_ONLY: $changed changed since $VERSION and installs run it; release it instead"
    exit 1
  done < <(git diff --name-only "$VERSION" HEAD)
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/rbook-mirror.XXXXXXXX")"
RETAINED_ROOT=""
RETAINED_READY=0
cleanup() {
  rm -rf "$WORK"
  if [[ -n "$RETAINED_ROOT" && "$RETAINED_READY" != "1" ]]; then
    rm -rf "$RETAINED_ROOT"
  fi
}
trap cleanup EXIT
PUB="$WORK/public"
STAGE="$WORK/stage"

echo "→ cloning public ($PUBLIC_BRANCH) from $PUBLIC_REMOTE"
git clone --quiet --branch "$PUBLIC_BRANCH" --single-branch "$PUBLIC_REMOTE" "$PUB"

echo "→ materializing this tree's committed files (git archive HEAD)"
mkdir -p "$STAGE"
git archive --format=tar HEAD | tar -x -C "$STAGE"

# Build the rsync exclude list: top-level private paths + nested private-source exclusions. Anchored ('/x')
# so e.g. --exclude=/rbook matches only the top-level dir. /.git is excluded AND (via plain --delete,
# which protects excludes) preserved in the destination — do NOT use --delete-excluded here (it would
# delete the destination .git).
RSYNC_EXCLUDES=( "--exclude=/.git" )
for p in "${PRIVATE_PATHS[@]}";  do RSYNC_EXCLUDES+=( "--exclude=/$p" ); done
for d in "${DOCS_EXCLUDES[@]}";  do RSYNC_EXCLUDES+=( "--exclude=/$d" ); done

echo "→ rsync staged source into the public clone (minus private paths + nested exclusions)"
rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$STAGE"/ "$PUB"/

# Belt-and-suspenders: explicitly remove any excluded path that PRE-EXISTED in the public clone.
# --exclude protects such files from rsync --delete, so without this a nested exclusion already committed
# to public would silently persist. Removing them here records the deletion in the forward commit
# (append-only — a normal commit, never a history rewrite).
for p in "${PRIVATE_PATHS[@]}" "${DOCS_EXCLUDES[@]}"; do rm -rf "${PUB:?}/$p"; done
# Never ship a real .env (only .env.template). The protection is .gitignore: an untracked/gitignored
# .env is simply absent from `git archive HEAD`. As defense-in-depth against accidental force-tracking
# (`git add -f .env`), explicitly remove any real .env variant here too (the leak-assert below re-checks).
find "$PUB" -path "$PUB/.git" -prune -o -name '.env' -print -o \( -name '.env.*' ! -name '.env.template' \) -print 2>/dev/null \
  | while IFS= read -r f; do rm -f "$f"; done

# ── Hard leak-assert — abort if any private path, nested exclusion, DB, or .env survived ──────
LEAK=0
for p in "${PRIVATE_PATHS[@]}"; do [[ -e "$PUB/$p" ]] && { echo "LEAK: private path $p"; LEAK=1; }; done
for d in "${DOCS_EXCLUDES[@]}";  do [[ -e "$PUB/$d" ]] && { echo "LEAK: nested exclusion $d"; LEAK=1; }; done
if find "$PUB" -path "$PUB/.git" -prune -o \( -name '*.sqlite*' -o -name '*.db*' \) -print | grep -q .; then echo "LEAK: a database file (*.sqlite/*.db — the tree carries rbook/db/rbook.sqlite AND rbook/db/cmos.db)"; LEAK=1; fi
if find "$PUB" -path "$PUB/.git" -prune -o \( -name '.env' -o \( -name '.env.*' ! -name '.env.template' \) \) -print | grep -q .; then echo "LEAK: a real .env file"; LEAK=1; fi
[[ "$LEAK" -eq 0 ]] || { echo "ABORT: private content present in the staged public tree — refusing to mirror"; exit 1; }
echo "✓ leak-guard passed: no PRIVATE_PATHS, nested exclusions, *.sqlite, or .env in the staged tree"

cd "$PUB"
git add -A

# Compare Git trees, not filesystem names: a case-insensitive checkout/index can lose a
# case-only rename while rsync and git add both succeed. Only the declared root exclusions
# above and the explicit real-.env rule may differ; every remaining path, mode, and object
# must equal the committed source before we create a commit or tag (including dry runs).
PUBLIC_TREE="$(git write-tree)"
node - "$REPO_ROOT" "$PUB" "$PUBLIC_TREE" "${PRIVATE_PATHS[@]}" "${DOCS_EXCLUDES[@]}" <<'NODE'
const { execFileSync } = require('node:child_process');
const [source, destination, stagedTree, ...excludedPaths] = process.argv.slice(2);
const excluded = excludedPaths.map((name) => Buffer.from(name));
function tree(cwd, ref) {
  const output = execFileSync('git', ['ls-tree', '-rz', '--full-tree', ref], {
    cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
  const entries = new Map();
  let start = 0;
  while (start < output.length) {
    const end = output.indexOf(0, start);
    const tab = output.indexOf(9, start);
    if (end < 0 || tab < start || tab >= end) throw new Error('Malformed git ls-tree record');
    const name = output.subarray(tab + 1, end);
    entries.set(name.toString('hex'), {
      name,
      identity: output.subarray(start, tab).toString('ascii'),
    });
    start = end + 1;
  }
  return entries;
}
function isExcluded(name) {
  if (excluded.some((prefix) => name.equals(prefix) ||
    (name.length > prefix.length && name[prefix.length] === 47 &&
      name.subarray(0, prefix.length).equals(prefix)))) return true;
  // Matches the removal/leak-guard policy above, never all dotfiles or all nested docs.
  const basename = name.subarray(name.lastIndexOf(47) + 1).toString('utf8');
  return basename === '.env' || (basename.startsWith('.env.') && basename !== '.env.template');
}
const expected = tree(source, 'HEAD');
for (const [key, entry] of expected) if (isExcluded(entry.name)) expected.delete(key);
const actual = tree(destination, stagedTree);
const differences = [];
for (const [key, entry] of expected) {
  const observed = actual.get(key);
  const label = JSON.stringify(entry.name.toString('utf8'));
  if (!observed) differences.push(`missing ${label}`);
  else if (observed.identity !== entry.identity) {
    differences.push(`changed ${label}: expected ${entry.identity}; got ${observed.identity}`);
  }
}
for (const [key, entry] of actual) {
  if (!expected.has(key)) differences.push(`unexpected ${JSON.stringify(entry.name.toString('utf8'))}`);
}
if (differences.length) {
  console.error('ABORT: public tree differs from committed source (case-sensitive paths, modes, objects):');
  for (const difference of differences) console.error(`  ${difference}`);
  process.exit(1);
}
console.log(`✓ exact committed-tree comparison passed: ${expected.size} public entries`);
NODE

if git diff --cached --quiet; then
  echo "no source changes to mirror — public already matches this HEAD; checking release tag"
else
  PRIVATE_SHA="$(cd "$REPO_ROOT" && git rev-parse --short HEAD)"
  if [[ "${DOCS_ONLY:-0}" == "1" ]]; then SUBJECT="docs: update the $VERSION public tree"; else SUBJECT="release $VERSION"; fi
  git commit --quiet -m "$SUBJECT

Mirrored from the private @aquex/reasonbook source at $PRIVATE_SHA.
Excludes private paths (rbook/, analysis/, artifacts/, …) and nested private-source files."
fi

PUBLIC_COMMIT="$(git rev-parse HEAD)"
if [[ "${DOCS_ONLY:-0}" == "1" ]]; then
  git show-ref --verify --quiet "refs/tags/$VERSION" || { echo "ERROR: DOCS_ONLY: public tag $VERSION does not exist; release it instead"; exit 1; }
  git merge-base --is-ancestor "$VERSION^{commit}" "$PUBLIC_COMMIT" || { echo "ERROR: DOCS_ONLY: public tag $VERSION is not an ancestor of public $PUBLIC_BRANCH"; exit 1; }
elif git show-ref --verify --quiet "refs/tags/$VERSION"; then
  TAG_COMMIT="$(git rev-parse "$VERSION^{commit}")"
  [[ "$TAG_COMMIT" == "$PUBLIC_COMMIT" ]] || {
    echo "ERROR: public tag $VERSION resolves to $TAG_COMMIT, expected $PUBLIC_COMMIT"
    exit 1
  }
else
  git tag "$VERSION" "$PUBLIC_COMMIT"
fi
echo "PUBLIC_COMMIT=$PUBLIC_COMMIT"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo
  echo "── DRY_RUN: staged public tree (top-level) ──────────────────────────────"
  git -C "$PUB" ls-files | sed 's#/.*##' | sort -u
  echo "── total tracked files staged: $(git -C "$PUB" ls-files | wc -l | tr -d ' ') ──"
  echo "── excluded paths confirmed ABSENT (must all say 'absent OK') ──"
  for p in "${PRIVATE_PATHS[@]}" "${DOCS_EXCLUDES[@]}"; do
    [[ -e "$PUB/$p" ]] && echo "  STILL PRESENT ⚠  $p" || echo "  absent OK     $p"
  done
  echo "── DRY_RUN — not pushing. Re-run without DRY_RUN=1 to push main + $VERSION ──"
  if [[ "${DRY_RUN_KEEP:-0}" == "1" ]]; then
    # WORK/stage contains the private archive. Retain ONLY the already-checked public clone.
    RETAINED_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/rbook-mirror.XXXXXXXX")"
    mv "$PUB" "$RETAINED_ROOT/public"
    echo "DRY_RUN_TREE=$RETAINED_ROOT/public"
    RETAINED_READY=1
  fi
  exit 0
fi

if [[ "${DOCS_ONLY:-0}" == "1" ]]; then
  echo "→ pushing $PUBLIC_BRANCH to $PUBLIC_REMOTE; tag $VERSION stays put"
  git push origin "HEAD:refs/heads/$PUBLIC_BRANCH"
  echo "✓ mirrored the $VERSION docs update to public at $PUBLIC_COMMIT"
  exit 0
fi
echo "→ atomically pushing $PUBLIC_BRANCH + tag $VERSION to $PUBLIC_REMOTE"
git push --atomic origin "HEAD:refs/heads/$PUBLIC_BRANCH" "refs/tags/$VERSION"
echo "✓ mirrored $VERSION to public at $PUBLIC_COMMIT"
