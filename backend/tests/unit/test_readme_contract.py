"""The root README stays short, plain, and in the approved order.

The README is for a stranger: one plain sentence, a way to try it, the problem and what
this does about it, then Try it / How it works / limits / run / develop / more detail /
license. Technical depth lives in docs/. This drifts the moment nobody checks it: a
tagline edited in the README but not in pyproject, a badge wall, the old "At a glance"
template creeping back, internal jargon, a doc nobody links, a relative link to a file
that moved. Deliberately dumb: string and regex checks only, no markdown parser. It
guards shape and vocabulary, not prose.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from urllib.parse import unquote

_ROOT = Path(__file__).resolve().parents[3]
_README = (_ROOT / "README.md").read_text(encoding="utf-8")

_SECTIONS = (
    "## Try it",
    "## How it works",
    "## What it does not do",
    "## When to use something else",
    "## Run it yourself",
    "## Develop",
    "## More detail",
    "## License",
)
_RETIRED_TEMPLATE = ("## At a glance", "## Try it in 60 seconds", "BELOW THE FOLD")
_BANNED = (
    "northstar",
    "seam",
    "lego",
    "trust envelope",
    "receipt",
    "fail-closed",
    "fail closed",
    "gate",
    "fleet",
    "portfolio",
    "production-ready",
    "robust",
    "blazing",
    "enterprise-grade",
    "seamless",
    "substrate",
    "flywheel",
)
_FENCE = re.compile(r"^```.*?^```", re.MULTILINE | re.DOTALL)
_INLINE_CODE = re.compile(r"`[^`\n]*`")
_LINK = re.compile(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)


def _description() -> str:
    pyproject = tomllib.loads((_ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8"))
    description = pyproject["project"]["description"]
    assert isinstance(description, str)
    return description


def _content_lines() -> list[str]:
    return [line.strip() for line in _README.splitlines()[1:] if line.strip()]


def _prose() -> str:
    return _FENCE.sub("", _README)


def _relative_links() -> list[str]:
    targets = _LINK.findall(_prose())
    return [t for t in targets if not _SCHEME.match(t) and not t.startswith("#")]


def _section(heading: str) -> str:
    start = _README.index(heading + "\n")
    following = _README.find("\n## ", start + len(heading))
    return _README[start : following if following != -1 else len(_README)]


def test_should_open_with_a_title_and_the_package_description_as_tagline() -> None:
    # Given / When
    tagline = _content_lines()[0]

    # Then
    assert re.match(r"^# \S", _README.splitlines()[0])
    assert 0 < len(tagline) <= 120
    assert tagline == _description()


def test_should_put_the_live_demo_link_in_bold_right_under_the_tagline() -> None:
    # Given
    try_line = _content_lines()[1]

    # Then
    assert try_line.startswith("**[")
    assert "(https://edge-reco.com)" in try_line


def test_should_show_at_most_three_badges() -> None:
    # Then
    assert _README.count("[![") <= 3


def test_should_link_the_technical_docs_before_try_it() -> None:
    # Given
    tech = next(line for line in _content_lines() if line.startswith("**Technical docs:**"))

    # Then
    assert _README.index(tech) < _README.index("## Try it\n")
    assert "(docs/ARCHITECTURE.md)" in tech
    assert "(docs/GETTING_STARTED.md)" in tech


def test_should_keep_the_sections_in_the_approved_order() -> None:
    # When
    positions = [_README.index(heading + "\n") for heading in _SECTIONS]

    # Then
    assert positions == sorted(positions)


def test_should_not_bring_back_the_retired_template() -> None:
    # Then
    for marker in _RETIRED_TEMPLATE:
        assert marker not in _README, marker


def test_should_not_use_internal_jargon_or_hype() -> None:
    # Given: commands such as `make gate` and link targets (file names) are not prose
    prose = _LINK.sub("]", _INLINE_CODE.sub("", _prose())).lower()

    # When
    found = [word for word in _BANNED if re.search(rf"\b{re.escape(word)}\b", prose)]

    # Then
    assert found == []


def test_should_show_a_real_screenshot_in_try_it() -> None:
    # Given
    images = re.findall(r"!\[[^\]]+\]\((docs/assets/[^)]+\.png)\)", _section("## Try it"))

    # Then
    assert images
    assert all((_ROOT / image).is_file() for image in images)


def test_should_link_getting_started_from_develop() -> None:
    # Then
    assert "(docs/GETTING_STARTED.md)" in _section("## Develop")


def test_should_link_every_technical_doc_from_more_detail() -> None:
    # Given
    more = _section("## More detail")
    docs = sorted(p.relative_to(_ROOT).as_posix() for p in (_ROOT / "docs").glob("*.md"))

    # Then
    missing = [doc for doc in docs if f"({doc})" not in more]
    assert missing == []
    for top_level in ("CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md"):
        assert f"({top_level})" in _README, top_level


def test_should_link_the_interactive_architecture_map() -> None:
    # Then
    map_link = (
        r"\[\*{0,2}Explore the interactive architecture map[^\]]*\]"
        r"\(docs/architecture/index\.html\)"
    )
    assert re.search(map_link, _README)
    assert (_ROOT / "docs" / "architecture" / "runtime.architecture.json").is_file()


def test_should_say_mit_in_the_license_section() -> None:
    # Then
    assert "MIT" in _section("## License")


def test_should_resolve_every_relative_link_to_a_path_in_the_repo() -> None:
    # Given
    links = _relative_links()

    # When
    missing = [t for t in links if not (_ROOT / unquote(t.split("#")[0])).exists()]

    # Then
    assert links
    assert missing == []
