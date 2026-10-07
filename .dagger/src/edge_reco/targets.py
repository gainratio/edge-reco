"""Validated delivery target for EdgeReco's public Pages release."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Self

#: Today's owner. Every entrypoint defaults to it, so callers that pass nothing are unchanged.
DEFAULT_REPOSITORY: Final = "hseshadr/edge-reco"
#: The exact repositories a run may claim: today's owner and the gainratio org after transfer.
ALLOWED_REPOSITORIES: Final = ("hseshadr/edge-reco", "gainratio/edge-reco")
_PRODUCTION_PAGES: Final = ("edge-reco", "main", "edge-reco.com")


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
    def production(cls, repository: str = DEFAULT_REPOSITORY) -> Self:
        """Return the immutable production delivery target for one allow-listed repository."""
        return cls(repository, *_PRODUCTION_PAGES)
