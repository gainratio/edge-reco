# Dagger lego adoption

## TL;DR

EdgeReco is the first—and currently the only—graduated consumer of the shared Dagger
delivery modules. It pins both central modules to the literal commit
`9d491851fc5c65ad4a388ed2dd7bb4def4e1f007`, delegates common guard and provider
mechanics to them, and keeps only product-specific checks locally.

The canary reached production at EdgeReco commit
`14abbdf0dd74b64064903fee9521d65bc107d247`. The exact-main Dagger gate, guarded
Cloudflare deployment, public build identity, and live zero-egress browser proof all
passed. This document is evidence for EdgeReco, not a claim that the rest of the
portfolio has graduated.

## Run the proof

From a fresh clone with Dagger 0.21.8, Docker, `uv`, Node, and pnpm available:

```bash
git clone https://github.com/gainratio/edge-reco.git
cd edge-reco
test "$(jq -r '.engineVersion' dagger.json)" = v0.21.8
dagger develop
uv sync --frozen --all-groups --directory .dagger
DAGGER_NO_NAG=1 dagger call ci \
  --commit-sha="$(git rev-parse HEAD)"
DAGGER_NO_NAG=1 dagger call release-preflight \
  --commit-sha="$(git rev-parse HEAD)"
```

To reproduce the production-shaped product proof for the commit currently live:

```bash
live_sha="$(curl -fsS https://edge-reco.com/build.json | jq -r .commit)"
curl -fsS https://edge-reco.com/build.json | jq -e --arg sha "$live_sha" '.commit == $sha'
DAGGER_NO_NAG=1 dagger call verify-live --commit-sha="$live_sha"
```

That last command verifies the public commit and bundle/model identity, canonical host
behavior, browser console/page health, and zero application-backend or foreign egress.
It does not deploy or require production credentials.

## Ownership: reusable blocks and product adapters

| Owner | Responsibility |
| --- | --- |
| `portfolio-foundation` at the exact central SHA | Typed source/history identity, workflow and full-history secret guard, canonical artifact envelope, exact-green GitHub evidence |
| `cloudflare-pages` at the exact central SHA | Credential preflight, one Pages mutation, exact deployment convergence, non-secret deployment UUID and unique URL evidence |
| EdgeReco's local Dagger module | Python/frontend audits and quality, CodeQL, parity fixtures, model and Pages artifact build, signed catalog, browser journeys, local live verification |
| GitHub Actions | Pinned checkout and Dagger ingress, protected `production` environment boundary, secret injection into the privileged deploy call |

The process still runs one Dagger engine container per job or local session. The
"legos" are typed graph modules inside that engine, so common behavior is reused and
cached without creating a separate long-lived container per repository component.

## Canary and rollback evidence

The adoption was deliberately staged instead of deleting local code first:

1. [EdgeReco canary PR #97](https://github.com/gainratio/edge-reco/pull/97) merged as
   `86c2c80d0ac5f7d46f58620f79a6d060463bacf2`. Its first deployment run
   ([33181142497](https://github.com/gainratio/edge-reco/actions/runs/33181142497))
   failed inside the original per-file artifact envelope before any Cloudflare mutation.
   Production remained on the prior build.
2. The central bounded-envelope release merged as
   `daebff7ebf3e69a0361b90cd7b7a767c0e4b48e1`. It replaced thousands of per-file
   graph terminals with a bounded inventory/normalization step while preserving the
   authenticated manifest and exact verifier.
3. [EdgeReco repin PR #98](https://github.com/gainratio/edge-reco/pull/98) merged as
   `14abbdf0dd74b64064903fee9521d65bc107d247`. A fresh cold local Dagger engine
   passed all nine checks; the release preflight also passed with pinned Wrangler
   4.103.0 and no credentials.
4. The [exact-main gate](https://github.com/gainratio/edge-reco/actions/runs/33189648062)
   passed both Dagger and Dagger SARIF for that exact SHA. Only then did the guarded
   [deployment and live-verification run](https://github.com/gainratio/edge-reco/actions/runs/33190282778)
   execute; it completed successfully after provider preflight, mutation, convergence,
   and the local live browser proof.
5. `https://edge-reco.com/build.json` then reported the same exact commit and bundle
   manifest `d1868cff60ef7f36244dc6536611a273b3eab7949b5eaa25d6e135a56ef5ad64`.
6. Before merge, an isolated rollback worktree restored the pre-shared Task 10 delivery
   implementation and passed all nine Dagger lanes. The rehearsal did not mutate the
   provider, main branch, tags, packages, or registries, and the temporary worktree was
   removed afterward.

The canary deploy predated EdgeReco's log projection of provider evidence, so its hosted
output proves provider convergence but does not expose the UUID and unique `pages.dev`
URL. The graduated adapter now consumes both values once from created and verified
evidence, rejects any noncanonical or unequal pair, and emits the single verified pair
with the live-proof result for subsequent deployments.

## Current credential boundary limitation

The deploy job selects the GitHub `production` environment, and that environment is
restricted to exact `main`. However, the authoritative environment-secret listing was
empty at graduation time. The successful canary therefore resolved
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` through repository-secret fallback
with the same names.

No secret value was read back, printed, copied, or moved by this work. GitHub does not
allow an existing secret value to be recovered for re-upload. A maintainer must enter
both values directly under the `production` environment, confirm a fresh guarded
deployment, and only then remove the repository-scoped duplicates. Until that happens,
the strict fleet policy correctly remains red; this repository does not weaken it or
claim the migration is complete.

## Promotion checklist for the next repository

Do not copy EdgeReco files mechanically. Reuse the modules and keep the next consumer's
product adapter small:

1. Add literal 40-character pins for Foundation and the relevant provider module.
2. Define the repository, branch, provider project, custom domain, and deploy root as a
   validated target tuple.
3. Keep product build, product audits, and live behavior local; delegate source/history,
   guard, artifact envelope, GitHub evidence, and provider mechanics.
4. Shadow the shared behavior and rehearse rollback before deleting duplicates.
5. Require fresh exact-head, exact-main, deploy, and independent live evidence for the
   deletion tree; prior canary evidence is not sufficient.
6. Store production credentials only in the protected environment and require the fleet
   conformance check to report zero findings before calling that consumer graduated.
