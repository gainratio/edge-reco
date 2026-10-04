# EdgeReco — top-level convenience wrappers over the poe demo tasks.
#
# The demos are defined once in poe_tasks.toml (kept in sync with
# backend/pyproject.toml's [tool.poe.tasks.*]); these `make` targets are just a
# thin, discoverable front door so `make demo` works the same as `poe demo`:
#
#   make demo            turnkey backend-free demo: edge + Vite SPA (random free ports)
#
# Ports are allocated per run (no fixed :8081/:5174), so the demo never
# collides with a stale container or a sibling project. The chosen URLs are
# printed at startup and the SPA opens automatically.
#
# Prefers a global `poe`; falls back to the backend venv's poe via `uv`, so a
# fresh clone with only `uv` installed still works (no global poe install needed).

# Repo root, regardless of where `make` is invoked from.
ROOT_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
POE := $(shell command -v poe >/dev/null 2>&1 && echo poe || echo 'uv run --directory backend poe')

.DEFAULT_GOAL := help
.PHONY: help gate demo

# The one dual-stack gate (house standard §3): fans out to the backend `poe gate`
# and the frontend `pnpm gate` — the same commands CI runs, in the same order.
gate: ## Full dual-stack quality gate — backend `poe gate` + frontend `pnpm gate` (mirrors CI).
	cd $(ROOT_DIR)/backend && uv run poe gate
	cd $(ROOT_DIR)/frontend && pnpm run gate

demo: ## Turnkey backend-free demo — edge + Vite SPA on free ports, opens your browser.
	cd $(ROOT_DIR) && $(POE) demo

help: ## Show this help.
	@echo "EdgeReco demo targets (thin wrappers over poe):"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
