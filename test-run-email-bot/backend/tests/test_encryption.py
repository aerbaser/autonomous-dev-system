"""
Tests for app/services/encryption_service.py

Covers:
- encrypt / decrypt roundtrip
- empty string edge case
- wrong key raises EncryptionError
- tampered ciphertext raises EncryptionError
- missing FERNET_KEY triggers key generation + warning
- invalid base64 FERNET_KEY raises EncryptionError
- FERNET_KEY with wrong decoded length raises EncryptionError
"""

import base64
import importlib
import warnings
from unittest.mock import patch

import pytest
from cryptography.fernet import Fernet

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_b64_key(n_bytes: int) -> str:
    """Return a base64-encoded key of *n_bytes* random bytes."""
    return base64.urlsafe_b64encode(b"x" * n_bytes).decode()


def _fresh_module(fernet_key: str = ""):
    """Re-import encryption_service with a custom FERNET_KEY value.

    Each call reloads the module so the module-level cache is reset.
    """
    with patch("app.config.settings") as mock_settings:
        mock_settings.FERNET_KEY = fernet_key
        import app.services.encryption_service as svc
        importlib.reload(svc)
    return svc


# ---------------------------------------------------------------------------
# Roundtrip
# ---------------------------------------------------------------------------

class TestRoundtrip:
    def setup_method(self):
        # Use a real valid key for roundtrip tests
        self.valid_key = Fernet.generate_key().decode()

    def _svc(self):
        return _fresh_module(self.valid_key)

    def test_basic_roundtrip(self):
        svc = self._svc()
        plaintext = "super-secret-password"
        token = svc.encrypt(plaintext)
        assert svc.decrypt(token) == plaintext

    def test_empty_string_roundtrip(self):
        svc = self._svc()
        token = svc.encrypt("")
        assert svc.decrypt(token) == ""

    def test_unicode_roundtrip(self):
        svc = self._svc()
        plaintext = "пароль-Ünîcödé-🔑"
        token = svc.encrypt(plaintext)
        assert svc.decrypt(token) == plaintext

    def test_encrypt_returns_bytes(self):
        svc = self._svc()
        result = svc.encrypt("anything")
        assert isinstance(result, bytes)

    def test_decrypt_returns_str(self):
        svc = self._svc()
        token = svc.encrypt("anything")
        result = svc.decrypt(token)
        assert isinstance(result, str)

    def test_two_encryptions_differ(self):
        """Fernet tokens include a nonce — same plaintext should not produce identical tokens."""
        svc = self._svc()
        t1 = svc.encrypt("same")
        t2 = svc.encrypt("same")
        assert t1 != t2


# ---------------------------------------------------------------------------
# Wrong key
# ---------------------------------------------------------------------------

class TestWrongKey:
    def test_decrypt_with_different_key_raises_encryption_error(self):
        key_a = Fernet.generate_key().decode()
        key_b = Fernet.generate_key().decode()

        svc_a = _fresh_module(key_a)
        svc_b = _fresh_module(key_b)

        token = svc_a.encrypt("secret")

        with pytest.raises(svc_b.EncryptionError):
            svc_b.decrypt(token)


# ---------------------------------------------------------------------------
# Corrupted / tampered ciphertext
# ---------------------------------------------------------------------------

class TestCorruptedToken:
    def setup_method(self):
        self.valid_key = Fernet.generate_key().decode()

    def _svc(self):
        return _fresh_module(self.valid_key)

    def test_random_bytes_raise_encryption_error(self):
        svc = self._svc()
        with pytest.raises(svc.EncryptionError):
            svc.decrypt(b"this-is-not-a-valid-fernet-token")

    def test_flipped_byte_raises_encryption_error(self):
        svc = self._svc()
        token = bytearray(svc.encrypt("data"))
        token[-1] ^= 0xFF  # flip last byte
        with pytest.raises(svc.EncryptionError):
            svc.decrypt(bytes(token))

    def test_empty_bytes_raise_encryption_error(self):
        svc = self._svc()
        with pytest.raises(svc.EncryptionError):
            svc.decrypt(b"")

    def test_raw_exception_is_not_exposed(self):
        """The raised exception must be EncryptionError, not InvalidToken."""
        from cryptography.fernet import InvalidToken

        svc = self._svc()
        with pytest.raises(svc.EncryptionError) as exc_info:
            svc.decrypt(b"garbage")
        # The EncryptionError should wrap the original, not BE the original
        assert not isinstance(exc_info.value, InvalidToken)


# ---------------------------------------------------------------------------
# Missing FERNET_KEY → auto-generation
# ---------------------------------------------------------------------------

class TestMissingKey:
    def test_generates_key_when_absent(self):
        svc = _fresh_module(fernet_key="")
        # Should not raise — generated key is used transparently
        token = svc.encrypt("test")
        assert svc.decrypt(token) == "test"

    def test_warns_when_key_generated(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            svc = _fresh_module(fernet_key="")
            svc.encrypt("trigger init")  # ensure _get_fernet() is called

        messages = [str(w.message) for w in caught]
        assert any("FERNET_KEY" in m for m in messages), (
            "Expected a warning mentioning FERNET_KEY, got: " + str(messages)
        )


# ---------------------------------------------------------------------------
# Invalid FERNET_KEY values
# ---------------------------------------------------------------------------

class TestInvalidKey:
    def test_non_base64_key_raises_encryption_error(self):
        svc = _fresh_module(fernet_key="not-valid-base64!!!")
        with pytest.raises(svc.EncryptionError, match="not valid base64"):
            svc.encrypt("anything")

    def test_wrong_length_key_raises_encryption_error(self):
        # 16 bytes → invalid for Fernet (needs 32)
        short_key = _make_b64_key(16)
        svc = _fresh_module(fernet_key=short_key)
        with pytest.raises(svc.EncryptionError, match="32"):
            svc.encrypt("anything")

    def test_64_byte_key_raises_encryption_error(self):
        long_key = _make_b64_key(64)
        svc = _fresh_module(fernet_key=long_key)
        with pytest.raises(svc.EncryptionError, match="32"):
            svc.encrypt("anything")
