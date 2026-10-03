"""Post-deploy live smoke with automatic rollback.

The deploy records the production deployment that is live now, ships the new
one, and drives the live site. If the smoke goes red, production is rolled back
to the recorded deployment through the shared cloudflare-pages module, and a
recovery smoke proves the restored site works. The release still fails: a
rollback is a recovery, never a green deploy.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final, Protocol, Self

RELEASE_SMOKE: Final = "@release|@fresh"
RECOVERY_SMOKE: Final = "@fresh"
SMOKE_OUTPUT_LINES: Final = 60


@dataclass(frozen=True)
class Deployment:
    """One Cloudflare Pages deployment: its id and unique https URL."""

    deployment_id: str
    deployment_url: str

    def __post_init__(self) -> None:
        if not self.deployment_id or not self.deployment_url.startswith("https://"):
            raise ValueError("deployment identity differs")


@dataclass(frozen=True)
class SmokeRun:
    """The verdict (exit code) and output tail of one Playwright live run."""

    passed: bool
    output: str

    @classmethod
    def from_streams(cls, exit_code: int, stdout: str, stderr: str) -> Self:
        """Judge on the exit code; keep only the tail of the combined output."""
        lines = f"{stdout}\n{stderr}".strip().splitlines()
        return cls(exit_code == 0, "\n".join(lines[-SMOKE_OUTPUT_LINES:]))


@dataclass(frozen=True)
class RollbackEvidence:
    """The shared module's non-secret proof of a completed rollback."""

    from_deployment_id: str
    to_deployment_id: str
    live_deployment_id: str


class LiveRelease(Protocol):
    """The four side effects a release performs, in the order it performs them."""

    async def previous_production(self) -> Deployment: ...

    async def deploy_release(self) -> Deployment: ...

    async def smoke(self, grep: str) -> SmokeRun: ...

    async def rollback_to(self, deployment_id: str) -> RollbackEvidence: ...


class LiveSmokeError(RuntimeError):
    """The released deployment failed its live smoke."""


async def release_with_rollback(port: LiveRelease) -> tuple[Deployment, str]:
    """Deploy, smoke the live site, and roll back to the previous deployment on red."""
    previous = await port.previous_production()
    released = await port.deploy_release()
    smoke = await port.smoke(RELEASE_SMOKE)
    if smoke.passed:
        return released, f"Live smoke passed: release, fresh\n{smoke.output}"
    outcome = await _roll_back(port, previous, released)
    raise LiveSmokeError(f"Live smoke failed on deployment {released.deployment_id}; {outcome}\n{smoke.output}")


async def _roll_back(port: LiveRelease, previous: Deployment, released: Deployment) -> str:
    try:
        _require_restored(await port.rollback_to(previous.deployment_id), previous, released)
    except Exception as error:  # any rollback failure must be reported, never masked
        return f"rollback FAILED, {released.deployment_id} may still be live: {error}"
    rolled_back = f"production rolled back from {released.deployment_id} to {previous.deployment_id}"
    recovery = await port.smoke(RECOVERY_SMOKE)
    if recovery.passed:
        return f"{rolled_back}; recovery smoke (fresh) passed"
    return f"{rolled_back}; recovery smoke (fresh) FAILED\n{recovery.output}"


def _require_restored(evidence: RollbackEvidence, previous: Deployment, released: Deployment) -> None:
    expected = (released.deployment_id, previous.deployment_id, previous.deployment_id)
    actual = (evidence.from_deployment_id, evidence.to_deployment_id, evidence.live_deployment_id)
    if actual != expected:
        raise ValueError("rollback evidence differs")
