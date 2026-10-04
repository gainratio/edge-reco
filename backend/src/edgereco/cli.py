"""Typer CLI for EdgeReco — sync, index, serve, search, preprocess."""

from __future__ import annotations

import json
import shutil
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Annotated

import typer

if TYPE_CHECKING:
    from collections.abc import Iterator

    import polars as pl

    from edgereco.api.deps import ServiceContainer
    from edgereco.catalog.models import SearchResult
    from edgereco.reco.reranker import RetrievalEvidence

app = typer.Typer(name="edgereco", help="EdgeReco: edge product discovery engine.")


@contextmanager
def _coded_model_refusal() -> Iterator[None]:
    """Render edge-proc's fail-closed model refusal as ``[code] message``, exit 1.

    Since edge-proc 0.4.0 the embedding model never downloads implicitly: it needs
    ``EDGEPROC_MODEL_PATH`` (a local model directory) or, on a build machine,
    ``EDGEPROC_ALLOW_MODEL_DOWNLOAD=1``. The refusal already names both remedies, so
    the CLI prints it with its canonical code instead of a traceback.
    """
    from edgeproc.localvec.model_source import ModelSourceError

    try:
        yield
    except ModelSourceError as exc:
        code = getattr(exc, "code", "config.invalid")
        typer.echo(f"[{code}] {exc}", err=True)
        raise typer.Exit(1) from exc


# ---------------------------------------------------------------------------
# index
# ---------------------------------------------------------------------------


@app.command()
def index(
    cache_dir: Annotated[Path, typer.Argument(help="Cache directory with products.jsonl")],
    index_dir: Annotated[Path, typer.Argument(help="Output directory for indexes")],
) -> None:
    """Build vector + keyword indexes from CACHE_DIR/products.jsonl."""
    from edgereco.catalog.loader import load_jsonl
    from edgereco.embeddings.encoder import ProductEncoder
    from edgereco.embeddings.index import VectorIndex

    products_path = cache_dir / "products.jsonl"
    if not products_path.exists():
        typer.echo(f"ERROR: {products_path} not found", err=True)
        raise typer.Exit(1)

    typer.echo(f"Loading products from {products_path}...")
    products = load_jsonl(products_path)
    typer.echo(f"Loaded {len(products)} products.")

    typer.echo("Encoding embeddings (this may take a moment)...")
    with _coded_model_refusal():
        encoder = ProductEncoder()
    embeddings = encoder.encode(products)
    ids = [p.id for p in products]
    dim = encoder.dim

    vector_dir = index_dir / "vector"
    vi = VectorIndex.build(embeddings, ids, dim=dim)
    vi.save(vector_dir)
    typer.echo(f"Vector index saved to {vector_dir}  (rows={len(products)}, dim={dim})")

    # Copy products.jsonl to index_dir for keyword rebuild at serve time
    index_dir.mkdir(parents=True, exist_ok=True)
    dest = index_dir / "products.jsonl"
    shutil.copy2(products_path, dest)
    typer.echo(f"Keyword corpus copied to {dest}")


# ---------------------------------------------------------------------------
# bundle
# ---------------------------------------------------------------------------


@app.command()
def bundle(
    staging_dir: Annotated[
        Path, typer.Argument(help="Staging dir: products.jsonl + saved vector/ index")
    ],
    origin_dir: Annotated[Path, typer.Argument(help="Output origin dir a device can sync")],
    private_key_path: Annotated[
        Path, typer.Argument(help="Raw ed25519 private key (edgeproc keygen)")
    ],
    catalog_id: Annotated[str, typer.Option(help="Catalog id")] = "amazon-demo",
    version: Annotated[str, typer.Option(help="Bundle version string")] = "v1",
    embedding_model: Annotated[
        str, typer.Option(help="Embedding model id")
    ] = "sentence-transformers/all-MiniLM-L6-v2",
    embedding_dim: Annotated[int, typer.Option(help="Embedding dimension")] = 384,
    embedding_count: Annotated[
        int, typer.Option(help="Number of embedding rows in vector/embeddings.f32")
    ] = 0,
    product_count: Annotated[int, typer.Option(help="Number of products in the catalog")] = 0,
    sequence: Annotated[
        int | None,
        typer.Option(
            min=1,
            max=2**53 - 1,
            help=(
                "Monotonic signed release sequence: must exceed every sequence already "
                "published for this catalog id, across signing keys (a new key does not "
                "reset it). Browsers refuse a lower or equal one as a rollback. Default: "
                "one more than ORIGIN_DIR/latest serves now (1 on a fresh origin); an "
                "explicit value at or below it is refused."
            ),
        ),
    ] = None,
) -> None:
    """Build a signed, content-addressed bundle (FAISS index + catalog) origin.

    Key rotation: pin an edgeproc.keyring/v1 trust root listing the old and new keys
    (see docs/DEPLOY.md) rather than swapping public.key, and keep --sequence rising.
    """
    from edgereco.catalog.publish import SequenceNotIncreasingError, publish_bundle

    try:
        publish_bundle(
            staging_dir=staging_dir,
            origin_dir=origin_dir,
            private_key_path=private_key_path,
            catalog_id=catalog_id,
            version=version,
            embedding_model=embedding_model,
            embedding_dim=embedding_dim,
            embedding_count=embedding_count,
            product_count=product_count,
            sequence=sequence,
        )
    except SequenceNotIncreasingError as exc:
        typer.echo(f"ERROR: {exc}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"Built bundle '{catalog_id}' v{version} → {origin_dir}")


# ---------------------------------------------------------------------------
# serve
# ---------------------------------------------------------------------------


@app.command()
def serve(  # pragma: no cover
    cache_dir: Annotated[Path, typer.Argument(help="Cache directory with products.jsonl")],
    index_dir: Annotated[Path, typer.Argument(help="Directory with vector/ index")],
    # Bind all interfaces by default so the demo container is reachable from the host.
    host: Annotated[str, typer.Option(help="Bind host")] = "0.0.0.0",  # noqa: S104
    port: Annotated[int, typer.Option(help="Bind port")] = 8000,
) -> None:
    """Start the EdgeReco API server.

    When ``EDGERECO_BUNDLE_BASE_URL`` + ``EDGERECO_VERIFY_KEY_PATH`` are set, the
    runtime syncs a signed, content-addressed bundle from that origin (HTTP for an
    http(s) URL, filesystem for a local path) and verifies it against the pinned
    public key. Otherwise it loads the legacy flat ``cache_dir`` + ``index_dir``.
    """
    import uvicorn

    from edgereco.api.app import create_app
    from edgereco.api.deps import ServiceContainer
    from edgereco.config import Settings

    settings = Settings()
    if settings.bundle_base_url and settings.verify_key_path:
        from edgeproc.bundles.signing import Ed25519Verifier

        verifier = Ed25519Verifier.from_public_bytes(settings.verify_key_path.read_bytes())
        container = ServiceContainer.from_synced(
            base_url=settings.bundle_base_url,
            cache_root=settings.bundle_cache_dir,
            verifier=verifier,
        )
    else:
        container = ServiceContainer.from_dirs(cache_dir, index_dir)
    fastapi_app = create_app(container)
    typer.echo(f"Serving on http://{host}:{port}  (catalog: {len(container.catalog)} products)")
    uvicorn.run(fastapi_app, host=host, port=port)


# ---------------------------------------------------------------------------
# search
# ---------------------------------------------------------------------------


def _fused_search_results(
    container: ServiceContainer, query: str, k: int
) -> tuple[list[SearchResult], dict[str, RetrievalEvidence]]:
    """Fused candidates plus the absolute retrieval scores RRF discards."""
    from edgereco.catalog.models import SearchResult
    from edgereco.reco.reranker import retrieval_evidence
    from edgereco.search.hybrid import reciprocal_rank_fusion

    keyword_hits = container.keyword.search(query, k=k)
    query_vec = container.encoder.encode_query(query)
    vector_hits = container.vector.search(query_vec, k=k)
    results: list[SearchResult] = []
    for pid, score in reciprocal_rank_fusion(keyword_hits, vector_hits):
        product = container.by_id.get(pid)
        if product is not None:
            results.append(SearchResult(product=product, score=score))
    return results, retrieval_evidence(keyword_hits, vector_hits)


def _print_search_results(results: list[SearchResult], output_json: bool) -> None:
    """Print results as JSON or an aligned plain-text table."""
    if output_json:
        typer.echo(json.dumps([r.model_dump() for r in results]))
        return
    typer.echo(f"{'ID':<12} {'Score':>7}  {'Category':<18}  Title")
    typer.echo("-" * 72)
    for r in results:
        typer.echo(
            f"{r.product.id:<12} {r.score:>7.4f}  {r.product.category:<18}  {r.product.title}"
        )


@app.command()
def search(
    query: Annotated[str, typer.Argument(help="Search query")],
    cache_dir: Annotated[Path, typer.Argument(help="Cache directory with products.jsonl")],
    index_dir: Annotated[Path, typer.Argument(help="Directory with vector/ index")],
    limit: Annotated[int, typer.Option(help="Number of results")] = 10,
    category: Annotated[str | None, typer.Option(help="Filter by category")] = None,
    output_json: Annotated[bool, typer.Option("--json", help="Output as JSON")] = False,
) -> None:
    """Search the catalog and print results."""
    from edgereco.api.deps import ServiceContainer
    from edgereco.catalog.models import SessionProfile
    from edgereco.reco.reranker import rerank_search

    with _coded_model_refusal():
        container = ServiceContainer.from_dirs(cache_dir, index_dir)
    fused, evidence = _fused_search_results(container, query, k=max(limit * 3, 30))
    results = rerank_search(fused, SessionProfile(), evidence)
    if category:
        results = [r for r in results if r.product.category == category]
    _print_search_results(results[:limit], output_json)


# ---------------------------------------------------------------------------
# preprocess
# ---------------------------------------------------------------------------


DEFAULT_PREPROCESS_CATEGORIES = (
    "Electronics",
    "Clothing",
    "Home & Kitchen",
    "Sports",
    "Books",
)


def _scalar_as_float(value: object, default: float) -> float:
    """Coerce a polars aggregate scalar to ``float``, falling back on null/non-numeric.

    ``Series.min()/.max()`` are typed as a broad union (dates, bytes, lists, ...),
    so we narrow to numeric values explicitly instead of trusting the column dtype.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return float(value)


def _top_category(raw_category: object) -> str:
    """First segment of a ``>``-separated category path."""
    parts = str(raw_category).split(">")
    return parts[0].strip() if parts else ""


def _write_products_jsonl(
    df: pl.DataFrame,
    out_path: Path,
    target_categories: set[str],
    limit: int,
    *,
    pop_min: float,
    pop_max: float,
    fresh_min: float,
    fresh_max: float,
) -> int:
    """Write rows in ``target_categories`` as JSONL products, capped at ``limit``."""
    from edgereco.catalog.preprocessor import amazon_row_to_product

    count = 0
    with out_path.open("w", encoding="utf-8") as f:
        for row in df.iter_rows(named=True):
            if _top_category(row.get("category_id", "")) not in target_categories:
                continue
            product = amazon_row_to_product(
                row, pop_min=pop_min, pop_max=pop_max, fresh_min=fresh_min, fresh_max=fresh_max
            )
            f.write(product.model_dump_json() + "\n")
            count += 1
            if count >= limit:
                break
    return count


def _write_manifest(output_dir: Path, out_path: Path, count: int) -> None:
    """Emit ``manifest.json`` describing the freshly written ``products.jsonl``."""
    import hashlib

    from edgereco.catalog.models import CatalogFile, CatalogManifest

    checksum = "sha256:" + hashlib.sha256(out_path.read_bytes()).hexdigest()
    catalog_file = CatalogFile(
        path="products.jsonl", file_type="products", checksum=checksum, rows=count
    )
    manifest = CatalogManifest(
        catalog_id="amazon-demo",
        version="2026-04-24T00:00:00Z",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim=384,
        files=[catalog_file],
    )
    (output_dir / "manifest.json").write_text(manifest.model_dump_json(indent=2), encoding="utf-8")


@app.command()
def preprocess(
    input_path: Annotated[Path, typer.Argument(help="Path to Amazon CSV")],
    output_dir: Annotated[Path, typer.Argument(help="Output directory")],
    limit: Annotated[int, typer.Option(help="Max products to output")] = 10000,
    category: Annotated[
        list[str] | None,
        typer.Option(
            "--category",
            help=("Top-level category to keep (repeatable). Defaults to the 5 demo categories."),
        ),
    ] = None,
) -> None:
    """Convert Amazon CSV to EdgeReco JSONL + manifest."""
    import polars as pl

    target_categories = set(category) if category else set(DEFAULT_PREPROCESS_CATEGORIES)

    typer.echo(f"Reading {input_path}...")
    df = pl.read_csv(input_path)

    pop_expr = pl.col("stars").cast(pl.Float64) * (pl.col("reviews").cast(pl.Float64) + 1).log()
    df = df.with_columns([pop_expr.alias("pop_raw")])

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "products.jsonl"
    count = _write_products_jsonl(
        df,
        out_path,
        target_categories,
        limit,
        pop_min=_scalar_as_float(df["pop_raw"].min(), 0.0),
        pop_max=_scalar_as_float(df["pop_raw"].max(), 1.0),
        fresh_min=_scalar_as_float(df["boughtInLastMonth"].min(), 0.0),
        fresh_max=_scalar_as_float(df["boughtInLastMonth"].max(), 1.0),
    )
    _write_manifest(output_dir, out_path, count)
    typer.echo(f"Wrote {count} products to {out_path}")


# ---------------------------------------------------------------------------
# build-catalog (scraped-Amazon schema -> products.jsonl)
# ---------------------------------------------------------------------------


def _scraped_score_bounds(rows: list[dict[str, str]]) -> tuple[float, float, float, float]:
    """Min/max of raw popularity and freshness across all rows."""
    from edgereco.catalog.preprocessor import (
        _parse_int,
        _parse_rating,
        compute_scraped_popularity_raw,
    )

    pops, fresh = [], []
    for row in rows:
        stars, count = _parse_rating(row.get("rating_stars"), row.get("rating_count"))
        pops.append(compute_scraped_popularity_raw(stars, count))
        fresh.append(float(_parse_int(row.get("recent_purchases"))))
    return (
        min(pops, default=0.0),
        max(pops, default=1.0),
        min(fresh, default=0.0),
        max(fresh, default=1.0),
    )


@app.command(name="build-catalog")
def build_catalog(
    input_csv: Annotated[Path, typer.Argument(help="Path to scraped-Amazon products.csv")],
    output_jsonl: Annotated[Path, typer.Argument(help="Output products.jsonl path")],
) -> None:
    """Convert a scraped-Amazon CSV to an EdgeReco products.jsonl."""
    import csv

    from edgereco.catalog.preprocessor import scraped_row_to_product

    typer.echo(f"Reading {input_csv}...")
    # stdlib csv (not polars): the scraped dataset has un-doubled inch-mark quotes
    # inside quoted fields (e.g. `6' 1"`), an RFC4180 violation a strict chunked
    # parser rejects but csv.DictReader recovers from row-by-row.
    with input_csv.open(newline="", encoding="utf-8") as handle:
        rows: list[dict[str, str]] = [dict(r) for r in csv.DictReader(handle)]
    pop_min, pop_max, fresh_min, fresh_max = _scraped_score_bounds(rows)

    output_jsonl.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with output_jsonl.open("w", encoding="utf-8") as f:
        for row in rows:
            product = scraped_row_to_product(
                row, pop_min=pop_min, pop_max=pop_max, fresh_min=fresh_min, fresh_max=fresh_max
            )
            f.write(product.model_dump_json() + "\n")
            count += 1
    typer.echo(f"Wrote {count} products to {output_jsonl}")
