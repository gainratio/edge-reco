# Security and privacy contract

## TL;DR

No user data leaves the device. The shopper's activity is stored only in their own
browser's SQLite database, and nothing is sent to or stored on any server or cloud.

The hosted Nimbus demo downloads a public, signed catalog and runs queries and
personalization inside the browser. There is no analytics, no event uplink, no collector
and no application API in the build. Catalog integrity fails closed. Product photos are
self-hosted on the app origin, so showing them makes no third-party requests.

The data belongs to the shopper. They can wipe it with **Reset taste** or by clearing the
site's data. Export/import is not built yet.

## Trust boundaries and threat model

| Boundary | Trusted input | Enforced behavior | Residual risk |
|---|---|---|---|
| Browser app origin | Reviewed static JS, public key, model and WASM | CSP limits code/data connections to self; no third-party fonts, model, runtime, or query API | A first-load compromise of the app origin can replace both JS and its key. Bundle signing does not cure a compromised application origin. |
| Catalog CDN / bundle bytes | Ed25519 public key shipped with the app | Signed pointer, manifest and chunk hashes verify before promotion; malformed ranking/vector/co-occurrence data fails closed | A previously valid signed release can be replayed unless the deployment layer enforces freshness. Do not expose the signing private key to CI or Docker. |
| Browser device | OPFS, CacheStorage and in-memory profile | Catalog/model caches contain public artifacts; search and recommendation use local Workers with 60 s engine and 300 s first-embed deadlines; the taste log keeps at most 500 no-PII interaction records in the on-device SQLite database | Anyone with device/browser-profile access can inspect public catalog artifacts and the local taste log (product IDs, event types, timestamps only). |
| Production deploy | GitHub CI SHA and scoped Cloudflare credentials | Missing secrets fail red; Cloudflare must report the exact successful commit; `www` must permanently redirect to the apex | DNS/Cloudflare settings are external state and still require post-deploy verification and rollback drills. |

The main hostile cases are tampered or truncated bundle bytes, malformed signed data,
Worker crash/silence, oversized API input, API session-memory exhaustion, dependency or
container-context leakage, and a deploy that reports success without serving the
reviewed commit. The tests and release workflow name each corresponding failure
boundary; no integrity error falls back to unverified data.

## Privacy and egress inventory

| Data | Default hosted demo | Storage / retention | Network egress |
|---|---|---|---|
| Search text | Processed in the embedder/search Workers | Memory for the active operation; not persisted by EdgeReco | None after bundle/model sync |
| Click, view, favorite, cart | Folded into the in-tab session profile | `taste_events` table in the on-device SQLite database (`edgereco-catalogue`, OPFS pool): product ID, event type, timestamp. No user ID, no session ID, no PII. Rolling window of the newest 500 events, replayed locally on boot to rebuild the profile. When OPFS is refused or another tab holds the database, SQLite runs in memory and the log resets on reload; a status pill says so. Erased by "Reset taste" or by clearing site data | None. The app has no code that sends it anywhere |
| Catalog, embeddings, model, WASM, public key | Public release artifacts | OPFS, service-worker/transformers caches, HTTP cache | Same-origin sync/download only |
| Product images | Generated SVG product cards (a Lucide icon for the product's shelf on a pastel backdrop), self-hosted with the app under `/images/<product-id>.svg` (720 files, about 0.8 MB); the signed catalog's `image_url` is root-relative and no third-party image is loaded | Browser HTTP cache only; not precached by the service worker. The same cards are also signed into the bundle as `images/<id>.svg`, and a build guard (`frontend/app/scripts/check-product-images.mjs`) fails the build if any product's card is missing | Same-origin image requests only (`img-src 'self' data:`) |
| Self-hosted API-server search (optional, not in the demo) | Query text and parameters only; the server is stateless, keeps no session or profile, and ignores any session header | None; each request is ranked against an empty profile and nothing is kept after the response | Client-to-API request; normal access logs may contain the URL query and must be governed by the operator |

SQLite is the only store for app data. Other browser storage holds no shopper data:
the signed-bundle cache (content-addressed OPFS chunks plus `@gainratio/browser`'s
IndexedDB anti-rollback record `edgeproc-browser-cache`), the service-worker
CacheStorage (app shell and model), the transformers.js model cache, and a per-tab
sessionStorage "launched" flag.

There are no prompts, LLM providers, user embeddings, account records, backups, or
personal-data exports in this repository. Export/import of the shopper's data is not
built yet. Clearing site data removes all of it. "Reset taste" clears the SQLite taste
table and the live profile without touching the cached catalog/model.

Returning visitors from older builds are migrated on boot. The old OPFS file
`taste/events.jsonl` is copied into SQLite with an `app_migrations` marker in the same
transaction, then deleted (only when the database is durable). The old localStorage
keys `nimbus_session_id` and `nimbus_uplink_queue` are removed and their contents
dropped, never sent. Production never sent events: no deploy ever set an events URL.

Guards that fail the build if this changes:

- `frontend/app/src/storageBoundary.test.ts`: non-test source may not use
  localStorage, sessionStorage or IndexedDB outside a short allow-list.
- `frontend/app/scripts/network-allowlist.test.mjs` (in `test:artifacts`): the built app
  may not name a host outside the allow-list, open a beacon, WebSocket or EventSource,
  or loosen CSP `connect-src` / `img-src` from `'self'`.
- `backend/tests/unit/api/test_no_event_sink.py`: fails if a `POST /events` route returns.

## Operator requirements

- Keep the Ed25519 private key outside Git, CI build artifacts, Docker contexts, logs,
  and backups that are not explicitly protected as signing-key material.
- Treat API access logs as search-history data. Disable query logging or set a short,
  documented retention period appropriate to the deployment.
- A green release requires local gates, exact-sha Cloudflare identity, canonical-host,
  real-domain header/MIME/cache checks, clean browser console/network, and a tested
  rollback to an immutable Pages deployment.
