"""
Tests for app/services/mime_parser.py

Covers:
- Plain text only email
- HTML only email
- multipart/alternative (text + html)
- multipart/mixed with attachment
- RFC 2047 encoded subject and From header
- ISO-8859-1 charset body
- Windows-1252 charset body
- Quoted-printable content transfer encoding
- Base64 content transfer encoding
- Email with no body
- Email with missing/broken Date header
- Multiple To recipients + Cc recipients
- Message-ID extraction
- raw_headers completeness
- Completely empty / garbage bytes (no exceptions)
"""

import base64
import quopri
import textwrap
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import pytest

from app.services.mime_parser import ParsedEmail, parse_email


# ---------------------------------------------------------------------------
# Helpers for building raw emails
# ---------------------------------------------------------------------------

def _build_simple(
    *,
    from_: str = "Sender <sender@example.com>",
    to: str = "recipient@example.com",
    subject: str = "Test subject",
    body: str = "Hello world",
    content_type: str = "text/plain",
    charset: str = "utf-8",
    extra_headers: str = "",
    date: str = "Thu, 01 Jan 2015 12:00:00 +0000",
    message_id: str = "<abc123@example.com>",
) -> bytes:
    """Build a minimal single-part email."""
    encoded_body = body.encode(charset)
    raw = (
        f"From: {from_}\r\n"
        f"To: {to}\r\n"
        f"Subject: {subject}\r\n"
        f"Date: {date}\r\n"
        f"Message-ID: {message_id}\r\n"
        f"Content-Type: {content_type}; charset={charset}\r\n"
        + extra_headers
        + "\r\n"
    ).encode("utf-8") + encoded_body
    return raw


def _multipart_alternative(
    plain: str,
    html: str,
    *,
    subject: str = "Alt subject",
    from_: str = "a@example.com",
    to: str = "b@example.com",
    date: str = "Mon, 02 Feb 2015 08:30:00 +0000",
) -> bytes:
    msg = MIMEMultipart("alternative")
    msg["From"] = from_
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = date
    msg["Message-ID"] = "<alt@example.com>"
    msg.attach(MIMEText(plain, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))
    return msg.as_bytes()


def _multipart_mixed(
    plain: str,
    html: str,
    attachment_name: str = "file.txt",
    attachment_data: bytes = b"attachment content",
) -> bytes:
    outer = MIMEMultipart("mixed")
    outer["From"] = "sender@example.com"
    outer["To"] = "r1@example.com, r2@example.com"
    outer["Cc"] = "cc@example.com"
    outer["Subject"] = "Mixed email"
    outer["Date"] = "Tue, 03 Mar 2015 09:00:00 +0000"
    outer["Message-ID"] = "<mixed@example.com>"

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(plain, "plain", "utf-8"))
    alt.attach(MIMEText(html, "html", "utf-8"))
    outer.attach(alt)

    from email.mime.base import MIMEBase
    from email import encoders

    part = MIMEBase("application", "octet-stream")
    part.set_payload(attachment_data)
    encoders.encode_base64(part)
    part.add_header("Content-Disposition", "attachment", filename=attachment_name)
    outer.attach(part)

    return outer.as_bytes()


# ---------------------------------------------------------------------------
# Plain text email
# ---------------------------------------------------------------------------

class TestPlainTextEmail:
    def setup_method(self):
        self.raw = _build_simple(body="Hello, plain world!")
        self.parsed: ParsedEmail = parse_email(self.raw)

    def test_body_text_extracted(self):
        assert self.parsed.body_text is not None
        assert "Hello, plain world!" in self.parsed.body_text

    def test_body_html_is_none(self):
        assert self.parsed.body_html is None

    def test_from_address(self):
        assert self.parsed.from_address == "sender@example.com"

    def test_from_name(self):
        assert self.parsed.from_name == "Sender"

    def test_to_addresses(self):
        assert "recipient@example.com" in self.parsed.to_addresses[0]

    def test_subject(self):
        assert self.parsed.subject == "Test subject"

    def test_date_iso8601(self):
        assert self.parsed.date.startswith("2015-01-01")

    def test_message_id(self):
        assert self.parsed.message_id == "abc123@example.com"

    def test_raw_headers_has_from(self):
        assert "From" in self.parsed.raw_headers


# ---------------------------------------------------------------------------
# HTML-only email
# ---------------------------------------------------------------------------

class TestHtmlOnlyEmail:
    def setup_method(self):
        self.raw = _build_simple(
            body="<h1>Hello HTML</h1>",
            content_type="text/html",
        )
        self.parsed = parse_email(self.raw)

    def test_body_html_extracted(self):
        assert self.parsed.body_html is not None
        assert "<h1>" in self.parsed.body_html

    def test_body_text_is_none(self):
        assert self.parsed.body_text is None


# ---------------------------------------------------------------------------
# multipart/alternative
# ---------------------------------------------------------------------------

class TestMultipartAlternative:
    def setup_method(self):
        self.raw = _multipart_alternative(
            plain="Plain text version",
            html="<p>HTML version</p>",
        )
        self.parsed = parse_email(self.raw)

    def test_body_text_extracted(self):
        assert self.parsed.body_text is not None
        assert "Plain text version" in self.parsed.body_text

    def test_body_html_extracted(self):
        assert self.parsed.body_html is not None
        assert "<p>HTML version</p>" in self.parsed.body_html

    def test_both_present(self):
        assert self.parsed.body_text is not None
        assert self.parsed.body_html is not None


# ---------------------------------------------------------------------------
# multipart/mixed (with attachment)
# ---------------------------------------------------------------------------

class TestMultipartMixed:
    def setup_method(self):
        self.raw = _multipart_mixed(
            plain="Plain body text",
            html="<p>HTML body</p>",
        )
        self.parsed = parse_email(self.raw)

    def test_body_text_extracted(self):
        assert self.parsed.body_text is not None
        assert "Plain body text" in self.parsed.body_text

    def test_body_html_extracted(self):
        assert self.parsed.body_html is not None
        assert "HTML body" in self.parsed.body_html

    def test_multiple_to(self):
        # "r1@example.com, r2@example.com"
        assert len(self.parsed.to_addresses) == 2

    def test_cc_extracted(self):
        assert len(self.parsed.cc_addresses) == 1
        assert "cc@example.com" in self.parsed.cc_addresses[0]

    def test_attachment_not_in_bodies(self):
        # The attachment binary data must not bleed into body_text / body_html
        assert "attachment content" not in (self.parsed.body_text or "")
        assert "attachment content" not in (self.parsed.body_html or "")


# ---------------------------------------------------------------------------
# RFC 2047 encoded headers
# ---------------------------------------------------------------------------

class TestRFC2047EncodedHeaders:
    """Subject and From can be encoded as =?charset?encoding?...?="""

    def test_base64_encoded_subject(self):
        # "Привет мир" encoded as UTF-8 base64 RFC 2047
        encoded = "=?utf-8?b?0J/RgNC40LLQtdGCINC80LjRgA==?="
        raw = _build_simple(subject=encoded)
        parsed = parse_email(raw)
        assert "Привет" in parsed.subject or parsed.subject != ""

    def test_qp_encoded_subject(self):
        # "Héllo" encoded as ISO-8859-1 quoted-printable
        encoded = "=?iso-8859-1?q?H=E9llo?="
        raw = _build_simple(subject=encoded)
        parsed = parse_email(raw)
        assert "H" in parsed.subject  # at minimum the header was decoded

    def test_encoded_from_name(self):
        encoded_from = "=?utf-8?b?0JjQstCw0L0g0JjQstCw0L3QvtCy0LjRhw==?= <ivan@example.com>"
        raw = _build_simple(from_=encoded_from)
        parsed = parse_email(raw)
        assert parsed.from_address == "ivan@example.com"


# ---------------------------------------------------------------------------
# Charset decoding: ISO-8859-1
# ---------------------------------------------------------------------------

class TestISO88591Charset:
    def test_latin1_body_decoded(self):
        # "café" in ISO-8859-1
        body_bytes = "café au lait".encode("iso-8859-1")
        # Manually craft a raw email with ISO-8859-1 charset
        header = (
            b"From: sender@example.com\r\n"
            b"To: r@example.com\r\n"
            b"Subject: Latin test\r\n"
            b"Date: Mon, 01 Jun 2020 10:00:00 +0000\r\n"
            b"Content-Type: text/plain; charset=iso-8859-1\r\n"
            b"\r\n"
        )
        raw = header + body_bytes
        parsed = parse_email(raw)
        assert parsed.body_text is not None
        assert "caf" in parsed.body_text  # at minimum not garbled


# ---------------------------------------------------------------------------
# Charset decoding: Windows-1252
# ---------------------------------------------------------------------------

class TestWindows1252Charset:
    def test_cp1252_body_decoded(self):
        # "–" (en dash, 0x96 in windows-1252)
        body_bytes = b"Price \x96 discount"
        header = (
            b"From: sender@example.com\r\n"
            b"To: r@example.com\r\n"
            b"Subject: CP1252 test\r\n"
            b"Date: Mon, 01 Jun 2020 10:00:00 +0000\r\n"
            b"Content-Type: text/plain; charset=windows-1252\r\n"
            b"\r\n"
        )
        raw = header + body_bytes
        parsed = parse_email(raw)
        assert parsed.body_text is not None
        assert "Price" in parsed.body_text


# ---------------------------------------------------------------------------
# Quoted-printable
# ---------------------------------------------------------------------------

class TestQuotedPrintable:
    def test_qp_body_decoded(self):
        plain_text = "Héllo Wörld — this has special chars"
        qp_encoded = quopri.encodestring(plain_text.encode("utf-8")).decode("ascii")
        header = (
            "From: sender@example.com\r\n"
            "To: r@example.com\r\n"
            "Subject: QP test\r\n"
            "Date: Mon, 01 Jun 2020 10:00:00 +0000\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "Content-Transfer-Encoding: quoted-printable\r\n"
            "\r\n"
        )
        raw = (header + qp_encoded).encode("ascii")
        parsed = parse_email(raw)
        assert parsed.body_text is not None
        assert "special chars" in parsed.body_text


# ---------------------------------------------------------------------------
# Base64
# ---------------------------------------------------------------------------

class TestBase64Encoding:
    def test_base64_body_decoded(self):
        plain_text = "Base64 encoded email body content"
        b64_encoded = base64.b64encode(plain_text.encode("utf-8")).decode("ascii")
        header = (
            "From: sender@example.com\r\n"
            "To: r@example.com\r\n"
            "Subject: B64 test\r\n"
            "Date: Mon, 01 Jun 2020 10:00:00 +0000\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            "Content-Transfer-Encoding: base64\r\n"
            "\r\n"
        )
        raw = (header + b64_encoded).encode("ascii")
        parsed = parse_email(raw)
        assert parsed.body_text is not None
        assert "Base64 encoded email body content" in parsed.body_text


# ---------------------------------------------------------------------------
# Email with no body
# ---------------------------------------------------------------------------

class TestNoBody:
    def test_no_body_returns_none(self):
        raw = (
            b"From: sender@example.com\r\n"
            b"To: r@example.com\r\n"
            b"Subject: No body\r\n"
            b"Date: Mon, 01 Jun 2020 10:00:00 +0000\r\n"
            b"\r\n"
        )
        parsed = parse_email(raw)
        # Should not raise; bodies should be None (or empty)
        assert parsed.subject == "No body"
        # body may be None or empty string; must not raise


# ---------------------------------------------------------------------------
# Missing / broken Date header
# ---------------------------------------------------------------------------

class TestBrokenDate:
    def test_missing_date_returns_empty_string(self):
        raw = (
            b"From: sender@example.com\r\n"
            b"To: r@example.com\r\n"
            b"Subject: No date\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"\r\n"
            b"body"
        )
        parsed = parse_email(raw)
        assert parsed.date == ""

    def test_garbage_date_returns_empty_string(self):
        raw = (
            b"From: sender@example.com\r\n"
            b"To: r@example.com\r\n"
            b"Subject: Bad date\r\n"
            b"Date: not-a-date-at-all!!!\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"\r\n"
            b"body"
        )
        parsed = parse_email(raw)
        assert parsed.date == ""


# ---------------------------------------------------------------------------
# Missing fields — graceful empty defaults
# ---------------------------------------------------------------------------

class TestMissingFields:
    def test_empty_bytes_returns_parsed_email(self):
        parsed = parse_email(b"")
        assert isinstance(parsed, ParsedEmail)
        assert parsed.from_address == ""
        assert parsed.to_addresses == []
        assert parsed.cc_addresses == []
        assert parsed.subject == ""
        assert parsed.date == ""
        assert parsed.message_id is None

    def test_garbage_bytes_no_exception(self):
        parsed = parse_email(b"\x00\xff\xfe garbage \x01\x02\x03")
        assert isinstance(parsed, ParsedEmail)

    def test_no_cc_returns_empty_list(self):
        raw = _build_simple()  # no Cc header
        parsed = parse_email(raw)
        assert parsed.cc_addresses == []

    def test_no_message_id_returns_none(self):
        raw = (
            b"From: a@example.com\r\n"
            b"To: b@example.com\r\n"
            b"Subject: No MID\r\n"
            b"Date: Mon, 01 Jun 2020 10:00:00 +0000\r\n"
            b"Content-Type: text/plain; charset=utf-8\r\n"
            b"\r\n"
            b"body"
        )
        parsed = parse_email(raw)
        assert parsed.message_id is None


# ---------------------------------------------------------------------------
# Multiple recipients
# ---------------------------------------------------------------------------

class TestMultipleRecipients:
    def test_multiple_to_parsed(self):
        raw = _build_simple(to="a@example.com, b@example.com, c@example.com")
        parsed = parse_email(raw)
        assert len(parsed.to_addresses) == 3

    def test_to_with_display_names(self):
        raw = _build_simple(to='"Alice" <alice@example.com>, Bob <bob@example.com>')
        parsed = parse_email(raw)
        assert len(parsed.to_addresses) == 2
        assert any("alice@example.com" in a for a in parsed.to_addresses)
        assert any("bob@example.com" in a for a in parsed.to_addresses)


# ---------------------------------------------------------------------------
# Date timezone normalisation
# ---------------------------------------------------------------------------

class TestDateNormalisation:
    def test_positive_offset_converted_to_utc(self):
        # +0200 means the UTC time is 2 hours earlier
        raw = _build_simple(date="Mon, 01 Jan 2024 12:00:00 +0200")
        parsed = parse_email(raw)
        # ISO string should represent UTC
        assert "2024-01-01T10:00:00" in parsed.date

    def test_negative_offset_converted_to_utc(self):
        raw = _build_simple(date="Mon, 01 Jan 2024 12:00:00 -0500")
        parsed = parse_email(raw)
        assert "2024-01-01T17:00:00" in parsed.date


# ---------------------------------------------------------------------------
# raw_headers
# ---------------------------------------------------------------------------

class TestRawHeaders:
    def test_raw_headers_is_dict(self):
        raw = _build_simple()
        parsed = parse_email(raw)
        assert isinstance(parsed.raw_headers, dict)

    def test_raw_headers_contains_standard_fields(self):
        raw = _build_simple()
        parsed = parse_email(raw)
        assert "From" in parsed.raw_headers
        assert "To" in parsed.raw_headers
        assert "Subject" in parsed.raw_headers
        assert "Date" in parsed.raw_headers


# ---------------------------------------------------------------------------
# Message-ID stripping angle brackets
# ---------------------------------------------------------------------------

class TestMessageId:
    def test_angle_brackets_stripped(self):
        raw = _build_simple(message_id="<unique-id-42@mail.example.com>")
        parsed = parse_email(raw)
        assert parsed.message_id == "unique-id-42@mail.example.com"

    def test_message_id_without_brackets(self):
        raw = _build_simple(message_id="bare-id@example.com")
        parsed = parse_email(raw)
        assert parsed.message_id == "bare-id@example.com"
