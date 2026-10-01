"""Signing-key helpers that exercise Avow's production custody path."""

from __future__ import annotations

from pathlib import Path

from avow import save_signing_key
from nacl.signing import SigningKey


def save_seed(seed: bytes, path: Path) -> None:
    """Persist a raw Ed25519 seed atomically with owner-only permissions."""
    save_signing_key(SigningKey(seed), path=path)
