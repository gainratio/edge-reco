"""Re-sign the committed ``examples/catalog`` bundle from its own contents.

Materializes the current signed bundle into a staging dir, drops in the current
``DEFAULT_RANKING_CONFIG`` (so a config retune — e.g. Phase-2's strategy map, Phase-3's
co-occurrence strategies — flows into the seed bundle) plus the seed ``cooccurrence.json``
computed from the committed demo session log, and republishes.

Product images follow ``EDGERECO_IMAGE_MODE`` — ONE switch, two supported modes:

``local`` (default)
    Every product's REAL photo is downloaded here, once, validated
    (``edgereco.catalog.image_download``), written to ``frontend/app/public/images/``
    and pointed at by a root-relative ``image_url``. A page load then makes ZERO
    third-party requests, so the deployed CSP stays ``img-src 'self' data:``. A photo
    that fails to download falls back to that product's generated SVG card
    (``edgereco.catalog.product_image``) — per product, never per build.

``remote``
    The catalog's own CDN urls are restored and no images are staged. The deployment
    must then list those hosts in ``img-src`` (``frontend/app/scripts/imageCsp.mjs``
    does this at build time) AND ship them to the component allowlist, or every card
    renders as a placeholder. Cheaper to build; every visitor's IP reaches that CDN.

Photo BYTES are deliberately kept out of the signed bundle: ``syncIndex`` reassembles
and hash-verifies every manifest file on each sync, so signing ~16 MB of photos would
push them onto every visitor for bytes no client reads back. They are an origin asset.

The prebuilt ``vector/`` is carried verbatim (embeddings depend on text, not on
``image_url``), so the FAISS index stays byte-identical.

Every rebuild publishes at a STRICTLY GREATER ``sequence`` — a changed bundle at an
unchanged sequence is what a client refuses as a rollback, permanently bricking it.

Run from backend/ (regenerate the demo sessions first if they changed)::

    .venv/bin/python3 scripts/gen_demo_sessions.py
    .venv/bin/python3 scripts/rebuild_example_bundle.py

After the CATALOG changed (``scripts/generate_catalog.py``), pass ``--from-source`` so
products.jsonl and the FAISS ``vector/`` are rebuilt from ``examples/source/catalog.csv``
through ``edgereco build-catalog`` + ``edgereco index`` (needs the embedding model:
``EDGEPROC_ALLOW_MODEL_DOWNLOAD=1`` or ``EDGEPROC_MODEL_PATH``)::

    .venv/bin/python3 scripts/rebuild_example_bundle.py --from-source

Then mirror the result into the browser parity fixture (the browser syncs this copy)::

    rm -rf ../frontend/packages/edgereco-browser/src/engine/__fixtures__/bundle/catalog
    cp -R examples/catalog \
        ../frontend/packages/edgereco-browser/src/engine/__fixtures__/bundle/catalog
"""

from __future__ import annotations

import ast
import csv
import glob
import hashlib
import json
import os
import shutil
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import zstandard as zstd

from edgereco.catalog.image_download import ProductPhoto, fetch_product_photo
from edgereco.catalog.product_image import ImageMode
from edgereco.catalog.publish import publish_bundle
from edgereco.cli import build_catalog, index
from edgereco.reco.cooccurrence import (
    CooccurrenceMatrix,
    SessionLog,
    build_cooccurrence,
    sessions_from_logs,
)
from edgereco.reco.ranking_config import DEFAULT_RANKING_CONFIG

BACKEND_ROOT = Path(__file__).resolve().parent.parent
CATALOG = BACKEND_ROOT / "examples" / "catalog"
SOURCE_CSV = BACKEND_ROOT / "examples" / "source" / "catalog.csv"
DEMO_SESSIONS = BACKEND_ROOT / "examples" / "source" / "demo_sessions.jsonl"
KEY = BACKEND_ROOT / "examples" / "keys" / "private.key"
PUBLIC_IMAGES = BACKEND_ROOT.parent / "frontend" / "app" / "public" / "images"
CATALOG_ID = "amazon-demo"
VERSION = "v1"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
DIM = 384

#: THE switch. `EDGERECO_IMAGE_MODE=remote` publishes a bundle that keeps the catalog's
#: own CDN urls (and needs those hosts in the deployed `img-src`); the default `local`
#: downloads every photo here, once, so a page load makes zero third-party requests.
IMAGE_MODE = ImageMode(os.environ.get("EDGERECO_IMAGE_MODE", ImageMode.LOCAL.value))
#: Card-sized rendition. The grid renders ~227 CSS px and the PDP hero ~420, so 400 is
#: the smallest width that stays sharp on the surfaces a shopper actually looks at.
PHOTO_MAX_PX = int(os.environ.get("EDGERECO_IMAGE_MAX_PX", "400"))
#: Polite, bounded parallelism — enough to keep a 720-product build to ~a minute.
FETCH_WORKERS = 8


def _source_image_urls() -> dict[str, str]:
    """``{product id: first remote image url}`` read from the committed source catalog.

    The published bundle no longer carries the remote urls (LOCAL mode rewrote them),
    so the ORIGINAL csv is the only place either mode can recover them from.
    """
    csv.field_size_limit(10**7)
    urls: dict[str, str] = {}
    with SOURCE_CSV.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            images = _parse_image_list(row.get("all_images", ""))
            if images:
                urls[row["asin"]] = images[0]
    return urls


def _parse_image_list(raw: str) -> list[str]:
    """The csv stores a python-literal list; a malformed cell yields no image."""
    try:
        parsed = ast.literal_eval(raw)
    except (ValueError, SyntaxError):
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def _download_photos(product_ids: list[str]) -> dict[str, ProductPhoto]:
    """Localize every product's real photo. Failures are skipped, never fatal.

    A product with no source photo (the synthetic catalog has none) makes no request;
    it simply gets its generated card.
    """
    urls = _source_image_urls()
    product_ids = [pid for pid in product_ids if urls.get(pid)]
    with (
        httpx.Client(timeout=httpx.Timeout(20.0), follow_redirects=True) as client,
        ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool,
    ):
        fetched = pool.map(
            lambda pid: (
                pid,
                fetch_product_photo(client, urls.get(pid, ""), max_px=PHOTO_MAX_PX),
            ),
            product_ids,
        )
        photos = {pid: photo for pid, photo in fetched if photo is not None}
    _report_download(len(product_ids), photos)
    return photos


def _report_download(total: int, photos: dict[str, ProductPhoto]) -> None:
    """One honest line: how many products show a real photo and how many a placeholder."""
    have = len(photos)
    megabytes = sum(len(p.body) for p in photos.values()) / 1024 / 1024
    sys.stdout.write(
        f">> photos: {have}/{total} real ({megabytes:.1f} MB), "
        f"{total - have} fell back to a generated card\n"
    )


def _manifest() -> dict[str, object]:
    return json.loads(Path(glob.glob(str(CATALOG / "manifest" / "*"))[0]).read_bytes())


def _materialize(path: str) -> bytes:
    entry = next(f for f in _manifest()["files"] if f["path"] == path)  # type: ignore[index]
    dctx = zstd.ZstdDecompressor()
    parts = [dctx.decompress((CATALOG / "chunk" / r["hash"]).read_bytes()) for r in entry["chunks"]]
    blob = b"".join(parts)
    if hashlib.sha256(blob).hexdigest() != entry["file_sha256"]:
        raise ValueError(f"{path} failed reassembly check")
    return blob


def _build_from_source(workdir: Path) -> None:
    """Run the real pipeline on the source csv: ``build-catalog`` then ``index``.

    Used when the catalog itself changed (``--from-source``): products.jsonl and the
    FAISS ``vector/`` are rebuilt from ``examples/source/catalog.csv`` instead of being
    carried over from the currently published bundle.
    """
    cache, built = workdir / "cache", workdir / "built"
    build_catalog(SOURCE_CSV, cache / "products.jsonl")
    index(cache, built)


def _stage(staging: Path, *, from_source: bool) -> int:
    """Stage products, vector, images, ranking config and co-occurrence; return count."""
    (staging / "vector").mkdir(parents=True, exist_ok=True)
    read = _materialize
    if from_source:
        workdir = staging.parent / "_source_build"
        shutil.rmtree(workdir, ignore_errors=True)
        _build_from_source(workdir)
        read = lambda path: (workdir / "built" / path).read_bytes()  # noqa: E731
    count = _stage_products_and_images(staging, read("products.jsonl"))
    for name in ("embeddings.f32", "index.faiss", "state.json"):
        (staging / "vector" / name).write_bytes(read(f"vector/{name}"))
    shutil.rmtree(staging.parent / "_source_build", ignore_errors=True)
    # Drop in the CURRENT default ranking config (carries the Phase-2/3 strategy map).
    (staging / "ranking_config.json").write_text(
        DEFAULT_RANKING_CONFIG.model_dump_json(), encoding="utf-8"
    )
    # Compute the seed co-occurrence from the committed demo session log.
    (staging / "cooccurrence.json").write_text(
        _seed_cooccurrence().model_dump_json(), encoding="utf-8"
    )
    return count


def _product_ids(raw: str) -> list[str]:
    """Every product id in a products.jsonl blob, in catalog order."""
    return [json.loads(line)["id"] for line in raw.split("\n") if line.strip()]


def _restore_remote_urls(raw: str, urls: dict[str, str]) -> str:
    """Put each product's ORIGINAL cdn url back (REMOTE mode).

    The committed bundle was published in LOCAL mode, so its urls already point at
    ``/images/<id>.svg``. Republishing REMOTE has to undo that from the source csv,
    otherwise the mode ships placeholders and looks broken.
    """
    out = []
    for line in raw.split("\n"):
        if not line.strip():
            continue
        record = json.loads(line)
        record["image_url"] = urls.get(record["id"], record.get("image_url", ""))
        out.append(json.dumps(record, ensure_ascii=False, separators=(",", ":")))
    return "\n".join(out) + "\n" if out else ""


def _stage_products_and_images(staging: Path, raw: bytes) -> int:
    """Stage products.jsonl plus every image the chosen mode needs.

    LOCAL: download each real photo, stage it for the SIGNED bundle AND mirror it to
    the SPA's public dir (the static origin is what actually serves ``/images/<id>``);
    a product whose download failed falls back to the generated card in
    ``publish_bundle``. REMOTE: restore the catalog's own cdn urls and stage no images.
    """
    text = raw.decode("utf-8")
    _reset_public_images()
    if IMAGE_MODE is ImageMode.REMOTE:
        restored = _restore_remote_urls(text, _source_image_urls())
        (staging / "products.jsonl").write_bytes(restored.encode("utf-8"))
        return len(_product_ids(restored))
    _stage_local_photos(staging, _download_photos(_product_ids(text)))
    (staging / "products.jsonl").write_bytes(text.encode("utf-8"))
    return len(_product_ids(text))


def _stage_local_photos(staging: Path, photos: dict[str, ProductPhoto]) -> None:
    """Write each downloaded photo into the staging bundle and the SPA's public dir."""
    images = staging / "images"
    images.mkdir(parents=True, exist_ok=True)
    for product_id, photo in photos.items():
        name = f"{product_id}.{photo.extension}"
        (images / name).write_bytes(photo.body)
        (PUBLIC_IMAGES / name).write_bytes(photo.body)


def _reset_public_images() -> None:
    """Clear + recreate ``frontend/app/public/images`` so a removed product leaves no orphan."""
    shutil.rmtree(PUBLIC_IMAGES, ignore_errors=True)
    PUBLIC_IMAGES.mkdir(parents=True, exist_ok=True)


def _seed_cooccurrence() -> CooccurrenceMatrix:
    """Build the seed co-occurrence matrix from ``demo_sessions.jsonl`` (labeled demo data)."""
    logs = [
        SessionLog.model_validate_json(line)
        for line in DEMO_SESSIONS.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return build_cooccurrence(sessions_from_logs(logs))


def _next_sequence() -> int:
    """One MORE than the sequence currently published. Read before `latest` is removed.

    This is load-bearing, not hygiene. A client refuses an incoming pointer whose
    sequence EQUALS its stored one but whose manifest hash differs — that shape is a
    publisher equivocating at one sequence, and `sync.ts` treats it as a rollback and
    throws (`refusing sequence N over active sequence N`). Because the promotion path
    only ever writes a higher sequence, a visitor bricked that way can never recover on
    their own. Republishing at a strictly greater sequence is what makes an update an
    update — and it also heals anyone already stuck on an older hash.
    """
    try:
        current = json.loads((CATALOG / "latest").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 1
    sequence = current.get("sequence")
    return sequence + 1 if isinstance(sequence, int) and sequence >= 0 else 1


def main() -> None:
    staging = CATALOG.parent / "_staging_rebuild"
    if staging.exists():
        shutil.rmtree(staging)
    sequence = _next_sequence()
    count = _stage(staging, from_source="--from-source" in sys.argv[1:])
    for sub in ("manifest", "chunk"):
        shutil.rmtree(CATALOG / sub, ignore_errors=True)
    (CATALOG / "latest").unlink(missing_ok=True)
    publish_bundle(
        staging_dir=staging,
        origin_dir=CATALOG,
        private_key_path=KEY,
        catalog_id=CATALOG_ID,
        version=VERSION,
        embedding_model=EMBEDDING_MODEL,
        embedding_dim=DIM,
        embedding_count=count,
        product_count=count,
        sequence=sequence,
        image_mode=IMAGE_MODE,
    )
    # AFTER publish: the producer fills in a generated card for every product whose
    # download failed, so mirroring here is what keeps the static origin and the signed
    # bundle serving the exact same set of files.
    _mirror_images_to_public(staging)
    shutil.rmtree(staging)
    _drop_producer_scratch()
    print(
        f"rebuilt {CATALOG} with strategy-map ranking_config "
        f"({count} products, image mode {IMAGE_MODE.value}, sequence {sequence})"
    )


def _mirror_images_to_public(staging: Path) -> None:
    """Copy the staged image set to the SPA's public dir — the origin that serves them."""
    images = staging / "images"
    if not images.is_dir():
        return
    for path in sorted(images.iterdir()):
        if path.is_file() and not path.is_symlink():
            (PUBLIC_IMAGES / path.name).write_bytes(path.read_bytes())


def _drop_producer_scratch() -> None:
    """Remove the producer-side CAS dirs (``chunks/``, ``manifests/``, ``active``).

    ``build_bundle`` lays out the flat ``chunk/`` + ``manifest/`` + ``latest`` origin
    the CDN serves *and* leaves its internal sharded store beside it. Only the flat
    origin belongs in the committed bundle, so the scratch dirs are dropped here.
    """
    shutil.rmtree(CATALOG / "chunks", ignore_errors=True)
    shutil.rmtree(CATALOG / "manifests", ignore_errors=True)
    (CATALOG / "active").unlink(missing_ok=True)


if __name__ == "__main__":
    main()
