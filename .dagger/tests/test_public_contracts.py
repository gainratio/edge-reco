"""Behavioral contracts for EdgeReco's public release graph."""

from __future__ import annotations

import ast
import asyncio
import inspect
import json
import os
import re
import shutil
import subprocess
import textwrap
import tomllib
from collections.abc import Awaitable
from pathlib import Path
from typing import cast

import dagger
import pytest

import edge_reco.main as main_module
from edge_reco.live_release import LiveSmokeError
from edge_reco.main import EdgeReco, parse_release_evidence
from edge_reco.targets import EdgeRecoTarget

FOUNDATION_SHA = "a88866232e679b6353d2b75bceb01969be739f67"
REPOSITORY = "gainratio/edge-reco"
#: Kept on the allow-list until the gainratio org move finishes; never a default.
PRE_TRANSFER_REPOSITORY = "hseshadr/edge-reco"
#: Look-alikes of the two owners that must never pass the exact allow-list.
REFUSED_REPOSITORIES = (
    "attacker/edge-reco",
    "gainratio/other-repo",
    "hseshadr/edge-reco-evil",
    "gainratio-evil/edge-reco",
    "",
)
VALID_DEPLOYMENT_ID = "f621dc42-3cf9-4217-b4fb-0392c1d39020"
VALID_DEPLOYMENT_URL = "https://f621dc42.edge-reco.pages.dev"
PREVIOUS_DEPLOYMENT_ID = "0b915c11-176b-493e-b9fb-969a1304cdec"
PREVIOUS_DEPLOYMENT_URL = "https://0b915c11.edge-reco.pages.dev"
RECORDING_ENVELOPE = object()
RECORDING_GITHUB_TOKEN = object()
RECORDING_CLOUDFLARE_TOKEN = object()
RECORDING_CLOUDFLARE_ACCOUNT = object()
RECORDING_ACCOUNT = (RECORDING_CLOUDFLARE_TOKEN, RECORDING_CLOUDFLARE_ACCOUNT, "edge-reco")
PRETRANSPORT_SOURCE = """\
from dagger import dag, function, object_type

SHA = "a88866232e679b6353d2b75bceb01969be739f67"
COMMIT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
REPOSITORY = "gainratio/edge-reco"


@object_type
class Pretransport:
    @function
    async def tampered_preflight(self) -> str:
        artifact = dag.directory().with_new_file("dist/index.html", "valid")
        envelope = dag.foundation().envelope(artifact, f"{REPOSITORY}@{COMMIT}", f"{SHA}:123456", ["dist"])
        tampered = envelope.with_new_file("artifact/dist/index.html", "tampered")
        github = dag.set_secret("github", "synthetic-github-token")
        api = dag.set_secret("cloudflare-api", "synthetic-cloudflare-token")
        account = dag.set_secret("cloudflare-account", "synthetic-cloudflare-account")
        return await dag.cloudflare_pages().preflight(
            tampered, github, api, account, "123456", 2, REPOSITORY, "edge-reco", "main", "edge-reco.com",
            "dist", ["www.edge-reco.com"], f"{REPOSITORY}@{COMMIT}", f"{SHA}:123456", ["dist"],
        )
"""


def _production_target() -> EdgeRecoTarget:
    return EdgeRecoTarget.production(REPOSITORY)


def _recording_provider_arguments(repository: str = REPOSITORY) -> tuple[object, ...]:
    return (
        RECORDING_ENVELOPE,
        RECORDING_GITHUB_TOKEN,
        RECORDING_CLOUDFLARE_TOKEN,
        RECORDING_CLOUDFLARE_ACCOUNT,
        "123456",
        2,
        repository,
        "edge-reco",
        "main",
        "edge-reco.com",
        "dist",
        ["www.edge-reco.com"],
        repository + "@" + "a" * 40,
        FOUNDATION_SHA + ":123456",
        ["dist"],
    )


class RecordingWorkspace:
    """Record the source selection made by the module constructor."""

    def __init__(self) -> None:
        self.path = ""

    def directory(self, path: str, **_options: object) -> dagger.Directory:
        self.path = path
        return cast(dagger.Directory, object())


class RecordingSync:
    """Record evaluation of one lazy Dagger result."""

    def __init__(self, name: str, events: list[str], error: Exception | None = None) -> None:
        self.name = name
        self.events = events
        self.error = error

    async def sync(self) -> None:
        if self.error is not None:
            raise self.error
        self.events.append(self.name)


class RecordingContainer:
    """Record one live-smoke run without invoking a browser; exit codes are scripted per grep."""

    def __init__(self, events: list[str], grep: str, exit_codes: dict[str, list[int]]) -> None:
        self.events = events
        self.grep = grep
        self.exit_codes = exit_codes

    async def exit_code(self) -> int:
        self.events.append(f"smoke:{self.grep}")
        codes = self.exit_codes.get(self.grep, [])
        return codes.pop(0) if codes else 0

    async def stdout(self) -> str:
        return "live proof"

    async def stderr(self) -> str:
        return ""


class RecordingDeployment:
    """Represent one generated provider result with exact non-secret evidence."""

    def __init__(self, events: list[str], object_id: str, deployment_id: str, deployment_url: str) -> None:
        self.events = events
        self.object_id = object_id
        self.deployment_id_value = deployment_id
        self.deployment_url_value = deployment_url

    async def id(self) -> str:
        self.events.append(f"materialize:{self.object_id}")
        return self.object_id

    async def deployment_id(self) -> str:
        self.events.append(f"identity:{self.deployment_id_value}")
        return self.deployment_id_value

    async def deployment_url(self) -> str:
        self.events.append(f"url:{self.deployment_url_value}")
        return self.deployment_url_value


class RecordingProvider:
    """Strict generated-client fake that records provider boundary calls."""

    def __init__(
        self,
        events: list[str],
        created_id: str = VALID_DEPLOYMENT_ID,
        created_url: str = VALID_DEPLOYMENT_URL,
    ) -> None:
        self.events = events
        self.created_id = created_id
        self.created_url = created_url
        self.evidence_by_id: dict[str, dagger.CloudflarePagesDeploymentEvidence] = {}
        self.stored_by_id: dict[str, object] = {}

    async def preflight(self, *arguments: object) -> str:
        self._require_exact_arguments(arguments)
        self.events.append("preflight")
        return "preflight"

    def deploy(self, *arguments: object, **options: object) -> dagger.CloudflarePagesDeploymentEvidence:
        self._require_exact_arguments(arguments)
        self._require_git_source_owner(options)
        self.events.append("deploy")
        return self._record("created-evidence", self.created_id, self.created_url)

    def load_evidence(self, object_id: str) -> dagger.CloudflarePagesDeploymentEvidence:
        return self.evidence_by_id[object_id]

    def previous_production_deployment(
        self, api_token: object, account_id: object, project: str
    ) -> dagger.CloudflarePagesProductionDeployment:
        assert (api_token, account_id, project) == RECORDING_ACCOUNT
        stored = RecordingDeployment(self.events, "previous", PREVIOUS_DEPLOYMENT_ID, PREVIOUS_DEPLOYMENT_URL)
        self.stored_by_id["previous"] = stored
        return cast(dagger.CloudflarePagesProductionDeployment, CacheNeverCall(self.events, "previous", stored))

    def rollback(
        self, api_token: object, account_id: object, project: str, *, deployment_id: str = ""
    ) -> dagger.CloudflarePagesProductionRollbackEvidence:
        assert (api_token, account_id, project) == RECORDING_ACCOUNT
        stored = RecordingRollback(self.created_id, deployment_id)
        self.stored_by_id[f"rollback-{deployment_id}"] = stored
        lazy = CacheNeverCall(self.events, f"rollback:{deployment_id}", stored, f"rollback-{deployment_id}")
        return cast(dagger.CloudflarePagesProductionRollbackEvidence, lazy)

    def load_stored(self, object_id: str) -> object:
        return self.stored_by_id[object_id]

    def _record(
        self, object_id: str, deployment_id: str, deployment_url: str
    ) -> dagger.CloudflarePagesDeploymentEvidence:
        evidence = RecordingDeployment(self.events, object_id, deployment_id, deployment_url)
        stored = cast(dagger.CloudflarePagesDeploymentEvidence, evidence)
        self.evidence_by_id[object_id] = stored
        return stored

    @staticmethod
    def _require_exact_arguments(arguments: tuple[object, ...]) -> None:
        assert arguments == _recording_provider_arguments()

    @staticmethod
    def _require_git_source_owner(options: dict[str, object]) -> None:
        assert options == {"git_source_owner": "hseshadr"}


class CacheNeverCall:
    """A lazy cache="never" call: every query re-executes it, as the Dagger engine does."""

    def __init__(self, events: list[str], execution: str, stored: object, object_id: str = "previous") -> None:
        self.events = events
        self.execution = execution
        self.stored = stored
        self.object_id = object_id

    async def id(self) -> str:
        self.events.append(self.execution)
        return self.object_id

    def __getattr__(self, field: str) -> object:
        read = getattr(self.stored, field)

        async def query() -> object:
            self.events.append(self.execution)
            return await read()

        return query


class RecordingRollback:
    """The shared module's rollback evidence: production now serves the target."""

    def __init__(self, released_id: str, target_id: str) -> None:
        self.released_id = released_id
        self.target_id = target_id

    async def from_deployment_id(self) -> str:
        return self.released_id

    async def to_deployment_id(self) -> str:
        return self.target_id

    async def live_deployment_id(self) -> str:
        return self.target_id


class IdBackedDeployment:
    """Expose stored evidence scalars without replaying their producer."""

    def __init__(self, events: list[str], deployment_id: str, deployment_url: str) -> None:
        self.events = events
        self.deployment_id_value = deployment_id
        self.deployment_url_value = deployment_url

    async def deployment_id(self) -> str:
        self.events.append(f"identity:{self.deployment_id_value}")
        return self.deployment_id_value

    async def deployment_url(self) -> str:
        self.events.append(f"url:{self.deployment_url_value}")
        return self.deployment_url_value


class NonCacheableDeployment:
    """Replay its producer whenever a scalar is read from the lazy graph."""

    def __init__(self, events: list[str], stage: str, object_id: str) -> None:
        self.events = events
        self.stage = stage
        self.object_id = object_id

    async def id(self) -> str:
        self.events.append(self.stage)
        return self.object_id

    async def deployment_id(self) -> str:
        self.events.append(self.stage)
        return VALID_DEPLOYMENT_ID

    async def deployment_url(self) -> str:
        self.events.append(self.stage)
        return VALID_DEPLOYMENT_URL


class MaterializingProvider(RecordingProvider):
    """Separate provider graph construction from cache-never execution."""

    def __init__(self, events: list[str]) -> None:
        super().__init__(events)
        self.materialized_evidence: dict[str, IdBackedDeployment] = {}

    def deploy(self, *arguments: object, **options: object) -> dagger.CloudflarePagesDeploymentEvidence:
        self._require_exact_arguments(arguments)
        self._require_git_source_owner(options)
        return self._construct("deploy")

    def verify(self, *arguments: object) -> dagger.CloudflarePagesDeploymentEvidence:
        self._require_exact_arguments(arguments)
        return self._construct("verify")

    def _construct(self, stage: str) -> dagger.CloudflarePagesDeploymentEvidence:
        object_id = f"{stage}-evidence"
        self.events.append(f"construct:{stage}")
        self.materialized_evidence[object_id] = IdBackedDeployment(
            self.events, VALID_DEPLOYMENT_ID, VALID_DEPLOYMENT_URL
        )
        lazy = NonCacheableDeployment(self.events, stage, object_id)
        return cast(dagger.CloudflarePagesDeploymentEvidence, lazy)

    def load_evidence(self, object_id: str) -> dagger.CloudflarePagesDeploymentEvidence:
        return cast(dagger.CloudflarePagesDeploymentEvidence, self.materialized_evidence[object_id])


class RecordingFoundation:
    """Strict foundation fake covering source, envelope, and verification boundaries."""

    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.bound = cast(dagger.Directory, "bound-source")
        self.guard_error: Exception | None = None
        self.calls: list[tuple[str, dagger.Directory, str, str]] = []

    def source(self, source: dagger.Directory, repository: str, commit_sha: str) -> dagger.Directory:
        self.calls.append(("source", source, repository, commit_sha))
        self.events.append("source")
        return self.bound

    def guard(self, source: dagger.Directory, repository: str, commit_sha: str) -> dagger.Container:
        self.calls.append(("guard", source, repository, commit_sha))
        return cast(dagger.Container, RecordingSync("guard", self.events, self.guard_error))

    def envelope(self, *_arguments: object) -> dagger.Directory:
        self.events.append("envelope")
        return cast(dagger.Directory, RECORDING_ENVELOPE)


class RecordingDag:
    """Minimal generated-Dagger facade for the EdgeReco composition contract."""

    def __init__(self, events: list[str], provider: RecordingProvider) -> None:
        self.events = events
        self.provider = provider
        self.foundation_client = RecordingFoundation(events)

    def cloudflare_pages(self) -> RecordingProvider:
        self.events.append("provider-client")
        return self.provider

    def directory(self) -> RecordingDirectory:
        self.events.append("directory")
        return RecordingDirectory()

    def foundation(self) -> RecordingFoundation:
        return self.foundation_client

    def load_cloudflare_pages_deployment_evidence_from_id(
        self, object_id: dagger.CloudflarePagesDeploymentEvidenceID
    ) -> dagger.CloudflarePagesDeploymentEvidence:
        assert isinstance(object_id, dagger.CloudflarePagesDeploymentEvidenceID)
        self.events.append(f"load:{object_id}")
        return self.provider.load_evidence(object_id)

    def load_cloudflare_pages_production_deployment_from_id(
        self, object_id: dagger.CloudflarePagesProductionDeploymentID
    ) -> dagger.CloudflarePagesProductionDeployment:
        assert isinstance(object_id, dagger.CloudflarePagesProductionDeploymentID)
        return cast(dagger.CloudflarePagesProductionDeployment, self.provider.load_stored(object_id))

    def load_cloudflare_pages_production_rollback_evidence_from_id(
        self, object_id: dagger.CloudflarePagesProductionRollbackEvidenceID
    ) -> dagger.CloudflarePagesProductionRollbackEvidence:
        assert isinstance(object_id, dagger.CloudflarePagesProductionRollbackEvidenceID)
        return cast(dagger.CloudflarePagesProductionRollbackEvidence, self.provider.load_stored(object_id))


class RecordingDirectory:
    """Fake artifact package directory that preserves the Dagger method shape."""

    def with_directory(self, _path: str, _artifact: dagger.Directory) -> dagger.Directory:
        return cast(dagger.Directory, RECORDING_ENVELOPE)


class FailingProviderTransaction(RecordingProvider):
    """Provider fake that proves a shared transaction failure blocks live proof."""

    def deploy(self, *arguments: object, **options: object) -> dagger.CloudflarePagesDeploymentEvidence:
        self._require_exact_arguments(arguments)
        self._require_git_source_owner(options)
        self.events.append("deploy")
        raise ValueError("provider transaction failed")


class TamperRejectingProvider(RecordingProvider):
    """Model the central envelope verifier rejecting changed artifact bytes."""

    def deploy(self, *arguments: object, **options: object) -> dagger.CloudflarePagesDeploymentEvidence:
        self._require_exact_arguments(arguments)
        self._require_git_source_owner(options)
        self.events.extend(("deploy", "provider-envelope-reject"))
        raise ValueError("envelope checksum mismatch")


class RejectingRedundantProviderStages(RecordingProvider):
    """Prove the consumer uses only the central deploy transaction."""

    async def preflight(self, *_arguments: object) -> str:
        raise AssertionError("provider deploy already owns preflight")

    def verify(self, *_arguments: object) -> dagger.CloudflarePagesDeploymentEvidence:
        raise AssertionError("provider deploy evidence is already converged")


class GraphDirectory:
    """Minimal typed directory for constructing every local product graph."""

    def directory(self, _path: str) -> dagger.Directory:
        return cast(dagger.Directory, self)

    def file(self, _path: str) -> dagger.File:
        return cast(dagger.File, object())

    def with_directory(self, _path: str, _directory: dagger.Directory) -> dagger.Directory:
        return cast(dagger.Directory, self)

    async def digest(self) -> str:
        return "digest"


class GraphContainer:
    """Typed fluent container double for pure Dagger graph construction."""

    def from_(self, _image: str) -> GraphContainer:
        return self

    def with_entrypoint(self, _entrypoint: list[str]) -> GraphContainer:
        return self

    def with_directory(self, _path: str, _directory: dagger.Directory) -> GraphContainer:
        return self

    def with_exec(self, _command: list[str], **_options: object) -> GraphContainer:
        return self

    def with_file(self, _path: str, _file: dagger.File) -> GraphContainer:
        return self

    def file(self, _path: str) -> dagger.File:
        return cast(dagger.File, object())

    def with_workdir(self, _path: str) -> GraphContainer:
        return self

    def with_env_variable(self, _name: str, _value: str) -> GraphContainer:
        return self

    def with_mounted_cache(self, _path: str, _cache: object) -> GraphContainer:
        return self

    def with_exposed_port(self, _port: int) -> GraphContainer:
        return self

    def with_service_binding(self, _name: str, _service: dagger.Service) -> GraphContainer:
        return self

    def with_secret_variable(self, _name: str, _secret: dagger.Secret) -> GraphContainer:
        return self

    def as_service(self, *, args: list[str]) -> dagger.Service:
        return cast(dagger.Service, self)

    def directory(self, _path: str) -> dagger.Directory:
        return cast(dagger.Directory, GraphDirectory())

    async def sync(self) -> None:
        return None

    async def stdout(self) -> str:
        return "live proof"

    async def stderr(self) -> str:
        return ""

    async def exit_code(self) -> int:
        return 0


class SmokeGraphContainer:
    """Record the environment and the single exec of one live-smoke container."""

    def __init__(self) -> None:
        self.environment: dict[str, str] = {}
        self.executed: tuple[list[str], dict[str, object]] = ([], {})

    def with_env_variable(self, name: str, value: str) -> SmokeGraphContainer:
        self.environment[name] = value
        return self

    def with_exec(self, command: list[str], **options: object) -> SmokeGraphContainer:
        self.executed = (command, options)
        return self


class GraphGitRef:
    async def commit(self) -> str:
        return "a" * 40

    def tree(self, *, depth: int, include_tags: bool = False) -> dagger.Directory:
        return cast(dagger.Directory, GraphDirectory())


class GraphGitRepository:
    def branch(self, _branch: str) -> GraphGitRef:
        return GraphGitRef()

    def commit(self, _commit: str) -> GraphGitRef:
        return GraphGitRef()


class GraphFoundation:
    def guard(self, *_arguments: object, **_options: object) -> dagger.Container:
        return cast(dagger.Container, GraphContainer())

    def source(self, *_arguments: object, **_options: object) -> dagger.Directory:
        return cast(dagger.Directory, GraphDirectory())

    def envelope(self, *_arguments: object) -> dagger.Directory:
        return cast(dagger.Directory, GraphDirectory())


class GraphDeployment:
    async def id(self) -> str:
        return "graph-evidence"

    async def deployment_id(self) -> str:
        return VALID_DEPLOYMENT_ID

    async def deployment_url(self) -> str:
        return VALID_DEPLOYMENT_URL


class GraphCloudflarePages:
    def deploy(self, *_arguments: object, **_options: object) -> dagger.CloudflarePagesDeploymentEvidence:
        return cast(dagger.CloudflarePagesDeploymentEvidence, GraphDeployment())

    def previous_production_deployment(self, *_arguments: object) -> dagger.CloudflarePagesProductionDeployment:
        return cast(dagger.CloudflarePagesProductionDeployment, GraphPreviousDeployment())


class GraphPreviousDeployment:
    async def id(self) -> str:
        return "previous"

    async def deployment_id(self) -> str:
        return PREVIOUS_DEPLOYMENT_ID

    async def deployment_url(self) -> str:
        return PREVIOUS_DEPLOYMENT_URL


class GraphDag:
    """Generated-client facade covering each retained EdgeReco composition path."""

    def container(self, *, platform: dagger.Platform | None = None) -> GraphContainer:
        return GraphContainer()

    def git(self, _repository: str) -> GraphGitRepository:
        return GraphGitRepository()

    def cache_volume(self, _name: str) -> object:
        return object()

    def cloudflare_pages(self) -> GraphCloudflarePages:
        return GraphCloudflarePages()

    def directory(self) -> GraphDirectory:
        return GraphDirectory()

    def http(self, _url: str, *, checksum: str) -> dagger.File:
        return cast(dagger.File, object())

    def load_cloudflare_pages_deployment_evidence_from_id(
        self, _object_id: dagger.CloudflarePagesDeploymentEvidenceID
    ) -> dagger.CloudflarePagesDeploymentEvidence:
        assert isinstance(_object_id, dagger.CloudflarePagesDeploymentEvidenceID)
        return cast(dagger.CloudflarePagesDeploymentEvidence, GraphDeployment())

    def load_cloudflare_pages_production_deployment_from_id(
        self, _object_id: dagger.CloudflarePagesProductionDeploymentID
    ) -> dagger.CloudflarePagesProductionDeployment:
        assert isinstance(_object_id, dagger.CloudflarePagesProductionDeploymentID)
        return cast(dagger.CloudflarePagesProductionDeployment, GraphPreviousDeployment())

    def foundation(self) -> GraphFoundation:
        return GraphFoundation()


def _recording_edge_reco(
    monkeypatch: pytest.MonkeyPatch,
    events: list[str],
    provider: RecordingProvider,
    exit_codes: dict[str, list[int]] | None = None,
) -> EdgeReco:
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "workspace")
    root = RecordingDag(events, provider)
    codes = exit_codes if exit_codes is not None else {}
    monkeypatch.setattr(main_module, "dag", root)
    monkeypatch.setattr(edge_reco, "_build_source", lambda *_arguments: _recorded_artifact(events))
    monkeypatch.setattr(
        edge_reco, "_live_container", lambda _source, _commit, grep: RecordingContainer(events, grep, codes)
    )
    return edge_reco


def _recorded_artifact(events: list[str]) -> dagger.Directory:
    events.append("build")
    return cast(dagger.Directory, "artifact")


def _run_real_dagger(binary: str, directory: Path, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "DAGGER_NO_NAG": "1"}
    return subprocess.run(  # noqa: S603 -- the resolved local Dagger executable is the integration subject.
        [binary, *arguments], cwd=directory, check=False, capture_output=True, env=environment, text=True
    )


def _require_dagger_success(result: subprocess.CompletedProcess[str]) -> None:
    assert result.returncode == 0, result.stdout + result.stderr


def _install_real_provider_dependencies(binary: str, module: Path) -> None:
    dependencies = (("foundation", "portfolio-foundation"), ("cloudflare-pages", "cloudflare-pages"))
    for name, source in dependencies:
        dependency = f"github.com/hseshadr/ci/modules/{source}@{FOUNDATION_SHA}"
        _require_dagger_success(_run_real_dagger(binary, module, "install", dependency, "--name", name))


def _real_provider_module(tmp_path: Path, binary: str) -> Path:
    module = tmp_path / "real-provider"
    arguments = ("init", "--sdk", "python", "--name", "pretransport", str(module))
    _require_dagger_success(_run_real_dagger(binary, tmp_path, *arguments))
    _install_real_provider_dependencies(binary, module)
    source = module / "src" / "pretransport" / "main.py"
    source.write_text(textwrap.dedent(PRETRANSPORT_SOURCE), encoding="utf-8")
    _require_dagger_success(_run_real_dagger(binary, module, "develop"))
    return module


def test_should_select_explicit_root_directory_when_module_is_constructed() -> None:
    # Given
    workspace = RecordingWorkspace()
    # When
    EdgeReco.create(cast(dagger.Workspace, workspace))
    # Then
    assert workspace.path == "/"


def test_should_exclude_local_quality_artifacts_from_exact_source_binding() -> None:
    # Given
    generated = {
        "**/.coverage",
        "**/.mypy_cache",
        "**/.pytest_cache",
        "**/.ruff_cache",
        "**/__pycache__",
    }

    # When / Then
    assert generated <= set(main_module.SOURCE_EXCLUDES)


def test_should_require_typed_workspace_when_module_is_constructed() -> None:
    # Given
    signature = inspect.signature(EdgeReco.create, eval_str=True)
    # When
    workspace = signature.parameters.get("workspace")
    # Then
    assert workspace is not None
    assert workspace.annotation is dagger.Workspace


def test_should_expose_one_explicit_exact_sha_ci_entrypoint() -> None:
    # Given / When
    ci = inspect.signature(EdgeReco.ci, eval_str=True)

    # Then
    assert ci.parameters["commit_sha"].annotation is str
    assert ci.return_annotation is str


def test_should_expose_ci_as_the_only_automatic_check_entrypoint() -> None:
    # Given / When
    source = inspect.getsource(EdgeReco)

    # Then
    assert source.count("@check") == 1


def test_should_keep_every_adapter_function_within_fifteen_physical_lines() -> None:
    # Given
    tree = ast.parse(inspect.getsource(main_module))

    # When
    oversized = {
        node.name: node.end_lineno - node.lineno + 1
        for node in ast.walk(tree)
        if isinstance(node, (ast.AsyncFunctionDef, ast.FunctionDef))
        and node.end_lineno is not None
        and node.end_lineno - node.lineno + 1 > 15
    }

    # Then
    assert oversized == {}


def test_should_bind_guard_then_run_every_product_check_on_the_bound_source(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    provider = RecordingProvider(events)
    root = RecordingDag(events, provider)
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "caller-source")
    products = tuple(RecordingSync(name, events) for name in ("quality", "audit"))
    monkeypatch.setattr(main_module, "dag", root)
    monkeypatch.setattr(edge_reco, "_product_checks", lambda _source: products)

    # When
    result = cast(str, asyncio.run(edge_reco.ci("a" * 40, REPOSITORY)))

    # Then
    assert result == "EdgeReco canonical Dagger gate passed"
    assert events == ["source", "guard", "quality", "audit"]
    assert root.foundation_client.calls == [
        ("source", cast(dagger.Directory, "caller-source"), "gainratio/edge-reco", "a" * 40),
        ("guard", root.foundation_client.bound, "gainratio/edge-reco", "a" * 40),
    ]


def test_should_stop_before_product_when_the_shared_guard_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    root = RecordingDag(events, RecordingProvider(events))
    root.foundation_client.guard_error = ValueError("shared guard rejected")
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "caller-source")
    monkeypatch.setattr(main_module, "dag", root)
    monkeypatch.setattr(
        edge_reco,
        "_product_checks",
        lambda _source: (RecordingSync("product", events),),
    )

    # When / Then
    with pytest.raises(ValueError, match="shared guard rejected"):
        asyncio.run(edge_reco.ci("a" * 40, REPOSITORY))
    assert events == ["source"]


def test_should_keep_full_quality_security_and_parity_in_the_ci_product_set(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    edge_reco = EdgeReco.__new__(EdgeReco)
    source = cast(dagger.Directory, object())
    events: list[str] = []
    names = (
        "backend-quality",
        "backend-audit",
        "parity",
        "frontend-quality",
        "browser",
        "frontend-audit",
        "codeql",
    )
    methods = (
        "_backend_quality",
        "_backend_audit",
        "_parity",
        "_frontend_quality",
        "_browser_e2e",
        "_frontend_audit",
        "_codeql_analysis",
    )
    expected = tuple(RecordingSync(name, events) for name in names)
    for method, product in zip(methods, expected, strict=True):
        monkeypatch.setattr(edge_reco, method, lambda _source, item=product: item)

    # When
    actual = edge_reco._product_checks(source)

    # Then
    assert actual == expected


def test_should_expose_typed_build_artifact_contract() -> None:
    # Given
    build = inspect.signature(EdgeReco.build, eval_str=True)
    # When
    commit = build.parameters.get("commit_sha")
    # Then
    assert commit is not None
    assert commit.annotation is str
    assert build.return_annotation is dagger.Directory


def test_should_require_typed_secrets_when_deploying_exact_artifact() -> None:
    # Given
    deploy = inspect.signature(EdgeReco.deploy, eval_str=True)
    # When
    secret_types = {
        name: deploy.parameters[name].annotation
        for name in ("cloudflare_api_token", "cloudflare_account_id", "github_token")
    }
    identity_types = {
        name: deploy.parameters[name].annotation for name in ("commit_sha", "workflow_run_id", "run_attempt")
    }
    # Then
    assert set(secret_types.values()) == {dagger.Secret}
    assert identity_types == {"commit_sha": str, "workflow_run_id": str, "run_attempt": int}


def test_should_bind_edge_reco_repository_pages_and_domain() -> None:
    # Given
    from edge_reco.targets import EdgeRecoTarget

    # When
    target = EdgeRecoTarget.production(REPOSITORY)
    # Then
    assert target.repository == "gainratio/edge-reco"
    assert target.project == "edge-reco"
    assert target.branch == "main"
    assert target.domain == "edge-reco.com"
    assert main_module.PAGES_DOMAINS == ("www.edge-reco.com",)


@pytest.mark.parametrize(
    "values",
    (
        ("gainratio/another-repository", "edge-reco", "main", "edge-reco.com"),
        ("gainratio/edge-reco", "another-project", "main", "edge-reco.com"),
        ("gainratio/edge-reco", "edge-reco", "release", "edge-reco.com"),
        ("gainratio/edge-reco", "edge-reco", "main", "evil.example"),
    ),
)
def test_should_reject_mismatched_delivery_target_tuple(values: tuple[str, str, str, str]) -> None:
    # Given
    from edge_reco.targets import EdgeRecoTarget

    # When / Then
    with pytest.raises(ValueError, match="validated production values"):
        EdgeRecoTarget(*values)


@pytest.mark.parametrize("repository", REFUSED_REPOSITORIES)
def test_should_reject_unvalidated_repository_override(monkeypatch: pytest.MonkeyPatch, repository: str) -> None:
    # Inverted contract (was: deploy takes no repository at all). The run now passes its own
    # identity so the guard survives the gainratio transfer; anything off the two-item list
    # is refused before the shared guard, the build, or the provider sees it.
    # Given
    events: list[str] = []
    edge_reco = _recording_edge_reco(monkeypatch, events, RecordingProvider(events))

    # When / Then
    with pytest.raises(ValueError, match="validated production values"):
        asyncio.run(_deploy_with_fake_secrets(edge_reco, repository))
    assert events == []


def test_should_require_the_runs_repository_on_every_entrypoint() -> None:
    # Inverted contract (was: every entrypoint defaulted to "hseshadr/edge-reco"). After the
    # gainratio transfer a stale default would gate as the old owner, so there is none.
    # Given
    entrypoints = (
        EdgeReco.ci,
        EdgeReco.deploy,
        EdgeReco.codeql_upload,
        EdgeReco.workflow_security,
        EdgeReco.secret_scan,
        EdgeReco.security,
    )

    # When
    defaults = {inspect.signature(entry).parameters["repository"].default for entry in entrypoints}
    release_target = inspect.signature(EdgeReco._release_context).parameters["target"].default

    # Then
    assert defaults == {inspect.Parameter.empty}
    assert release_target is inspect.Parameter.empty


def test_should_allow_gainratio_first_and_hseshadr_only_mid_move() -> None:
    # Given
    from edge_reco import targets

    # Then
    assert targets.ALLOWED_REPOSITORIES == ("gainratio/edge-reco", "hseshadr/edge-reco")
    assert not hasattr(targets, "DEFAULT_REPOSITORY")
    assert not hasattr(main_module, "REPOSITORY")
    assert not hasattr(main_module, "TARGET")
    production = inspect.signature(targets.EdgeRecoTarget.production)
    assert production.parameters["repository"].default is inspect.Parameter.empty


@pytest.mark.parametrize("repository", (REPOSITORY, PRE_TRANSFER_REPOSITORY))
def test_should_accept_both_owners_of_the_edge_reco_repository(repository: str) -> None:
    # Given
    from edge_reco.targets import EdgeRecoTarget

    # When
    target = EdgeRecoTarget.production(repository)

    # Then
    assert (target.repository, target.project, target.branch, target.domain) == (
        repository,
        "edge-reco",
        "main",
        "edge-reco.com",
    )


@pytest.mark.parametrize("repository", REFUSED_REPOSITORIES)
def test_should_refuse_every_repository_outside_the_exact_allow_list(repository: str) -> None:
    # Given
    from edge_reco.targets import EdgeRecoTarget

    # When / Then
    with pytest.raises(ValueError, match="validated production values"):
        EdgeRecoTarget.production(repository)


def test_should_bind_the_runs_transferred_repository_in_ci(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    events: list[str] = []
    root = RecordingDag(events, RecordingProvider(events))
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "caller-source")
    monkeypatch.setattr(main_module, "dag", root)
    monkeypatch.setattr(edge_reco, "_product_checks", lambda _source: ())

    # When
    asyncio.run(edge_reco.ci("a" * 40, PRE_TRANSFER_REPOSITORY))

    # Then
    assert [call[2] for call in root.foundation_client.calls] == [PRE_TRANSFER_REPOSITORY] * 2


@pytest.mark.parametrize("repository", REFUSED_REPOSITORIES)
def test_should_refuse_ci_for_an_unlisted_repository_before_the_guard(
    monkeypatch: pytest.MonkeyPatch, repository: str
) -> None:
    # Given
    events: list[str] = []
    root = RecordingDag(events, RecordingProvider(events))
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "caller-source")
    monkeypatch.setattr(main_module, "dag", root)

    # When / Then
    with pytest.raises(ValueError, match="validated production values"):
        asyncio.run(edge_reco.ci("a" * 40, repository))
    assert root.foundation_client.calls == []


class RepositoryRecordingFoundation(GraphFoundation):
    def __init__(self, guarded: list[object]) -> None:
        self.guarded = guarded

    def guard(self, *_arguments: object, **options: object) -> dagger.Container:
        self.guarded.append(options.get("repository"))
        return cast(dagger.Container, GraphContainer())


class RepositoryRecordingDag(GraphDag):
    def __init__(self) -> None:
        self.urls: list[str] = []
        self.guarded: list[object] = []

    def git(self, repository: str) -> GraphGitRepository:
        self.urls.append(repository)
        return GraphGitRepository()

    def foundation(self) -> GraphFoundation:
        return RepositoryRecordingFoundation(self.guarded)


@pytest.mark.parametrize("entrypoint", ("workflow_security", "secret_scan", "security"))
def test_should_guard_the_runs_transferred_repository_history(monkeypatch: pytest.MonkeyPatch, entrypoint: str) -> None:
    # Given
    root = RepositoryRecordingDag()
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, GraphDirectory())
    monkeypatch.setattr(main_module, "dag", root)

    # When
    asyncio.run(getattr(edge_reco, entrypoint)(REPOSITORY))

    # Then
    assert root.urls == ["https://github.com/gainratio/edge-reco.git"] * 2
    assert root.guarded == [REPOSITORY]


@pytest.mark.parametrize("entrypoint", ("workflow_security", "secret_scan", "security"))
def test_should_refuse_history_guard_for_an_unlisted_repository(
    monkeypatch: pytest.MonkeyPatch, entrypoint: str
) -> None:
    # Given
    root = RepositoryRecordingDag()
    edge_reco = EdgeReco.__new__(EdgeReco)
    monkeypatch.setattr(main_module, "dag", root)

    # When / Then
    with pytest.raises(ValueError, match="validated production values"):
        asyncio.run(getattr(edge_reco, entrypoint)("attacker/edge-reco"))
    assert root.urls == [] and root.guarded == []


def test_should_upload_sarif_for_the_runs_transferred_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    events: list[str] = []
    root = RecordingDag(events, RecordingProvider(events))
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "caller-source")
    uploads: list[str] = []

    async def record(_source: object, request: main_module.SarifUploadRequest) -> str:
        uploads.append(request.repository)
        return "uploaded"

    monkeypatch.setattr(main_module, "dag", root)
    monkeypatch.setattr(edge_reco, "_upload_sarif", record)

    # When
    token = cast(dagger.Secret, RECORDING_GITHUB_TOKEN)
    asyncio.run(edge_reco.codeql_upload(token, "a" * 40, repository=PRE_TRANSFER_REPOSITORY))

    # Then
    assert uploads == [PRE_TRANSFER_REPOSITORY]
    assert [call[2] for call in root.foundation_client.calls] == [PRE_TRANSFER_REPOSITORY] * 2


def test_should_refuse_sarif_upload_for_an_unlisted_repository(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    events: list[str] = []
    root = RecordingDag(events, RecordingProvider(events))
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, "caller-source")
    monkeypatch.setattr(main_module, "dag", root)

    # When / Then
    token = cast(dagger.Secret, RECORDING_GITHUB_TOKEN)
    with pytest.raises(ValueError, match="validated production values"):
        asyncio.run(edge_reco.codeql_upload(token, "a" * 40, repository="attacker/edge-reco"))
    assert root.foundation_client.calls == []


def test_should_pin_the_pages_git_source_owner_to_hseshadr() -> None:
    # Given
    source = inspect.getsource(EdgeReco._provider_deploy)

    # Then: the Git-linked Pages project stays bound to hseshadr across the gainratio transfer
    assert main_module.PAGES_GIT_SOURCE_OWNER == "hseshadr"
    assert "git_source_owner=PAGES_GIT_SOURCE_OWNER" in source


class TransferredRecordingProvider(RecordingProvider):
    @staticmethod
    def _require_exact_arguments(arguments: tuple[object, ...]) -> None:
        assert arguments == _recording_provider_arguments(PRE_TRANSFER_REPOSITORY)


def test_should_deploy_the_runs_transferred_repository_identity(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    events: list[str] = []
    provider = TransferredRecordingProvider(events)
    edge_reco = _recording_edge_reco(monkeypatch, events, provider)
    root = RecordingDag(events, provider)
    monkeypatch.setattr(main_module, "dag", root)

    # When
    result = asyncio.run(_deploy_with_fake_secrets(edge_reco, PRE_TRANSFER_REPOSITORY))

    # Then
    assert VALID_DEPLOYMENT_ID in result
    assert "deploy" in events
    assert [call[2] for call in root.foundation_client.calls] == [PRE_TRANSFER_REPOSITORY] * 2


def test_should_delegate_both_repository_guard_entrypoints_to_foundation() -> None:
    # Given
    workflow_security = inspect.getsource(EdgeReco.workflow_security)
    secret_scan = inspect.getsource(EdgeReco.secret_scan)

    # Then
    assert "_shared_guard" in workflow_security
    assert "_shared_guard" in secret_scan
    assert "_legacy" not in workflow_security + secret_scan


def test_should_expose_security_and_live_release_functions() -> None:
    # Given
    expected = {
        "secret_scan",
        "codeql",
        "codeql_sarif",
        "codeql_upload",
        "release_preflight",
        "verify_live",
        "live_probe",
    }
    # When
    available = {name for name in expected if hasattr(EdgeReco, name)}
    # Then
    assert available == expected


def test_should_construct_every_retained_product_graph_with_typed_inputs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, GraphDirectory())
    monkeypatch.setattr(main_module, "dag", GraphDag())
    secret = cast(dagger.Secret, object())

    # When
    edge_reco.backend_quality(), edge_reco.backend_audit(), edge_reco.parity()
    edge_reco.frontend_quality(), edge_reco.browser_e2e(), edge_reco.frontend_audit()
    asyncio.run(edge_reco.workflow_security(REPOSITORY)), asyncio.run(edge_reco.secret_scan(REPOSITORY))
    asyncio.run(edge_reco.ci("a" * 40, REPOSITORY))
    edge_reco.build("a" * 40), edge_reco.release_preflight("a" * 40), edge_reco.codeql()
    asyncio.run(edge_reco.security(REPOSITORY))
    asyncio.run(edge_reco.codeql_upload(secret, "a" * 40, repository=REPOSITORY))
    asyncio.run(edge_reco.verify_live("a" * 40))
    deployment = cast(
        str,
        asyncio.run(edge_reco.deploy(secret, secret, secret, "a" * 40, "123456", 2, REPOSITORY)),
    )

    # Then
    assert edge_reco.codeql_sarif() is not None
    assert VALID_DEPLOYMENT_ID in deployment
    assert VALID_DEPLOYMENT_URL in deployment


def test_should_run_bundled_codeql_code_scanning_queries() -> None:
    # Given
    script = (Path(__file__).parents[1] / "scripts/codeql-analysis.sh").read_text()
    # Then
    assert "/opt/codeql/codeql database analyze" in script
    assert "--format=sarifv2.1.0" in script
    assert "--download" not in script
    assert "codeql/javascript" not in script


def test_should_not_commit_a_secret_shaped_gitleaks_canary() -> None:
    # Given
    module = inspect.getmodule(EdgeReco)
    # Then
    assert module is not None
    module_source = inspect.getsource(module)
    assert "ghp_" not in module_source


def test_should_not_retain_shared_provider_or_guard_implementations() -> None:
    # Given
    scripts = Path(__file__).parents[1] / "scripts"
    duplicates = (
        scripts / "cloudflare-pages.sh",
        scripts / "gitleaks-canary.sh",
    )

    # Then
    assert all(not path.exists() for path in duplicates)


def test_should_pin_foundation_to_literal_central_sha() -> None:
    # Given
    config = json.loads((Path(__file__).parents[2] / "dagger.json").read_text())
    dependency = next(item for item in config.get("dependencies", ()) if item["name"] == "foundation")

    # When
    source = dependency["source"]
    pin = dependency["pin"]

    # Then
    assert config["engineVersion"] == "v0.21.8"
    assert source == f"github.com/hseshadr/ci/modules/portfolio-foundation@{FOUNDATION_SHA}"
    assert pin == FOUNDATION_SHA
    assert re.fullmatch(r"[0-9a-f]{40}", pin)


def test_should_pin_cloudflare_pages_to_literal_central_sha() -> None:
    # Given
    config = json.loads((Path(__file__).parents[2] / "dagger.json").read_text())
    dependency = next(item for item in config.get("dependencies", ()) if item["name"] == "cloudflare-pages")

    # When
    source = dependency["source"]
    pin = dependency["pin"]

    # Then
    assert source == f"github.com/hseshadr/ci/modules/cloudflare-pages@{FOUNDATION_SHA}"
    assert pin == FOUNDATION_SHA
    assert re.fullmatch(r"[0-9a-f]{40}", pin)


def test_should_delegate_canonical_provider_delivery_to_the_generated_client() -> None:
    # Given
    deploy = inspect.getsource(EdgeReco.deploy) + inspect.getsource(EdgeReco._deploy_context)
    deploy += inspect.getsource(main_module.PagesRelease)

    # When / Then
    assert "dag.cloudflare_pages" in deploy
    assert "_disable_git_deployments" not in deploy
    assert "_deploy_artifact" not in deploy


def test_should_keep_product_live_verification_local_to_edge_reco() -> None:
    # Given
    verify_live = inspect.getsource(EdgeReco.verify_live)

    # When / Then
    assert "playwright.live.config.ts" in inspect.getsource(EdgeReco._live_container)
    assert "_smoke" in verify_live
    assert "_live_container" in inspect.getsource(EdgeReco._smoke)


def test_should_extract_one_exact_attempt_from_serialized_green_main_evidence() -> None:
    # Given
    evidence = json.dumps(
        {
            "branch": "main",
            "commit_sha": "a" * 40,
            "repository": "gainratio/edge-reco",
            "run_attempt": 2,
            "workflow_run_id": "123456",
        }
    )

    # When
    attempt = parse_release_evidence(evidence)

    # Then
    assert attempt == ("a" * 40, "123456", 2)


@pytest.mark.parametrize("repository", (REPOSITORY, PRE_TRANSFER_REPOSITORY))
def test_should_accept_green_main_evidence_from_either_owner(repository: str) -> None:
    # Given
    evidence = json.dumps(
        {"branch": "main", "commit_sha": "a" * 40, "repository": repository, "run_attempt": 2, "workflow_run_id": "1"}
    )

    # When / Then
    assert parse_release_evidence(evidence) == ("a" * 40, "1", 2)


@pytest.mark.parametrize("repository", REFUSED_REPOSITORIES)
def test_should_refuse_green_main_evidence_from_an_unlisted_repository(repository: str) -> None:
    # Given
    evidence = json.dumps(
        {"branch": "main", "commit_sha": "a" * 40, "repository": repository, "run_attempt": 2, "workflow_run_id": "1"}
    )

    # When / Then
    with pytest.raises(ValueError, match="serialized green-main evidence"):
        parse_release_evidence(evidence)


@pytest.mark.parametrize(
    "evidence",
    (
        "not json",
        "[]",
        "{}",
        '{"commit_sha":"short","workflow_run_id":"123456","run_attempt":2}',
        '{"commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflow_run_id":"0","run_attempt":2}',
        '{"commit_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","workflow_run_id":"123456","run_attempt":0}',
    ),
)
def test_should_reject_malformed_serialized_green_main_evidence(evidence: str) -> None:
    # Given / When / Then
    with pytest.raises(ValueError, match="serialized green-main evidence"):
        parse_release_evidence(evidence)


@pytest.mark.parametrize(("workflow_run_id", "run_attempt"), (("0", 1), ("abc", 1), ("123", 0)))
def test_should_reject_invalid_trigger_attempt_before_product_build(
    monkeypatch: pytest.MonkeyPatch,
    workflow_run_id: str,
    run_attempt: int,
) -> None:
    # Given
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, GraphDirectory())
    monkeypatch.setattr(main_module, "dag", GraphDag())

    # When / Then
    with pytest.raises(ValueError, match="workflow run identity"):
        asyncio.run(edge_reco._release_context("a" * 40, workflow_run_id, run_attempt, _production_target()))


def test_should_reject_noncanonical_sha_at_product_build_boundary() -> None:
    # Given
    edge_reco = EdgeReco.__new__(EdgeReco)
    edge_reco.source = cast(dagger.Directory, GraphDirectory())

    # When / Then
    with pytest.raises(ValueError, match="lowercase 40-character Git SHA"):
        edge_reco.build("A" * 40)


def test_should_consume_provider_deployment_id_and_unique_url_before_live_verification(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    evidence = cast(dagger.CloudflarePagesDeploymentEvidence, GraphDeployment())
    monkeypatch.setattr(main_module, "dag", GraphDag())

    # When
    identity = asyncio.run(EdgeReco._provider_identity(evidence))

    # Then
    assert (identity.deployment_id, identity.deployment_url) == (
        VALID_DEPLOYMENT_ID,
        VALID_DEPLOYMENT_URL,
    )


def test_should_materialize_the_verified_provider_deploy_once_when_reading_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    provider = MaterializingProvider(events)
    edge_reco = _recording_edge_reco(monkeypatch, events, provider)

    # When
    result = asyncio.run(_deploy_with_fake_secrets(edge_reco))

    # Then
    assert VALID_DEPLOYMENT_ID in result and VALID_DEPLOYMENT_URL in result
    assert events.count("construct:deploy") == events.count("deploy") == 1
    assert events.count("construct:verify") == events.count("verify") == 0
    assert events.count("load:deploy-evidence") == 1


def test_should_not_repeat_provider_preflight_or_verification_around_deploy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    provider = RejectingRedundantProviderStages(events)
    edge_reco = _recording_edge_reco(monkeypatch, events, provider)

    # When
    result = asyncio.run(_deploy_with_fake_secrets(edge_reco))

    # Then
    assert VALID_DEPLOYMENT_ID in result and VALID_DEPLOYMENT_URL in result
    assert events.count("deploy") == 1
    assert "preflight" not in events


def test_should_reject_a_wrong_envelope_at_the_provider_boundary() -> None:
    # Given
    provider = RecordingProvider([])
    arguments: tuple[object, ...] = (
        "wrong-envelope",
        RECORDING_GITHUB_TOKEN,
        RECORDING_CLOUDFLARE_TOKEN,
        RECORDING_CLOUDFLARE_ACCOUNT,
        "123456",
        2,
        "gainratio/edge-reco",
        "edge-reco",
        "main",
        "edge-reco.com",
        "dist",
        ["www.edge-reco.com"],
        "gainratio/edge-reco@" + "a" * 40,
        FOUNDATION_SHA + ":123456",
        ["dist"],
    )

    # When / Then
    with pytest.raises(AssertionError):
        asyncio.run(provider.preflight(*arguments))


def _wrong_provider_arguments(position: int, value: object) -> tuple[object, ...]:
    arguments = list(_recording_provider_arguments())
    arguments[position] = value
    return tuple(arguments)


def _run_provider_stage(provider: RecordingProvider, stage: str, arguments: tuple[object, ...]) -> None:
    if stage == "preflight":
        asyncio.run(provider.preflight(*arguments))
    else:
        provider.deploy(*arguments)


@pytest.mark.parametrize("stage", ("preflight", "deploy"))
@pytest.mark.parametrize(
    ("position", "wrong"),
    (
        (0, "wrong-envelope"),
        (4, "999999"),
        (5, 3),
        (7, "wrong-project"),
        (8, "wrong-branch"),
        (9, "wrong.example.com"),
        (12, "gainratio/edge-reco@" + "b" * 40),
        (13, FOUNDATION_SHA + ":999999"),
    ),
)
def test_should_reject_wrong_provider_argument_at_every_generated_stage(
    stage: str, position: int, wrong: object
) -> None:
    # Given
    events: list[str] = []
    provider = RecordingProvider(events)

    # When / Then
    with pytest.raises(AssertionError):
        _run_provider_stage(provider, stage, _wrong_provider_arguments(position, wrong))
    assert events == []


def test_should_order_shared_provider_mutation_after_source_guard_and_product_build(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    edge_reco = _recording_edge_reco(monkeypatch, events, RecordingProvider(events))

    # When
    result = asyncio.run(_deploy_with_fake_secrets(edge_reco))

    # Then
    assert result == (
        f"provider deployment verified: id={VALID_DEPLOYMENT_ID} url={VALID_DEPLOYMENT_URL}\n"
        "Live smoke passed: release, fresh\nlive proof"
    )
    assert events == [
        "source",
        "guard",
        "build",
        "directory",
        "envelope",
        "provider-client",
        "previous",
        f"identity:{PREVIOUS_DEPLOYMENT_ID}",
        f"url:{PREVIOUS_DEPLOYMENT_URL}",
        "provider-client",
        "deploy",
        "materialize:created-evidence",
        "load:created-evidence",
        f"identity:{VALID_DEPLOYMENT_ID}",
        f"url:{VALID_DEPLOYMENT_URL}",
        "smoke:@release|@fresh",
    ]


def test_should_roll_production_back_through_the_shared_module_when_the_live_smoke_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    codes = {"@release|@fresh": [1], "@fresh": [0]}
    edge_reco = _recording_edge_reco(monkeypatch, events, RecordingProvider(events), codes)

    # When / Then
    with pytest.raises(LiveSmokeError, match=f"rolled back from {VALID_DEPLOYMENT_ID} to {PREVIOUS_DEPLOYMENT_ID}"):
        asyncio.run(_deploy_with_fake_secrets(edge_reco))
    assert events[-4:] == [
        "smoke:@release|@fresh",
        "provider-client",
        f"rollback:{PREVIOUS_DEPLOYMENT_ID}",
        "smoke:@fresh",
    ]


def test_should_execute_each_cache_never_provider_call_exactly_once_on_a_rollback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: three field reads off the lazy rollback ran three rollbacks (almamesh run 37162823046)."""
    # Given
    events: list[str] = []
    codes = {"@release|@fresh": [1], "@fresh": [0]}
    edge_reco = _recording_edge_reco(monkeypatch, events, RecordingProvider(events), codes)

    # When
    with pytest.raises(LiveSmokeError, match="rolled back"):
        asyncio.run(_deploy_with_fake_secrets(edge_reco))

    # Then
    assert events.count(f"rollback:{PREVIOUS_DEPLOYMENT_ID}") == 1
    assert events.count("previous") == 1


def test_should_fail_verify_live_on_a_red_smoke(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    events: list[str] = []
    edge_reco = _recording_edge_reco(monkeypatch, events, RecordingProvider(events), {"@release|@fresh": [1]})

    # When / Then
    with pytest.raises(LiveSmokeError, match="live proof"):
        asyncio.run(edge_reco.verify_live("a" * 40))


def test_should_probe_production_as_a_fresh_visitor_and_fail_on_red(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    events: list[str] = []
    edge_reco = _recording_edge_reco(monkeypatch, events, RecordingProvider(events), {"@fresh": [0, 1]})

    # When
    proof = asyncio.run(edge_reco.live_probe())

    # Then
    assert proof == "Live probe passed (fresh) against https://edge-reco.com\nlive proof"
    with pytest.raises(LiveSmokeError, match="Live probe failed"):
        asyncio.run(edge_reco.live_probe())
    assert events == ["smoke:@fresh", "smoke:@fresh"]


def test_should_never_cache_the_live_probe() -> None:
    # Given
    source = inspect.getsource(EdgeReco.live_probe)

    # Then
    assert '@function(cache="never")' in source


def test_should_judge_each_live_smoke_by_exit_code_with_a_fresh_nonce(monkeypatch: pytest.MonkeyPatch) -> None:
    # Given
    edge_reco = EdgeReco.__new__(EdgeReco)
    monkeypatch.setattr(main_module, "dag", GraphDag())
    monkeypatch.setattr(edge_reco, "_frontend", lambda *_arguments: SmokeGraphContainer())

    # When
    first = cast(SmokeGraphContainer, edge_reco._live_container(cast(dagger.Directory, None), "a" * 40, "@fresh"))
    second = cast(SmokeGraphContainer, edge_reco._live_container(cast(dagger.Directory, None), "a" * 40, "@fresh"))

    # Then
    command, options = first.executed
    assert command[-2:] == ["--grep", "@fresh"]
    assert "--config=playwright.live.config.ts" in command
    assert options == {"expect": dagger.ReturnType.ANY}
    assert first.environment["LIVE_BASE_URL"] == "https://edge-reco.com"
    assert first.environment["LIVE_SMOKE_RUN"] != second.environment["LIVE_SMOKE_RUN"]


def test_should_block_product_live_verification_when_provider_transaction_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    edge_reco = _recording_edge_reco(monkeypatch, events, FailingProviderTransaction(events))

    # When / Then
    with pytest.raises(ValueError, match="provider transaction failed"):
        asyncio.run(_deploy_with_fake_secrets(edge_reco))
    assert events[-1] == "deploy"


def test_should_reject_a_tampered_envelope_before_generated_provider_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    events: list[str] = []
    edge_reco = _recording_edge_reco(monkeypatch, events, TamperRejectingProvider(events))

    # When / Then
    with pytest.raises(ValueError, match="envelope checksum mismatch"):
        asyncio.run(_deploy_with_fake_secrets(edge_reco))
    assert events[-2:] == ["deploy", "provider-envelope-reject"]
    assert "provider-transport" not in events
    assert "live" not in events


async def _deploy_with_fake_secrets(edge_reco: EdgeReco, repository: str = REPOSITORY) -> str:
    token = cast(dagger.Secret, RECORDING_CLOUDFLARE_TOKEN)
    account = cast(dagger.Secret, RECORDING_CLOUDFLARE_ACCOUNT)
    github = cast(dagger.Secret, RECORDING_GITHUB_TOKEN)
    deployment = cast(Awaitable[str], edge_reco.deploy(token, account, github, "a" * 40, "123456", 2, repository))
    return await deployment


@pytest.mark.skipif(
    os.getenv("DAGGER_REAL_PROVIDER_PRETRANSPORT") != "1",
    reason="set DAGGER_REAL_PROVIDER_PRETRANSPORT=1 for the no-secret provider proof",
)
def test_should_reject_real_pinned_provider_preflight_before_transport_when_envelope_artifact_is_tampered(
    tmp_path: Path,
) -> None:
    # Given
    binary = shutil.which("dagger")
    assert binary is not None
    module = _real_provider_module(tmp_path, binary)
    config = json.loads((module / "dagger.json").read_text(encoding="utf-8"))

    # When
    result = _run_real_dagger(binary, module, "call", "tampered-preflight")
    output = result.stdout + result.stderr

    # Then
    dependencies = {item["name"]: item["pin"] for item in config["dependencies"]}
    assert dependencies == {"foundation": FOUNDATION_SHA, "cloudflare-pages": FOUNDATION_SHA}
    assert result.returncode != 0
    assert "Foundation.verifyEnvelope" in output
    assert "artifact bytes or modes differ from manifest" in output
    assert "Foundation.greenMain" not in output
    assert "api.github.com" not in output


def test_should_enforce_the_complete_dagger_quality_gate() -> None:
    # Given
    project = tomllib.loads((Path(__file__).parents[1] / "pyproject.toml").read_text())
    tasks = project["tool"]["poe"]["tasks"]

    # When
    gate = tuple(tasks["gate"])

    # Then
    assert project["tool"]["coverage"]["run"]["branch"] is True
    assert any(item.startswith("pytest-cov") for item in project["dependency-groups"]["dev"])
    assert gate == ("lint", "typecheck", "complexity", "test", "branchrate")
    assert "--cov-branch" in tasks["test"]
    assert "--cov-fail-under=90" in tasks["test"]


def test_should_compare_relevance_from_the_product_browser_package() -> None:
    assert EdgeReco._relevance_path() == ("packages/edgereco-browser/src/engine/__fixtures__/relevance_export.json")


def test_should_reinstall_the_same_assay_release_the_backend_locks() -> None:
    # Given
    backend = tomllib.loads((Path(__file__).parents[2] / "backend/pyproject.toml").read_text())
    pinned = [item for item in backend["project"]["dependencies"] if item.startswith("assay-engine")]

    # When
    requirement = main_module.ASSAY_INSTALL[-1]

    # Then
    assert pinned == ["assay-engine[metrics]==0.5.0.dev6"]
    assert requirement == "assay-engine==0.5.0.dev6"
