# Contributing

Contributions are welcome. EdgeReco is small enough to read end-to-end in an afternoon — start with the [README](README.md) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Local setup

Follow [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md): the tools and versions, a fresh
clone to a running store, the full check, a map of the code, and a first change. The
short version, from the repo root:

```bash
cd backend && uv sync --group dev --reinstall-package assay-engine && cd ..
cd frontend && corepack enable && pnpm install && cd ..
```

## Quality gate (run before opening a PR)

```bash
make gate
```

This runs the backend `uv run poe gate` and the frontend `pnpm run gate`, the same checks
CI runs through `dagger check`.

## Test layout (in `backend/`)

- `tests/unit/` — fast, isolated unit tests
- `tests/bdd/` — pytest-bdd step impls (features live in `features/`, decoupled by design)
- `tests/integration/` — FastAPI `TestClient` + CLI integration
- `tests/e2e/` — full sync → index → search → events → recommend loops

New behavior: write the failing test first, then the smallest implementation that turns it green.

## Invariants

The scoring formula and interaction weights are spec-locked — see the scoring section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The weights ship as bundle-carried config (`ranking_config.json`), so retuning ranking is a data republish, not a code change; altering the formula itself requires updating the docs alongside the code.
