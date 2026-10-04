# backend/demo_server/ (optional API-server variant)

**Not in the default demo path.** The Nimbus demo is **backend-free**: the SPA
syncs the signed bundle and runs the whole engine in the browser — see
[`../../README.md`](../../README.md). The default `docker compose up --build` does
not start anything in this directory.

This directory is preserved for the optional **server-side API** use case: a
thin FastAPI wrapper around `edgereco` that syncs the same signed bundle at
startup and exposes `/search`, `/recommend`, and `/products`. Useful if you
want to consume the engine over HTTP from a non-browser client.

To run it: `make backend` from `frontend/` (it launches `demo_server.serve` from
`backend/`). Its Docker image (`demo_server/Dockerfile`) uses only the `backend/` build context; uv resolves
the substrate from the release tags pinned in `uv.lock`, so sibling repositories and
parent-workspace secrets are never sent to Docker.
