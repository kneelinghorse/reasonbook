# Default name and registration pre-edit census

Run `node tests/sweeps/s101-m10/census.js`. The universe is every file returned by
`git ls-files -z`, across all extensions, decoded as UTF-8; binary and invalid UTF-8
files are excluded. A matching line counts once per class. `before.json` was
captured at the recorded HEAD and measuredAt before any matching production edit;
new failing tests were present but untracked tests are outside that universe.

| Predicate in census.js                                                        | Whole tracked tree | src/ plus rbook-seed/ |
| ----------------------------------------------------------------------------- | -----------------: | --------------------: |
| registerProject call/declaration or projects/sync registration route spelling |                103 |                    12 |
| empty projectName default or projectName-or-restoredName expression           |                  3 |                     3 |
| normalized-address project lookup for a missing sender id                     |                  1 |                     1 |

## Changed and retained candidates

Registration has two executable callers: `src/tools/rbook/checkpoint-registration.ts`
and `scripts/register-fork.ts`. Both call the one method in `dashboard-client.ts`;
its declaration and HTTP URL are separate lexical hits. The other nine src hits
are comments and an auth-state explanation. The two scripts hits are the executable
call and its endpoint log. Protect the common client method so the script cannot
bypass the guard; update route explanations only if the final wire contract changes.
The 71 rbook, 17 test and one CHANGELOG hits are historical or regression witnesses.
Retain those unless an assertion needs to follow the new contract.

All three default-name candidates are in `rbook-project-init.ts`: preserve the
existing explicit-name semantics, but fill absent/blank stored names from a restored
registry name or the folder. Preserve an existing nonblank name, stable id and a
concurrent explicit-name winner. The one sender-address match in `sender-identity.ts`
must stop deriving another project's id from a reusable address; stored dashboard
UUIDs continue to identify copied records.

## Verified dependency and false-negative profile

The sibling dashboard source at b5020298d8f8894e7b692cbb9d70632569813155 accepts
no create-only option on `/api/projects/register`. It checks exact owner/name before
the creation transaction and purges an existing record. Its `/api/projects/me` listing
excludes archived projects, while registration includes them. A client listing followed
by registration therefore cannot prevent either an archived-name collision or a second
request arriving after another store registered the name. The operator authorized the required atomic dashboard operation and deployment on
2026-10-23 (decision 1626). The dashboard build chat owns the new create-only route;
the common client will never fall back to legacy registration. A listing-only check,
ignored form field or local-only lock cannot satisfy this mission.

These predicates enumerate lexical candidates, not every possible equivalent effect.
They miss aliased methods, assembled URLs, multiline default expressions and address
comparisons with other spellings. Immediate callers, dispatch gates and server source
were read as well. Production classification includes the registration script even
though the numeric src/seed column does not. The sibling repository and its deployed
PostgreSQL schema are outside this tracked-tree census. Server semantics above are
verified against that checked-in source. The dashboard team has since verified the
live non-deferrable owner/name unique constraint. Deployment at dashboard commit
`c82adad1f1ab0665725c93c4db69addc415389e1` passed all 34 checks recorded in its
`register-new/receipt.json`, including active and archived collisions through this
candidate client and scratch-residue checks. Concurrent, archived-name, shared-with, case-sensitive and real-store
fixtures are required to demonstrate the final behavior, rather than granting credit
from this lexical count.

## Current result

The common client now posts only to the distinct create-only endpoint; the script
uses that same method. Current client route explanations and its auth-state notice
follow the new endpoint; historical key-minting comments remain accurate for old
keys. The empty argument default remains deliberately: it means no explicit rename.
Metadata and contexts resolve their name under the relevant write locks. An unnamed
shared copy keeps its recorded identity. The sender-address lookup has no remaining
production match. `sender-boundary.md` records the additional publication-boundary
census before tightening direct message and carry-forward sends.

The final `after.json` uses the same tracked UTF-8 matching-line predicate. Its
counts are observations, not a zero-defect claim; retained test and history hits
include the original before receipt and this census script itself.
