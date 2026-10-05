from edgereco.catalog.models import (
    CatalogFile,
    CatalogManifest,
    Product,
    SessionProfile,
)


def test_product_from_dict() -> None:
    data = {"id": "B001", "title": "Test", "category": "Electronics", "price": 9.99}
    product = Product.model_validate(data)
    assert product.id == "B001"
    assert product.popularity_score == 0.0
    assert product.tags == []


def test_product_full_fields() -> None:
    product = Product(
        id="B001",
        title="Test",
        category="Electronics",
        tags=["wireless"],
        brand="Sony",
        price=99.99,
        popularity_score=0.85,
        freshness_score=0.6,
    )
    assert product.brand == "Sony"
    assert len(product.tags) == 1


def test_catalog_manifest() -> None:
    manifest = CatalogManifest(
        catalog_id="test",
        version="2026-01-01T00:00:00Z",
        embedding_model="all-MiniLM-L6-v2",
        embedding_dim=384,
        files=[CatalogFile(path="products.jsonl", file_type="products", checksum="sha256:abc")],
    )
    assert manifest.catalog_id == "test"
    assert len(manifest.files) == 1


def test_session_profile_defaults() -> None:
    profile = SessionProfile()
    assert profile.category_affinity == {}
    assert profile.click_count == 0
    assert profile.recently_viewed == []
