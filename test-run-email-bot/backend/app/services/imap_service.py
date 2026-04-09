"""IMAP connection service with structured error classification."""

from __future__ import annotations

import asyncio
import re
import socket
from typing import TYPE_CHECKING

import aioimaplib
import structlog

if TYPE_CHECKING:
    pass

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class IMAPError(Exception):
    """Base class for all IMAP service errors."""


class IMAPAuthError(IMAPError):
    """Raised when authentication fails (wrong username or password)."""


class IMAPTimeoutError(IMAPError):
    """Raised when the connection or operation times out."""


class IMAPHostError(IMAPError):
    """Raised when the host cannot be reached (DNS failure, refused, etc.)."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_CONNECT_TIMEOUT = 15  # seconds

# Matches STATUS response body like: INBOX (MESSAGES 42 UNSEEN 3)
_STATUS_RE = re.compile(r"MESSAGES\s+(\d+).*?UNSEEN\s+(\d+)", re.IGNORECASE)
_UNSEEN_MESSAGES_RE = re.compile(r"UNSEEN\s+(\d+).*?MESSAGES\s+(\d+)", re.IGNORECASE)

# Matches folder line from LIST response, e.g.:
#   (\HasNoChildren) "/" "INBOX"
#   (\Noselect \HasChildren) "/" "[Gmail]"
_LIST_RE = re.compile(
    r'^\((?P<flags>[^)]*)\)\s+"?(?P<delimiter>[^"]+)"?\s+(?P<name>.+)$'
)


def _parse_folder_name(raw: str) -> str:
    """Strip surrounding quotes from a folder name."""
    raw = raw.strip()
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    return raw


def _parse_status_line(line: str) -> tuple[int, int]:
    """
    Parse a STATUS response line.

    Returns (total_messages, unseen_messages).
    Handles both orderings of MESSAGES / UNSEEN.
    """
    m = _STATUS_RE.search(line)
    if m:
        return int(m.group(1)), int(m.group(2))

    # Try the reversed order
    m2 = _UNSEEN_MESSAGES_RE.search(line)
    if m2:
        return int(m2.group(2)), int(m2.group(1))

    return 0, 0


def _classify_connect_error(exc: Exception, host: str, port: int) -> IMAPError:
    """Map a low-level connection exception to a typed IMAPError."""
    msg = str(exc).lower()

    if isinstance(exc, asyncio.TimeoutError):
        return IMAPTimeoutError(
            f"Connection to {host}:{port} timed out after {_CONNECT_TIMEOUT}s"
        )

    if isinstance(exc, (socket.gaierror, socket.herror)):
        return IMAPHostError(f"Cannot resolve host '{host}': {exc}")

    if isinstance(exc, ConnectionRefusedError):
        return IMAPHostError(f"Connection refused by {host}:{port}")

    if isinstance(exc, OSError):
        # Covers "Network is unreachable", "No route to host", etc.
        return IMAPHostError(f"Network error connecting to {host}:{port}: {exc}")

    # Fallback — keep it an IMAPError but not misclassified
    return IMAPError(f"Unexpected error connecting to {host}:{port}: {exc}")


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class IMAPService:
    """
    Async IMAP service wrapping aioimaplib.IMAP4_SSL.

    Usage::

        svc = IMAPService(host, port, username, password)
        await svc.connect()
        ok, count = await svc.test_connection()
        folders = await svc.list_folders()
        await svc.disconnect()
    """

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
    ) -> None:
        self.host = host
        self.port = port
        self._username = username
        self._password = password
        self._client: aioimaplib.IMAP4_SSL | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def connect(self) -> None:
        """
        Establish an authenticated TLS connection.

        Raises:
            IMAPHostError: DNS / network failure.
            IMAPAuthError: Wrong credentials.
            IMAPTimeoutError: Operation exceeded 15-second timeout.
            IMAPError: Any other IMAP-level failure.
        """
        log = logger.bind(host=self.host, port=self.port, username=self._username)
        log.debug("imap.connecting")

        try:
            client = aioimaplib.IMAP4_SSL(
                host=self.host,
                port=self.port,
                timeout=_CONNECT_TIMEOUT,
            )
            await asyncio.wait_for(client.wait_hello_from_server(), timeout=_CONNECT_TIMEOUT)
        except asyncio.TimeoutError as exc:
            raise IMAPTimeoutError(
                f"Connection to {self.host}:{self.port} timed out after {_CONNECT_TIMEOUT}s"
            ) from exc
        except (socket.gaierror, socket.herror, ConnectionRefusedError, OSError) as exc:
            raise _classify_connect_error(exc, self.host, self.port) from exc
        except Exception as exc:
            raise _classify_connect_error(exc, self.host, self.port) from exc

        # Authenticate
        try:
            response = await asyncio.wait_for(
                client.login(self._username, self._password),
                timeout=_CONNECT_TIMEOUT,
            )
        except asyncio.TimeoutError as exc:
            raise IMAPTimeoutError(
                f"Login to {self.host}:{self.port} timed out after {_CONNECT_TIMEOUT}s"
            ) from exc
        except Exception as exc:
            raise IMAPError(f"Login error: {exc}") from exc

        if response.result != "OK":
            raise IMAPAuthError(
                f"Authentication failed for user '{self._username}' on {self.host}: "
                f"{response.result}"
            )

        self._client = client
        log.info("imap.connected")

    async def test_connection(self) -> tuple[bool, int]:
        """
        Verify the connection by selecting INBOX and counting messages.

        Returns:
            (True, message_count) on success.
            (False, 0) on any error (error is logged, not raised).
        """
        log = logger.bind(host=self.host, port=self.port)
        try:
            await self.connect()
            client = self._require_client()

            response = await asyncio.wait_for(
                client.select("INBOX"),
                timeout=_CONNECT_TIMEOUT,
            )
            if response.result != "OK":
                log.warning("imap.select_failed", result=response.result)
                return False, 0

            # EXISTS count is in the response lines as b'<n> EXISTS'
            count = _extract_exists_count(response.lines)
            log.info("imap.test_ok", inbox_count=count)
            return True, count

        except IMAPError as exc:
            log.warning("imap.test_failed", error=str(exc))
            return False, 0
        except Exception as exc:
            log.exception("imap.test_unexpected_error", error=str(exc))
            return False, 0

    async def list_folders(self) -> list[tuple[str, int, int]]:
        """
        List all selectable IMAP folders with message counts.

        Returns:
            List of (folder_name, unread_count, total_count).

        Raises:
            IMAPError (or subclass) if not connected or operation fails.
        """
        client = self._require_client()
        log = logger.bind(host=self.host)

        # LIST "" "*"
        response = await asyncio.wait_for(
            client.list('""', "*"),
            timeout=_CONNECT_TIMEOUT,
        )
        if response.result != "OK":
            raise IMAPError(f"LIST command failed: {response.result}")

        folders: list[tuple[str, int, int]] = []

        for raw_line in response.lines:
            line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else raw_line
            line = line.strip()
            if not line:
                continue

            m = _LIST_RE.match(line)
            if not m:
                log.debug("imap.list_parse_skip", line=line)
                continue

            flags = m.group("flags").lower()
            if r"\noselect" in flags:
                # Non-selectable container folder — skip
                continue

            folder_name = _parse_folder_name(m.group("name"))

            # Get STATUS for this folder
            try:
                total, unread = await self._get_folder_status(folder_name)
            except Exception as exc:
                log.warning(
                    "imap.folder_status_failed",
                    folder=folder_name,
                    error=str(exc),
                )
                total, unread = 0, 0

            folders.append((folder_name, unread, total))

        log.info("imap.folders_listed", count=len(folders))
        return folders

    async def disconnect(self) -> None:
        """Logout and close the connection. Safe to call multiple times."""
        if self._client is None:
            return

        log = logger.bind(host=self.host)
        try:
            await asyncio.wait_for(self._client.logout(), timeout=5)
            log.info("imap.disconnected")
        except Exception as exc:
            # Already disconnected or network gone — log and move on
            log.debug("imap.disconnect_error", error=str(exc))
        finally:
            self._client = None

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _require_client(self) -> aioimaplib.IMAP4_SSL:
        """Return the active client or raise IMAPError if not connected."""
        if self._client is None:
            raise IMAPError("Not connected. Call connect() first.")
        return self._client

    async def _get_folder_status(self, folder_name: str) -> tuple[int, int]:
        """
        Run STATUS command for a single folder.

        Returns:
            (total_messages, unseen_messages)
        """
        client = self._require_client()

        # Quote folder names that contain spaces
        quoted = f'"{folder_name}"' if " " in folder_name else folder_name

        response = await asyncio.wait_for(
            client.status(quoted, "(MESSAGES UNSEEN)"),
            timeout=_CONNECT_TIMEOUT,
        )
        if response.result != "OK":
            return 0, 0

        for raw_line in response.lines:
            line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else raw_line
            total, unread = _parse_status_line(line)
            if total or unread:
                return total, unread

        return 0, 0


# ---------------------------------------------------------------------------
# Module-level helpers (used above, defined here for clarity)
# ---------------------------------------------------------------------------


def _extract_exists_count(lines: list) -> int:
    """
    Extract the EXISTS count from SELECT response lines.

    SELECT response includes lines like: [b'42 EXISTS', b'1 RECENT', ...]
    """
    for raw in lines:
        line = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
        m = re.search(r"(\d+)\s+EXISTS", line, re.IGNORECASE)
        if m:
            return int(m.group(1))
    return 0
