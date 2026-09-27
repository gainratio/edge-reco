# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- **The landing no longer claims a ~1.2 s cold start.** That figure came from a local
  headless run with the model served from localhost. Measured against the live site in
  real Chromium (7 cold runs in fresh profiles, 7 warm), a first visit takes a median
  ~2.6 s to first results on a fast connection and a return visit ~0.6 s. Every
  performance tile (first visit, search latency, heap) is now computed from a recorded
  measurement file, `frontend/app/src/metrics/live-measurement.json`, written by the new
  `pnpm run measure:live`; `landing-figures.test.ts` recomputes each tile from the raw
  runs and fails if the landing copy carries a timing or size of its own.

### Security
- **Backend substrate bumped: edge-proc 0.2.0 → 0.5.0, edgeproc-core 0.2.1 → 0.4.3,
  avow 0.3.0 → 0.4.1** (floors in `backend/pyproject.toml`; `uv.lock` moves only those
  three packages). The important one is edge-proc 0.3.0's HIGH-severity anti-replay fix:
  before it, an EQUAL version read as "fresh", so a genuinely signed older pointer at the
  same version label could replay onto the Python tier (`edgereco serve`, `retrain`,
  `audit`). A promote now needs a strictly greater `sequence`. The browser tier
  (`@edgeproc/browser` 02171df) already enforced this. avow 0.4.x changes none of the
  three calls EdgeReco makes (`content_hash`, `load_signing_key`, `sign_payload`).

### Fixed
- **Both server images booted into an `ImportError`** (pre-existing). avow ships its
  own older `assay/` package, so a fresh `uv sync --frozen` could leave it on top of
  assay-engine's and `edgereco.reco.formula` failed with `cannot import name
  'canonical_zero' from 'assay.composite'`. `deploy/Dockerfile` and
  `demo_server/Dockerfile` now finish with `uv sync --frozen --reinstall-package
  assay-engine` (lock-pinned and hash-checked, the image equivalent of Dagger's
  `ASSAY_INSTALL`). `tests/unit/test_assay_install.py` checks every installed
  `assay/*.py` against assay-engine's RECORD hashes and requires the reinstall to be
  each image's last sync.
- **Concurrent publishers on one origin are serialized.** The served-`latest` read
  and the `latest` write now happen under one `filelock` on
  `ORIGIN_DIR/.publish.lock` (separate from edge-proc's own store lock, and removed on
  release). Two publishers can no longer both sign N+1, and a slow N+1 can no longer
  land over an N+2; threaded tests pin both. `filelock` is now a declared dependency.
- **The served floor is parsed strictly and must be the publisher's own.** `latest`
  is read no-follow, regular-file-only (a FIFO no longer blocks), bounded to 64 KiB, and
  its `sequence` must be a plain JSON integer in [0, 2^53-1]. It must also carry a valid
  signature by the publishing key for this `--catalog-id` and the `stable` channel.
  Anything else is refused, so a tampered `latest` cannot push the floor out of range.
  `--sequence`, and the library's `sequence`, must be in [1, 2^53-1].
- **`VectorIndex` file I/O is no-follow and atomic.** `load` opens each source once
  (no-follow, regular file, at most 1 GiB) and copies from that descriptor. `save`
  writes each file through an `O_EXCL|O_NOFOLLOW` temp, fsyncs it and `os.replace`s it
  into place, so a planted symlink is replaced, never written through. The committed
  seed `vector/` still round-trips byte for byte.
- **The DEPLOY.md CI recipe could sign sequence 1.** It runs under `set -euo
  pipefail` and requires a numeric integer `sequence` from the served pointer, so a failed
  fetch or a malformed pointer stops the job before `edgereco bundle`.
  `tests/unit/test_deploy_sequence_recipe.py` runs the doc's own shell text against
  shims and real `jq`, which the Dagger Python toolchain now installs.

- **The publisher can no longer sign a sequence that returning shoppers refuse.**
  `edgereco bundle` used to default `--sequence` to 1 on every run, so re-bundling into
  an origin that already served a higher sequence signed a release every returning
  browser rejects as a rollback. Now `--sequence` defaults to one more than
  `ORIGIN_DIR/latest` serves, and an explicit value at or below it is refused before
  anything is written (`SequenceNotIncreasingError`, printed as `ERROR: ...`, exit 1).
  An unreadable or symlinked `latest` is refused rather than guessed past. `edgereco
  retrain` signed `synced sequence + 1` even when its target origin already served a
  higher one. It now signs one more than the higher of the two. The DEPLOY.md CI
  example built into a fresh directory, where the new default can only see an empty
  origin, so it now reads the served sequence and passes `--sequence` explicitly.
- **`vector/` stays in the signed-bundle format under edge-proc 0.4.1+.** edge-proc now
  saves a FAISS index as crash-atomic `snapshots/` generations with random names, and
  its `load` migrates a writable `index.faiss` + `state.json` pair into that layout,
  deleting the pair. Adopted as-is, that would have signed bundles without the
  `vector/state.json` the browser reads (every device fails closed) and made them
  non-reproducible. A server load would also have rewritten the materialized
  `vector/` that `retrain` copies into the next bundle. `VectorIndex` now writes the
  flat, deterministic `index.faiss` + `state.json` + `embeddings.f32` itself and loads
  from a private copy, never touching the source. The committed seed bundle's
  `vector/` round-trips through load and save byte for byte.

### Changed
- **The embedding model no longer downloads implicitly** (edge-proc 0.4.0). A
  `ProductEncoder` needs `EDGEPROC_MODEL_PATH` (a local model directory) or, on a
  build machine, `EDGEPROC_ALLOW_MODEL_DOWNLOAD=1`. `edgereco index` and `edgereco
  search` print the refusal as `[config.missing] ...` with both remedies, not a
  traceback. Both server images (`deploy/Dockerfile`, `demo_server/Dockerfile`) opt in
  explicitly, so `edgereco serve` and the flywheel collector still boot. That fetch
  is not pinned to a model commit, because no upstream revision is recorded in this
  project to pin against. DEPLOY.md ("The server images and the embedding model")
  states this and gives the pinned path (`EDGEPROC_MODEL_PATH` +
  `EDGEPROC_MODEL_DIGEST`). A contract test requires a model path to carry its digest
  and a download opt-in to point at that section. The test suite
  opts in from `tests/conftest.py`, and the two parity-fixture generators that embed
  with the real model opt in themselves. README, QUICKSTART and DEPLOY show the variable
  on every `index`/`serve` command. The browser tier self-hosts its own weights and is
  unaffected.
- `edgeproc keygen` now prints a second `key_id <16 hex>` line. QUICKSTART says so;
  nothing in this repo parses that output.
- **`docs/SECURITY-PRIVACY.md` no longer says product images are placeholders.** They
  are real product photos, self-hosted under `/images/<product-id>.jpg` (720 files,
  about 18 MB) and fetched same-origin. They are not precached and not part of the
  signed bundle.
- **README follows the portfolio template.** A plain-language first screen: a tagline
  that says what it does and for whom, "At a glance" (including exactly what leaves the
  device), and a "Try it in 60 seconds" walkthrough whose hero screenshot and pasted
  on-screen results were captured from the production build (`build:pages` + `vite
  preview`) searching "something for my aching back". Every existing section is kept
  below the fold. The stale demo GIF (blank product images, old "why?" panel) is
  removed, and the stale "category tiles" sentence now says product photos are
  self-hosted under `/images/`. `backend/pyproject.toml`'s `description` now equals the
  tagline; `backend/tests/unit/test_readme_contract.py` (run by `poe gate`) keeps the
  first screen in shape.
- **Truth-in-labeling for the "why?" panel and search docs.** The Avow section is
  now headed **Config provenance — Avow** (was "What verified — Avow"), its check
  reads **Ranking config signed by publisher** (was "Publisher signature verified"),
  and its limit line says the formula self-test runs on fixed synthetic test inputs,
  not on the displayed result. README, `frontend/README.md` and `docs/ARCHITECTURE.md`
  now say the ranking proof attests which config/formula shipped (one fixed synthetic
  probe per strategy), not that a result was computed from them, and state plainly
  that vector retrieval is exact flat search (FAISS `IndexFlatIP` / sqlite-vector full
  scan) — fine at demo scale (720 products), no ANN index yet. The demo-server
  docstring's "728-product" catalog is corrected to 720. The `edgereco.ranking-proof/v1`
  schema id, the signed bundle, and all behavior are unchanged.
- **`@edgeproc/errors` is installed from npm; the copy in this repo is deleted.**
  The library was vendored at `frontend/packages/edgeproc-errors/` as a snapshot of
  upstream commit `7705a72`. A copy cannot be upgraded, so it rotted quietly: by
  removal it was pinned at `0.1.0-dev` against a published `0.1.1`, sat **408 source
  lines** behind upstream, and was missing **8 exports** the library had grown
  (`corePack`, `aiPack`, `bundlePack`, `defineErrorsWith`, `DEFAULT_FALLBACK_CODE`,
  `UnregisteredFallbackError`, `KnownCategory`, `RegistryOptions`). Nothing was ever
  red, because nothing measured it.

  The copy held **zero local changes**: its `src/` and `test/` are byte-identical to
  upstream `7705a72`, so nothing was lost and nothing needed pushing upstream. Only
  packaging differed (`private: true`, a source-entry `exports` map, toolchain-matched
  devDependencies) — all of it an artifact of vendoring.

  Behaviour is unchanged. The seam `app/src/api/syncErrors.ts` is the only module that
  names the library and it was not restructured — one dependency line moved. All 6
  reused `starterPack` codes, their English strings, and the classification precedence
  are identical, and the shipped bundle does not grow.

  New guard: `app/scripts/errors-package-contract.test.mjs` fails if the dependency
  reverts to a local protocol, if a fork reappears under `frontend/packages/`, or if
  the *resolved* package in `node_modules` is not the published artifact — the last
  clause being the one that reads what actually loads, not what was asked for.

### Added
- **Recovery for a stuck returning shopper: "Clear cached catalog and retry".** When
  boot fails with an integrity refusal (`bundle.integrity_failed`), the boot screen
  now offers this action next to Retry. It never runs on its own. It clears only
  the synced signed catalog through `@edgeproc/browser`'s `EngineClient.clear()`, on
  a fresh sync Worker and under the cache's Web Lock. That covers the OPFS
  `chunk/` and `manifest/` directories and the active-pointer files, plus the
  IndexedDB rollback floor. It then deletes the `edgeproc-browser-cache` floor
  database, awaited and bounded to 10 s: `onblocked` keeps waiting, and a timeout
  fails loudly instead of reporting a floor as cleared. Only after all that does
  it boot again. Before the clear, any worker the failed boot left behind is torn
  down, so it releases its lock and OPFS handles.

  A **rollback** refusal is different. The server offered an *older* catalog than
  the one the browser holds, which is what an attacker able to serve an old,
  validly signed `latest` would cause. So the action first shows a plain-language
  tampering warning and needs an inline second click ("Yes, clear and retry").
  Other integrity refusals are a single click. Network, lock, storage, device and
  unknown failures keep Retry alone, because wiping the verified offline copy fixes
  none of them. The Worker's `EngineOperationError.code` is now carried through to
  the boot screen (`bootFailure()` in `app/src/api/syncErrors.ts`).

  Per the live-user storage covenant, no cache name, storage key or format changes.
  The service-worker caches, the self-hosted model's `transformers-cache`, and the
  on-device taste log are untouched. A new Playwright spec
  (`tests/e2e/catalog-recovery.spec.ts`) seeds a real returning shopper: a
  higher-`sequence` pointer in both OPFS and the IndexedDB floor, or a retired
  `bundle_id`. It proves that Retry never clears, that the rollback confirm is
  required, that the catalog loads after the clear with both floors back at the
  live `sequence`, and that a `transformers-cache` entry and an unrelated OPFS file
  survive.
- **An expired signed pointer is surfaced.** When the engine serves an
  already-verified cached catalog whose pointer is past its signed `expires_at`
  (`SyncResult.expired`, offline only), the app logs a coded
  `[edge-reco:bundle.expired]` console warning. The publisher sets no `expires_at`
  today, so this is a developer breadcrumb, not UI copy.

### Security
- **A revoked signing key no longer keeps verifying the ranking proof from the HTTP
  cache.** The ranking-proof check read the trust root (`public.key`) with
  `cache: "force-cache"`, and `_headers` serves that file `immutable` for a year, so a
  keyring that revoked a key could leave the proof panel trusting that key until the
  browser's cached copy expired, while the sync Worker (upstream `loadTrustRoot`,
  `cache: "no-store"`) had already stopped. The proof loader now uses `no-store` too;
  `runtimeRankingProof.test.ts` pins the cache mode. The service worker still precaches
  `public.key` so an offline reload can start the engine; the resulting
  one-page-load revocation lag for returning shoppers, and why a network-first route
  was not swapped in, are documented in `docs/DEPLOY.md` ("Revocation lag").

- **Worker-boundary sync failures are now classified by their stable engine code.**
  A failure inside the sync Worker reaches the main thread as `@edgeproc/browser`'s
  `EngineOperationError`, whose `.name` is always `EngineOperationError` — the
  category lives only in `.code`. `frontend/app/src/api/syncErrors.ts` classified by
  `.name` alone, so since the Worker engine landed (`a94e7f2`) every real signature,
  integrity, rollback, revoked/unknown-key, or expired-pointer refusal was logged as
  `internal.unknown` (or, if its message mentioned a fetch, the starter pack's
  retryable `net.unreachable`) instead of `bundle.integrity_failed`. The registry now
  maps every `EngineErrorCode` through a total, typecheck-enforced table —
  `integrity`/`rollback` → `bundle.integrity_failed`, `network` →
  `bundle.download_failed`, `lock` → `bundle.timeout`, `storage` →
  `bundle.quota_exceeded` (quota) or `bundle.device_unsupported`, `internal` →
  `internal.unknown` — and a missing or unknown code fails safe to
  `internal.unknown`; a Worker error never reaches the message-based network
  fallback. The in-thread name path also now recognises every `IntegrityError` /
  `SignatureError` subclass name (`RollbackError`, `PointerExpiredError`,
  `SyncCapError`, `ResponseTooLargeError`, `KeyringError`, `KeyRevokedError`,
  `UnknownKeyError`) and `StorageQuotaError`. The BootScreen still shows the engine's
  own message verbatim; only the canonical code changes. Sync stays fail-closed —
  this fixes the classification, not the verification.
- **The ranking-proof check reads the trust root the same way the sync Worker does.**
  `loadPinnedKey` (`@edgereco/browser` `runtime.ts`) accepted exactly 32 bytes, and
  the default loader capped the fetch at 32 bytes. Once `public.key` became an
  `edgeproc.keyring/v1` keyring (which the sync Worker already accepts), the proof
  would have dropped silently to `key_unavailable`. The trust root is now parsed
  with upstream `parseTrustRoot`, fetched up to `MAX_TRUST_ROOT_BYTES`, and the
  proof verifies under the keyring's **unrevoked** keys. A proof signed by a
  revoked or unlisted key fails `signature_invalid`, and a malformed trust root
  stays `key_unavailable`. New guard: `app/scripts/trust-root-contract.test.mjs`
  fails if the three committed `public.key` copies disagree, or if the served one
  stops parsing with the Worker's own parser. `docs/DEPLOY.md` now documents the
  rules: `sequence` must strictly increase across signing keys, `bundle_id` /
  `channel` must stay stable, and rotation goes through a keyring. The
  `edgereco bundle --sequence` help says the same.
- **`@edgeproc/browser` bumped `a94e7f2` → `02171df` (upstream `main`) for the
  rollback-floor fix.** Upstream #13: `syncIndex` used to re-verify the stored
  active pointer under the currently pinned key and, on a `SignatureError`, forget
  it — so any key change reset the anti-rollback floor and an OLD release re-signed
  by the new key was promoted with no freshness check. The stored pointer is now
  the floor whether or not the current key verifies it; serving the cached bundle
  offline still requires a valid signature under the pinned key. The same range
  also brings upstream #14 (a trust-root URL may serve an `edgeproc.keyring/v1`
  JSON keyring; optional signed `key_id` / `expires_at` pointer fields;
  `KeyRevokedError` / `UnknownKeyError` / `PointerExpiredError` map to the existing
  `integrity` Worker code; `SyncResult.expired` on an offline, expired cache) and
  #11/#12 (an opt-in `@edgeproc/browser/sqlite` app-state export edge-reco does not
  import). For edge-reco, the trust root stays the raw 32-byte `public.key`, the
  committed signed bundle and its pointers (no `key_id`, no `expires_at`) verify
  byte-identically, no storage key or format changes, and no call site changes. Only
  the two `package.json` pins, the contract test that pins them, and the lockfile's
  `@edgeproc/browser` entry moved, with no transitive changes. **One behaviour did
  change for returning shoppers.** A stored pointer the current key can't verify
  used to be dropped silently (the "stale pointer self-heals" path). It now stays
  as the rollback floor. After a republish with a lower `sequence`, a new signing
  key published without a higher `sequence`, or a changed `bundle_id` / `channel`,
  such a shopper hits the same integrity refusal on every Retry. The answer is the
  explicit **Clear cached catalog and retry** action below, plus the publishing
  rule in `docs/DEPLOY.md`.

- **`edge-proc` installs from PyPI, closing the last hole in `poe audit`.**
  pip-audit *skips* any URL requirement — "URL requirements cannot be pinned to a
  specific package version" — so while `edge-proc` was pinned to a git SHA it and
  everything under it were silently outside the scan. It was the only URL
  requirement left in this tree, so the audit now covers all of it. Measured:
  before, the run printed a skip table with `edge-proc` in it and the requirement
  read `edge-proc @ git+https://github.com/hseshadr/edge-proc.git@d88af07…`;
  after, the requirement reads `edge-proc==0.2.0`, 131 requirements are audited
  (up from 130), and pip-audit prints **no skip table at all**. Both runs exit 0
  with no known vulnerabilities.

  The pin's stated reason ("pending its own PyPI release") had been false for
  twelve days — `edge-proc` published 0.1.5 on 2026-07-22 and 0.2.0 on
  2026-08-01. Its second reason is retired rather than merely stale: uv honors a
  *git* dependency's own `[tool.uv.sources]`, which is why the rev had to be one
  whose `edgeproc-core` came from PyPI. A wheel carries no `[tool.uv.sources]`,
  only `requires_dist`, so consuming the release dissolves that constraint.
  `[tool.uv.sources]` is now empty and documented as deliberately so.

  This moves *forward*, not sideways: `d88af07` was on the 0.1.5 line, so the pin
  had been holding back 22 commits including fail-closed anti-rollback/anti-replay
  at promote and fail-closed FAISS index options. Floor only, no upper bound — a
  `<0.2` ceiling is exactly what forced the `avow` git detour, and that trap is
  not being re-armed.

  Relevance is bit-identical across the swap: natural nDCG@10 `0.42250285361220213`,
  P@10 `0.2333333333333333`; taxonomy-word nDCG@10 `0.761066848804909`, P@10
  `0.775` — the same values as the 2026-08-03 baseline, to full float precision.
  The ratchet reads a committed export and scores it with `assay`, so `edge-proc`
  is not in that path; the numbers confirm it.

### Changed
- **`/github` now links every public repository, not three of eight.** The page
  exists to hand crawlers a path to the source, and it was linking `edge-reco`,
  `edge-proc` and `edgeproc-core` only. The five it omitted — `almamesh`,
  `aml-filter`, `privacy-core`, `assay`, `ci` — each had **zero** pages indexed
  in Google, while all six repo URLs returned HTTP 200 to Googlebot. Nothing was
  blocking them; nothing had ever linked to them. Each repo now carries the
  describing sentence from the repository itself, because the anchor's
  surrounding copy is what a crawler weighs, and the page ships a
  `CollectionPage` + `ItemList` JSON-LD with a per-repo `sameAs`.
  `production-artifacts.test.mjs` pins the full set and requires ≥20 words of
  copy per entry, so a repo cannot quietly drop back into invisibility.
- **The site links out.** `edge-reco.com`, `aml-filter.com` and `almamesh.com`
  were three islands that linked to nothing but each other's absence — which is
  why `/edgeproc` sat at *Crawled – currently not indexed* despite being a
  well-formed 2,195-character page. The domain had no inbound authority. Every
  crawlable page (the SPA footer, `/github`, `/edgeproc`, `/faq`, the root
  `<noscript>`) now carries visible links to the other two live sites and to
  `github.com/hseshadr`, and `llms.txt` lists all eight repositories.
- **Diagrams are inline Mermaid; `docs/diagrams/` is gone.** The five `.d2`
  sources and their six committed SVGs are deleted. d2 emitted ~4:1 letterbox
  SVGs that GitHub's ~1000px column shrank until the labels were unreadable and
  the right third clipped; Mermaid renders natively with a zoom control, has no
  build artifact to go stale, and diffs in review. The README diagram is now
  five plain-language boxes with real numbers instead of an image plus a
  collapsible duplicate of its own source.
- **The diagrams also stopped lying.** The `.d2` sources predated the current
  architecture and drew a `Compute Worker` reading `SQLite WASM` and `IndexedDB`
  behind a `Hybrid Router` with a kill switch and a backend fallback. None of
  those exist in this repo — it is a sync worker and an embedder worker over
  OPFS, with an in-memory session profile. The Mermaid replacements describe
  what the code does and match the prose beside them.

## [0.13.0] — 2026-07-21

### Added
- **Durable on-device taste (still 0 backend calls)**: every folded interaction
  (click / favorite / cart / dwell-view) now appends to an append-only JSONL
  taste log in the browser's OPFS (`taste/events.jsonl`) through one storage
  seam (`src/signals/tasteLog.ts`) — versioned no-PII envelopes
  `{v, ts, type, productId, sessionId}`, rolling window of the newest 500
  events, atomic `createWritable` swaps, and per-line fail-soft parsing so a
  torn tail record can never poison boot (a corrupt line is skipped and the
  next append rewrites a clean file). Boot replays the log through the SAME
  fold used live (`buildProfile`), so a full reload keeps "Recommended for
  you" personalized and restores the For-You badge count. A failing storage
  layer degrades to the old session-only behavior, never a crash.
- **In-app PDP history**: opening a product pushes a `#/p/<id>` hash entry (no
  router library; static-host and offline safe), so the browser's Back button
  returns to browsing IN the app via `popstate` instead of unloading the
  document, and a reload or deep link on a PDP URL restores that product view
  without re-emitting a click.
- **"Reset taste" affordance** next to the For-You signal badge: wipes the
  durable log, the live profile, and the once-per-session signal caps, then
  re-ranks the rails back to the popularity baseline — with copy that tells
  the truth: activity is stored only in this browser, never sent to a server.
  The badge tooltip now reads "saved only in this browser", and the
  security/privacy contract documents the log's contents, 500-event retention,
  and both erasure paths (Reset taste / Clear site data).
- **Four Playwright property guards** (`tests/e2e/persistent-taste.spec.ts`,
  real Chromium + real OPFS): clicks re-rank the rail; a FULL RELOAD retains
  badge + personalization via replay (red-proven: disabling main-thread OPFS
  fails it 0-vs-3); browser Back from the PDP stays in-app with taste intact;
  Reset taste returns the rail to the settled baseline and survives a reload
  as empty.

### Fixed
- **The in-tab fold now honors bundle-supplied `interaction_weights`**: the
  browser `sendEvent` fold (and the new boot replay) passes the synced
  bundle's `ranking_config.json` weights to `applyInteraction` — mirroring the
  backend `/events` fold contract — instead of silently using the typed
  defaults, so republishing retuned weights retunes the in-browser hero loop
  too. The engine now exposes `SearchEngine.interactionWeights()`, and a
  retuned-bundle test (click weights zeroed) pins the contract.

## [0.12.0] — 2026-07-21

### Fixed
- **Small signal-family text now holds WCAG-AA 4.5:1**: `.metrics-strip__value`
  (14px metric values) and `.card__pick` (12px hover cue) render with the
  existing `--signal-ink` token (4.89:1 on `--paper`, 5.18:1 on `--paper-raise`)
  instead of the hot `--signal` (3.07:1 / 3.25:1). `theme.contrast.test.ts` now
  measures those two rules' resolved tokens as a property, so a future palette
  tweak below 4.5:1 fails with the measured ratio.
- **Sound heading outline on home/browse**: the product grid — owner of the
  single page `<h1>` — now precedes the rail `<h2>`s in DOM order, with a
  `.shop--browse` flex-`order` rule keeping the visual stack (rails above grid)
  unchanged. Guarded by a Storefront mount test on document positions.
- **The hybrid parity fixture generator replays `/search`'s real scoring**:
  `scripts/gen_hybrid_fixture.py` called the retrieval-less `rerank()` while the
  route (and the browser engine the fixture arbitrates) blend normalized RRF
  retrieval via `rerank_search()`. The weekly parity workflow's red on
  `hybrid_parity.json` was this script drift — the committed fixture was correct
  all along, and the fixed script regenerates it byte-for-byte. Pinned by a
  model-free regression test. `embedding_parity.json` refreshed with CI-exact
  bytes (float-only drift, ids/order intact, max delta 1.4e-07).

### Added
- **Measured release contract for the real browser path**: the C1 Chromium gate now
  boots the committed 720-product signed catalog with the real q8 MiniLM model,
  proves the Timberland waterproof boot is the first result for its exact query,
  rejects every request outside the app and signed-bundle origins, and enforces
  cold-start (30 s), warm-search (p50 300 ms / p95 750 ms), heap (512 MiB), and
  zero-backend-call budgets. The architecture and new security/privacy contract
  publish the same numbers, timeouts, retention bounds, data inventory, and
  residual risks.
- **Bounded API sessions**: the optional server now holds at most 10,000 session
  profiles, expires them after one hour idle, and evicts least-recently-used
  profiles deterministically under pressure.
- **Internationalization (i18next) across the app** (#36): `i18next` +
  `react-i18next` initialized in `src/i18n.ts` with bundled **offline** English
  catalogs (no runtime fetch), so user-facing copy resolves through `t()` and a
  locale can later be added as a pure copy-paste. Landing, Footer, Header,
  MetricsStrip, WhyPopover, BootScreen, and OfflineBadge copy moved into the
  `common` / `landing` / `storefront` / `errors` namespaces; numeric facts still
  interpolate from `landing-figures.ts`. `locales.parity.test.ts` auto-enforces
  exact key parity for any future locale, and a headless-Chromium
  `scripts/verify-i18n.mjs` gate asserts the Landing renders translated copy with
  a clean console in CI.
- **Canonical errors: vendored `@edgeproc/errors` + bundle-sync classification**
  (#37): the portfolio canonical-errors standard adopted at
  `frontend/packages/edgeproc-errors/` (zero runtime deps, TS source consumed
  directly), with a new `app/src/api/syncErrors.ts` seam whose
  `bundleErrorRegistry` classifies the demo's one user-facing failure — the
  signed catalog-bundle sync — into stable canonical codes
  (`bundle.download_failed`, `bundle.integrity_failed`, `bundle.timeout`,
  `bundle.device_unsupported`, `net.unreachable`, `internal.unknown`) keyed on
  the engine's typed error names. Behaviour-identical: the same raw failure still
  renders the same message and the same `errors.*` i18n string.

### Security
- **Zero third-party storefront egress by default**: remote catalog-image URLs now
  render as local editorial category tiles, the app uses platform-native fonts,
  and CSP/service-worker configuration no longer permits or caches Google Fonts,
  Amazon image hosts, Hugging Face, or jsDelivr. Release-owned root-relative
  product images remain supported.
- **Collector Docker context narrowed to `backend/`**: the optional image resolves
  release-tagged dependencies from `uv.lock`; sibling repositories, `.env` files,
  signing keys, PEM files, VCS state, and host caches never enter the build context.
- **Additive HTTP security headers + CI least-privilege permissions** (#32):
  a `/*` block of non-resource-restricting headers (`X-Content-Type-Options:
  nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: SAMEORIGIN` + `Content-Security-Policy: frame-ancestors
  'self'`, `Cross-Origin-Opener-Policy: same-origin`, a deny-by-default
  `Permissions-Policy`) that cannot break the same-origin ONNX/WASM/worker
  pipeline, and top-level `permissions: contents: read` on the CI and
  security-audit workflows (deploy already had it).
- **CodeQL URL and randomness alerts resolved** (#33): the product-image host
  check now matches `media-amazon.com` exactly or as a proper subdomain
  (was a spoofable `endsWith` substring test), and the session-id fallback
  uses `crypto.getRandomValues` instead of `Math.random` — telemetry disables
  itself rather than minting a weak id when Web Crypto is unavailable.
- **The in-browser embedder now fails closed on a missing local model
  weight**: `env.allowRemoteModels = false` (transformers.js defaults it to
  true), so a missing/renamed file under the self-hosted `/models/` mirror
  throws instead of silently falling back to an unpinned model on the
  Hugging Face CDN. Belt-and-suspenders on top of the cold-CDN-blocked e2e;
  the Node parity path (test-time HF fetch) is untouched.

### Changed
- **`edgeproc-core` now installs from PyPI** (`>=0.2.1`, locked to the registry
  release): the retired `shared-libs-python` git pin is gone from
  `[tool.uv.sources]` and `uv.lock` (zero git refs for it remain), and the
  `edge-proc` pin moved to `d88af07` (same v0.1.5 line, src-identical), the
  first rev whose own sources consume edgeproc-core from PyPI. Docs, SEO pages,
  and type-checker paths updated for the repo rename
  (`shared-libs-python` → `edgeproc-core`).
- **`@edgeproc/browser` public surface trimmed** (0.5.0): `EMBEDDING_MODEL` and
  `DEFAULT_RANKING_CONFIG` are engine-internal again — the model id is wired
  inside `createEmbedder` and the runtime reads ranking config from the signed
  bundle; no consumer imported either. `EMBEDDING_DIM` and the config *types*
  remain exported.
- **Search reranking preserves query relevance**: the normalized BM25/vector RRF
  signal contributes a measured 0.20 relevance component before session-aware
  product signals. Cross-tier parity and a real-model regression prevent a popular
  personalized apparel item from outranking the exact waterproof hiking boot.
- **Deployment success now means production identity**: missing Cloudflare secrets
  fail visibly; Wrangler records the exact CI SHA; the workflow waits for a
  successful Cloudflare production deployment with that SHA and rejects a missing
  or lossy `www` → apex permanent redirect. `public.key`, signed bundle bytes,
  Vite assets, model weights, and ORT files receive explicit MIME/cache contracts.
- **Production SEO, crawlability, and static delivery hardened** (#34): more
  crawlable root HTML with tighter search snippets, route-specific Open
  Graph/Twitter metadata for `/edgeproc`, `/github`, and `/faq`, sitemap
  `lastmod` values, a real noindex `404.html` replacing the SPA catch-all for
  unknown routes, HSTS + a resource-aware CSP with hashed JSON-LD, wildcard
  CORS removed from same-origin static responses, and built-artifact
  regression tests (`scripts/production-artifacts.test.mjs`) wired into the
  frontend gate. Recommendation and search logic unchanged.

## [0.11.0] — 2026-07-12

### Fixed
- **Deploy entrypoint invoked a nonexistent `edgereco sync` command**, so the
  demo container crashed on boot. The entrypoint now boots `edgereco serve` in
  signed-bundle mode (`EDGERECO_BUNDLE_BASE_URL` + `EDGERECO_VERIFY_KEY_PATH`,
  baked into the image with the demo catalog's committed public verify key) —
  `serve` self-syncs the content-addressed bundle fail-closed at startup. A new
  deploy smoke test (`backend/tests/integration/test_deploy_entrypoint.py`)
  executes every `edgereco <subcommand>` the entrypoint invokes against the
  real CLI and rejects dead env knobs / missing COPY sources, so the deploy
  scripts can no longer rot against the CLI.
- **A crashed embedding Web Worker hung every in-flight request to the timeout
  deadline** instead of failing fast. The engine client now rejects all pending
  requests with a typed `WorkerCrashError` the moment the worker fires `error`
  or `messageerror` (a reply that fails structured-clone), and latches so
  requests issued after the crash reject immediately.
- **The main-thread embedder client ignored `messageerror`**, so an embedder
  reply that failed structured-clone deserialization left the embed hanging to
  the deadline. It now wires `messageerror` for parity with the engine client
  and rejects the pending embed fast.
- **The browser query encoder was not bound to the catalog's declared embedding
  model**, and stale materialized index files could survive a rebuild.
  Publishing now binds the query encoder to the declared model and prunes stale
  materialized files, so query- and document-time vectors can never drift apart.
- **A stale search could overwrite newer results (latest-wins race).** A slow
  older query that resolved after a newer one repainted the grid with outdated
  results; the grid loader now guards every state write behind a monotonic
  request id, so only the latest query paints (and owns the loading flag).
- **One corrupt OPFS chunk poisoned every subsequent load forever.** A chunk
  that failed its content-address check on read left `hasChunk` true, so the
  sync loop never re-fetched it. The store now evicts the bad object on an
  `IntegrityError` (the read still fails closed) so the next sync self-heals by
  re-fetching it. Cache names, storage keys, and the OPFS bundle format are
  untouched — eviction operates on the content-addressed chunk object.
- **`publish` followed symlinks under the staging directory**, which would
  inline an arbitrary host file into the *signed* bundle (arbitrary-file read).
  It now refuses a symlinked staging entry before `is_file()` follows it and
  fails closed.

### Changed
- **Substrate legos bumped in dependency order (house standard §7):**
  `edge-proc` v0.1.1 → **v0.1.2** and `shared-libs-python` v0.1.2 → **v0.1.3**
  (edge-proc v0.1.2's metadata re-pins shared-libs v0.1.3, so both move
  together — a single-tag bump fails closed on conflicting git URLs). Lock
  lines verified moved; both upstream releases are gate/CI/docs-only.
- **`shared-libs-python` declared as a direct `[project.dependencies]` entry**:
  `edgereco.embeddings.index` imports `shared_libs_python.vector_mgmt` directly,
  so the manifest now states the dependency honestly instead of relying on it
  transitively via edge-proc (the `[tool.uv.sources]` entry already existed).

### Added
- **SEO entity hub**: GitHub links in the header ("Open source") and the site
  footer (now rendered on every view, Landing included), entity-page
  cross-links (`/edgeproc`, `/faq`, `/github` each carry a `footer.entity-nav`),
  and the homepage JSON-LD upgraded to an `@graph`
  (SoftwareApplication + SoftwareSourceCode + Person with `sameAs` → GitHub).
- **Cold-CDN-blocked e2e proof** (`tests/e2e-offline/cold-blocked.spec.ts`):
  the minified production build boots, loads the real model, and serves a real
  search with every HuggingFace host AND jsDelivr aborted — plus a provenance
  assertion that every cached model URL is same-origin.
- **One canonical gate per stack** (house standard §3): frontend root
  `pnpm gate` (= `gate:quality` + `gate:e2e`) and a dual-stack root
  `make gate`; CI jobs now run these exact commands instead of hand-copied
  step lists.
- **gitleaks CI job** (full-history, `fetch-depth: 0`) and a **`pnpm audit`
  lane** in the weekly security-audit workflow.

### Changed
- **The in-browser embedder makes zero runtime CDN fetches (house standard
  §8.1b).** The `all-MiniLM-L6-v2` weights are self-hosted under `/models/`
  (mirrored at build time by `scripts/download-model.mjs` — sha256-pinned,
  idempotent, fail-loud) with an explicit `dtype: "q8"` pin, and the
  onnxruntime-web wasm runtime is self-hosted under `/ort/`
  (`scripts/stage-ort-wasm.mjs`, staged from the lockfile-pinned node_modules
  copy). The new cold-blocked e2e caught the runtime dynamically importing its
  wasm loader from jsDelivr — a previously invisible CDN dependency; offline
  only worked because the service worker had runtime-cached it. Every mirrored
  file sits under Cloudflare Pages' 25 MiB single-asset limit, pinned by
  preflight tests. Existing clients upgrade cleanly: cache names, storage keys,
  and the OPFS bundle format are untouched (the old HF/jsDelivr runtime-cache
  routes remain as legacy fallbacks).
- transformers.js now owns the model's offline copy in its `transformers-cache`
  (was: SW CacheFirst over the HuggingFace host), with the Vite build target
  raised to `es2022` (the private-field downlevel crash guard).
- Backend complexity gate tightened to **xenon A/A/A** — the seven rank-B
  blocks (CLI `search`/`preprocess`, reco signals/audit/recommend candidates,
  API search route) were refactored to rank A with behavior-preserving helper
  extractions; 290 tests green at 99.75% coverage.
- `poe audit` switched to the portable §4 invocation (`uv export --frozen` →
  `pip-audit -r … --disable-pip --no-deps`): the audit now covers exactly what
  the lock pins, not whatever happens to be installed.
- CI e2e job's HuggingFace runtime-download cache replaced by a fixed-key
  cache of the self-hosted weights, shared by the frontend, e2e, and deploy
  jobs; the C1 embed suite dropped from minutes to seconds.
- `astral-sh/setup-uv` full-pinned to v8.3.2 in both workflows.

## [0.10.1] — 2026-06-27

A quality, security, and hardening release. No functional product changes — the signed
catalog bundle is byte-identical to 0.10.0 — but the code-quality bar is now *enforced*
rather than aspirational, a CVE is fixed at the root instead of suppressed, and several
fail-closed / robustness gaps are closed.

### Security
- **Dropped the torch CVE-2025-3000 suppression in favor of the real fix.** Pinned
  `torch >= 2.12.1` (the version that fixes the CVE) and removed `pip-audit
  --ignore-vuln`; the dependency audit is now genuinely clean, with zero suppressions.

### Changed
- **The no-explicit-`Any` ban is now enforced**, not just documented. Added ruff
  `ANN401` (repo-wide) + mypy `disallow_any_explicit`, plus an AST guard test that
  forbids `Any` in any annotation across `src` — closing the gap where a model-field
  `dict[str, Any]` could evade both tools. Eliminated every existing explicit `Any`:
  source annotations narrowed to precise `Mapping`/union types (annotation-only, so the
  bundle is unchanged), and the pytest-bdd context replaced with typed `StepContext`
  dataclasses.
- **`/events` hardening:** wire models reject unknown fields (`extra="forbid"`),
  `session_id` is length-bounded, the unknown-product warning is aggregated per request,
  the auth settings are resolved once instead of per request, and the fail-closed bundle
  loaders are promoted to public functions in `api/deps.py`.
- **Coverage is gated on both tiers.** Added `@vitest/coverage-v8` thresholds to both
  frontend workspaces and raised the Nimbus app's view-layer line coverage from ~62% to
  ~92% with real component tests; the offline-PWA Playwright proof now runs in CI.
- **README architecture diagram** now embeds a pre-rendered SVG
  (`docs/diagrams/architecture.svg`) with the Mermaid source preserved in a collapsible
  block, so it renders even where GitHub's `viewscreen` Mermaid iframe is blocked.

### Fixed
- **`/events` returns 401 (not 500) for a non-ASCII bearer token** — the comparison is
  byte-based and still rejects (no bypass).
- **The telemetry uplink can no longer throw into the click handler.** `localStorage`
  reads/writes are fully guarded, so a full/disabled store (quota, private mode) degrades
  to in-memory instead of escaping the fire-and-forget path.
- **The browser engine validates the whole product row** before use — numeric
  `popularity_score`/`price`/`freshness_score`, string `title`/`category`/`brand`, array
  `tags`, positive-integer index/count — and raises the typed `VectorIndexError` on every
  malformed-bundle path, so a malformed-but-signed bundle fails closed instead of
  silently corrupting ranking.
- **No duplicate cards in a rail** (dedupe by normalized title at the render layer,
  parity-safe) and **stable, unique rail heading ids** derived from the rail key.
- Repaired broken relative links in `edgeproc-browser/README.md` and
  `demo_server/README.md`; corrected a stale strategy-count code comment and removed a
  stale `docs/superpowers/` reference.

### Removed
- Four orphaned diagram SVGs and their `.d2` sources (including the stale pre-pivot
  `demo-architecture` diagram that contradicted the backend-free positioning).

## [0.10.0] — 2026-06-26

### Added
- **Installable, offline-capable PWA.** The Nimbus storefront is now an installable
  Progressive Web App that works **fully offline after one online sync**. A Workbox
  service worker precaches the app shell and the ~25 MB embedding model; the signed
  catalog bundle stays OPFS-owned, preserving the Ed25519 + SHA-256 fail-closed
  guarantees. Adds an in-app install affordance (install button + offline badge).
  Offline operation is proven by a real-browser Playwright e2e (`test:e2e:offline`):
  warm online, cut the network, reload — the store still mounts and ranks.
- **`SECURITY.md`** — private vulnerability-reporting policy plus the signed-bundle
  trust model (Ed25519 verify-before-trust, SHA-256 content-addressing, pinned key).
- A **"View source on GitHub"** link on the landing page.

### Changed
- **Open-source launch.** Relicensed from Apache-2.0 to **MIT** (LICENSE + all
  package manifests); `NOTICE` retained for third-party data attribution only.
- **Clone-and-go onboarding.** The backend pulls its substrate libs (`edge-proc`,
  `shared-libs-python`) from public GitHub via git sources pinned to release tags,
  so `git clone … && cd backend && uv sync` builds with no sibling checkout. CI
  dropped the private-sibling checkout + path-patch + `PORTFOLIO_PAT` secret and now
  builds exactly as an external cloner does. A commented path-source override remains
  for substrate co-development.
- **Plain-language docs.** README and the SPA landing lead with the value proposition
  in non-technical terms (zero per-query cloud cost, scales on the clients not the
  servers, resilient on weak/dropped connections), make explicit that companies — not
  shoppers — bear cloud search/reco cost, add a Mermaid architecture diagram, and
  cross-link the `edge-reco → edge-proc → shared-libs-python` stack as one system.
- **Docs tidy for the public repo.** Removed the pre-pivot `docs/archive/` and the
  internal `docs/superpowers/` planning docs from the published tree (preserved in
  project history); fixed the references that pointed at them; relabeled the
  `DEPLOY.md` compose snippet as abridged.

### Fixed
- **`audit` now fails closed.** The `edgereco audit` path threads the bundle schema
  version into the co-occurrence and ranking-config loaders, so a schema-mismatched or
  corrupt bundle is rejected instead of silently degrading to an empty matrix / default
  weights — matching the serving path.
- **Demo `/events` collector hardened.** Request batches are capped
  (`max_length=1000`, oversized → 422) and an optional fail-closed bearer token
  (`EDGERECO_EVENTS_TOKEN`) guards `/events` and `/events/export` (unset = open, so the
  local flywheel demo keeps working tokenless).
- **Uplink no longer double-sends or drops events on tab unload.** The in-flight batch
  is claimed before the network call, so a concurrent `flushBeacon()` only beacons the
  un-sent tail (restoring order on failure). Still fire-and-forget, off the inference path.
- **Browser engine validates bundle data fail-closed.** `products.jsonl`,
  `catalog_meta.json`, and the vector state are now runtime-validated (rejecting
  malformed data) instead of unchecked casts; live performance entries degrade-and-skip
  rather than throwing.
- Internal: the scorer's reputation penalty was rewritten to an explicit
  single-subtraction form (behavior-preserving; Python↔TS scoring stays byte-identical).

## [0.9.0] — 2026-06-11

### Added
- **Richer interaction signals** — the storefront now emits the full graded
  vocabulary the engine and retrain already understood: a favorite heart
  (once per product per session; unfavoriting is visual-only), add-to-cart
  (every press; header cart pill; first add carries a "nothing is purchased"
  honesty note), and capped ambient dwell views (≥75% visible for 2 s, once
  per product, silent). Cart-over-clicks facet dominance is pinned against
  the real engine fold in `signals/gradedSignals.test.ts`; a single cart-add
  visibly re-ranks the rail in e2e. Zero engine/backend/weight change;
  parity fixtures byte-identical.

### Changed
- The rail badge counts all explicit signals (clicks + favorites + cart-adds)
  app-side; product cards are now `<article>` roots with a full-card
  "add to taste" overlay button plus layered signal buttons (keyboard
  focus-visible styles included), and the image hover-zoom is driven from
  card-level CSS.

## [0.8.0] — 2026-06-08

### Added
- **Intro landing + live metrics** — the SPA now opens on a landing page that
  explains what EdgeReco is and why running discovery in the browser is effective,
  then a **"Launch the live demo"** button boots the engine. Inside the store, a
  live `MetricsStrip` shows REAL in-browser measurements: recommendation latency,
  backend calls after sync (0), cold start, JS-heap memory, and catalog size.
  Honesty is enforced and tested — memory is labelled "JS heap (Chromium)" and
  hidden when unavailable (never faked); the "0 backend calls" counter excludes
  product images and the optional uplink; the cost figure is labelled
  "illustrative". New `src/metrics/*` (store + classifier + observers),
  `Landing` / `MetricsStrip` components, and instrumentation in `api/client.ts`,
  `App.tsx`, and `Storefront.tsx`. Design captured in an internal design spec
  (since archived).

### Changed
- **Demo allocates random free ports per run** — `make demo` / `poe demo` /
  `poe demo-flywheel` no longer pin :8081 / :5174 / :8000. A single orchestrator
  (`frontend/app/scripts/demo.mjs`) picks free ports and wires them through the
  compose port-mappings, Vite, the collector CORS allow-list, and the edge
  preflight, removing cross-project and stale-container port collisions. Standalone
  `docker compose up` still defaults to 8081/8000/5174. The poe tasks,
  `backend/pyproject.toml`, and the Makefile are now thin wrappers over the one
  orchestrator.
- Demo SPA dev port moved to **5174** (was 5173), pinned via Vite `strictPort` so it
  fails loudly rather than silently landing elsewhere. The collector CORS allow-list,
  Docker port mapping, Playwright e2e, and docs were updated to match.

## [0.7.0] — 2026-06-05

### Added
- **Flywheel retrain (the loop closes)** — the cloud half that v0.6.0's uplink set
  up: aggregate the collected interaction events → recompute `popularity_score` →
  rebuild, **re-sign, and republish** the content-addressed bundle (new `latest`).
  Both tiers (Python core + `@edgeproc/browser`) pick up the new popularity on
  their next sync — **with zero scoring-formula changes**, because the scorer is
  coefficient-driven and reads `popularity_score` straight off the synced product.
  The prebuilt FAISS `vector/` is reused verbatim (embeddings depend on product
  text, not popularity), so a retrain re-encodes nothing.
  - New `GET /events/export` aggregates the collector's event buffer into weighted
    engagement per product (the retrain read seam).
  - New `edgereco retrain` CLI: sync the current bundle → fold in engagement →
    republish a freshly signed bundle (`backend/src/edgereco/republish.py` +
    `reco/retrain.py`). Engagement is an additive, max-normalized boost
    (`new_pop = clamp01(base_pop + α · engagement_norm)`, `α` tunable).
  - New `poe demo-retrain`: after clicking around under `poe demo-flywheel`,
    recompute + republish into a **runtime origin** (the demo edge serves a
    writable copy seeded from the committed bundle, so the committed seed stays
    byte-stable). Refresh the SPA — the edge revalidates `latest` within 30s and
    the rail re-ranks toward what was clicked. Requires the maintainer signing key
    (`examples/keys/private.key`, gitignored) since the bundle is re-signed.

## [0.6.0] — 2026-06-05

### Added
- **Flywheel uplink (the "events back to the cloud" loop)** — clicks are now
  captured in-tab, persisted (localStorage), and periodically flushed in batches
  to a "mimicked cloud" collector (the existing FastAPI `/events`). It is an
  **optional, async, fire-and-forget beacon kept entirely off the inference
  path** and **off by default**: with `VITE_EVENTS_URL` unset the demo makes zero
  backend calls (the headline invariant holds). New `poe demo-flywheel` brings up
  the collector container and runs the SPA with the uplink enabled; a `SyncBadge`
  shows "N interactions synced to cloud". Implemented in
  `frontend/app/src/telemetry/uplink.ts` (bounded queue, `fetch(keepalive)` +
  `navigator.sendBeacon` on unload), wired into `sendEvent` without touching the
  in-tab rerank. The collector's `/events` gained an optional in-body `session_id`
  so beacon batches (which can't set headers) attribute correctly.
  _Retrain half (aggregate events → recompute popularity → republish the signed
  bundle) is intentionally future work._

## [0.5.1] — 2026-06-03

Make the turnkey `poe demo` robust against a cross-project Docker collision that
surfaced as a cryptic **"signature verification failed"** in the browser. The
engine, signed bundle, pinned key, and fail-closed verify were all correct — the
failure was purely in demo orchestration when another project occupied `:8081`.

### Fixed
- **Isolated the demo's Docker namespace** — `frontend/docker-compose.yml` now pins
  `name: nimbus-demo`, so its volumes/network are `nimbus-demo_*` instead of the
  directory-derived default `frontend`. A sibling repo with its own `frontend/`
  compose dir no longer shares (and contaminates) the same `caddy_data` volume.
  This was the root cause: a foreign-but-valid signed `/latest` answered on `:8081`
  and failed the SPA's pinned-key verify.
- **`poe demo` now fails clearly, early** — the task runs `docker compose up -d
  --wait` (no startup race) and a preflight (`frontend/app/scripts/check-edge.mjs`)
  that asserts `:8081/latest` matches this repo's committed bundle pointer before
  opening the SPA. If another project occupies `:8081`, the user gets an actionable
  terminal message instead of a browser crypto error.

### Added
- **Preflight regression test** — `frontend/app/scripts/check-edge.test.mjs`
  (`pnpm test:preflight`, zero-dep `node:test`) covers the match / foreign-bundle /
  unreachable / non-200 / malformed-pointer branches; wired into CI.

## [0.5.0] — 2026-06-01

The session-aware reranker now *shows*: clicking products visibly re-ranks the
"Recommended for you" rail, backed by a balanced multi-category demo catalog.

### Added
- **Streaming demo-catalog curator** — `backend/scripts/curate_demo_catalog.py`
  builds a balanced, reproducible catalog source (`backend/examples/source/catalog.csv`)
  by streaming a real Amazon metadata parquet (memory-bounded; never loads the
  source's embeddings column). Pass `--source <parquet>`.

### Changed
- **Affinity-first recommendation rail** — clicking products now *visibly* re-ranks
  "Recommended for you". `recommend()` selects its candidate pool by session affinity
  when warm (popularity backfills only when there are fewer than `limit` matches);
  cold start stays popularity top-N. The scoring formula is unchanged — only candidate
  *selection* changed. Implemented byte-parity in the Python core (`reco/pool.py`) and
  the in-browser engine (`poolSelection.ts`).
- **Demo catalog rebuilt to 720 products across 12 balanced categories** (60 each), so
  session-aware reranking has real signal to act on (the previous bundle was ~98% one
  category). The committed signed bundle is re-signed with the existing pinned key, so
  fail-closed verification is unaffected.

### Fixed
- The "Recommended for you" rail no longer appears frozen on click — a data + candidate-
  pool problem, not a wiring bug (the click → profile → rerank loop was always correct).

### Docs
- Re-attributed the demo catalog to the **Amazon Reviews 2023** dataset (McAuley Lab,
  UC San Diego) in `NOTICE` and the README, with the underlying-content rights caveat.

## [0.4.1] — 2026-05-31

Developer-experience polish: a one-command, browser-opening demo runner.

### Added
- **Turnkey `poe demo` task** — `cd backend && uv run poe demo` brings up the
  signed-bundle Caddy edge (`:8081`), starts the Vite SPA (`:5173`), and opens the
  storefront in your browser: one command from clone to running in-tab. Surfaced in
  the README "Try it" section, `docs/ARCHITECTURE.md`, and `docs/QUICKSTART.md`.

## [0.4.0] — 2026-05-30

Public-launch readiness: legal attribution for the demo dataset, a clear
fictional-product disclaimer, a two-altitude README, and a reusable sync-tier
export — so a cold visitor sees an honest, runnable, properly-credited demo.

### Added
- **`@edgeproc/browser/engine`** — new stable public subpath export promoting the
  domain-agnostic sync tier (`EngineClient`, OPFS/memory CAS stores, the
  `syncIndex` state machine, crypto + wire types) to a first-class API. Previously
  reachable only behind the `./testing` seam marked "NOT production surface"; now
  a reusable sync tier for downstream consumers of the edgeproc pattern. Purely
  additive — the `.` (search) and `./testing` surfaces are untouched.
- **`NOTICE`** crediting the demo catalog's source: the Kaggle "Amazon
  E-commerce Products & Reviews Dataset" (MIT), with an Amazon Terms-of-Service
  caveat for the underlying product data.
- **Fictional-demo footer** in the storefront UI making explicit that "Nimbus"
  is a fictional store and the catalog is third-party sample data — plus
  browser/backend parity and config comments clarifying the shared search knobs.

### Changed
- **Two-altitude README**: a plain-language front door (what it is, how to run
  it) above an "under the hood" section for engineers, heroing the in-browser
  personalization story and surfacing the `edge-proc` dependency.
- **Offline-resilient `syncIndex`**: when the signed index can't be fetched, the
  browser tier now falls back to the cached active version instead of failing.

### Fixed
- **License consistency**: project unified on **Apache-2.0** (the README badge
  previously contradicted the declared license); data attribution corrected.
- npm→pnpm drift in the docs; e2e storefront screenshots redirected to a
  gitignored `test-results/` path.

## [0.3.0] — 2026-05-29

Hardening: full test pyramid wired into CI, modern dependencies, and a
discoverable config surface — so the repo is not just clear but provably works
end-to-end on a cold clone.

### Added
- **Playwright e2e in CI** (`.github/workflows/frontend.yml`): the storefront
  suite and the C1 sync suite now run on every push/PR, with HuggingFace model
  weights cached and traces uploaded on failure.
- **In-browser model-load smoke test** (`frontend/app/tests/e2e-c1/embed.spec.ts`
  + `embed-harness.html`): loads the real MiniLM model through onnxruntime-web
  WASM in headless Chromium and asserts a normalized 384-d embedding — guarding
  the browser ML path that unit tests (Node backend) can't cover.
- **`.env.example`** for both `backend/` and `frontend/`, documenting every env
  var the code reads, referenced from a new README "Configuration" section.
- Typed Pydantic response models for the API routes (`backend/.../api/models.py`).
- Backend `poe gate` task mirroring CI (lint + format-check + mypy + pytest-cov).

### Changed
- **Dependencies modernized.** Backend: mypy 1.20→2.1, polars 1.41,
  pydantic 2.13.4, sentence-transformers 5.5, typer 0.26, uvicorn 0.48, plus
  raised constraint floors. Frontend: transformers.js 3.8→4.2 (onnxruntime-web
  1.26-dev), jsdom 26→29; pinned Node via `engines` + `.nvmrc`.
- `@edgeproc/browser/testing` is now browser-safe; the node-only fixture loader
  moved behind `@edgeproc/browser/testing/fixtures` so importing the test-seam
  barrel never drags `node:fs` into a browser bundle.

### Fixed
- **Both Playwright suites were silently broken** since the `backend/`+`frontend/`
  restructure: `catalog-server.mjs` still resolved the signed catalog at the
  pre-restructure repo-root `examples/` instead of `backend/examples/`.
- Removed `@rolldown/binding-darwin-arm64` from direct deps (it is an optional
  per-platform binding) — `npm ci` on the Linux CI runner no longer fails.

## [0.2.0] — 2026-05-28

The Nimbus demo goes **backend-free**: the SPA syncs the signed bundle and runs
the full hybrid-search + session-aware-rerank pipeline in the browser tab. No
application backend in the request path. The in-browser engine is extracted as
a reusable workspace package, and the demo gains its own frontend CI.

### Added
- `@edgeproc/browser` — new private npm workspace package
  (`frontend/packages/edgeproc-browser/`). In-browser signed-bundle sync into OPFS
  (ed25519 + sha256 fail-closed), reassembly, and the full hybrid-search engine
  (BM25 ⊕ vector → RRF → session rerank). Top-k parity-tested against the
  Python core over the same committed bundle.
- Browser embedder via transformers.js (`Xenova/all-MiniLM-L6-v2`,
  `{ pooling: "mean", normalize: true }`) — the byte-for-byte equivalent of the
  Python core's query encoder.
- Backend-free `docker compose up --build` path: `origin` → Caddy `edge` → static
  Nimbus SPA. No FastAPI in the request path; the browser does the search.
- Real 728-product Amazon catalog committed as the demo bundle
  (`examples/catalog/`), built via `edgereco build-catalog` → `index` → `bundle`.
- Frontend CI workflow: Biome lint + tsc + Vitest across the npm workspace plus
  Playwright end-to-end coverage of the backend-free hero loop (sync → search →
  click → rail re-rank → "why?" panel).

### Changed
- Top-level README + `CLAUDE.md` rewritten to make the backend-free demo the
  headline path; the Python FastAPI runtime is reframed as the optional
  server-side API variant.
- `@edgeproc/browser` public surface trimmed: low-level sync primitives
  (`MemoryCacheStore`, `syncIndex`, `materializeFile`, `Verify` / `FetchBytes`
  / `CacheStore`) moved behind the `./testing` subpath; the main entrypoint is
  the production runtime (`EngineRuntime`, `SearchEngine`, the domain types).
- Demo data layer (`frontend/app/src/api/client.ts`) refactored from
  module-level mutable state to a `createDataClient(runtime)` factory.

## [0.1.0] — 2026-04-30

First public release. Python v1 reference architecture for edge-first product discovery.

### Added
- Manifest-based catalog sync with sha256 checksums
- BM25 keyword index (`rank-bm25`) and FAISS vector index (`sentence-transformers/all-MiniLM-L6-v2`), built via `edgereco index`
- Reciprocal Rank Fusion hybrid search (`edgereco search`, `GET /search`)
- Session-aware reranker: `0.40·pop + 0.20·cat + 0.15·tag + 0.10·brand + 0.10·fresh − 0.25·rep`
- Interaction event ingest (`POST /events`) with click / view / favorite / cart weights
- Recommendation endpoint with session signals (`GET /recommend`)
- Typer CLI: `index`, `serve`, `search`, `preprocess`
- FastAPI app with Protocol-based DI for edge clients (HTTP + filesystem adapters)
- Synthetic 1000-product demo catalog (superseded in 0.2.0 by the committed 728-product Amazon bundle built via `edgereco build-catalog`)
- Docker Compose stack: origin + Caddy edge + app, with healthcheck-gated startup
- BDD test suite (5 Gherkin features), integration + e2e coverage, 98%+ line coverage
- GitHub Actions CI: ruff + mypy strict + pytest with 90% coverage gate
