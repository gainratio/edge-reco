"""Bit-exact Python precomputation of ``sqlite-vector`` 2-bit TurboQuant and coarse IVF shards.

Matches ``sqliteai/sqlite-vector``'s ``turbo_rotation_plan_init`` (12 Givens rotation rounds
seeded via ``turbo_splitmix64``) and ``turbo_make_codebook`` (Gauss-Legendre quadrature over
the shifted spherical Beta distribution) byte-for-byte, folding the 12 rounds into a single
dense orthogonal matrix so million-row catalogs quantize in seconds via BLAS.
"""

from __future__ import annotations

import math
import sqlite3
from typing import Final

import numpy as np
from numpy.polynomial.legendre import leggauss
from numpy.typing import NDArray

_SIGN_SEED_MASK: Final[int] = 0xA5A5A5A55A5A5A5A
_ROUND_SEED_MASK: Final[int] = 0xD1B54A32D192ED03
_U64_MASK: Final[int] = 0xFFFFFFFFFFFFFFFF
_SPLITMIX_GAMMA: Final[int] = 0x9E3779B97F4A7C15
_SPLITMIX_M1: Final[int] = 0xBF58476D1CE4E5B9
_SPLITMIX_M2: Final[int] = 0x94D049BB133111EB
_ANGLE_SCALE: Final[float] = 2.0 * math.pi / float(1 << 53)
_TURBO_QTYPE: Final[int] = 4
_DEFAULT_ROUNDS: Final[int] = 12
_DEFAULT_QBITS: Final[int] = 2
_DEFAULT_BLOCK_ROWS: Final[int] = 4096
_LLOYD_ITERS: Final[int] = 200
_EPSILON: Final[float] = 1e-12
_GL32_NODES, _GL32_WEIGHTS = leggauss(32)


def _splitmix64(state: list[int]) -> int:
    state[0] = (state[0] + _SPLITMIX_GAMMA) & _U64_MASK
    z = state[0]
    z = ((z ^ (z >> 30)) * _SPLITMIX_M1) & _U64_MASK
    z = ((z ^ (z >> 27)) * _SPLITMIX_M2) & _U64_MASK
    return (z ^ (z >> 31)) & _U64_MASK


def _initial_signs(dim: int) -> NDArray[np.float64]:
    state = [_SIGN_SEED_MASK ^ dim]
    signs = [-1.0 if (_splitmix64(state) & 1) == 1 else 1.0 for _ in range(dim)]
    return np.diag(np.asarray(signs, dtype=np.float64))


def _apply_round(matrix: NDArray[np.float64], dim: int, round_idx: int) -> NDArray[np.float64]:
    r_state = [(_ROUND_SEED_MASK ^ (dim << 32) ^ round_idx) & _U64_MASK]
    perm = list(range(dim))
    for i in range(dim - 1, 0, -1):
        j = _splitmix64(r_state) % (i + 1)
        perm[i], perm[j] = perm[j], perm[i]
    for i in range(0, dim - 1, 2):
        angle = float(np.float32(float(_splitmix64(r_state) >> 11) * _ANGLE_SCALE))
        c, s = float(np.float32(math.cos(angle))), float(np.float32(math.sin(angle)))
        col0, col1 = matrix[:, perm[i]].copy(), matrix[:, perm[i + 1]].copy()
        matrix[:, perm[i]] = c * col0 - s * col1
        matrix[:, perm[i + 1]] = s * col0 + c * col1
    return matrix


def build_rotation_matrix(dim: int = 384, rounds: int = _DEFAULT_ROUNDS) -> NDArray[np.float32]:
    """Fold ``sqlite-vector``'s signed permutation and Givens rounds into one matrix."""
    matrix = _initial_signs(dim)
    for round_idx in range(rounds):
        _apply_round(matrix, dim, round_idx)
    return matrix.astype(np.float32)


def _beta_pdf_shifted(x: NDArray[np.float64], dim: int) -> NDArray[np.float64]:
    if dim <= 1:
        return np.zeros_like(x)
    a = (dim - 1.0) * 0.5
    y = np.clip((x + 1.0) * 0.5, _EPSILON, 1.0 - _EPSILON)
    norm = math.lgamma(2.0 * a) - 2.0 * math.lgamma(a) - math.log(2.0)
    log_pdf = (a - 1.0) * (np.log(y) + np.log1p(-y)) + norm
    return np.where((x > -1.0) & (x < 1.0), np.exp(log_pdf), 0.0)


def _beta_interval_moments(lo: float, hi: float, dim: int) -> tuple[float, float]:
    lo_c, hi_c = max(-1.0, lo), min(1.0, hi)
    if hi_c <= lo_c:
        return 0.0, 0.0
    mid, half = 0.5 * (lo_c + hi_c), 0.5 * (hi_c - lo_c)
    pts = mid + half * _GL32_NODES
    pdfs = _beta_pdf_shifted(pts, dim)
    return float(half * np.dot(_GL32_WEIGHTS, pdfs)), float(
        half * np.dot(_GL32_WEIGHTS, pts * pdfs)
    )


def _lloyd_step(centroids: list[float], dim: int) -> tuple[list[float], float]:
    levels = len(centroids)
    nxt = [0.0] * levels
    max_change = 0.0
    for idx in range(levels):
        lo = -1.0 if idx == 0 else 0.5 * (centroids[idx - 1] + centroids[idx])
        hi = 1.0 if idx == levels - 1 else 0.5 * (centroids[idx] + centroids[idx + 1])
        prob, moment = _beta_interval_moments(lo, hi, dim)
        nxt[idx] = centroids[idx] if prob <= 1e-15 else moment / prob
        max_change = max(max_change, abs(nxt[idx] - centroids[idx]))
    return nxt, max_change


def make_turbo_codebook(
    bits: int = _DEFAULT_QBITS, dim: int = 384
) -> tuple[NDArray[np.float32], NDArray[np.float32]]:
    """Compute ``sqlite-vector``'s exact Lloyd-Max Beta codebook ``(centroids, boundaries)``."""
    levels = 1 << bits
    sigma = 1.0 / math.sqrt(max(dim, 1))
    centroids = [(-3.0 + 6.0 * i / (levels - 1)) * sigma for i in range(levels)]
    for _ in range(_LLOYD_ITERS):
        centroids, delta = _lloyd_step(centroids, dim)
        if delta < _EPSILON:
            break
    bounds = [0.5 * (centroids[i] + centroids[i + 1]) for i in range(levels - 1)]
    return np.asarray(centroids, dtype=np.float32), np.asarray(bounds, dtype=np.float32)


def _pack_2bit_codes(codes: NDArray[np.uint8]) -> NDArray[np.uint8]:
    n_rows, dim = codes.shape
    grouped = codes.reshape(n_rows, dim // 4, 4)
    packed: NDArray[np.uint8] = (
        grouped[:, :, 0]
        | (grouped[:, :, 1] << 2)
        | (grouped[:, :, 2] << 4)
        | (grouped[:, :, 3] << 6)
    ).astype(np.uint8)
    return packed


def quantize_turbo_batch(
    embeddings: NDArray[np.float32],
    rowids: NDArray[np.int64],
    *,
    rotation: NDArray[np.float32],
    centroids: NDArray[np.float32],
    boundaries: NDArray[np.float32],
) -> bytes:
    """Quantize a batch of vectors into ``sqlite-vector``'s ``vector0_*`` binary layout."""
    norms = np.linalg.norm(embeddings.astype(np.float32), axis=1, keepdims=True)
    unit = np.where(norms > _EPSILON, embeddings / np.maximum(norms, _EPSILON), 0.0)
    rotated = unit.astype(np.float32) @ rotation
    codes = np.searchsorted(boundaries, rotated, side="left").astype(np.uint8)
    inner = np.sum(rotated * centroids[codes], axis=1)
    scales = np.where((norms[:, 0] > _EPSILON) & (inner > 1e-6), 1.0 / inner, 0.0).astype("<f4")
    packed = _pack_2bit_codes(codes)
    dtype = np.dtype([("rowid", "<i8"), ("scale", "<f4"), ("codes", "u1", (packed.shape[1],))])
    records = np.empty(len(rowids), dtype=dtype)
    records["rowid"], records["scale"], records["codes"] = rowids, scales, packed
    return records.tobytes()


def _init_turboquant_tables(conn: sqlite3.Connection) -> None:
    conn.execute(
        'CREATE TABLE IF NOT EXISTS "vector0_products_embedding" '
        "(rowid1 INTEGER, rowid2 INTEGER, counter INTEGER, data BLOB)"
    )
    conn.executemany(
        "INSERT OR REPLACE INTO _sqliteai_vector VALUES ('products', 'embedding', ?, ?)",
        [("qtype", _TURBO_QTYPE), ("qbits", _DEFAULT_QBITS), ("qscale", 0.0), ("qoffset", 0.0)],
    )


def populate_turboquant_shadow(
    conn: sqlite3.Connection,
    embeddings: NDArray[np.float32],
    *,
    block_rows: int = _DEFAULT_BLOCK_ROWS,
    strip_raw_embeddings: bool = True,
) -> None:
    """Populate ``vector0_products_embedding`` and ``_sqliteai_vector`` in ``conn``."""
    count, dim = embeddings.shape
    rotation = build_rotation_matrix(dim=dim)
    centroids, boundaries = make_turbo_codebook(bits=_DEFAULT_QBITS, dim=dim)
    _init_turboquant_tables(conn)
    for start in range(0, count, block_rows):
        end = min(start + block_rows, count)
        blob = quantize_turbo_batch(
            embeddings[start:end],
            np.arange(start, end, dtype=np.int64),
            rotation=rotation,
            centroids=centroids,
            boundaries=boundaries,
        )
        conn.execute(
            'INSERT INTO "vector0_products_embedding" VALUES (?, ?, ?, ?)',
            (start, end - 1, end - start, blob),
        )
    if strip_raw_embeddings:
        conn.execute("UPDATE products SET embedding = zeroblob(0)")


def _normalize_rows(matrix: NDArray[np.float32]) -> NDArray[np.float32]:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    return np.where(norms > _EPSILON, matrix / np.maximum(norms, _EPSILON), 0.0).astype(np.float32)


def _update_ivf_centroids(
    unit_vecs: NDArray[np.float32],
    labels: NDArray[np.int32],
    centroids: NDArray[np.float32],
) -> NDArray[np.float32]:
    updated = centroids.copy()
    for idx in range(len(centroids)):
        mask = labels == idx
        if np.any(mask):
            updated[idx] = unit_vecs[mask].mean(axis=0)
    return _normalize_rows(updated)


def partition_ivf_shards(
    embeddings: NDArray[np.float32],
    *,
    n_shards: int = 64,
    max_iter: int = 12,
    seed: int = 42,
) -> tuple[NDArray[np.float32], NDArray[np.int32]]:
    """Partition ``embeddings`` into ``n_shards`` coarse spherical-k-means IVF cells."""
    unit_vecs = _normalize_rows(embeddings.astype(np.float32))
    rng = np.random.default_rng(seed)
    choice = rng.choice(len(unit_vecs), size=min(n_shards, len(unit_vecs)), replace=False)
    centroids = unit_vecs[choice].copy()
    labels = np.zeros(len(unit_vecs), dtype=np.int32)
    for _ in range(max_iter):
        labels = np.argmax(unit_vecs @ centroids.T, axis=1).astype(np.int32)
        centroids = _update_ivf_centroids(unit_vecs, labels, centroids)
    return centroids, labels
