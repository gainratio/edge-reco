"""EdgeReco keeps thin workflow ingress while Foundation owns repository guards."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import cast

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[3]


def _load_workflow(name: str) -> dict[str, object]:
    document = yaml.safe_load((_ROOT / ".github" / "workflows" / name).read_text(encoding="utf-8"))
    assert isinstance(document, dict)
    return document


def _dagger_source() -> str:
    path = _ROOT / ".dagger" / "src" / "edge_reco" / "main.py"
    return path.read_text(encoding="utf-8")


def test_should_delegate_repository_guard_to_exact_sha_foundation() -> None:
    # Given / When
    source = _dagger_source()

    # Then
    assert "dag.foundation().guard(" in source
    assert "def workflow_security(" in source
    assert "def secret_scan(" in source
    assert "_legacy" not in source


def test_should_keep_unprivileged_dagger_checks_free_of_release_credentials() -> None:
    # Given / When
    workflow = (_ROOT / ".github" / "workflows" / "dagger.yml").read_text(encoding="utf-8")
    job = workflow.split("  dagger:\n", 1)[1].split("\n  ", 1)[0]

    # Then
    assert "name: Dagger" in job
    assert "CLOUDFLARE_API_TOKEN" not in job
    assert "CLOUDFLARE_ACCOUNT_ID" not in job
    assert "security-events: write" not in job


def test_should_bind_the_protected_dagger_job_to_the_exact_checkout_sha() -> None:
    # Given / When
    workflow = _load_workflow("dagger.yml")
    steps = workflow["jobs"]["dagger"]["steps"]

    # Then
    assert steps[0]["with"] == {
        "fetch-depth": 0,
        "persist-credentials": False,
        "ref": "${{ github.sha }}",
    }
    assert steps[1]["with"] == {
        "version": "0.21.8",
        "call": "ci --commit-sha=${{ github.sha }}",
    }


def test_should_project_sarif_only_from_the_fork_guarded_privileged_job() -> None:
    workflow = (_ROOT / ".github" / "workflows" / "dagger.yml").read_text(encoding="utf-8")
    assert "security-events: write" in workflow
    assert "head.repo.full_name == github.repository" in workflow
    assert "codeql-upload" in workflow
    assert "--github-token=env:GITHUB_TOKEN" in workflow


def test_should_consolidate_manual_and_weekly_security_into_the_protected_dagger_job() -> None:
    # Given / When
    workflow = _load_workflow("dagger.yml")
    triggers = workflow[True]

    # Then
    assert triggers["workflow_dispatch"] is None
    assert triggers["schedule"] == [{"cron": "0 9 * * 1"}]
    assert workflow["permissions"] == {"contents": "read"}
    assert not (_ROOT / ".github" / "workflows" / "security-audit.yml").exists()


def test_should_call_deploy_without_repository_override() -> None:
    # Given / When
    workflow = _load_workflow("deploy.yml")
    call = workflow["jobs"]["deploy"]["steps"][1]["with"]["call"]

    # Then
    assert "--repository=" not in call


#: Expression roots whose values an event author, dispatcher, or fork controls.
_ATTACKER_EXPRESSIONS = ("${{ inputs.", "${{ github.event.", "${{ github.head_ref")

#: dagger-for-github passes `module` as INPUT_MODULE; every other input is pasted into bash.
_ENV_ONLY_INPUTS = frozenset({"module"})

#: The deploy invocation. Event values reach bash only as double-quoted variables.
_DEPLOY_CALL = (
    "deploy --cloudflare-api-token=env:CLOUDFLARE_API_TOKEN "
    "--cloudflare-account-id=env:CLOUDFLARE_ACCOUNT_ID --github-token=env:GITHUB_TOKEN "
    '--commit-sha="$HEAD_SHA" --workflow-run-id="$RUN_ID" --run-attempt="$RUN_ATTEMPT"'
)

#: Values a hostile event could carry; each must reach Dagger as one inert argument.
_HOSTILE_VALUES = (
    "",
    "abc --github-token=env:CLOUDFLARE_API_TOKEN",
    "abc;touch pwned",
    "$(touch pwned)",
    "`touch pwned`",
    "abc\ntouch pwned",
    'abc" ; touch pwned ; "',
)


Step = dict[str, object]


def _workflow_steps(name: str) -> list[tuple[str, Step]]:
    jobs = cast(dict[str, dict[str, object]], _load_workflow(name)["jobs"])
    return [
        (job_name, step)
        for job_name, job in jobs.items()
        for step in cast(list[Step], job["steps"])
    ]


def _dagger_steps() -> list[tuple[str, Step]]:
    return [
        (path.name, step)
        for path in sorted((_ROOT / ".github" / "workflows").glob("*.yml"))
        for _, step in _workflow_steps(path.name)
        if str(step.get("uses", "")).startswith("dagger/dagger-for-github@")
    ]


def _deploy_step() -> Step:
    steps = [step for job, step in _workflow_steps("deploy.yml") if job == "deploy"]
    return steps[1]


def _script_inputs() -> list[tuple[str, str, str]]:
    return [
        (name, key, str(value))
        for name, step in _dagger_steps()
        for key, value in cast(Step, step.get("with", {})).items()
        if key not in _ENV_ONLY_INPUTS
    ]


def _expand_like_the_action(text: str, env: dict[str, str], cwd: Path) -> list[str]:
    """Expand a Dagger input exactly as dagger-for-github's bash step does, but print it."""
    bash = shutil.which("bash")
    assert bash is not None
    result = subprocess.run(  # noqa: S603 - fixed bash, test-owned argv
        [bash, "-c", f"printf '%s\\0' {text}"],
        env={**env, "PATH": "/usr/bin:/bin"},
        cwd=cwd,
        capture_output=True,
        check=True,
    )
    return result.stdout.decode().split("\0")[:-1]


def test_should_paste_no_attacker_controlled_expression_into_any_dagger_input() -> None:
    # Given every input dagger-for-github pastes into its bash script
    inputs = _script_inputs()

    # Then none carries an expression whose value an event author controls
    assert inputs
    assert [
        (name, key, text)
        for name, key, text in inputs
        if any(expression in text for expression in _ATTACKER_EXPRESSIONS)
    ] == []


def test_should_pass_workflow_run_identity_to_deploy_only_through_env() -> None:
    # Given the deploy Dagger step
    step = _deploy_step()

    # Then event values arrive as environment variables and the call quotes them
    assert step["with"] == {"version": "0.21.8", "call": _DEPLOY_CALL}
    assert step["env"] == {
        "CLOUDFLARE_API_TOKEN": "${{ secrets.CLOUDFLARE_API_TOKEN }}",
        "CLOUDFLARE_ACCOUNT_ID": "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
        "GITHUB_TOKEN": "${{ github.token }}",
        "HEAD_SHA": "${{ github.event.workflow_run.head_sha }}",
        "RUN_ID": "${{ github.event.workflow_run.id }}",
        "RUN_ATTEMPT": "${{ github.event.workflow_run.run_attempt }}",
    }


@pytest.mark.parametrize("value", _HOSTILE_VALUES)
def test_should_hand_any_event_value_to_dagger_as_one_inert_argument(
    value: str, tmp_path: Path
) -> None:
    # Given the real deploy call, expanded by bash with hostile event values
    call = str(cast(Step, _deploy_step()["with"])["call"])
    env = {"HEAD_SHA": value, "RUN_ID": value, "RUN_ATTEMPT": value}

    # When bash expands it
    argv = _expand_like_the_action(call, env, tmp_path)

    # Then each value is one literal argument and bash ran nothing
    assert argv[-3:] == [
        f"--commit-sha={value}",
        f"--workflow-run-id={value}",
        f"--run-attempt={value}",
    ]
    assert len(argv) == 7
    assert not (tmp_path / "pwned").exists()
