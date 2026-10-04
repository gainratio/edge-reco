# Security Policy

## Reporting a vulnerability

**Please report security issues privately — do not open a public issue.**

- Preferred: open a [GitHub private security advisory](https://github.com/hseshadr/edge-reco/security/advisories/new)
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

## Non-production components

The demo **`/events` collector** (`backend/src/edgereco/api/routes/events.py`) is a
*reference* component for the personalization flywheel demo — not a hardened
internet-facing service. It is request-bounded and supports an optional fail-closed shared
token (`EDGERECO_EVENTS_TOKEN`); set that token (and put it behind your own auth/rate
limiting) before exposing it beyond localhost. The flywheel uplink itself is optional,
off the inference path, and disabled unless `VITE_EVENTS_URL` is set.
