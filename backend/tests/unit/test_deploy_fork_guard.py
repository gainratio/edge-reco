"""The deploy trigger must reject a fork's pull request, not merely a branch NAME.

``workflow_run`` fires in the BASE repository, with the base repository's secrets.
Its ``head_branch`` is attacker-controlled: a fork's default branch is also called
``main``, and a fork-PR run reports that name here. So a gate that checks only
``head_branch == 'main'`` admits any outside contributor's PR — and this workflow's
deploy job then checks out ``workflow_run.head_sha`` and runs ``pnpm install`` plus
the build with ``CLOUDFLARE_API_TOKEN`` in scope. A lifecycle script in the
fork-authored lockfile is arbitrary code holding the credential that fronts every
site in this portfolio.

Once the guard below holds, the ``ref: workflow_run.head_sha`` checkout is safe: the
only ``head_sha`` that reaches it belongs to a push to this repository's ``main``,
so it is a commit a maintainer already pushed. ``EXPECTED_SHA`` derives from the same
value and is therefore equally constrained — an attacker cannot influence either.

These tests evaluate the ACTUAL ``if:`` expression committed in
``.github/workflows/deploy.yml`` against synthesized event payloads, in both
polarities: a legitimate push to this repo's ``main`` must be ACCEPTED, and a fork
pull request claiming ``main`` must be REJECTED. ``test_pre_fix_guard_...`` replays
the expression this guard replaced against the same hostile payload and asserts it
was ACCEPTED — proof that these cases measure the guard's property, not its shape.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from itertools import takewhile
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_DEPLOY = _ROOT / ".github" / "workflows" / "deploy.yml"
_GUARDED_JOB = "deploy"
_THIS_REPO = "hseshadr/edge-reco"
#: Today's owner and the gainratio org after transfer: the guard must hold for both.
_THIS_REPOS = (_THIS_REPO, "gainratio/edge-reco")
_FORK_REPO = "attacker/edge-reco"

# The gate this one replaced, verbatim. Kept so the hostile-payload case can show
# the harness reporting ACCEPT for it — a red run for the code we deleted.
_PRE_FIX_GUARD = (
    "github.event_name == 'workflow_dispatch' || "
    "(github.event.workflow_run.conclusion == 'success' && "
    "github.event.workflow_run.head_branch == 'main')"
)

_TOKEN = re.compile(r"\(|\)|\|\||&&|==|!=|'[^']*'|[A-Za-z_][A-Za-z0-9_.]*")
_RUN_PREFIX = "github.event.workflow_run."
_BLOCK_MARKERS = (">-", ">", ">+", "|-", "|", "|+")
_IF_KEY = "    if:"

Value = str | bool | None


@dataclass(frozen=True)
class WorkflowRun:
    """The attacker-visible fields of a ``workflow_run`` payload."""

    event: str
    conclusion: str
    head_branch: str
    head_repository_full_name: str


@dataclass(frozen=True)
class Context:
    """The ``github`` context a job-level ``if:`` is evaluated against."""

    event_name: str
    repository: str
    workflow_run: WorkflowRun | None = None


def _run_field(run: WorkflowRun, field: str) -> str:
    if field == "event":
        return run.event
    if field == "conclusion":
        return run.conclusion
    if field == "head_branch":
        return run.head_branch
    if field == "head_repository.full_name":
        return run.head_repository_full_name
    raise ValueError(f"unmodelled workflow_run field: {field}")


def _resolve(context: Context, path: str) -> Value:
    """Look up a dotted path. An unmodelled path raises instead of vanishing to null."""
    if path == "github.event_name":
        return context.event_name
    if path == "github.repository":
        return context.repository
    if not path.startswith(_RUN_PREFIX):
        raise ValueError(f"unmodelled context path: {path}")
    if context.workflow_run is None:
        return None
    return _run_field(context.workflow_run, path[len(_RUN_PREFIX) :])


def _truthy(value: Value) -> bool:
    """GitHub coerces to boolean: null is false, a non-empty string is true."""
    return bool(value)


class _Evaluator:
    """Recursive-descent evaluator for the ``|| && == !=`` subset used by deploy.yml."""

    def __init__(self, expression: str, context: Context) -> None:
        self._tokens = _TOKEN.findall(expression)
        self._index = 0
        self._context = context

    def run(self) -> bool:
        value = self._or_expr()
        if self._index != len(self._tokens):
            raise ValueError(f"trailing tokens: {self._tokens[self._index :]}")
        return _truthy(value)

    def _peek(self) -> str | None:
        return self._tokens[self._index] if self._index < len(self._tokens) else None

    def _take(self) -> str:
        if self._index >= len(self._tokens):
            raise ValueError("expression ended early")
        self._index += 1
        return self._tokens[self._index - 1]

    def _or_expr(self) -> bool:
        result = _truthy(self._and_expr())
        while self._peek() == "||":
            self._take()
            result = _truthy(self._and_expr()) or result
        return result

    def _and_expr(self) -> bool:
        result = _truthy(self._compare())
        while self._peek() == "&&":
            self._take()
            result = _truthy(self._compare()) and result
        return result

    def _compare(self) -> Value:
        left = self._atom()
        if self._peek() not in ("==", "!="):
            return left
        equal = self._take() == "=="
        right = self._atom()
        return (left == right) if equal else (left != right)

    def _atom(self) -> Value:
        lexeme = self._take()
        if lexeme == "(":
            value = self._or_expr()
            if self._take() != ")":
                raise ValueError("unbalanced parenthesis")
            return value
        if lexeme.startswith("'"):
            return lexeme[1:-1]
        return _resolve(self._context, lexeme)


def evaluate(expression: str, context: Context) -> bool:
    """Evaluate a GitHub Actions ``if:`` expression against a synthesized context."""
    return _Evaluator(expression, context).run()


def _is_job_header(line: str) -> bool:
    """True for a two-space job key (``  deploy:``) — i.e. the end of the previous job."""
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return False
    return line.startswith("  ") and not line.startswith("   ")


def _job_lines(lines: list[str], job: str) -> list[str]:
    header = f"  {job}:"
    if header not in lines:
        raise ValueError(f"no job named {job!r}")
    start = lines.index(header) + 1
    ends = [i for i in range(start, len(lines)) if _is_job_header(lines[i])]
    return lines[start : ends[0] if ends else len(lines)]


def _is_continuation(line: str) -> bool:
    """A folded-scalar continuation is blank, or indented past the ``if:`` key itself."""
    return not line.strip() or line.startswith("      ")


def _fold(marker: str, rest: list[str]) -> str:
    """Join a folded block scalar the way YAML does: continuation lines, one space."""
    if marker not in _BLOCK_MARKERS:
        return marker
    body = takewhile(_is_continuation, rest)
    return " ".join(line.strip() for line in body if line.strip())


def extract_job_if(workflow: str, job: str) -> str:
    """Return the ``if:`` expression of ``job`` exactly as committed."""
    lines = _job_lines(workflow.splitlines(), job)
    for index, line in enumerate(lines):
        if line.startswith(_IF_KEY):
            return _fold(line[len(_IF_KEY) :].strip(), lines[index + 1 :])
    raise ValueError(f"job {job!r} declares no if:")


GUARD = extract_job_if(_DEPLOY.read_text(encoding="utf-8"), _GUARDED_JOB)


def _push_to_main(repository: str = _THIS_REPO) -> Context:
    """The one payload that may deploy: a push to THIS repo's main whose CI passed."""
    return Context(
        event_name="workflow_run",
        repository=repository,
        workflow_run=WorkflowRun("push", "success", "main", repository),
    )


def _fork_pull_request(event: str = "pull_request", repository: str = _THIS_REPO) -> Context:
    """A fork PR. The fork's default branch is ALSO called ``main`` — that is the point."""
    return Context(
        event_name="workflow_run",
        repository=repository,
        workflow_run=WorkflowRun(event, "success", "main", _FORK_REPO),
    )


def test_guard_is_read_from_the_committed_workflow() -> None:
    """Non-vacuity: a missing or gutted expression must fail here, not pass silently."""
    assert "head_repository.full_name == github.repository" in GUARD
    assert "github.event.workflow_run.event == 'push'" in GUARD


@pytest.mark.parametrize("repository", _THIS_REPOS)
def test_legitimate_push_to_this_repos_main_is_accepted(repository: str) -> None:
    assert evaluate(GUARD, _push_to_main(repository)) is True


@pytest.mark.parametrize("repository", _THIS_REPOS)
def test_fork_pull_request_claiming_main_is_rejected(repository: str) -> None:
    """The attack: an outside contributor's PR reaching base-repo secrets."""
    assert evaluate(GUARD, _fork_pull_request(repository=repository)) is False


@pytest.mark.parametrize("repository", _THIS_REPOS)
def test_fork_run_reporting_a_push_is_still_rejected(repository: str) -> None:
    """The repository check has teeth on its own, not merely as a proxy for the event."""
    assert evaluate(GUARD, _fork_pull_request(event="push", repository=repository)) is False


def test_pre_transfer_push_replayed_into_the_transferred_repo_is_rejected() -> None:
    """After the transfer, a run whose head claims the old owner is not this repository."""
    context = Context(
        event_name="workflow_run",
        repository="gainratio/edge-reco",
        workflow_run=WorkflowRun("push", "success", "main", _THIS_REPO),
    )
    assert evaluate(GUARD, context) is False


def test_same_repo_pull_request_is_rejected() -> None:
    """The ``event == 'push'`` clause has teeth on its own."""
    context = Context(
        event_name="workflow_run",
        repository=_THIS_REPO,
        workflow_run=WorkflowRun("pull_request", "success", "main", _THIS_REPO),
    )
    assert evaluate(GUARD, context) is False


def test_failed_ci_on_main_is_rejected() -> None:
    context = Context(
        event_name="workflow_run",
        repository=_THIS_REPO,
        workflow_run=WorkflowRun("push", "failure", "main", _THIS_REPO),
    )
    assert evaluate(GUARD, context) is False


def test_manual_dispatch_cannot_bypass_the_protected_dagger_run() -> None:
    context = Context(event_name="workflow_dispatch", repository=_THIS_REPO)
    assert evaluate(GUARD, context) is False


def test_pre_fix_guard_accepted_the_fork_pull_request() -> None:
    """Break the property, not the form: the gate we replaced ACCEPTS the attack."""
    assert evaluate(_PRE_FIX_GUARD, _fork_pull_request()) is True
    assert evaluate(GUARD, _fork_pull_request()) is False


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("'a' == 'a'", True),
        ("'a' == 'b'", False),
        ("'a' != 'b'", True),
        ("'a' == 'b' || 'c' == 'c'", True),
        ("'a' == 'b' && 'c' == 'c'", False),
        ("('a' == 'b' || 'c' == 'c') && 'd' == 'd'", True),
        ("'a' == 'b' || 'c' == 'c' && 'd' == 'e'", False),
    ],
)
def test_evaluator_follows_github_operator_precedence(expression: str, expected: bool) -> None:
    assert evaluate(expression, Context("push", _THIS_REPO)) is expected


def test_missing_workflow_run_resolves_to_null_not_a_match() -> None:
    context = Context(event_name="workflow_dispatch", repository=_THIS_REPO)
    assert evaluate("github.event.workflow_run.conclusion == 'success'", context) is False


def test_extractor_folds_a_block_scalar_and_stops_at_the_next_job() -> None:
    workflow = (
        "jobs:\n"
        "  preflight:\n"
        "    if: >-\n"
        "      a == 'x' &&\n"
        "      b == 'y'\n"
        "    outputs:\n"
        "      k: v\n"
        "  deploy:\n"
        "    if: always()\n"
    )
    assert extract_job_if(workflow, "preflight") == "a == 'x' && b == 'y'"
    assert extract_job_if(workflow, "deploy") == "always()"


def test_extractor_refuses_a_missing_job() -> None:
    with pytest.raises(ValueError, match="no job named"):
        extract_job_if("jobs:\n  deploy:\n    if: true\n", "preflight")


def test_resolver_rejects_an_unmodelled_context_path() -> None:
    """A typo'd path must abort, never evaluate to null and pass vacuously."""
    with pytest.raises(ValueError, match="unmodelled context path"):
        evaluate("github.actor == 'x'", Context("push", _THIS_REPO))
