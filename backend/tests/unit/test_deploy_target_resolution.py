"""The Dagger deploy function must release the exact protected trigger identity."""

from __future__ import annotations

import ast
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_MODULE = _ROOT / ".dagger" / "src" / "edge_reco" / "main.py"
_WRANGLER_RELEASE = _ROOT / "frontend" / "app" / "scripts" / "wrangler-release.sh"
_DEPLOY_DOC = _ROOT / "docs" / "DEPLOY.md"
_ADOPTION_DOC = _ROOT / "docs" / "dagger-lego-adoption.md"


def _source() -> str:
    return _MODULE.read_text(encoding="utf-8")


def _wrangler_release_source() -> str:
    return _WRANGLER_RELEASE.read_text(encoding="utf-8")


def _async_method(name: str) -> ast.AsyncFunctionDef:
    tree = ast.parse(_source())
    methods = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.AsyncFunctionDef) and node.name == name
    ]
    assert len(methods) == 1
    return methods[0]


def _call_attributes(statement: ast.stmt) -> list[str]:
    return [
        node.func.attr
        for node in ast.walk(statement)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    ]


def _top_level_calls(name: str) -> list[list[str]]:
    return [
        calls for statement in _async_method(name).body if (calls := _call_attributes(statement))
    ]


def _top_level_call_names(name: str) -> list[list[str]]:
    """Every call per statement, including plain-name calls such as constructors."""
    return [
        [
            node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
            for node in ast.walk(statement)
            if isinstance(node, ast.Call) and isinstance(node.func, (ast.Attribute, ast.Name))
        ]
        for statement in _async_method(name).body
    ]


def test_should_require_the_triggering_protected_run_identity() -> None:
    deploy = _async_method("deploy")
    parameters = [argument.arg for argument in deploy.args.args]

    assert parameters[-3:] == ["commit_sha", "workflow_run_id", "run_attempt"]


def test_should_bind_the_triggering_checkout_before_building_product_bytes() -> None:
    deploy = _top_level_calls("deploy")
    delivery = _top_level_calls("_deploy_context")
    assert deploy == [["_release_context"], ["_deploy_context"]]
    assert delivery[0] == ["_provider_request", "_build_source"]


def test_should_leave_green_run_validation_to_the_attempt_bound_provider() -> None:
    source = _source()
    assert "dag.foundation().green_main(" not in source
    assert "_verified_source(self.source, commit_sha)" in source
    assert "ReleaseContext(bound, commit_sha, workflow_run_id, run_attempt)" in source
    assert "actions/workflows/dagger.yml/runs?head_sha={commit}" not in source
    assert 'select(.conclusion=="success")' not in source


def test_should_build_the_exact_foundation_bound_trigger_tree() -> None:
    source = _source()
    assert "self._build_source(context.source, context.commit_sha)" in source


def test_should_mount_the_built_directory_without_exporting_it() -> None:
    source = _source()
    assert 'with_directory("/artifact", artifact)' in source
    assert "export(" not in source


def test_should_not_retain_checkout_local_pages_mutation() -> None:
    # Given / When
    source = _wrangler_release_source()

    # Then
    assert "pages deploy /artifact" not in source


def test_should_delegate_the_closed_envelope_to_one_shared_provider_transaction() -> None:
    source = _source()
    calls = _top_level_call_names("_deploy_context")
    assert calls == [
        ["_provider_request", "_build_source"],
        ["PagesRelease"],
        ["release_with_rollback"],
        ["_deployment_result"],
    ]
    assert _top_level_calls("deploy_release") == [["_deliver", "cloudflare_pages"]]
    assert "dag.foundation().envelope(" in source
    assert "dag.cloudflare_pages()" in source
    assert "_disable_git_deployments" not in source
    assert "_deploy_artifact" not in source
    assert "_github_probe" not in source
    assert '"wrangler-release.sh", "deploy"' not in source


def test_should_materialize_verified_provider_deploy_before_local_live_verification() -> None:
    delivery = _top_level_calls("_deliver")
    assert delivery[0] == ["_provider_deploy"]
    assert delivery[1] == ["_provider_identity"]
    assert "_provider_verify" not in _source()
    # The live smoke runs after the verified deploy; a red run rolls production back.
    assert _top_level_calls("smoke") == [["_smoke"]]
    assert _top_level_calls("_smoke") == [
        ["_live_container"],
        ["from_streams", "exit_code", "stdout", "stderr"],
    ]
    assert _top_level_calls("rollback_to")[0] == ["rollback", "cloudflare_pages"]


def test_should_document_the_exact_trigger_attempt_delivery_contract() -> None:
    deploy = " ".join(_DEPLOY_DOC.read_text(encoding="utf-8").split())
    adoption = _ADOPTION_DOC.read_text(encoding="utf-8")

    assert "exact triggering protected Dagger run" in deploy
    assert "revalidates that attempt as the latest protected green `main` run" in deploy
    assert "A manual dispatch" not in deploy
    assert "manual runs" not in deploy
    assert "current remote `main`" not in deploy
    assert "`9d491851fc5c65ad4a388ed2dd7bb4def4e1f007`" in adoption
    assert "dagger call ci" in adoption
    assert '--commit-sha="$(git rev-parse HEAD)"' in adoption
    assert "DAGGER_NO_NAG=1 dagger check" not in adoption
