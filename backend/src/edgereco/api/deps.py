"""FastAPI dependency injection: ServiceContainer + get_container()."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated

from edgeproc.bundles.adapters import FetchAdapter, FilesystemAdapter, HttpAdapter
from edgeproc.bundles.cas import FilesystemCacheStore
from edgeproc.bundles.manifest import IndexManifest
from edgeproc.bundles.signing import Verifier
from edgeproc.bundles.sync import materialize_file, sync_index
from fastapi import Depends, Request

from edgereco.catalog.models import CatalogManifest, Product
from edgereco.catalog.publish import CURRENT_META_SCHEMA, CatalogMeta
from edgereco.embeddings.encoder import DEFAULT_MODEL_NAME, ProductEncoder
from edgereco.embeddings.index import VectorIndex
from edgereco.reco.cooccurrence import CooccurrenceMatrix
from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG, RankingConfig
from edgereco.search.keyword import KeywordSearcher
from edgereco.search.vector import VectorSearcher

_log = logging.getLogger(__name__)

_RANKING_CONFIG_NAME = "ranking_config.json"
_COOCCURRENCE_NAME = "cooccurrence.json"

#: Builds a query encoder for a given model name. Seam kept so tests bind a
#: hermetic stub (no model download) and prod binds the real ``ProductEncoder``.
EncoderFactory = Callable[[str], ProductEncoder]


class EmbeddingModelMismatchError(RuntimeError):
    """The bound encoder's vector space contradicts the bundle's declared dim.

    A bundle ships a PREBUILT index computed with a specific model; a query
    encoded by an encoder of a different dimensionality lands in the wrong space
    and yields silently-wrong results. Raised (fail-closed) instead.
    """


def load_ranking_config(local: Path, *, meta_schema: int = 1) -> RankingConfig:
    """Read the bundle's ``ranking_config.json`` (public fail-closed loader).

    A genuinely pre-feature bundle (``meta_schema`` below the current schema) is
    allowed to omit the file and falls back to ``DEFAULT_RANKING_CONFIG`` — true
    backward compat. But a CURRENT bundle unexpectedly missing the file it should
    carry is a corruption signal and raises (never silently bakes legacy weights).
    """
    config_path = local / _RANKING_CONFIG_NAME
    if not config_path.exists():
        if meta_schema >= CURRENT_META_SCHEMA:
            raise FileNotFoundError(
                f"{config_path} missing from a current-schema bundle "
                f"(schema {meta_schema}); refusing to fall back to legacy weights"
            )
        return DEFAULT_RANKING_CONFIG
    return RankingConfig.model_validate_json(config_path.read_bytes())


def load_cooccurrence(local: Path, *, meta_schema: int = 1) -> CooccurrenceMatrix:
    """Read the bundle's ``cooccurrence.json`` (public fail-closed loader).

    A pre-feature bundle may omit it and gets an empty matrix; a CURRENT bundle
    missing the file raises rather than silently degrading to an empty matrix.
    """
    cooc_path = local / _COOCCURRENCE_NAME
    if not cooc_path.exists():
        if meta_schema >= CURRENT_META_SCHEMA:
            raise FileNotFoundError(
                f"{cooc_path} missing from a current-schema bundle "
                f"(schema {meta_schema}); refusing to fall back to an empty matrix"
            )
        return CooccurrenceMatrix()
    return CooccurrenceMatrix.model_validate_json(cooc_path.read_bytes())


@dataclass
class ServiceContainer:
    catalog: list[Product]
    by_id: dict[str, Product]
    keyword: KeywordSearcher
    vector: VectorSearcher
    encoder: ProductEncoder
    manifest: CatalogManifest | None = None
    ranking_config: RankingConfig = field(default_factory=lambda: DEFAULT_RANKING_CONFIG)
    cooccurrence: CooccurrenceMatrix = field(default_factory=CooccurrenceMatrix)

    # Back-compat shims: the loaders are now public module-level functions
    # (``load_ranking_config`` / ``load_cooccurrence``); these thin staticmethods
    # keep existing ``ServiceContainer._load_*`` callers working unchanged.
    _load_ranking_config = staticmethod(load_ranking_config)
    _load_cooccurrence = staticmethod(load_cooccurrence)

    @classmethod
    def from_catalog(
        cls,
        products: list[Product],
        *,
        manifest: CatalogManifest | None = None,
    ) -> ServiceContainer:
        encoder = ProductEncoder()
        embeddings = encoder.encode(products)
        ids = [p.id for p in products]
        index = VectorIndex.build(embeddings, ids, dim=encoder.dim)
        keyword = KeywordSearcher.build(products)
        vector = VectorSearcher(index)
        by_id = {p.id: p for p in products}
        return cls(
            catalog=products,
            by_id=by_id,
            keyword=keyword,
            vector=vector,
            encoder=encoder,
            manifest=manifest,
        )

    @classmethod
    def from_dirs(
        cls,
        cache_dir: Path,
        index_dir: Path,
        *,
        encoder_factory: EncoderFactory = ProductEncoder,
    ) -> ServiceContainer:
        """Build a container from a synced cache dir and a pre-built index dir."""
        from edgereco.catalog.loader import load_jsonl
        from edgereco.catalog.manifest import parse_manifest

        catalog = load_jsonl(cache_dir / "products.jsonl")
        manifest = parse_manifest(cache_dir / "manifest.json")
        encoder = _bind_encoder(
            declared_model=manifest.embedding_model,
            declared_dim=manifest.embedding_dim,
            factory=encoder_factory,
        )
        vector_index = VectorIndex.load(index_dir / "vector")
        keyword = KeywordSearcher.build(catalog)
        vector = VectorSearcher(vector_index)
        by_id = {p.id: p for p in catalog}
        return cls(
            catalog=catalog,
            by_id=by_id,
            keyword=keyword,
            vector=vector,
            encoder=encoder,
            manifest=manifest,
        )

    @classmethod
    def from_synced(
        cls,
        *,
        base_url: str,
        cache_root: Path,
        verifier: Verifier,
        encoder_factory: EncoderFactory = ProductEncoder,
    ) -> ServiceContainer:
        """Build a container from a signed, content-addressed bundle origin.

        Sync the bundle (fail-closed on a bad signature / tampered chunk), reassemble
        each bundled file into a local dir, ``VectorIndex.load`` the prebuilt ``vector/``
        (zero recompute on the edge), and parse ``catalog_meta.json`` into a
        ``CatalogManifest`` so ``/catalog/info`` keeps working unchanged.
        """
        from edgereco.catalog.loader import load_jsonl

        local = sync_and_materialize(base_url=base_url, cache_root=cache_root, verifier=verifier)
        catalog = load_jsonl(local / "products.jsonl")
        meta = CatalogMeta.model_validate_json((local / "catalog_meta.json").read_bytes())
        encoder = _bind_encoder(
            declared_model=meta.embedding_model,
            declared_dim=meta.embedding_dim,
            factory=encoder_factory,
        )
        vector = VectorSearcher(VectorIndex.load(local / "vector"))
        return cls(
            catalog=catalog,
            by_id={p.id: p for p in catalog},
            keyword=KeywordSearcher.build(catalog),
            vector=vector,
            encoder=encoder,
            manifest=_manifest_from_meta(meta),
            ranking_config=load_ranking_config(local, meta_schema=meta.schema_version),
            cooccurrence=load_cooccurrence(local, meta_schema=meta.schema_version),
        )


def sync_and_materialize(*, base_url: str, cache_root: Path, verifier: Verifier) -> Path:
    """Sync a signed bundle origin and reassemble its files into a local dir.

    Fail-closed on a bad signature or tampered chunk. Returns the dir holding the
    materialized ``products.jsonl`` + ``vector/`` + ``catalog_meta.json`` — the
    base inputs ``from_synced`` builds the serving container on.
    """
    store, manifest = _sync_and_load_manifest(
        base_url=base_url, cache_root=cache_root, verifier=verifier
    )
    return _materialize_bundle(store, manifest, cache_root / "materialized")


def _sync_and_load_manifest(
    *, base_url: str, cache_root: Path, verifier: Verifier
) -> tuple[FilesystemCacheStore, IndexManifest]:
    """Sync the origin into a fresh store, then load + validate the active manifest."""
    store = FilesystemCacheStore(cache_root)
    sync_index(base_url=base_url, store=store, adapter=_select_adapter(base_url), verifier=verifier)
    pointer = store.read_active()
    if pointer is None:  # pragma: no cover - sync_index promotes or raises
        raise RuntimeError("sync completed without promoting an active version")
    return store, IndexManifest.model_validate_json(store.get_manifest(pointer.manifest_hash))


def _materialize_bundle(store: FilesystemCacheStore, manifest: IndexManifest, dest: Path) -> Path:
    """Reassemble every bundled file (vector/ subdir preserved) into ``dest``.

    ``dest`` is a derived cache rebuilt from the CAS store on every sync: files a
    previous version materialized but the active manifest no longer carries are
    pruned first, so the on-disk tree always mirrors exactly the manifest's set.
    """
    _prune_stale_files(dest, wanted={entry.path for entry in manifest.files})
    for entry in manifest.files:
        out = dest / entry.path
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(materialize_file(store, manifest, entry.path))
    return dest


def _prune_stale_files(dest: Path, *, wanted: set[str]) -> None:
    """Delete files under ``dest`` absent from ``wanted``; sweep emptied dirs.

    Only the materialized dir itself is touched — the edgeproc CAS store lives
    ABOVE ``dest`` (its ``cache_root`` parent) and is never visited here.
    """
    if not dest.is_dir():
        return
    for path in sorted(dest.rglob("*"), reverse=True):
        _prune_path(path, dest=dest, wanted=wanted)


def _prune_path(path: Path, *, dest: Path, wanted: set[str]) -> None:
    """Unlink a file the active manifest no longer wants; rmdir an emptied dir."""
    if path.is_file() and path.relative_to(dest).as_posix() not in wanted:
        path.unlink()
    elif path.is_dir() and next(path.iterdir(), None) is None:
        path.rmdir()


def _select_adapter(base_url: str) -> FetchAdapter:
    """HTTP adapter for an http(s) origin, filesystem adapter for a local path."""
    if base_url.startswith(("http://", "https://")):
        return HttpAdapter()
    return FilesystemAdapter()


def _bind_encoder(
    *, declared_model: str, declared_dim: int, factory: EncoderFactory
) -> ProductEncoder:
    """Build the query encoder in the bundle's DECLARED embedding space.

    The bundle's prebuilt index was computed with ``declared_model``; the query
    encoder must match it, so it is built FROM the declared model (never a silent
    hardcoded default) and fails closed if its dimensionality contradicts the
    declared ``embedding_dim``.
    """
    model = declared_model or _default_model_logged()
    encoder = factory(model)
    if encoder.dim != declared_dim:
        _log.error(
            "encoder %r has dim=%d but bundle declares embedding_dim=%d — refusing "
            "to encode queries in the wrong embedding space",
            model,
            encoder.dim,
            declared_dim,
        )
        raise EmbeddingModelMismatchError(
            f"encoder dim={encoder.dim} contradicts declared embedding_dim={declared_dim}"
        )
    return encoder


def _default_model_logged() -> str:
    """Return the default model, logging that binding it was an EXPLICIT choice."""
    _log.warning(
        "bundle declares no embedding model — binding default %r as an explicit "
        "decision (legacy metadata), not an accidental fallback",
        DEFAULT_MODEL_NAME,
    )
    return DEFAULT_MODEL_NAME


def _manifest_from_meta(meta: CatalogMeta) -> CatalogManifest:
    """Project bundle ``catalog_meta.json`` onto the legacy ``CatalogManifest`` view."""
    return CatalogManifest(
        catalog_id=meta.catalog_id,
        version=meta.version,
        embedding_model=meta.embedding_model,
        embedding_dim=meta.embedding_dim,
        files=[],
    )


def get_container(request: Request) -> ServiceContainer:
    container = request.app.state.container
    if not isinstance(container, ServiceContainer):
        msg = "app.state.container is not a ServiceContainer; app was not initialized"
        raise RuntimeError(msg)
    return container


Container = Annotated[ServiceContainer, Depends(get_container)]
