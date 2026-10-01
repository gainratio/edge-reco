"""Static ranking proof: Assay formula probes sealed once with Avow."""

from __future__ import annotations

import importlib
import json
import os
from pathlib import Path
from types import ModuleType

import pytest
from avow import content_hash, generate_signing_key, public_key_hex, verify_signature
from avow.errors import KeyPermissionsInsecure, PayloadHashMismatch, SignatureInvalid
from nacl.signing import SigningKey
from tests.signing import save_seed

from edgereco.reco.ranking_config import (
    DEFAULT_RANKING_CONFIG,
    GradedSignal,
    InteractionWeights,
)

_SEED = b"\x07" * 32
_REPO_ROOT = Path(__file__).resolve().parents[4]
_BROWSER_FIXTURE = (
    _REPO_ROOT / "frontend/packages/edgereco-browser/src/engine/__fixtures__/ranking_proof_v1.json"
)
_FORMULA_IDS = (
    "retrieval",
    "popularity",
    "category_match",
    "tag_match",
    "brand_match",
    "freshness",
    "similarity",
    "cooccurrence",
    "repetition_penalty",
)


def _module(name: str) -> ModuleType:
    return importlib.import_module(name)


def _key() -> SigningKey:
    return SigningKey(_SEED)


def _signals(formula: ModuleType) -> object:
    return formula.FormulaSignals(
        retrieval=0.0,
        popularity=0.7,
        category_match=0.6,
        tag_match=0.8,
        brand_match=0.5,
        freshness=0.4,
        similarity=0.0,
        cooccurrence=0.0,
        repetition_penalty=1.0,
    )


def test_should_declare_exact_runtime_order_when_building_assay_formula() -> None:
    # Given
    formula = _module("edgereco.reco.formula")

    # When
    request = formula.formula_request(_signals(formula), DEFAULT_RANKING_CONFIG.scoring_weights)

    # Then
    assert request.method == "additive"
    assert tuple(term.id for term in request.terms) == _FORMULA_IDS
    assert tuple(term.operation.value for term in request.terms) == (*("add",) * 8, "subtract")
    assert tuple(term.coefficient for term in request.terms) == (
        1.0,
        0.40,
        0.20,
        0.15,
        0.10,
        0.10,
        0.0,
        0.0,
        0.25,
    )


def test_should_preserve_binary64_runtime_score_when_composing_with_assay() -> None:
    # Given
    formula = _module("edgereco.reco.formula")

    # When
    result = formula.explain_score(_signals(formula), DEFAULT_RANKING_CONFIG.scoring_weights)

    # Then
    assert result.score == 0.3600000000000001
    assert tuple(component.contribution for component in result.components) == (
        0.0,
        0.27999999999999997,
        0.12,
        0.12,
        0.05,
        0.04000000000000001,
        0.0,
        0.0,
        0.25,
    )


def test_should_cover_search_and_every_strategy_when_building_static_proof() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")

    # When
    proof = receipts.build_ranking_proof(DEFAULT_RANKING_CONFIG)

    # Then
    assert proof.schema_version == "edgereco.ranking-proof/v1"
    assert proof.ranking_config_hash == content_hash(DEFAULT_RANKING_CONFIG.model_dump(mode="json"))
    assert tuple(probe.id for probe in proof.formula_probes) == (
        "search",
        *sorted(DEFAULT_RANKING_CONFIG.strategies),
    )


def test_should_preserve_every_strategy_weight_when_building_formula_probes() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")

    # When
    proof = receipts.build_ranking_proof(DEFAULT_RANKING_CONFIG)

    # Then
    probes = {probe.id: probe for probe in proof.formula_probes}
    for strategy_id, strategy in DEFAULT_RANKING_CONFIG.strategies.items():
        coefficients = tuple(row.coefficient for row in probes[strategy_id].result.components)
        assert coefficients == (
            1.0,
            strategy.weights.popularity,
            strategy.weights.category,
            strategy.weights.tag,
            strategy.weights.brand,
            strategy.weights.freshness,
            strategy.weights.similarity,
            strategy.weights.cooccurrence,
            strategy.weights.repetition_penalty,
        )


def test_should_sort_strategy_probe_ids_canonically() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    strategy = DEFAULT_RANKING_CONFIG.strategies["for_you"]
    config = DEFAULT_RANKING_CONFIG.model_copy(
        update={"strategies": {"2": strategy, "10": strategy}}
    )

    # When
    proof = receipts.build_ranking_proof(config)

    # Then
    assert tuple(probe.id for probe in proof.formula_probes) == ("search", "10", "2")


def test_should_sort_unicode_strategy_probe_ids_like_javascript() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    strategy = DEFAULT_RANKING_CONFIG.strategies["for_you"]
    config = DEFAULT_RANKING_CONFIG.model_copy(
        update={"strategies": {"\ue000": strategy, "\U00010000": strategy}}
    )

    # When
    proof = receipts.build_ranking_proof(config)

    # Then -- JavaScript compares strings by UTF-16 code units.
    assert tuple(probe.id for probe in proof.formula_probes) == (
        "search",
        "\U00010000",
        "\ue000",
    )


def test_should_sign_deterministically_when_proof_and_key_are_unchanged() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")

    # When
    first = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())
    second = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())

    # Then
    assert first.model_dump_json() == second.model_dump_json()
    verify_signature(first, expected_public_key=public_key_hex(_key()))


def test_should_change_whole_config_hash_when_interaction_weight_changes() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    retuned = DEFAULT_RANKING_CONFIG.model_copy(
        update={
            "interaction_weights": InteractionWeights(
                click=GradedSignal(category=0.11, tag=0.05, brand=0.08),
                view=DEFAULT_RANKING_CONFIG.interaction_weights.view,
                favorite=DEFAULT_RANKING_CONFIG.interaction_weights.favorite,
                cart=DEFAULT_RANKING_CONFIG.interaction_weights.cart,
            )
        }
    )

    # When
    base = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())
    changed = receipts.sign_ranking_receipt(retuned, _key())

    # Then
    assert base.payload.ranking_config_hash != changed.payload.ranking_config_hash
    assert base.signature != changed.signature


def test_should_fail_verification_when_payload_is_tampered() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    receipt = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())
    forged_payload = receipt.payload.model_copy(
        update={"ranking_config_hash": f"sha256:{'0' * 64}"}
    )
    forged = receipt.model_copy(update={"payload": forged_payload})

    # When / Then
    with pytest.raises(PayloadHashMismatch):
        verify_signature(forged, expected_public_key=public_key_hex(_key()))


def test_should_fail_verification_when_pinned_key_is_wrong() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    receipt = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())

    # When / Then
    with pytest.raises(SignatureInvalid):
        verify_signature(receipt, expected_public_key=public_key_hex(generate_signing_key()))


def test_should_load_raw_seed_as_same_publisher_identity(tmp_path: Path) -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    key_path = tmp_path / "private.key"
    save_seed(bytes(_key()), key_path)

    # When
    loaded = receipts.signing_key_from_seed(key_path)

    # Then
    assert public_key_hex(loaded) == public_key_hex(_key())


@pytest.mark.skipif(os.name != "posix", reason="POSIX mode bits are required")
def test_should_reject_group_readable_signing_seed(tmp_path: Path) -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    key_path = tmp_path / "private.key"
    key_path.write_bytes(bytes(_key()))
    key_path.chmod(0o640)

    # When / Then
    with pytest.raises(KeyPermissionsInsecure, match="owner-only"):
        receipts.signing_key_from_seed(key_path)


def test_should_emit_edge_owned_payload_inside_avow_envelope() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")

    # When
    receipt = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())
    document = json.loads(receipt.model_dump_json())

    # Then
    assert document["schema"] == "avow.receipt/v1"
    assert document["payload"]["schema"] == "edgereco.ranking-proof/v1"
    assert receipts.RANKING_RECEIPT_NAME == "ranking_receipt.json"


def test_should_match_committed_python_to_browser_proof_fixture() -> None:
    # Given
    receipts = _module("edgereco.reco.score_receipt")
    generated = receipts.sign_ranking_receipt(DEFAULT_RANKING_CONFIG, _key())
    expected = json.dumps(json.loads(generated.model_dump_json(by_alias=True)), indent="\t")

    # When
    committed = _BROWSER_FIXTURE.read_text(encoding="utf-8").strip()

    # Then
    assert committed == expected
