"""Tests for IMAPService — all IMAP I/O is mocked via unittest.mock."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.imap_service import (
    IMAPAuthError,
    IMAPError,
    IMAPHostError,
    IMAPTimeoutError,
    IMAPService,
    _extract_exists_count,
    _parse_status_line,
)


# ---------------------------------------------------------------------------
# Unit tests for pure helpers
# ---------------------------------------------------------------------------


class TestParseStatusLine:
    def test_messages_then_unseen(self):
        total, unread = _parse_status_line('INBOX (MESSAGES 42 UNSEEN 7)')
        assert total == 42
        assert unread == 7

    def test_unseen_then_messages(self):
        total, unread = _parse_status_line('INBOX (UNSEEN 3 MESSAGES 10)')
        assert total == 10
        assert unread == 3

    def test_zero_counts(self):
        total, unread = _parse_status_line('Sent (MESSAGES 0 UNSEEN 0)')
        assert total == 0
        assert unread == 0

    def test_no_match_returns_zeros(self):
        total, unread = _parse_status_line('something unrelated')
        assert total == 0
        assert unread == 0


class TestExtractExistsCount:
    def test_bytes_line(self):
        assert _extract_exists_count([b'42 EXISTS', b'1 RECENT']) == 42

    def test_string_line(self):
        assert _extract_exists_count(['10 EXISTS']) == 10

    def test_empty_lines(self):
        assert _extract_exists_count([]) == 0

    def test_no_exists_in_lines(self):
        assert _extract_exists_count([b'OK [READ-WRITE] SELECT completed']) == 0


# ---------------------------------------------------------------------------
# Helpers to build mock aioimaplib responses
# ---------------------------------------------------------------------------


def _ok_response(lines: list[bytes | str] | None = None):
    r = MagicMock()
    r.result = "OK"
    r.lines = lines or []
    return r


def _err_response(result: str = "NO", lines: list | None = None):
    r = MagicMock()
    r.result = result
    r.lines = lines or []
    return r


# ---------------------------------------------------------------------------
# IMAPService.connect()
# ---------------------------------------------------------------------------


class TestConnect:
    @pytest.fixture
    def mock_client(self):
        client = MagicMock()
        client.wait_hello_from_server = AsyncMock(return_value=None)
        client.login = AsyncMock(return_value=_ok_response())
        client.logout = AsyncMock(return_value=_ok_response())
        return client

    @pytest.mark.asyncio
    async def test_connect_success(self, mock_client):
        with patch("app.services.imap_service.aioimaplib.IMAP4_SSL", return_value=mock_client):
            svc = IMAPService("imap.example.com", 993, "user@example.com", "secret")
            await svc.connect()
            assert svc._client is mock_client
            mock_client.login.assert_awaited_once_with("user@example.com", "secret")

    @pytest.mark.asyncio
    async def test_connect_auth_failure(self, mock_client):
        mock_client.login.return_value = _err_response("NO")
        with patch("app.services.imap_service.aioimaplib.IMAP4_SSL", return_value=mock_client):
            svc = IMAPService("imap.example.com", 993, "user@example.com", "wrong")
            with pytest.raises(IMAPAuthError):
                await svc.connect()

    @pytest.mark.asyncio
    async def test_connect_host_error(self):
        import socket

        with patch("app.services.imap_service.aioimaplib.IMAP4_SSL") as mock_cls:
            mock_cls.return_value.wait_hello_from_server = AsyncMock(
                side_effect=socket.gaierror("Name or service not known")
            )
            svc = IMAPService("nonexistent.invalid", 993, "u", "p")
            with pytest.raises(IMAPHostError):
                await svc.connect()

    @pytest.mark.asyncio
    async def test_connect_timeout(self):
        with patch("app.services.imap_service.aioimaplib.IMAP4_SSL") as mock_cls:
            mock_cls.return_value.wait_hello_from_server = AsyncMock(
                side_effect=asyncio.TimeoutError()
            )
            svc = IMAPService("slow.host", 993, "u", "p")
            with pytest.raises(IMAPTimeoutError) as exc_info:
                await svc.connect()
            assert "slow.host:993" in str(exc_info.value)

    @pytest.mark.asyncio
    async def test_connect_refused(self):
        with patch("app.services.imap_service.aioimaplib.IMAP4_SSL") as mock_cls:
            mock_cls.return_value.wait_hello_from_server = AsyncMock(
                side_effect=ConnectionRefusedError()
            )
            svc = IMAPService("imap.example.com", 993, "u", "p")
            with pytest.raises(IMAPHostError):
                await svc.connect()


# ---------------------------------------------------------------------------
# IMAPService.test_connection()
# ---------------------------------------------------------------------------


class TestTestConnection:
    @pytest.fixture
    def connected_service(self):
        svc = IMAPService("imap.example.com", 993, "user", "pass")
        mock_client = MagicMock()
        mock_client.select = AsyncMock(
            return_value=_ok_response(lines=[b"42 EXISTS", b"1 RECENT"])
        )
        svc._client = mock_client
        return svc, mock_client

    @pytest.mark.asyncio
    async def test_returns_true_with_count(self, connected_service):
        svc, _ = connected_service
        # Patch connect() to be a no-op (client already set)
        with patch.object(svc, "connect", new_callable=AsyncMock):
            ok, count = await svc.test_connection()
        assert ok is True
        assert count == 42

    @pytest.mark.asyncio
    async def test_returns_false_on_auth_error(self):
        svc = IMAPService("imap.example.com", 993, "u", "p")
        with patch.object(svc, "connect", side_effect=IMAPAuthError("auth failed")):
            ok, count = await svc.test_connection()
        assert ok is False
        assert count == 0

    @pytest.mark.asyncio
    async def test_returns_false_on_timeout(self):
        svc = IMAPService("imap.example.com", 993, "u", "p")
        with patch.object(svc, "connect", side_effect=IMAPTimeoutError("timed out")):
            ok, count = await svc.test_connection()
        assert ok is False
        assert count == 0

    @pytest.mark.asyncio
    async def test_returns_false_on_unexpected_error(self):
        svc = IMAPService("imap.example.com", 993, "u", "p")
        with patch.object(svc, "connect", side_effect=RuntimeError("boom")):
            ok, count = await svc.test_connection()
        assert ok is False
        assert count == 0


# ---------------------------------------------------------------------------
# IMAPService.list_folders()
# ---------------------------------------------------------------------------


class TestListFolders:
    LIST_LINES = [
        b'(\\HasNoChildren) "/" "INBOX"',
        b'(\\HasNoChildren) "/" "Sent"',
        b'(\\HasNoChildren) "/" "Drafts"',
        b'(\\Noselect \\HasChildren) "/" "[Gmail]"',  # should be skipped
    ]

    def _make_service_with_client(self, list_lines, status_lines_map=None):
        svc = IMAPService("imap.example.com", 993, "user", "pass")
        mock_client = MagicMock()
        mock_client.list = AsyncMock(return_value=_ok_response(lines=list_lines))

        async def fake_status(folder, _items):
            folder_clean = folder.strip('"')
            lines = (status_lines_map or {}).get(folder_clean, [])
            return _ok_response(lines=lines)

        mock_client.status = fake_status
        svc._client = mock_client
        return svc

    @pytest.mark.asyncio
    async def test_filters_noselect(self):
        status_map = {
            "INBOX": [b"INBOX (MESSAGES 10 UNSEEN 2)"],
            "Sent": [b"Sent (MESSAGES 5 UNSEEN 0)"],
            "Drafts": [b"Drafts (MESSAGES 1 UNSEEN 0)"],
        }
        svc = self._make_service_with_client(self.LIST_LINES, status_map)
        folders = await svc.list_folders()
        names = [f[0] for f in folders]
        assert "[Gmail]" not in names
        assert "INBOX" in names
        assert "Sent" in names
        assert "Drafts" in names

    @pytest.mark.asyncio
    async def test_correct_counts(self):
        status_map = {
            "INBOX": [b"INBOX (MESSAGES 10 UNSEEN 3)"],
            "Sent": [b"Sent (MESSAGES 50 UNSEEN 0)"],
            "Drafts": [b"Drafts (MESSAGES 2 UNSEEN 0)"],
        }
        svc = self._make_service_with_client(self.LIST_LINES, status_map)
        folders = await svc.list_folders()
        inbox = next(f for f in folders if f[0] == "INBOX")
        assert inbox == ("INBOX", 3, 10)  # (name, unread, total)

    @pytest.mark.asyncio
    async def test_raises_when_not_connected(self):
        svc = IMAPService("imap.example.com", 993, "u", "p")
        with pytest.raises(IMAPError, match="Not connected"):
            await svc.list_folders()

    @pytest.mark.asyncio
    async def test_status_failure_gracefully_returns_zeros(self):
        """If STATUS fails for one folder, others still succeed."""
        svc = self._make_service_with_client(
            list_lines=[b'(\\HasNoChildren) "/" "INBOX"'],
            status_lines_map={},  # no status lines → parse returns (0, 0)
        )
        folders = await svc.list_folders()
        assert folders == [("INBOX", 0, 0)]


# ---------------------------------------------------------------------------
# IMAPService.disconnect()
# ---------------------------------------------------------------------------


class TestDisconnect:
    @pytest.mark.asyncio
    async def test_disconnect_when_connected(self):
        svc = IMAPService("imap.example.com", 993, "u", "p")
        mock_client = MagicMock()
        mock_client.logout = AsyncMock(return_value=_ok_response())
        svc._client = mock_client

        await svc.disconnect()

        mock_client.logout.assert_awaited_once()
        assert svc._client is None

    @pytest.mark.asyncio
    async def test_disconnect_idempotent(self):
        """Calling disconnect() when not connected should not raise."""
        svc = IMAPService("imap.example.com", 993, "u", "p")
        await svc.disconnect()  # should be a no-op

    @pytest.mark.asyncio
    async def test_disconnect_swallows_errors(self):
        """If logout raises, disconnect still clears the client."""
        svc = IMAPService("imap.example.com", 993, "u", "p")
        mock_client = MagicMock()
        mock_client.logout = AsyncMock(side_effect=OSError("connection reset"))
        svc._client = mock_client

        await svc.disconnect()  # should not raise
        assert svc._client is None


# ---------------------------------------------------------------------------
# Exception hierarchy
# ---------------------------------------------------------------------------


class TestExceptionHierarchy:
    def test_auth_error_is_imap_error(self):
        assert issubclass(IMAPAuthError, IMAPError)

    def test_timeout_error_is_imap_error(self):
        assert issubclass(IMAPTimeoutError, IMAPError)

    def test_host_error_is_imap_error(self):
        assert issubclass(IMAPHostError, IMAPError)

    def test_imap_error_is_exception(self):
        assert issubclass(IMAPError, Exception)
