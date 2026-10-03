"""EdgeReco's complete build, security, and release graph."""

from __future__ import annotations

import json
from dataclasses import dataclass
from shlex import split as shell_split
from typing import Final, Self, cast

import dagger
from dagger import check, dag, field, function, object_type

from edge_reco.targets import EdgeRecoTarget

PYTHON_IMAGE: Final = "python:3.13.14-slim@sha256:9662417aace5ae7b8e2609cce472b72a8958e134ba372808abe9cc1a0c0125e6"
NODE_IMAGE: Final = "node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"
CODEQL_IMAGE: Final = "ubuntu:24.04@sha256:353675e2a41babd526e2b837d7ec780c2a05bca0164f7ea5dbbd433d21d166fc"
CODEQL_URL: Final = (
    "https://github.com/github/codeql-action/releases/download/codeql-bundle-v2.26.2/codeql-bundle-linux64.tar.zst"
)
CODEQL_CHECKSUM: Final = "sha256:0b152b004dec9fd57ccaf58d3fc410efa5be409e1b331cde280b0b8db7bc6dd6"
TARGET: Final = EdgeRecoTarget.production()
REPOSITORY: Final = TARGET.repository
REPOSITORY_URL: Final = f"https://github.com/{REPOSITORY}.git"
UV_VERSION: Final = "0.11.32"
PNPM_VERSION: Final = "11.5.0"
CHECK_SHA: Final = "0000000000000000000000000000000000000000"
CENTRAL_MODULE_SHA: Final = "2338511a17ed240121def1639a6c4f95c929ec2d"
DEPLOY_ROOT: Final = "dist"
PAGES_DOMAINS: Final = ("www.edge-reco.com",)
SHA_LENGTH: Final = 40
PREVIEW_ARGS: Final = tuple(shell_split("pnpm -C app exec vite preview --host --port 4173 --strictPort"))
ASSAY_INSTALL: Final = tuple(
    shell_split("uv pip install --python /opt/venv --no-cache --reinstall --no-deps assay-engine==0.5.0.dev6")
)
PLAYWRIGHT_INSTALL: Final = tuple(shell_split("pnpm -C app exec playwright install --with-deps chromium"))
FIXTURES: Final = tuple(shell_split("search_parity cooccurrence_parity strategy_parity embedding_parity hybrid_parity"))
FIXTURE_DIR: Final = "../frontend/packages/edgereco-browser/src/engine/__fixtures__"
SOURCE_EXCLUDES: Final = list(
    shell_split(
        ".git .venv .dagger/.venv .dagger/sdk **/.venv **/.coverage "
        "**/.mypy_cache **/.pytest_cache **/.ruff_cache **/__pycache__ "
        "**/node_modules **/dist **/coverage frontend/app/public/models frontend/app/public/ort"
    )
)
CODEQL_UPLOAD: Final = ("/opt/codeql/codeql", "github", "upload-results", "--github-auth-stdin")
AUTH_PIPE: Final = 'printf "%s" "$GITHUB_TOKEN" | exec "$@"'


@dataclass(frozen=True)
class ReleaseContext:
    """Exact shared evidence and source binding for one delivery attempt."""

    source: dagger.Directory
    commit_sha: str
    workflow_run_id: str
    run_attempt: int


@dataclass(frozen=True)
class ProviderRequest:
    """Closed provider inputs derived from the immutable release context."""

    envelope: dagger.Directory
    consumer_identity: str
    producing_identity: str
    workflow_run_id: str
    run_attempt: int


@dataclass(frozen=True)
class ProviderIdentity:
    """Non-secret provider identity safe to emit in hosted deployment logs."""

    deployment_id: str
    deployment_url: str


@dataclass(frozen=True)
class ProviderCredentials:
    """Typed secret bundle confined to the privileged deployment boundary."""

    github_token: dagger.Secret
    api_token: dagger.Secret
    account_id: dagger.Secret


@dataclass(frozen=True)
class SarifUploadRequest:
    """Typed SARIF upload identity and credential boundary."""

    github_token: dagger.Secret
    commit_sha: str
    ref: str
    repository: str


def parse_release_evidence(serialization: str) -> tuple[str, str, int]:
    """Accept one exact serialized green-main attempt from the shared boundary."""
    values = _release_evidence_values(serialization)
    if not _valid_release_evidence(values):
        raise ValueError("serialized green-main evidence is malformed")
    commit_sha, workflow_run_id, run_attempt, _, _ = values
    return cast(str, commit_sha), cast(str, workflow_run_id), cast(int, run_attempt)


def _release_evidence_values(serialization: str) -> tuple[object, object, object, object, object]:
    try:
        value = json.loads(serialization)
    except json.JSONDecodeError as error:
        raise ValueError("serialized green-main evidence is malformed") from error
    if not isinstance(value, dict):
        raise ValueError("serialized green-main evidence is malformed")
    return (
        cast(object, value.get("commit_sha")),
        cast(object, value.get("workflow_run_id")),
        cast(object, value.get("run_attempt")),
        cast(object, value.get("repository")),
        cast(object, value.get("branch")),
    )


def _valid_release_evidence(values: tuple[object, object, object, object, object]) -> bool:
    commit_sha, workflow_run_id, run_attempt, repository, branch = values
    identity = _valid_release_identity(commit_sha, repository, branch)
    return identity and _valid_release_attempt(workflow_run_id, run_attempt)


def _valid_release_identity(commit_sha: object, repository: object, branch: object) -> bool:
    return (
        isinstance(commit_sha, str)
        and _is_sha(commit_sha)
        and repository == TARGET.repository
        and branch == TARGET.branch
    )


def _valid_release_attempt(workflow_run_id: object, run_attempt: object) -> bool:
    return _valid_workflow_run_id(workflow_run_id) and _valid_run_attempt(run_attempt)


def _valid_workflow_run_id(value: object) -> bool:
    return isinstance(value, str) and value.isdecimal() and value != "0"


def _valid_run_attempt(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _is_sha(value: str) -> bool:
    return len(value) == SHA_LENGTH and all(character in "0123456789abcdef" for character in value)


@object_type
class EdgeReco:
    """Run the same typed release graph locally and on GitHub Actions."""

    source: dagger.Directory = field()

    @classmethod
    def create(cls, workspace: dagger.Workspace) -> Self:
        """Construct the graph from an explicit typed workspace snapshot."""
        instance = cls.__new__(cls)
        instance.source = workspace.directory("/", exclude=SOURCE_EXCLUDES)
        return instance

    @function
    def backend_quality(self) -> dagger.Container:
        """Run the strict Python gate with coverage and complexity floors."""
        return self._backend_quality(self.source)

    @function
    def backend_audit(self) -> dagger.Container:
        """Audit the exact Python lock without vulnerability suppressions."""
        return self._backend_audit(self.source)

    @function
    def parity(self) -> dagger.Container:
        """Regenerate and compare all Python-to-browser parity fixtures."""
        return self._parity(self.source)

    @function
    def frontend_quality(self) -> dagger.Container:
        """Run frontend quality, artifact freshness, and production i18n."""
        return self._frontend_quality(self.source)

    @function(name="browser")
    def browser_e2e(self) -> dagger.Container:
        """Run storefront, real-model, offline, and cold-network browser proofs."""
        return self._browser_e2e(self.source)

    @function
    def frontend_audit(self) -> dagger.Container:
        """Audit the exact pnpm lock without vulnerability suppressions."""
        return self._frontend_audit(self.source)

    @function
    @check
    async def ci(self, commit_sha: str) -> str:
        """Run every product gate only after the exact caller source is guarded."""
        source = await self._verified_source(self.source, commit_sha)
        for product in self._product_checks(source):
            await product.sync()
        return "EdgeReco canonical Dagger gate passed"

    @function
    async def workflow_security(self) -> dagger.Container:
        """Delegate the repository guard to the exact-SHA Foundation module."""
        source, commit_sha = await self._canonical_guard_source()
        return self._shared_guard(source, commit_sha)

    @function
    async def secret_scan(self) -> dagger.Container:
        """Delegate snapshot and complete-history scanning to Foundation."""
        source, commit_sha = await self._canonical_guard_source()
        return self._shared_guard(source, commit_sha)

    @function
    def build(self, commit_sha: str) -> dagger.Directory:
        """Build and validate the immutable Pages artifact for ``commit_sha``."""
        return self._build_source(self.source, commit_sha)

    @function
    def release_preflight(self, commit_sha: str) -> dagger.Container:
        """Validate pinned Wrangler and an exact Dagger-built artifact without credentials."""
        artifact = self._build_source(self.source, commit_sha)
        return self._wrangler_base(self.source, artifact).with_exec(
            ["sh", "app/scripts/wrangler-release.sh", "preflight", commit_sha]
        )

    @function
    def codeql(self) -> dagger.Container:
        """Run both official CodeQL analyses as a shadow gate before SARIF cutover."""
        return self._codeql_analysis(self.source)

    @function
    def codeql_sarif(self) -> dagger.Directory:
        """Analyze JavaScript/TypeScript and Python with the official CodeQL CLI."""
        return self._codeql_analysis(self.source).directory("/sarif")

    @function
    async def security(self) -> str:
        """Run every credentialless scheduled security check through Dagger."""
        source, commit_sha = await self._canonical_guard_source()
        checks = cast(
            tuple[dagger.Container, ...],
            (
                self._shared_guard(source, commit_sha),
                self.backend_audit(),
                self.frontend_audit(),
                self.codeql(),
            ),
        )
        for security_check in checks:
            await security_check.sync()
        return "security checks passed"

    def _codeql_analysis(self, source: dagger.Directory) -> dagger.Container:
        container = self._codeql().with_directory("/src", source).with_workdir("/src")
        return container.with_exec(["sh", ".dagger/scripts/codeql-analysis.sh"])

    @function
    async def codeql_upload(
        self,
        github_token: dagger.Secret,
        commit_sha: str,
        ref: str = "refs/heads/main",
        repository: str = REPOSITORY,
    ) -> str:
        """Upload Dagger-generated SARIF after GitHub default setup is retired."""
        source = await self._verified_source(self.source, commit_sha)
        request = SarifUploadRequest(github_token, commit_sha, ref, repository)
        return await self._upload_sarif(source, request)

    async def _upload_sarif(self, source: dagger.Directory, request: SarifUploadRequest) -> str:
        sarif = self._codeql_analysis(source).directory("/sarif")
        container = self._codeql().with_directory("/src", source).with_workdir("/src")
        container = container.with_directory("/sarif", sarif)
        container = container.with_secret_variable("GITHUB_TOKEN", request.github_token)
        for language in ("javascript-typescript", "python"):
            container = container.with_exec(self._codeql_upload_command(request, language))
        return await container.stdout()

    @staticmethod
    def _codeql_upload_command(request: SarifUploadRequest, language: str) -> list[str]:
        args = [*CODEQL_UPLOAD, f"--repository={request.repository}", f"--ref={request.ref}"]
        args.extend((f"--commit={request.commit_sha}", f"--sarif=/sarif/{language}.sarif"))
        return ["sh", "-ceu", AUTH_PIPE, "upload", *args]

    @function
    async def verify_live(self, commit_sha: str) -> str:
        """Verify public identity, canonical routing, and zero-egress browser behavior."""
        return await self._live_container(self.source, commit_sha).stdout()

    @function
    async def deploy(  # noqa: PLR0913,PLR0917 -- generated CLI requires explicit typed inputs.
        self,
        cloudflare_api_token: dagger.Secret,
        cloudflare_account_id: dagger.Secret,
        github_token: dagger.Secret,
        commit_sha: str,
        workflow_run_id: str,
        run_attempt: int,
    ) -> str:
        """Deploy one exact protected attempt and verify provider and live identity."""
        context = await self._release_context(commit_sha, workflow_run_id, run_attempt)
        credentials = ProviderCredentials(github_token, cloudflare_api_token, cloudflare_account_id)
        return await self._deploy_context(context, credentials)

    async def _deploy_context(self, context: ReleaseContext, credentials: ProviderCredentials) -> str:
        request = self._provider_request(self._build_source(context.source, context.commit_sha), context)
        provider = dag.cloudflare_pages()
        identity = await self._deliver(provider, request, credentials)
        live = await self._live_container(context.source, context.commit_sha).stdout()
        return self._deployment_result(identity, live)

    async def _deliver(
        self,
        provider: dagger.CloudflarePages,
        request: ProviderRequest,
        credentials: ProviderCredentials,
    ) -> ProviderIdentity:
        evidence = self._provider_deploy(provider, request, credentials)
        return await self._provider_identity(evidence)

    @staticmethod
    def _deployment_result(identity: ProviderIdentity, live: str) -> str:
        evidence = f"provider deployment verified: id={identity.deployment_id} url={identity.deployment_url}"
        return f"{evidence}\n{live}"

    def _build_source(self, source: dagger.Directory, commit_sha: str) -> dagger.Directory:
        self._require_sha(commit_sha)
        built = self._modeled(source, commit_sha).with_exec(["pnpm", "-F", "frontend", "run", "build:pages"])
        checked = built.with_exec(["pnpm", "-F", "frontend", "run", "test:artifacts"])
        return checked.directory("/src/frontend/app/dist")

    async def _release_context(self, commit_sha: str, workflow_run_id: str, run_attempt: int) -> ReleaseContext:
        """Bind the triggering checkout and its exact protected attempt."""
        self._require_release_attempt(workflow_run_id, run_attempt)
        bound = await self._verified_source(self.source, commit_sha)
        return ReleaseContext(bound, commit_sha, workflow_run_id, run_attempt)

    async def _verified_source(self, source: dagger.Directory, commit_sha: str) -> dagger.Directory:
        """Bind and guard one caller snapshot before any product evaluation."""
        self._require_sha(commit_sha)
        foundation = dag.foundation()
        bound = foundation.source(source, REPOSITORY, commit_sha)
        await foundation.guard(bound, REPOSITORY, commit_sha).sync()
        return bound

    async def _canonical_guard_source(self) -> tuple[dagger.Directory, str]:
        """Fetch public EdgeReco bytes that can be bound to complete Git history."""
        commit_sha = await dag.git(REPOSITORY_URL).branch(TARGET.branch).commit()
        self._require_sha(commit_sha)
        source = dag.git(REPOSITORY_URL).commit(commit_sha).tree(depth=0)
        return source, commit_sha

    def _shared_guard(self, source: dagger.Directory, commit_sha: str) -> dagger.Container:
        """Build the generated exact-SHA Foundation repository guard."""
        return dag.foundation().guard(source=source, repository=REPOSITORY, commit_sha=commit_sha)

    def _provider_request(self, artifact: dagger.Directory, context: ReleaseContext) -> ProviderRequest:
        """Create the closed central envelope and provider identity inputs."""
        consumer = f"{TARGET.repository}@{context.commit_sha}"
        producing = f"{CENTRAL_MODULE_SHA}:{context.workflow_run_id}"
        packaged = dag.directory().with_directory(DEPLOY_ROOT, artifact)
        envelope = dag.foundation().envelope(packaged, consumer, producing, [DEPLOY_ROOT])
        return ProviderRequest(envelope, consumer, producing, context.workflow_run_id, context.run_attempt)

    # fmt: off
    def _provider_deploy(
        self, provider: dagger.CloudflarePages, request: ProviderRequest,
        credentials: ProviderCredentials,
    ) -> dagger.CloudflarePagesDeploymentEvidence:
        """Request one generated-provider verified deployment transaction."""
        return provider.deploy(
            request.envelope, credentials.github_token, credentials.api_token,
            credentials.account_id, request.workflow_run_id, request.run_attempt,
            TARGET.repository, TARGET.project, TARGET.branch, TARGET.domain,
            DEPLOY_ROOT, list(PAGES_DOMAINS), request.consumer_identity,
            request.producing_identity, [DEPLOY_ROOT],
        )
    # fmt: on

    @staticmethod
    async def _provider_identity(evidence: dagger.CloudflarePagesDeploymentEvidence) -> ProviderIdentity:
        """Consume exact non-secret deployment evidence without repeating a mutation."""
        evidence_id = dagger.CloudflarePagesDeploymentEvidenceID(await evidence.id())
        stored = dag.load_cloudflare_pages_deployment_evidence_from_id(evidence_id)
        deployment_id = await stored.deployment_id()
        deployment_url = await stored.deployment_url()
        return ProviderIdentity(deployment_id, deployment_url)

    def _wrangler_base(self, source: dagger.Directory, artifact: dagger.Directory) -> dagger.Container:
        container = self._dependencies(source)
        return container.with_directory("/artifact", artifact).with_workdir("/src/frontend")

    def _live_container(self, source: dagger.Directory, commit: str) -> dagger.Container:
        self._require_sha(commit)
        verified = self._frontend(source, commit).with_env_variable("LIVE_BASE_URL", f"https://{TARGET.domain}")
        return verified.with_exec(
            [
                "pnpm",
                "-C",
                "app",
                "exec",
                "playwright",
                "test",
                "--config=playwright.live.config.ts",
            ]
        )

    def _python(self, source: dagger.Directory) -> dagger.Container:
        base = self._python_toolchain().with_directory("/src", source).with_workdir("/src/backend")
        base = base.with_env_variable("UV_PROJECT_ENVIRONMENT", "/opt/venv")
        base = base.with_mounted_cache("/root/.cache/uv", dag.cache_volume("edge-reco-uv"))
        return base.with_exec(["uv", "sync", "--group", "dev"]).with_exec(list(ASSAY_INSTALL))

    def _python_toolchain(self) -> dagger.Container:
        base = dag.container().from_(PYTHON_IMAGE).with_exec(["apt-get", "update"])
        base = base.with_exec(["apt-get", "install", "-y", "--no-install-recommends", "build-essential", "git", "jq"])
        return base.with_exec(["python", "-m", "pip", "install", f"uv=={UV_VERSION}"])

    def _product_checks(self, source: dagger.Directory) -> tuple[dagger.Container, ...]:
        return (
            self._backend_quality(source),
            self._backend_audit(source),
            self._parity(source),
            self._frontend_quality(source),
            self._browser_e2e(source),
            self._frontend_audit(source),
            self._codeql_analysis(source),
        )

    def _backend_quality(self, source: dagger.Directory) -> dagger.Container:
        return self._python(source).with_exec(["uv", "run", "poe", "gate"])

    def _backend_audit(self, source: dagger.Directory) -> dagger.Container:
        return self._python(source).with_exec(["uv", "run", "poe", "audit"])

    def _parity(self, source: dagger.Directory) -> dagger.Container:
        container = self._python(source).with_directory("/baseline", self._fixtures(source))
        for name in FIXTURES:
            script = f"scripts/gen_{name.removesuffix('_parity')}_fixture.py"
            container = container.with_exec(["uv", "run", "python", script])
        return container.with_exec(["sh", "-ceu", self._parity_command()])

    def _frontend_quality(self, source: dagger.Directory) -> dagger.Container:
        quality = self._frontend(source).with_exec(["apt-get", "update"])
        packages = ["apt-get", "install", "-y", "--no-install-recommends", "curl", "jq"]
        quality = quality.with_exec(packages).with_exec(["pnpm", "run", "gate:quality"])
        quality = quality.with_exec(["cmp", self._relevance_path(), "/baseline/relevance.json"])
        return quality.with_service_binding("preview", self._preview(quality)).with_exec(
            ["node", "app/scripts/verify-i18n.mjs", "http://preview:4173"]
        )

    def _browser_e2e(self, source: dagger.Directory) -> dagger.Container:
        return self._frontend(source).with_exec(["pnpm", "run", "gate:e2e"])

    def _frontend_audit(self, source: dagger.Directory) -> dagger.Container:
        return self._node(source).with_exec(["pnpm", "audit"])

    def _node(self, source: dagger.Directory, commit: str = CHECK_SHA) -> dagger.Container:
        base = dag.container().from_(NODE_IMAGE).with_exec(["corepack", "enable", "pnpm"])
        base = base.with_exec(["corepack", "install", "--global", f"pnpm@{PNPM_VERSION}"])
        base = base.with_directory("/src", source)
        base = base.with_env_variable("EXPECTED_SHA", commit).with_mounted_cache(
            "/pnpm/store", dag.cache_volume("edge-reco-pnpm")
        )
        return base.with_workdir("/src/frontend")

    def _dependencies(self, source: dagger.Directory, commit: str = CHECK_SHA) -> dagger.Container:
        container = self._node(source, commit).with_exec(["pnpm", "config", "set", "store-dir", "/pnpm/store"])
        return container.with_exec(["pnpm", "install", "--frozen-lockfile"])

    def _modeled(self, source: dagger.Directory, commit: str = CHECK_SHA) -> dagger.Container:
        container = self._dependencies(source, commit).with_mounted_cache(
            "/src/frontend/app/public/models", dag.cache_volume("edge-reco-model")
        )
        return container.with_exec(["node", "app/scripts/download-model.mjs"])

    def _frontend(self, source: dagger.Directory, commit: str = CHECK_SHA) -> dagger.Container:
        container = self._modeled(source, commit)
        container = container.with_file(
            "/baseline/relevance.json",
            self._fixtures(source).file("relevance_export.json"),
        )
        return container.with_mounted_cache(
            "/root/.cache/ms-playwright", dag.cache_volume("edge-reco-playwright")
        ).with_exec(list(PLAYWRIGHT_INSTALL))

    def _preview(self, quality: dagger.Container) -> dagger.Service:
        preview = quality.with_exec(["sed", "-i", "s/; upgrade-insecure-requests//", "app/public/_headers"])
        preview = preview.with_env_variable("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS", "preview")
        return preview.with_exposed_port(4173).as_service(args=list(PREVIEW_ARGS))

    @staticmethod
    def _fixtures(source: dagger.Directory) -> dagger.Directory:
        return source.directory("frontend/packages/edgereco-browser/src/engine/__fixtures__")

    @staticmethod
    def _codeql() -> dagger.Container:
        base = EdgeReco._codeql_base()
        archive = dag.http(CODEQL_URL, checksum=CODEQL_CHECKSUM)
        base = base.with_file("/opt/codeql.tar.zst", archive).with_exec(
            ["tar", "--zstd", "-xf", "/opt/codeql.tar.zst", "-C", "/opt"]
        )
        return base.with_exec(["mkdir", "-p", "/db", "/sarif"])

    @staticmethod
    def _codeql_base() -> dagger.Container:
        packages = ["ca-certificates", "git", "nodejs", "python3", "zstd"]
        base = dag.container(platform=dagger.Platform("linux/amd64")).from_(CODEQL_IMAGE)
        base = base.with_env_variable("DEBIAN_FRONTEND", "noninteractive")
        return base.with_exec(["apt-get", "update"]).with_exec(
            ["apt-get", "install", "-y", "--no-install-recommends", *packages]
        )

    @staticmethod
    def _require_sha(commit: str) -> None:
        if len(commit) != SHA_LENGTH or any(char not in "0123456789abcdef" for char in commit):
            raise ValueError("commit_sha must be a lowercase 40-character Git SHA")

    @staticmethod
    def _require_release_attempt(workflow_run_id: str, run_attempt: int) -> None:
        if not _valid_release_attempt(workflow_run_id, run_attempt):
            raise ValueError("workflow run identity is malformed")

    @staticmethod
    def _relevance_path() -> str:
        return "packages/edgereco-browser/src/engine/__fixtures__/relevance_export.json"

    @staticmethod
    def _parity_command() -> str:
        pairs = " ".join(f"--pair /baseline/{name}.json {FIXTURE_DIR}/{name}.json" for name in FIXTURES)
        return f"uv run python scripts/compare_parity_fixtures.py {pairs}"
