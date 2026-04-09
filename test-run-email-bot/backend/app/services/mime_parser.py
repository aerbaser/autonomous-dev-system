"""
MIME email parser service.

Parses raw email bytes into a structured ParsedEmail dataclass using only
Python stdlib. Handles multipart/alternative, multipart/mixed, RFC 2047
encoded headers, charset decoding (utf-8, iso-8859-1, windows-1252),
quoted-printable and base64 payloads.

With email.policy.default the library returns EmailMessage objects whose
get_content() / get_body() methods decode payloads and handle charset
conversion automatically — no manual codec juggling needed in most cases.
"""

from __future__ import annotations

import email
import email.policy
import email.utils
from dataclasses import dataclass, field
from datetime import timezone
from email.headerregistry import Address
from typing import Optional

import structlog

logger = structlog.get_logger(__name__)


@dataclass
class ParsedEmail:
    from_name: str
    from_address: str
    to_addresses: list[str]
    cc_addresses: list[str]
    subject: str
    body_text: Optional[str]
    body_html: Optional[str]
    date: str  # ISO 8601
    message_id: Optional[str]
    raw_headers: dict[str, str]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _decode_header_value(raw: str | None) -> str:
    """Return a clean Unicode string for any header value.

    email.policy.default already decodes RFC 2047 tokens when the header is
    accessed, but we still guard against None and strip surrounding whitespace.
    """
    if raw is None:
        return ""
    return str(raw).strip()


def _parse_address_header(msg: email.message.EmailMessage, header: str) -> list[str]:
    """Return a list of 'Display Name <addr>' or plain address strings.

    Uses getaddresses() on the raw (possibly multi-value) header to handle
    comma-separated recipients, group syntax, etc.
    """
    raw_values = msg.get_all(header, [])
    if not raw_values:
        return []

    # getaddresses tolerates encoded words and folded headers
    pairs = email.utils.getaddresses(raw_values)
    result: list[str] = []
    for name, addr in pairs:
        if not addr and not name:
            continue
        if name:
            result.append(f"{name} <{addr}>")
        elif addr:
            result.append(addr)
    return result


def _parse_from(msg: email.message.EmailMessage) -> tuple[str, str]:
    """Return (display_name, email_address) from the From header."""
    raw = msg.get("From", "")
    name, addr = email.utils.parseaddr(str(raw))
    return (name or ""), (addr or "")


def _parse_date(msg: email.message.EmailMessage) -> str:
    """Return ISO 8601 UTC date string, or empty string if unparseable."""
    raw = msg.get("Date")
    if not raw:
        return ""
    try:
        dt = email.utils.parsedate_to_datetime(str(raw))
        # Normalise to UTC
        dt_utc = dt.astimezone(timezone.utc)
        return dt_utc.isoformat()
    except Exception as exc:
        logger.warning("mime_parser.date_parse_failed", raw_date=str(raw), error=str(exc))
        return ""


def _collect_raw_headers(msg: email.message.EmailMessage) -> dict[str, str]:
    """Collect all headers into a plain dict (last value wins for duplicates).

    For headers that appear multiple times (e.g. Received) the values are
    joined with "; " so nothing is silently discarded.
    """
    seen: dict[str, list[str]] = {}
    for key in msg.keys():
        val = _decode_header_value(msg.get(key))
        seen.setdefault(key, []).append(val)

    return {k: "; ".join(v) for k, v in seen.items()}


def _get_charset(part: email.message.EmailMessage) -> str:
    """Return the charset for a MIME part, defaulting to utf-8."""
    charset = part.get_content_charset()
    if not charset:
        return "utf-8"
    # Normalise common aliases
    normalized = charset.lower().replace("_", "-")
    aliases = {
        "iso-8859-1": "iso-8859-1",
        "latin-1": "iso-8859-1",
        "latin1": "iso-8859-1",
        "windows-1252": "windows-1252",
        "cp1252": "windows-1252",
        "utf-8": "utf-8",
        "utf8": "utf-8",
        "us-ascii": "ascii",
        "ascii": "ascii",
    }
    return aliases.get(normalized, charset)


def _decode_payload(part: email.message.EmailMessage) -> str:
    """Safely decode a leaf MIME part to a Unicode string.

    Tries get_content() first (policy.default handles quoted-printable and
    base64 transparently). Falls back to manual decode with error replacement
    if the charset is broken or unknown.
    """
    try:
        # get_content() returns str for text/* parts when using policy.default
        content = part.get_content()
        if isinstance(content, str):
            return content
        # bytes returned for non-text; shouldn't happen here but guard anyway
        return content.decode("utf-8", errors="replace")
    except (LookupError, UnicodeDecodeError):
        # Charset the library doesn't know — decode manually
        raw_bytes = part.get_payload(decode=True)  # handles QP / base64
        if not isinstance(raw_bytes, bytes):
            return ""
        charset = _get_charset(part)
        try:
            return raw_bytes.decode(charset, errors="replace")
        except (LookupError, UnicodeDecodeError):
            logger.warning(
                "mime_parser.charset_fallback",
                charset=charset,
                fallback="utf-8 with replacement",
            )
            return raw_bytes.decode("utf-8", errors="replace")
    except Exception as exc:
        logger.warning("mime_parser.payload_decode_failed", error=str(exc))
        return ""


def _extract_bodies(
    msg: email.message.EmailMessage,
) -> tuple[Optional[str], Optional[str]]:
    """Return (body_text, body_html) extracted from the message tree.

    Strategy:
    1. Use get_body() for multipart/alternative — it respects the preference list
       and returns the best matching part.
    2. For multipart/mixed (or any other multipart), walk the tree manually.
    3. For simple (non-multipart) messages, handle directly.

    Returns None for a body type that is genuinely absent.
    """
    content_type = msg.get_content_type()

    # ------------------------------------------------------------------ simple
    if not msg.is_multipart():
        if content_type == "text/plain":
            return _decode_payload(msg), None
        if content_type == "text/html":
            return None, _decode_payload(msg)
        return None, None

    # ----------------------------------------- multipart/alternative (or mixed)
    # First try the high-level API which understands multipart/alternative
    # correctly (picks the last suitable part per RFC 2046).
    text_part = msg.get_body(preferencelist=("plain",))
    html_part = msg.get_body(preferencelist=("html",))

    body_text: Optional[str] = _decode_payload(text_part) if text_part else None
    body_html: Optional[str] = _decode_payload(html_part) if html_part else None

    # If get_body() found nothing (e.g. deeply nested multipart/mixed), fall
    # back to walking the full tree.
    if body_text is None and body_html is None:
        body_text, body_html = _walk_parts(msg)

    # Treat empty strings as None so callers don't have to deal with "".
    return (body_text or None), (body_html or None)


def _walk_parts(
    msg: email.message.EmailMessage,
) -> tuple[Optional[str], Optional[str]]:
    """Walk all leaf MIME parts and return the first text/plain and text/html."""
    body_text: Optional[str] = None
    body_html: Optional[str] = None

    for part in msg.walk():
        # Skip multipart containers — we only want leaf parts
        if part.get_content_maintype() == "multipart":
            continue
        # Skip attachments (have a filename or Content-Disposition: attachment)
        disposition = part.get_content_disposition()
        if disposition == "attachment":
            continue

        ct = part.get_content_type()
        if ct == "text/plain" and body_text is None:
            body_text = _decode_payload(part) or None
        elif ct == "text/html" and body_html is None:
            body_html = _decode_payload(part) or None

        if body_text is not None and body_html is not None:
            break  # No need to keep walking

    return body_text, body_html


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_email(raw_bytes: bytes) -> ParsedEmail:
    """Parse raw email bytes into a ParsedEmail dataclass.

    Never raises — all exceptions are caught and logged; missing fields
    are returned as empty strings / empty lists / None.

    Args:
        raw_bytes: The raw RFC 2822 / MIME email message bytes.

    Returns:
        A fully populated (but possibly empty) ParsedEmail instance.
    """
    try:
        msg: email.message.EmailMessage = email.message_from_bytes(
            raw_bytes,
            policy=email.policy.default,  # type: ignore[arg-type]
        )
    except Exception as exc:
        logger.error("mime_parser.parse_failed", error=str(exc))
        return ParsedEmail(
            from_name="",
            from_address="",
            to_addresses=[],
            cc_addresses=[],
            subject="",
            body_text=None,
            body_html=None,
            date="",
            message_id=None,
            raw_headers={},
        )

    from_name, from_address = _parse_from(msg)

    subject = _decode_header_value(msg.get("Subject"))
    message_id_raw = msg.get("Message-ID")
    message_id = _decode_header_value(message_id_raw).strip("<>") if message_id_raw else None

    body_text, body_html = _extract_bodies(msg)

    return ParsedEmail(
        from_name=from_name,
        from_address=from_address,
        to_addresses=_parse_address_header(msg, "To"),
        cc_addresses=_parse_address_header(msg, "Cc"),
        subject=subject,
        body_text=body_text,
        body_html=body_html,
        date=_parse_date(msg),
        message_id=message_id if message_id else None,
        raw_headers=_collect_raw_headers(msg),
    )
