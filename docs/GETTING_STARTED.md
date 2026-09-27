# Getting started for developers

This takes you from nothing to a green local build and your first change. Every command
here was run from a fresh clone on 25 Sep 2026 (macOS, Apple silicon); the times are
from that run.

## 1. What you need

| Tool | Version | How to get it |
| --- | --- | --- |
| Node | 24.16 exactly (see [`frontend/.nvmrc`](../frontend/.nvmrc)) | `nvm install 24.16.0 && nvm use 24.16.0` |
| pnpm | 11.5.0 (pinned in `frontend/package.json`) | `corepack enable`, run inside `frontend/` |
| Python | 3.13 or newer | uv downloads it for you if missing |
| uv | any recent release | `brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| Docker | optional | only for `make demo` and the API server image |

Two traps we hit on a real machine:

- **A stale corepack shim.** If `pnpm --version` crashes with
  `Cannot find module .../corepack/pnpm/12.5.1/bin/pnpm.cjs`, a newer Node's corepack is
  first on your `PATH`. Switch to Node 24.16 (`nvm use 24.16.0`) and run
  `corepack enable` again inside `frontend/`. The frontend checks also refuse to run on
  any other Node version (`pnpm run check:node`).
- **avow overwrites assay.** Until the backend moves to avow 0.5.0 (PR #128), a plain
  `uv sync` lets avow's old bundled `assay/` package overwrite `assay-engine`, and the
  type check fails with `Module "assay" has no attribute "ScoreResult"`. Always sync with
  `--reinstall-package assay-engine`, as below. CI and the Dockerfiles do the same.

## 2. Clone, install and run it

```bash
git clone https://github.com/hseshadr/edge-reco        # 3 s
cd edge-reco/frontend
corepack enable
pnpm install                                           # 12 s
pnpm -F frontend run build:pages                       # 17 s, downloads the model once
pnpm -F frontend exec vite preview
```

Open http://localhost:4173, click **Launch the live demo**, and search for
`something for my aching back`. Success looks like this, from a headless Chromium run
against that preview:

```text
1. Massage Gun Deep Tissue - Back Muscle Massager w/High Torque Motor for Back Pain, ...
2. Sheenive Stadium Seats for Bleachers with Back Support, ...
3. EINSKEY Sun Hat for Men/Women, Waterproof Wide Brim Bucket Hat ...
strip: 46 ms latency · 0 backend calls · 3.8 s cold start · 17.4 MB js heap · 720 catalog
console errors: 0
```

Your timings will differ. The number that must stay at 0 is backend calls.

Now the Python side:

```bash
cd ../backend
uv sync --group dev --reinstall-package assay-engine  # 2 s with a warm uv cache
uv run edgereco --help                                 # lists the CLI commands
```

[USAGE.md](USAGE.md) has a ten-line Python script that runs the same search with no
browser.

## 3. Run the full check

From the repo root:

```bash
make gate
```

That runs `uv run poe gate` in `backend/` (format, lint, strict types, complexity, 561
tests with at least 90% coverage; 252 s on our run) and then `pnpm run gate` in
`frontend/` (lint, types, 552 unit tests with coverage, build, and three Playwright
browser suites; 210 s). Allow about 8 minutes. CI runs the same checks through Dagger;
`dagger check` runs that exact graph locally if you have Dagger installed.

Run `pnpm -F frontend run build:pages` (step 2) at least once before `make gate`. It
downloads the language model into `frontend/app/public/models/`, and one browser-engine
parity test (`hybridParity.test.ts`) fails with `file was not found locally at
.../model_quantized.onnx` without it.

The frontend check rebuilds `frontend/app/dist` for its offline test with a test-only
catalog address (`localhost:8921`). If you then run `vite preview`, the app says
"Couldn't start the engine". Run `pnpm -F frontend run build:pages` again first.

## 4. Map of the code

| Path | What it does |
| --- | --- |
| `frontend/app/src/` | The Nimbus storefront (React). `App.tsx` is the shell, `components/` the UI, `locales/en/` all user-facing text. |
| `frontend/packages/edgereco-browser/src/engine/` | The in-browser engine: keyword search (`keyword.ts`), vector search (`vectorIndex.ts`), re-ranking (`rerank.ts`, `reranker.ts`), ranking config and proof. |
| `frontend/packages/edgereco-browser/src/engine/__fixtures__/` | Parity fixtures generated from Python. Browser results must match them. |
| `frontend/app/tests/` | Playwright browser tests: `e2e/` the storefront, `e2e-c1/` sync, tamper refusal and speed budgets, `e2e-offline/` offline and CDN-blocked boots. |
| `backend/src/edgereco/reco/` | The Python ranking: `ranking_config.py` (weights), `formula.py` (the scoring formula), strategies, retrain and audit. |
| `backend/src/edgereco/search/` | Python hybrid search: BM25 plus FAISS, merged with RRF. |
| `backend/src/edgereco/cli.py` | The `edgereco` command line tool. |
| `backend/tests/` | `unit/`, `bdd/` (steps for the Gherkin files in `backend/features/`), `integration/`, `e2e/`. |
| `backend/examples/catalog/` | The committed, signed 720-product catalog the demo loads. |
| `backend/scripts/` | Catalog curation and the parity-fixture generators. |

The signed-catalog download and checking in the browser come from
[`@edgeproc/browser`](https://github.com/hseshadr/edgeproc-browser), installed from a
pinned GitHub commit. The Python side gets the same job from
[`edge-proc`](https://github.com/hseshadr/edge-proc) on PyPI, which in turn uses
[`edgeproc-core`](https://github.com/hseshadr/edgeproc-core). Changes to that plumbing
belong in those repos.

## 5. Make your first change

A typical small change: fix a line of storefront text, or adjust ranking behaviour.

**Storefront text.** All user-facing strings live in
`frontend/app/src/locales/en/` (`landing.json` for the intro page, `storefront.json` for the
store, `common.json` for shared text such as the footer, `errors.json` for error
messages). The component tests and
`src/locales/i18n-extraction.test.ts` pin the exact English, so change the expected text
there first, watch it fail, then edit the string. Run the locale tests (they also check
that no text is hard-coded in a component):

```bash
cd frontend
pnpm -F frontend exec vitest run src/locales     # 3 files, 10 tests, 5 s
```

**Ranking behaviour.** Ranking lives in two places that must agree: Python in
`backend/src/edgereco/reco/` and TypeScript in
`frontend/packages/edgereco-browser/src/engine/`. Write the failing test first on both
sides, then change the code:

```bash
cd backend && uv run pytest tests/unit/reco -q --no-cov              # 159 tests, 7 s
cd ../frontend && pnpm -F @edgereco/browser exec vitest run src/engine/rerank.test.ts   # 2 s
```

If a change moves ranking results, regenerate the parity fixtures with
`backend/scripts/gen_*_fixture.py` and commit them with the code. The scoring weights are
data in the signed `ranking_config.json`, so retuning weights is a catalog republish, not
a code change; see [ARCHITECTURE.md](ARCHITECTURE.md#scoring-formula).

Finish with `make gate` before you push.

## 6. Open a pull request

- Branch from `main` with a short prefix: `fix/`, `feat/`, `docs/`, `ci/` or `deps/`
  (for example `fix/pdp-static-asset-counter`).
- Put the test and the code in the same commit. New behaviour starts with a failing test.
- Push and open a PR against `main`. CI runs the **Dagger** workflow (the same checks as
  `make gate`, plus parity, security scans and a production build) and **Dagger SARIF**
  (code scanning). Both must be green.
- Reviewers look for: a test that fails without your change, Python and browser ranking
  still agreeing, no new network calls from the storefront after the catalog loads, and
  no generated files (`dist/`, `public/models/`, `public/ort/`, coverage) in the diff.
- Found a security problem? Do not open a public issue; follow [SECURITY.md](../SECURITY.md).
  Bugs and feature requests go in GitHub Issues.
