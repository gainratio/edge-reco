# Security Policy

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue.**

- Preferred: open a [GitHub private security advisory](https://github.com/gainratio/edge-reco/security/advisories/new)
  (Security → *Report a vulnerability*).
- Or email **harish.seshadri@gmail.com** with `SECURITY` in the subject.

Useful things to include: what you found, how to reproduce it, the affected
file/endpoint, and the impact you think it has. A proof-of-concept helps but isn't
required.

**What to expect:** an acknowledgement within a few days, and an honest assessment of
severity and fix timeline. This is a solo-maintained OSS reference project, not a funded
product — there's no bug-bounty payout, but credit in the fix/release notes is offered
unless you'd rather stay anonymous. Please give a reasonable window to ship a fix before
any public disclosure.

## Supported versions

Fixes land on the latest release on `main`. Older tagged releases are not patched —
upgrade to the current release.

## Security model (what's in scope)

EdgeReco's whole design is **trust the bundle only after verifying it, fail closed
otherwise**. The parts worth probing:

- **Signed catalog bundle.** The catalog is a content-addressed bundle
  (`latest` → `manifest/<hash>` → `chunk/<hash>`) signed with **Ed25519**. The client
  pins the public key **from its own origin at build time — never from the bundle** — and
  verifies the signature *before* any bundle data is trusted. Chunks are addressed and
  re-checked by **SHA-256**; nothing is promoted into the running engine until the full
  reassembly verifies. A bad signature, a hash mismatch, a truncated/tampered chunk, or a
  schema-version mismatch must **fail closed** (reject and refuse to serve), never silently
  degrade. Both tiers — the Python runtime and the in-browser `@gainratio/browser` engine —
  enforce this, and a tampered-signature rejection is covered by a real-browser e2e test.
- **Key handling.** `backend/examples/keys/public.key` is the pinned, committed verify
  key. The signing `private.key` is **gitignored** and never ships.
- **Offline integrity.** After one sync the engine runs entirely on-device with zero
  backend calls; the cached bundle in OPFS is the same verified artifact.

In-scope reports include: any way to get unsigned, mis-signed, tampered, or stale bundle
data accepted by either tier; key-pinning bypasses; or a path that turns a verification
failure into a silent fallback instead of a hard fail.

## Shopper data

No user data leaves the device. The shopper's activity (clicks, views, favorites, cart
adds) is stored only in an on-device SQLite database in their own browser. There is no
event endpoint, collector, or uplink, so nothing is sent to or stored on any server or
cloud. Two guard tests keep it that way: `frontend/app/src/storageBoundary.test.ts`
(app data stays in SQLite) and `frontend/app/scripts/network-allowlist.test.mjs` (the
built app can only talk to its own origin). A report that shows shopper data leaving the
browser is in scope.
