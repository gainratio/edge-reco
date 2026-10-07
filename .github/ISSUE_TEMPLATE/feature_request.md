---
name: Feature request
about: Suggest an idea or enhancement for EdgeReco
title: "[Feature] "
labels: enhancement
assignees: ""
---

**What problem does this solve?**
The use case or pain point, not just the proposed solution.

**Proposed solution**
What you'd like to see — a new ranking strategy, a CLI flag, a storefront capability, etc.

**Alternatives considered**
Other approaches you weighed and why this one is better.

**Scope / fit**
How does this fit EdgeReco's role as a *backend-free recommender* — the scoring runs in
the shopper's browser tab (and an optional FastAPI edge tier), built on top of the
[edge-proc](https://github.com/gainratio/edge-proc) substrate? Does it belong in the
engine core, the Nimbus storefront, or as a signed-bundle config knob (`ranking_config.json`)?

**Additional context**
Links, prior art, or sketches.
