"""Validated delivery target for EdgeReco's public Pages release."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Self

#: The exact repositories a run may claim: the canonical gainratio owner first, and the
#: pre-transfer identity until the org move finishes. There is deliberately no default:
#: every gate takes the run's own ``github.repository``.
ALLOWED_REPOSITORIES: Final = ("gainratio/edge-reco", "hseshadr/edge-reco")
PRODUCTION_PROJECT: Final = "edge-reco"
PRODUCTION_BRANCH: Final = "main"
PRODUCTION_DOMAIN: Final = "edge-reco.com"
_PRODUCTION_PAGES: Final = (PRODUCTION_PROJECT, PRODUCTION_BRANCH, PRODUCTION_DOMAIN)


@dataclass(frozen=True)
class EdgeRecoTarget:
    """The permitted repository, Pages project, branch, and domain."""

    repository: str
    project: str
    branch: str
    domain: str

    def __post_init__(self) -> None:
        if self.repository not in ALLOWED_REPOSITORIES:
            raise ValueError(
                f"EdgeReco delivery target must use the validated production values: "
                f"repository {self.repository!r} is not one of {ALLOWED_REPOSITORIES}"
            )
        if (self.project, self.branch, self.domain) != _PRODUCTION_PAGES:
            raise ValueError("EdgeReco delivery target must use the validated production values")

    @classmethod
    def production(cls, repository: str) -> Self:
        """Return the immutable production delivery target for one allow-listed repository."""
        return cls(repository, *_PRODUCTION_PAGES)
