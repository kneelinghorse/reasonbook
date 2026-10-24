# Sender boundary pre-edit census

Measured at 2026-10-23T05:23:53.848Z, HEAD
`121770a411cd778211edbbdefa241c409327b9e4`, before changing production sender
resolution or its send boundaries. This extends the address-lookup census in
`before.json` after direct calls were found to permit address-only publication.

Runnable predicate (one matching line counts once; all tracked extensions, valid
UTF-8 only, excluding NUL-bearing binary files):

```sh
node <<'NODE'
const cp = require('child_process'), fs = require('fs');
const predicate = /assertSenderIdentityValid|!senderProjectId && !identity\.rbookAddress|client\.sendMessage\(/;
const sites = [];
for (const file of cp.execFileSync('git', ['ls-files', '-z']).toString().split('\0').filter(Boolean)) {
  const bytes = fs.readFileSync(file);
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { continue; }
  text.split('\n').forEach((line, index) => {
    if (predicate.test(line)) sites.push({ file, line: index + 1 });
  });
}
console.log(JSON.stringify({ count: sites.length, sites }, null, 2));
NODE
```

Before count: **58 whole-tree matching lines**, including **7 production lines**.
Production sites: `rbook-message.ts` import/comment/assertion/send at lines
39/1051/1064/1102, `rbook-sprint-carry-forward.ts` send at 255, and
`sender-identity.ts` assertion declaration/loose condition at 261/265.

Change the loose assertion to require a sender ID, and add the same assertion
before carry-forward publication. Keep the message handler's existing assertion,
transport call and explicit sender-ID override contract. Local ID resolution still
validates stored UUIDs; an address alone is never sufficient. Update historical
tests that required address-based ID adoption. Retain the other 51 matching lines:
40 historical plan/research witnesses and 11 direct dashboard-client transport
tests. Transport tests exercise the wire layer, not local sender authorization.

The predicate is lexical and misses aliased clients, multiline expressions,
different condition spellings and other method names. Reading the resolver's
immediate callers found both local publication paths; this is not a claim that the
wire client or sibling dashboard enforces every identity invariant. Explicit
caller-supplied sender IDs retain their existing compatibility contract. The
positive fixtures cover direct send and carry-forward with a reusable canonical
address and no stored ID, plus registered/copied stores with a valid stored UUID.
