# EdgeReco Storefront SPA (`frontend/app`)

**TL;DR.** This is the browser app for the [EdgeReco storefront](../README.md) — a React + TypeScript +
Vite storefront with **no application backend**. On load it syncs a signed,
content-addressed catalog bundle from a CDN edge, verifies it in the tab
(ed25519 + sha256, against the key pinned in `public/public.key`), and then runs every
search and recommendation locally via the workspace engine package
([`../packages/edgereco-browser`](../packages/edgereco-browser)). The Python tier only
*publishes* the bundle; it is never in the request path.

## Run it

One-time setup, from the repo's `frontend/` directory:

```bash
pnpm install                       # workspace deps (app + packages)
docker compose up -d origin edge   # serve the signed demo bundle on :8081
```

Then, from `frontend/app/`:

```bash
pnpm run dev        # Vite dev server on http://localhost:5174
```

The bundle origin is baked at build time via `VITE_BUNDLE_BASE_URL`
(default `http://localhost:8081`, the Caddy edge above).

## Test / lint / build

From `frontend/app/` (or `pnpm -r run <task>` from `frontend/` to cover the
packages too):

```bash
node scripts/download-model.mjs   # one-time: sha256-pinned local embedding model
pnpm run test        # Vitest units (incl. the click→re-rank loop over the real bundle)
pnpm run lint        # biome
pnpm run typecheck   # tsc -b
pnpm run build       # tsc -b + vite build → dist/
pnpm run test:e2e    # Playwright: the full backend-free loop in a real browser
```

`pnpm run build` first runs a prebuild step that downloads the all-MiniLM-L6-v2
embedding model and stages the ONNX-runtime WASM, so production serves everything
same-origin.

## How it relates to the backend bundles

The app consumes the same signed bundle format the Python tier produces:
`backend/examples/catalog` holds the committed 100,000-product demo bundle
(`latest` pointer → manifest → content-addressed chunks). Rebuild or re-sign it
with the `edgereco` CLI (see [`docs/QUICKSTART.md`](../../docs/QUICKSTART.md) §5)
and the app picks up the new version on the next load — verified fail-closed
before anything is written to OPFS.
