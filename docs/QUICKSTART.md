# Quickstart

Goal: clone the repo, gate both subprojects, then run the headline demo (Nimbus, our example storefront) end-to-end. Ten minutes.

## Prereqs

- Python 3.13+
- [`uv`](https://docs.astral.sh/uv/) (`brew install uv` or `curl -LsSf https://astral.sh/uv/install.sh | sh`)
- Node ≥ 22.12 (required by Vite 8)
- Docker (only for the headline demo)

## Clone and go

Clone **just this repo** — that's all you need. The Python backend pulls
[`edge-proc`](https://github.com/hseshadr/edge-proc) (`>=0.5.0`) and
[`edgeproc-core`](https://github.com/hseshadr/edgeproc-core) (`>=0.4.3`) from PyPI, and
`uv.lock` pins the exact releases, so `uv sync` resolves everything automatically:

```bash
git clone https://github.com/hseshadr/edge-reco
cd edge-reco/backend && uv sync     # edge-proc + edgeproc-core from PyPI
```

> **Co-developing the substrate?** If you want to hack on edge-proc or
> edgeproc-core alongside edge-reco, clone the three repos side-by-side and
> switch to local path sources — uncomment the two `path = ...`
> lines in `backend/pyproject.toml`'s `[tool.uv.sources]` (the comments there
> document the exact swap). This is the *optional* co-developer path; the default
> above needs none of it.
>
> ```text
> ~/dev/oss/
> ├── edge-reco/
> ├── edge-proc/
> └── edgeproc-core/
> ```

## 1. Backend gate (Python)

```bash
cd backend
uv sync --group dev
uv run pytest --cov=edgereco --cov-fail-under=90    # full suite + coverage gate
uv run ruff format --check .
uv run ruff check .
uv run mypy src
uv run xenon --max-absolute A --max-modules A --max-average A src    # complexity gate
```

If all five are green, the Python tier is healthy. (Or run them as one task:
`uv run poe gate`. A separate `uv run poe audit` runs `pip-audit` against the
dependency lock — it needs the network, so it lives in its own Security-audit
workflow. It stays honestly red while any known CVE in the dependency tree has no
released fix, with no suppressions — every finding is fixed by a version floor, not
silenced. (CVE-2025-3000 in torch, the one advisory ever ignored, is now fixed by
the `torch>=2.12.1` floor; the `--ignore-vuln` flag has been dropped.))

## 2. Frontend gate (pnpm workspaces)

`@edgeproc/browser` is resolved from the exact public Git commit pinned in both
workspace manifests and `pnpm-lock.yaml`. No sibling checkout or copied source
is required.

```bash
cd ../frontend
pnpm install                                    # resolves the whole workspace
node app/scripts/download-model.mjs             # one-time: sha256-pinned local embedding model (the parity tests embed with it; CI fetches it the same way)
pnpm -r run lint                                # biome on app + package
pnpm -r run typecheck                           # tsc -b on both
pnpm -r run test                                # vitest on both
pnpm -F frontend run build                      # prove the workspace link resolves
```

The pnpm workspace is rooted at `frontend/`; the SPA lives in `frontend/app/` and EdgeReco's product engine in `frontend/packages/edgereco-browser/`. Both consume the same exact `edgeproc-browser` Git commit.

## 3. Run the demo (backend-free, in-browser)

**Turnkey — starts everything and opens your browser:**

```bash
poe demo               # from the repo root — edge + Vite SPA on free ports, opens your browser
# or, without a global poe install:
cd backend && uv run poe demo
```

`poe demo` brings up the Caddy edge, installs the frontend deps on first run, starts
the Vite dev server, and opens the storefront in your browser. Ctrl-C tears the edge
back down. (Needs Node, pnpm, and Docker; the `uv run` form also uses the
`uv sync --group dev` from step 1.) The repo-root `poe demo` reads `poe_tasks.toml`;
the `backend/` form reads the same task from `backend/pyproject.toml`.

**Alternative — fully containerized (Docker only, no Node/pnpm):**

```bash
cd frontend
docker compose up --build
```

Then open **http://localhost:5174** manually — unlike `poe demo`, this path does not
auto-open a browser. Once the tab loads (either path) you'll see the intro landing
page — click **Launch the live demo** to watch the boot screen step through:

1. *Syncing the signed bundle* — pulled from the Caddy edge (`:8081` on the
   Docker-only path; `poe demo` allocates a free port per run).
2. *Reassembling the index* — into OPFS.
3. *Loading the model* — transformers.js fetches `Xenova/all-MiniLM-L6-v2`.

Then the 720-product synthetic storefront (12 categories, 60 products each; every brand and product is invented). Click a few products in one category: the "Recommended for you" rail visibly re-ranks toward that category, **no network round trip per click**. The home page also stacks *Trending* and *New arrivals* rails; click into any product to open its product page (a `#/p/<id>` history entry — browser Back stays in the app) with *Similar items*, *Because you viewed*, *Customers also bought*, and *Frequently bought together* — all seven rails are named strategies carried in the signed bundle (`ranking_config.json` + `cooccurrence.json`), computed in-tab. Your taste survives a reload too: interactions land in a small on-device log (OPFS, product ids only, newest 500) that replays through the same fold at boot — press **Reset taste** next to the For-You badge to clear it. Stop `origin` + `edge` and reload: the bundle is in OPFS and the model is cached, so it keeps working offline — personalization included.

## 4. Iterate on the SPA locally

Without rebuilding the full Docker stack:

```bash
cd frontend
make install     # one-time: pnpm workspace deps
make dev         # edge (docker) + Vite dev server (foreground)
```

`make dev` boots the Caddy edge in the background, then runs the Vite dev server on `:5174`. Ctrl-C tears the edge down. See `frontend/Makefile` for the full target list.

## 5. Index a fresh catalog

The committed demo bundle is rebuilt from `backend/examples/source/catalog.csv` —
a small, committed, reproducible source (no external download needed):

```bash
cd backend

# Catalog CSV → products.jsonl  (the committed synthetic demo source; or your own CSV)
uv run edgereco build-catalog examples/source/catalog.csv /tmp/cache/products.jsonl

# Build the FAISS index (reads /tmp/cache/products.jsonl, writes /tmp/staging/).
# edge-proc never downloads the embedding model unless told it may: this is the
# build machine, so opt in once (or point EDGEPROC_MODEL_PATH at a local copy).
EDGEPROC_ALLOW_MODEL_DOWNLOAD=1 uv run edgereco index /tmp/cache /tmp/staging

# Sign + publish a content-addressed bundle origin. The demo's signing key is
# deliberately not committed (only its public half, examples/keys/public.key, is),
# so generate your own ed25519 pair once (it prints the `wrote ...` line and then the
# new key's `key_id`, the id a keyring trust root names it by):
uv run edgeproc keygen --out /tmp/keys

uv run edgereco bundle /tmp/staging /tmp/origin /tmp/keys/private.key \
    --catalog-id amazon-demo --version v1 --product-count 720 --embedding-count 720
```

Drop the origin behind any static HTTP server / CDN and point the SPA at it (`VITE_BUNDLE_BASE_URL` at build time).
Because the browser verifies fail-closed against a **pinned** key, publishing your own
origin also means pinning your `public.key` in the SPA (`frontend/app/public/public.key`;
the API-server path reads `EDGERECO_VERIFY_KEY_PATH`).

To regenerate `examples/source/catalog.csv` itself, run the synthetic catalog
generator. It is deterministic (same seed, same bytes) and uses only the committed
vocabulary in `src/edgereco/catalog/synthetic_vocab.json`, with no downloads:

```bash
uv run python scripts/generate_catalog.py
uv run python scripts/gen_demo_sessions.py
uv run python scripts/rebuild_example_bundle.py --from-source   # needs examples/keys/private.key
```

## 6. Run as an API server (optional)

For server-side recommendations instead of in-browser:

```bash
cd backend
EDGERECO_BUNDLE_BASE_URL=/path/to/origin \
EDGERECO_VERIFY_KEY_PATH=examples/keys/public.key \
EDGERECO_BUNDLE_CACHE_DIR=/tmp/edge-cache \
EDGEPROC_ALLOW_MODEL_DOWNLOAD=1 \
    uv run edgereco serve /tmp/staging /tmp/staging --port 8000
```

The server embeds queries itself, so it needs the embedding model too:
`EDGEPROC_ALLOW_MODEL_DOWNLOAD=1` lets it fetch the model once, and
`EDGEPROC_MODEL_PATH=/path/to/model` loads a local copy with no model egress. With
neither set it exits with `[config.missing]` and names both.

Or use the alternative API-server launcher with the demo's CORS + browse route:

```bash
cd backend
uv run python -m demo_server.serve
```

That's the FastAPI variant of the same engine, on `:8000`.

## Next steps

- [`ARCHITECTURE.md`](ARCHITECTURE.md) — system context, request lifecycle, module map, parity contract.
- [`DEPLOY.md`](DEPLOY.md) — backend-free in-browser vs edge-origin API server.
- `frontend/README.md` — storefront walkthrough, screenshots, e2e tests.
