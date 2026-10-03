"""Behavior of the post-deploy live smoke and its automatic rollback."""

from __future__ import annotations

import asyncio

import pytest

from edge_reco.live_release import (
    RECOVERY_SMOKE,
    RELEASE_SMOKE,
    Deployment,
    LiveSmokeError,
    RollbackEvidence,
    SmokeRun,
    release_with_rollback,
)

PREVIOUS = Deployment("11111111-1111-4111-8111-111111111111", "https://11111111.edge-reco.pages.dev")
RELEASED = Deployment("22222222-2222-4222-8222-222222222222", "https://22222222.edge-reco.pages.dev")
RESTORED = RollbackEvidence(RELEASED.deployment_id, PREVIOUS.deployment_id, PREVIOUS.deployment_id)


class FakeRelease:
    """Scripted release port that records every step in order."""

    def __init__(
        self,
        smoke: dict[str, list[SmokeRun]],
        rollback: RollbackEvidence | Exception = RESTORED,
        previous: Deployment | Exception = PREVIOUS,
    ) -> None:
        self.events: list[str] = []
        self.smoke_runs = smoke
        self.rollback = rollback
        self.previous = previous

    async def previous_production(self) -> Deployment:
        self.events.append("previous")
        if isinstance(self.previous, Exception):
            raise self.previous
        return self.previous

    async def deploy(self) -> Deployment:
        self.events.append("deploy")
        return RELEASED

    async def smoke(self, grep: str) -> SmokeRun:
        self.events.append(f"smoke:{grep}")
        return self.smoke_runs[grep].pop(0)

    async def rollback_to(self, deployment_id: str) -> RollbackEvidence:
        self.events.append(f"rollback:{deployment_id}")
        if isinstance(self.rollback, Exception):
            raise self.rollback
        return self.rollback


def _passed(output: str = "1 passed") -> SmokeRun:
    return SmokeRun(passed=True, output=output)


def _failed(output: str = "1 failed") -> SmokeRun:
    return SmokeRun(passed=False, output=output)


def test_should_pin_the_release_and_recovery_smoke_selections() -> None:
    assert RELEASE_SMOKE == "@release|@fresh"
    assert RECOVERY_SMOKE == "@fresh"


def test_should_record_previous_production_before_deploying_then_smoke_the_release() -> None:
    # Given
    port = FakeRelease({RELEASE_SMOKE: [_passed("release proof")]})

    # When
    released, proof = asyncio.run(release_with_rollback(port))

    # Then
    assert released == RELEASED
    assert port.events == ["previous", "deploy", f"smoke:{RELEASE_SMOKE}"]
    assert proof == "Live smoke passed: release, fresh\nrelease proof"


def test_should_not_deploy_when_previous_production_cannot_be_recorded() -> None:
    # Given
    port = FakeRelease({}, previous=RuntimeError("no live production deployment"))

    # When / Then
    with pytest.raises(RuntimeError, match="no live production deployment"):
        asyncio.run(release_with_rollback(port))
    assert port.events == ["previous"]


def test_should_roll_back_to_previous_production_and_prove_recovery_when_smoke_fails() -> None:
    # Given
    port = FakeRelease({RELEASE_SMOKE: [_failed("journey red")], RECOVERY_SMOKE: [_passed()]})

    # When / Then
    with pytest.raises(LiveSmokeError) as raised:
        asyncio.run(release_with_rollback(port))
    message = str(raised.value)
    assert port.events == [
        "previous",
        "deploy",
        f"smoke:{RELEASE_SMOKE}",
        f"rollback:{PREVIOUS.deployment_id}",
        f"smoke:{RECOVERY_SMOKE}",
    ]
    assert message.startswith(f"Live smoke failed on deployment {RELEASED.deployment_id}; ")
    assert f"production rolled back from {RELEASED.deployment_id} to {PREVIOUS.deployment_id}" in message
    assert "recovery smoke (fresh) passed" in message
    assert message.endswith("journey red")


def test_should_report_a_red_recovery_smoke_after_rolling_back() -> None:
    # Given
    port = FakeRelease({RELEASE_SMOKE: [_failed()], RECOVERY_SMOKE: [_failed("still red")]})

    # When / Then
    with pytest.raises(LiveSmokeError, match=r"recovery smoke \(fresh\) FAILED\nstill red"):
        asyncio.run(release_with_rollback(port))


def test_should_say_the_release_may_still_be_live_when_rollback_raises() -> None:
    # Given
    port = FakeRelease({RELEASE_SMOKE: [_failed()]}, rollback=RuntimeError("Cloudflare said no"))

    # When / Then
    with pytest.raises(LiveSmokeError, match=f"rollback FAILED, {RELEASED.deployment_id} may still be live"):
        asyncio.run(release_with_rollback(port))
    assert f"smoke:{RECOVERY_SMOKE}" not in port.events


@pytest.mark.parametrize(
    "evidence",
    (
        RollbackEvidence(PREVIOUS.deployment_id, PREVIOUS.deployment_id, PREVIOUS.deployment_id),
        RollbackEvidence(RELEASED.deployment_id, RELEASED.deployment_id, PREVIOUS.deployment_id),
        RollbackEvidence(RELEASED.deployment_id, PREVIOUS.deployment_id, RELEASED.deployment_id),
    ),
)
def test_should_not_trust_rollback_evidence_that_does_not_restore_previous_production(
    evidence: RollbackEvidence,
) -> None:
    # Given
    port = FakeRelease({RELEASE_SMOKE: [_failed()]}, rollback=evidence)

    # When / Then
    with pytest.raises(LiveSmokeError, match=r"rollback FAILED.*rollback evidence differs"):
        asyncio.run(release_with_rollback(port))


@pytest.mark.parametrize(
    ("deployment_id", "deployment_url"),
    (
        ("", "https://11111111.edge-reco.pages.dev"),
        ("11111111-1111-4111-8111-111111111111", ""),
        ("11111111-1111-4111-8111-111111111111", "http://11111111.edge-reco.pages.dev"),
    ),
)
def test_should_reject_a_deployment_without_identity(deployment_id: str, deployment_url: str) -> None:
    with pytest.raises(ValueError, match="deployment identity"):
        Deployment(deployment_id, deployment_url)


def test_should_keep_only_the_tail_of_long_smoke_output() -> None:
    # Given
    lines = [f"line {index}" for index in range(100)]

    # When
    run = SmokeRun.from_streams(1, "\n".join(lines), "stderr tail")

    # Then
    assert run.passed is False
    assert run.output.splitlines()[-1] == "stderr tail"
    assert len(run.output.splitlines()) == 60
    assert SmokeRun.from_streams(0, "ok", "").passed is True
