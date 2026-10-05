# Nimbus storefront image — multi-stage: Vite build -> static serve.
#
# The SPA is backend-free: it syncs the signed bundle from the Caddy edge and
# runs the engine entirely in the browser. There is no API server.
#
# Build context: `frontend/`. The shared browser substrate is installed from the
# exact public Git commit pinned in the workspace manifests and lockfile.
#
# VITE_BUNDLE_BASE_URL is baked at BUILD time (Vite inlines import.meta.env at
# compile). It must be the origin the BROWSER reaches — i.e. the host-mapped
# edge port (http://localhost:8081), NOT the in-network `edge` hostname.

# ---- stage 1: build the static bundle ----
# Exact tag, kept in lockstep with frontend/.nvmrc (24.16.0) — the one Node pin
# Dagger, deploy, and the local gate all install. A floating
# `node:24-slim` would drift off that pin silently.
FROM node:24.16.0-slim AS build

# corepack ships with Node; it activates the pnpm version pinned in
# package.json's "packageManager" field.
RUN corepack enable

WORKDIR /workspace/frontend

# Install deps first (better layer caching): copy the workspace manifests + the
# root lockfile + the pnpm workspace config, then `pnpm install` resolves the
# whole workspace (app + package).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json ./app/package.json
COPY packages/edgereco-browser/package.json ./packages/edgereco-browser/package.json

RUN pnpm install --frozen-lockfile

# Bring in the full workspace sources (the package is consumed as TS by Vite).
COPY . .

# Caddy edge origin the browser syncs the signed bundle from. Default targets
# the host-mapped edge port; compose can override.
ARG VITE_BUNDLE_BASE_URL=http://localhost:8081
ENV VITE_BUNDLE_BASE_URL=${VITE_BUNDLE_BASE_URL}

# Build only the SPA workspace; it resolves @edgereco/browser via the workspace link.
# The workspace member is named "frontend" in app/package.json so `-F frontend` works.
RUN pnpm -F frontend run build

# ---- stage 2: serve the static dist/ ----
# `serve` is a tiny zero-config static server; -s rewrites unknown routes to
# index.html (SPA). Listens on 5174 to match the dev origin.
FROM node:24.16.0-slim AS serve

WORKDIR /app
RUN npm install -g serve@14

COPY --from=build /workspace/frontend/app/dist ./dist

EXPOSE 5174

CMD ["serve", "-s", "dist", "-l", "5174"]
