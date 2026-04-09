"""
Fernet symmetric encryption service for credential storage.

Key lifecycle:
- On module load, `_fernet` is None.
- First call to `_get_fernet()` invokes `load_or_generate_key()` which either
  decodes the FERNET_KEY env var or generates a fresh one (with a warning).
- The resulting `Fernet` instance is cached for the lifetime of the process.
"""

import base64
import warnings

import structlog
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

logger = structlog.get_logger(__name__)

# Module-level cache — populated lazily on first use
_fernet: Fernet | None = None


class EncryptionError(Exception):
    """Raised when encrypt/decrypt operations fail (bad key, corrupted token, etc.)."""


def load_or_generate_key() -> bytes:
    """Return a valid Fernet key.

    Priority:
    1. FERNET_KEY env var (base64-encoded 32-byte key) — validated and returned.
    2. If absent or empty — a new key is generated and a WARNING is emitted
       instructing the operator to persist it in .env.

    Returns:
        URL-safe base64-encoded 32-byte Fernet key (bytes).

    Raises:
        EncryptionError: if FERNET_KEY is set but is not a valid 32-byte key.
    """
    raw = settings.FERNET_KEY.strip()

    if raw:
        try:
            # Add padding so urlsafe_b64decode handles keys without trailing '='
            decoded = base64.urlsafe_b64decode(raw + "==")
        except Exception as exc:
            raise EncryptionError(
                "FERNET_KEY is not valid base64. "
                "Generate a correct key with: "
                "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            ) from exc

        if len(decoded) != 32:
            raise EncryptionError(
                f"FERNET_KEY decodes to {len(decoded)} bytes; exactly 32 are required. "
                "Generate a correct key with: "
                "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            )

        # Re-encode to guarantee URL-safe base64 format that Fernet expects
        return base64.urlsafe_b64encode(decoded)

    # No key configured — generate one and warn loudly
    new_key = Fernet.generate_key()
    logger.warning(
        "encryption_key_generated",
        message=(
            "FERNET_KEY not set — generated a temporary encryption key. "
            "Credentials encrypted with this key will become unreadable after restart. "
            f"Persist the key by adding to .env: FERNET_KEY={new_key.decode()}"
        ),
    )
    # Also emit a stdlib warning so it surfaces in environments without structlog configured
    warnings.warn(
        "FERNET_KEY not set — a temporary key was generated. "
        "Set FERNET_KEY in .env to persist encrypted credentials across restarts.",
        stacklevel=3,
    )
    return new_key


def _get_fernet() -> Fernet:
    """Return the cached Fernet instance, initialising it on first call."""
    global _fernet
    if _fernet is None:
        key = load_or_generate_key()
        _fernet = Fernet(key)
    return _fernet


def encrypt(plaintext: str) -> bytes:
    """Encrypt *plaintext* and return the Fernet token (bytes).

    Args:
        plaintext: The string to encrypt (e.g. a password or username).

    Returns:
        Encrypted Fernet token as bytes.
    """
    fernet = _get_fernet()
    return fernet.encrypt(plaintext.encode("utf-8"))


def decrypt(token: bytes) -> str:
    """Decrypt a Fernet *token* and return the original plaintext string.

    Args:
        token: A Fernet token as returned by :func:`encrypt`.

    Returns:
        The original plaintext string.

    Raises:
        EncryptionError: if the token is corrupted, has been tampered with,
            or was encrypted with a different key.
    """
    fernet = _get_fernet()
    try:
        return fernet.decrypt(token).decode("utf-8")
    except InvalidToken as exc:
        raise EncryptionError(
            "Failed to decrypt token: invalid or corrupted ciphertext, "
            "or the key does not match the one used for encryption."
        ) from exc
    except Exception as exc:
        raise EncryptionError(f"Unexpected decryption error: {exc}") from exc
