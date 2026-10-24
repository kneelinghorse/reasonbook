// SPDX-License-Identifier: Apache-2.0
// ABOUTME: s86-m06 structural gate — credential-repair paths must resolve USER-scoped, the
// ABOUTME: authenticating-keyId setter must stay in one place, and no success payload may fake it.

/**
 * Sprint 86 m06 — the three invariants that hold this fix in place.
 *
 * Two of them are UNOBSERVABLE behaviourally today, which is exactly why they need a gate
 * rather than a test:
 *
 *  - `defaultClientFactory` in project-key-capture resolves user-scoped, but the startup
 *    runner only reaches it after proving no local project row exists, so the project-scoped
 *    and user-scoped entry points behave identically there. A behavioural test for it would
 *    be a test that cannot fail. What CAN be gated is the structure: no code under `src/auth/`
 *    may resolve through the project-scoped entry point, and a future "no-op simplification"
 *    that reverts it must go red here.
 *  - The authenticating-keyId setter has exactly one call site. Spraying it across the
 *    resolution arms is the rejected fix: the field never reaches the wire, so stamping it in
 *    an arm that authenticates with a project key records an attribution the request does not
 *    support — a lie that looks like a fix.
 *
 * FALSE-NEGATIVE PROFILE, written rather than discovered later. This gate reads TEXT, so:
 *  (1) it cannot see a project-scoped client passed INTO `src/auth/` from a caller outside it
 *      — `classifyAttribution` rule 5 is the runtime backstop for that, covered in
 *      reissue-resolution.test.ts;
 *  (2) it cannot see resolution reached through an alias or a dynamic property access
 *      (`const f = DashboardClient['fromEnvForProject']`);
 *  (3) it counts CALL SITES, not mentions — comments and doc prose that name the chain are
 *      deliberately allowed, because describing why the change exists is the point. The rule is
 *      an identifier followed by `(`, so it is strict in one direction: a comment that writes the
 *      name WITH parentheses would be counted as a call site. That is a false POSITIVE (it fails
 *      loudly, it does not silently permit), which is the safe direction for a gate;
 *  (4) it says nothing about whether the resolved credential is CORRECT, only which entry
 *      point produced it.
 * Each check below therefore carries a premise assertion proving the pattern can still match
 * something, so a rename cannot silently turn the gate into a tautology.
 *
 * ZERO ALLOWLIST ENTRIES.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const AUTH_DIR = path.join(REPO_ROOT, 'src', 'auth');
const DASHBOARD_CLIENT = path.join(REPO_ROOT, 'src', 'tools', 'rbook', 'dashboard-client.ts');
const RBOOK_AUTH = path.join(REPO_ROOT, 'src', 'tools', 'rbook', 'rbook-auth.ts');

/**
 * Every `.ts` file under src/auth (the credential-capture surface), RECURSIVELY — a future
 * `src/auth/<subdir>/` must not be able to resolve project-scoped where this gate cannot see it.
 */
function authSources(dir: string = AUTH_DIR): Array<{ file: string; content: string }> {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return authSources(full);
    if (!entry.name.endsWith('.ts')) return [];
    return [{ file: path.relative(AUTH_DIR, full), content: fs.readFileSync(full, 'utf8') }];
  });
}

/** Call sites, not mentions: an identifier immediately followed by `(`. */
function callSites(content: string, method: string): number {
  return (content.match(new RegExp(`\\b${method}\\s*\\(`, 'g')) ?? []).length;
}

describe('s86-m06 structural gate: user-scoped resolution for credential repair', () => {
  it('has files to inspect (premise)', () => {
    const sources = authSources();
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.map((s) => s.file)).toContain('project-key-capture.ts');
  });

  it('no code under src/auth resolves a client through the project-scoped entry point', () => {
    const offenders = authSources()
      .map(({ file, content }) => ({ file, hits: callSites(content, 'fromEnvForProject') }))
      .filter((row) => row.hits > 0);

    expect(offenders).toEqual([]);
  });

  it('project-key-capture resolves through the user-scoped entry point (premise: the pattern matches)', () => {
    const content = fs.readFileSync(path.join(AUTH_DIR, 'project-key-capture.ts'), 'utf8');

    // The positive half. Without this, the check above would pass just as well on a file that
    // resolves nothing at all — which is how a gate becomes a tautology.
    expect(callSites(content, 'fromEnvForUser')).toBeGreaterThan(0);

    // And the comment recording WHY the change is unobservable today must survive, so a later
    // dead-code sweep does not read it as a pointless indirection.
    expect(content).toMatch(/provably dead|latent-trap|no-op simplification/);
  });

  it('the authenticating-keyId setter has exactly one call site repo-wide', () => {
    const clientSource = fs.readFileSync(DASHBOARD_CLIENT, 'utf8');

    // One definition + one call, both in dashboard-client.ts.
    const definitions = (clientSource.match(/^\s*setAuthenticatingKeyId\s*\(/gm) ?? []).length;
    expect(definitions).toBe(1);

    const totalCalls = callSites(clientSource, 'setAuthenticatingKeyId') - definitions;
    expect(totalCalls).toBe(1);

    // And it is inside the shared user-scoped chain, not in an arm-1/arm-2 path.
    const chainStart = clientSource.indexOf('private static async resolveUserScopedChain');
    expect(chainStart).toBeGreaterThan(-1);
    const callIndex = clientSource.indexOf('client.setAuthenticatingKeyId(');
    expect(callIndex).toBeGreaterThan(chainStart);
  });

  it('the reissue success payload does not hardcode an empty revoked list', () => {
    const content = fs.readFileSync(RBOOK_AUTH, 'utf8');

    // Premise: the field is still reported at all.
    expect(content).toContain('revokedKeyIds');
    // The lie: a success answer asserting "nothing was revoked" regardless of the response.
    expect(content).not.toMatch(/revokedKeyIds:\s*\[\s*\]/);
  });

  it('no message on the reissue path names device code as the cause of an attribution failure', () => {
    // Each entry pairs the forbidden wording with a PREMISE — a string the honest replacement
    // must still contain. Without the premise this check is a pure negative: on a future tree
    // where the wording has moved on it could never fail, which is the tautology the header
    // above claims this gate avoids. The premise makes a reword redden the gate instead.
    const files = [
      { file: RBOOK_AUTH, premise: 'holds no user-scoped keys' },
      { file: path.join(AUTH_DIR, 'project-key-capture.ts'), premise: 'holds no user-scoped keys' },
      {
        file: path.join(REPO_ROOT, 'src', 'tools', 'rbook', 'checkpoint-backfill.ts'),
        premise: 'attemptDashboardUpload(',
      },
      {
        // s101-m01: the checkpoint now enters the shared upload attempt; registration lives here.
        file: path.join(REPO_ROOT, 'src', 'tools', 'rbook', 'dashboard-upload-attempt.ts'),
        premise: 'checkAndRegister(',
      },
      {
        // s94-m10: registration and its key-attribution remedy moved together; keep the caller
        // and extracted module under the forbidden-wording check.
        file: path.join(REPO_ROOT, 'src', 'tools', 'rbook', 'checkpoint-registration.ts'),
        premise: 'keySource=',
      },
    ];

    for (const { file, premise } of files) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain(premise);
      expect(content).not.toContain('device code flow must be run');
      expect(content).not.toContain('run device code flow');
      // Nor may any of them promise that a later reissue will succeed.
      expect(content).not.toContain('then reissue will succeed');
      expect(content).not.toContain('reissue on next startup will recover');
    }
  });
});

/**
 * s87-m07 — TWO REACHABILITY GATES, both of which exist because the thing they guard is a LATENT
 * TRAP rather than a live lie, and latency is exactly what a gate preserves.
 */
describe('s87-m07 — every published union member has a producer', () => {
  const SRC_ROOT = path.join(REPO_ROOT, 'src');

  function allSourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...allSourceFiles(full));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  const sources = allSourceFiles(SRC_ROOT).map((f) => ({
    rel: path.relative(REPO_ROOT, f),
    text: fs.readFileSync(f, 'utf8'),
  }));

  it('every KeySource member is emitted somewhere in src/', () => {
    // The union is read from the source of truth rather than re-listed here, so a member added
    // later is gated automatically instead of quietly escaping this test.
    const storeSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'intelligence', 'credential-store.ts'),
      'utf8'
    );
    const decl = storeSrc.match(/export type KeySource =([^;]+);/);
    expect(decl).not.toBeNull();
    const members = [...(decl as RegExpMatchArray)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    // Non-vacuity: a broken parse must not pass by finding no members to check.
    expect(members.length).toBeGreaterThanOrEqual(4);

    const withoutProducer = members.filter(
      (member) =>
        !sources.some(
          (f) =>
            f.rel !== 'src/intelligence/credential-store.ts' &&
            new RegExp(`'${member}' as KeySource|keySource: '${member}'`).test(f.text)
        )
    );
    // `'none'` was a member for four sprints with no producer anywhere in src/, while three test
    // files exercised it as though it could occur. This is what stops the next one lasting as long.
    expect(withoutProducer).toEqual([]);
  });

  it('every startup-recovery status has a producer in src/', () => {
    const captureSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'auth', 'project-key-capture.ts'),
      'utf8'
    );
    const decl = captureSrc.match(/status:\s*((?:\s*\|\s*'[a-z-]+'|\s*\/\*[\s\S]*?\*\/)+)/);
    expect(decl).not.toBeNull();
    const members = [...(decl as RegExpMatchArray)[1].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(members.length).toBeGreaterThanOrEqual(6);

    const withoutProducer = members.filter(
      (member) => !new RegExp(`status: '${member}'`).test(captureSrc)
    );
    // f-02's whole point: hoisting classification left `skipped-unconfigured` with zero
    // producers, and closing one unreachable status by minting another would have been the
    // sprint's own defect class. This asserts neither happened.
    expect(withoutProducer).toEqual([]);
  });
});

/**
 * s87-m07 (#530, CUT 5) — THE GATE THAT KEEPS ARM 1's MISLABEL LATENT.
 *
 * `fromEnvForProject` arm 1 reports a keySource that would be wrong for an explicitly supplied
 * `apiKey` override. It is NOT a live lie: zero of the eleven production call sites pass one, so
 * the arm is unreachable and the label has never been rendered about a real call. CUT 5 therefore
 * DEFERS the relabel and ships this instead — a gate that turns the next such caller into a red
 * test rather than a silently wrong sentence.
 *
 * COUNTS CALL SITES, NOT MENTIONS, in the shape this file already uses: a docblock discussing
 * `apiKey` must not trip it, and an actual override must.
 */
describe('s87-m07 (#530) — no caller passes an apiKey override to the resolvers', () => {
  const SRC_ROOT = path.join(REPO_ROOT, 'src');
  const SCRIPTS_ROOT = path.join(REPO_ROOT, 'scripts');

  function walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
    }
    return out;
  }

  it('counts the resolver call sites, and none of them supplies an apiKey', () => {
    const files = [...walk(SRC_ROOT), ...walk(SCRIPTS_ROOT)];
    const CALL = /\b(?:fromEnvForProject|fromEnvForUser)\s*\(/g;

    let callSites = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file);
      if (rel === 'src/tools/rbook/dashboard-client.ts') continue; // the definitions themselves
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        // Comments are excluded by rule: this mission's own prose discusses the override.
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        CALL.lastIndex = 0;
        if (!CALL.test(line)) continue;
        callSites += 1;
        // The argument list can wrap; look at this line and the next three.
        const window = lines.slice(i, i + 4).join(' ');
        if (/\bapiKey\s*:/.test(window)) offenders.push(`${rel}:${i + 1}`);
      }
    }

    // CORPUS FLOOR. Without it a broken matcher passes by finding nothing — the vacuous-gate
    // failure this sprint is named against. Measured at build time: eleven production call sites.
    expect(callSites).toBeGreaterThanOrEqual(8);
    expect(offenders).toEqual([]);
  });
});
