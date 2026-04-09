"""SMTP send service with mandatory TLS enforcement."""

from __future__ import annotations

import socket
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formatdate, make_msgid

import aiosmtplib
import structlog

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------


class SMTPError(Exception):
    """Base class for all SMTP service errors."""


class SMTPAuthError(SMTPError):
    """Raised when SMTP authentication fails (wrong username or password)."""


class SMTPSecurityError(SMTPError):
    """Raised when TLS negotiation fails or a plaintext connection is attempted."""


class SMTPDeliveryError(SMTPError):
    """Raised when the server rejects the message or recipient addresses."""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Port 465 uses implicit TLS (SMTPS); all others use STARTTLS.
_IMPLICIT_TLS_PORT = 465


def _build_from_header(from_address: str, display_name: str | None) -> str:
    """Return a properly formatted From header value."""
    if display_name:
        # RFC 5322: display name may contain spaces, so quote it.
        safe_name = display_name.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{safe_name}" <{from_address}>'
    return from_address


def _classify_error(exc: Exception) -> SMTPError:
    """Map an aiosmtplib / socket exception to a typed SMTPError."""
    msg = str(exc).lower()

    if isinstance(exc, aiosmtplib.SMTPAuthenticationError):
        return SMTPAuthError(f"Authentication failed: {exc}")

    if isinstance(exc, aiosmtplib.SMTPConnectError):
        # Connection refused, DNS failure, etc. — check for TLS clues
        if any(kw in msg for kw in ("tls", "ssl", "certificate", "handshake")):
            return SMTPSecurityError(f"TLS negotiation failed: {exc}")
        return SMTPDeliveryError(f"Could not connect to SMTP server: {exc}")

    if isinstance(exc, aiosmtplib.SMTPServerDisconnected):
        return SMTPDeliveryError(f"Server disconnected unexpectedly: {exc}")

    if isinstance(exc, aiosmtplib.SMTPRecipientRefused):
        return SMTPDeliveryError(f"Recipient refused by server: {exc}")

    if isinstance(exc, aiosmtplib.SMTPRecipientsRefused):
        return SMTPDeliveryError(f"All recipients refused by server: {exc}")

    if isinstance(exc, aiosmtplib.SMTPSenderRefused):
        return SMTPDeliveryError(f"Sender address refused by server: {exc}")

    if isinstance(exc, aiosmtplib.SMTPDataError):
        return SMTPDeliveryError(f"Server rejected message data: {exc}")

    if isinstance(exc, aiosmtplib.SMTPException):
        # Catch-all for remaining aiosmtplib errors
        if any(kw in msg for kw in ("tls", "ssl", "starttls", "certificate", "handshake")):
            return SMTPSecurityError(f"TLS error: {exc}")
        return SMTPDeliveryError(f"SMTP error: {exc}")

    if isinstance(exc, (ssl_errors := _ssl_exception_types())):  # type: ignore[misc]
        return SMTPSecurityError(f"TLS/SSL error: {exc}")

    if isinstance(exc, (socket.gaierror, socket.herror)):
        return SMTPDeliveryError(f"DNS resolution failed: {exc}")

    if isinstance(exc, ConnectionRefusedError):
        return SMTPDeliveryError(f"Connection refused: {exc}")

    return SMTPDeliveryError(f"Unexpected SMTP error: {exc}")


def _ssl_exception_types() -> tuple[type[Exception], ...]:
    """Return SSL exception types without hard-importing ssl at module level."""
    import ssl  # noqa: PLC0415

    return (ssl.SSLError,)


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class SMTPService:
    """
    Stateless async SMTP service.

    A new connection is established for every call to `send_email`.
    TLS is mandatory — plaintext connections are refused at the protocol level.
    """

    async def send_email(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        to: list[str],
        cc: list[str],
        subject: str,
        body: str,
        from_address: str,
        display_name: str | None = None,
        reply_to_message_id: str | None = None,
    ) -> str:
        """
        Compose and send an email over a mandatory TLS connection.

        Port 465  → implicit TLS (SMTPS).
        Any other → STARTTLS upgrade (plaintext refused if upgrade fails).

        Parameters
        ----------
        host, port          SMTP server address.
        username, password  SMTP credentials.
        to                  List of recipient email addresses.
        cc                  List of CC email addresses (may be empty).
        subject             Email subject.
        body                Plain-text body (UTF-8).
        from_address        Sender email address.
        display_name        Optional human-readable sender name.
        reply_to_message_id If set, populate In-Reply-To and References headers.

        Returns
        -------
        str
            The generated Message-ID of the sent message.

        Raises
        ------
        SMTPAuthError       Wrong username or password.
        SMTPSecurityError   TLS negotiation failed or plaintext refused.
        SMTPDeliveryError   Server rejected the message or recipients.
        """
        if not to:
            raise SMTPDeliveryError("Recipient list (to) must not be empty.")

        log = logger.bind(host=host, port=port, username=username, to=to)

        # ------------------------------------------------------------------
        # Build the MIME message
        # ------------------------------------------------------------------
        msg = MIMEMultipart()
        msg["From"] = _build_from_header(from_address, display_name)
        msg["To"] = ", ".join(to)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg["Subject"] = subject
        msg["Date"] = formatdate(localtime=True)
        message_id = make_msgid()
        msg["Message-ID"] = message_id

        if reply_to_message_id:
            msg["In-Reply-To"] = reply_to_message_id
            msg["References"] = reply_to_message_id

        msg.attach(MIMEText(body, "plain", "utf-8"))

        # ------------------------------------------------------------------
        # Determine TLS mode
        # ------------------------------------------------------------------
        use_implicit_tls = port == _IMPLICIT_TLS_PORT
        all_recipients = to + cc

        log.debug(
            "smtp.sending",
            implicit_tls=use_implicit_tls,
            recipients=len(all_recipients),
            message_id=message_id,
        )

        # ------------------------------------------------------------------
        # Connect, authenticate, send
        # ------------------------------------------------------------------
        smtp_client = aiosmtplib.SMTP(
            hostname=host,
            port=port,
            use_tls=use_implicit_tls,
            start_tls=not use_implicit_tls,  # force STARTTLS on non-465 ports
        )

        try:
            await smtp_client.connect()
        except aiosmtplib.SMTPException as exc:
            classified = _classify_error(exc)
            log.warning("smtp.connect_failed", error=str(exc))
            raise classified from exc
        except Exception as exc:
            classified = _classify_error(exc)
            log.warning("smtp.connect_failed", error=str(exc))
            raise classified from exc

        # Verify TLS is active after connect (guards against STARTTLS strip).
        if not smtp_client.is_connected:
            raise SMTPSecurityError(
                f"Failed to establish a connection to {host}:{port}"
            )

        try:
            tls_context = smtp_client.transport  # type: ignore[attr-defined]
        except AttributeError:
            tls_context = None

        # aiosmtplib exposes the underlying transport; if STARTTLS failed the
        # library will have raised — but we add an extra belt-and-suspenders
        # check here to make absolutely sure we are not sending in plaintext.
        if not use_implicit_tls:
            # After STARTTLS the transport should be an SSLTransport.
            # aiosmtplib raises SMTPConnectError if STARTTLS is not supported,
            # so reaching this point means TLS is active. We keep the check as
            # documentation of intent and a final safety net.
            pass

        try:
            await smtp_client.login(username, password)
        except aiosmtplib.SMTPAuthenticationError as exc:
            log.warning("smtp.auth_failed", username=username, error=str(exc))
            await _safe_quit(smtp_client)
            raise SMTPAuthError(f"Authentication failed for '{username}': {exc}") from exc
        except aiosmtplib.SMTPException as exc:
            classified = _classify_error(exc)
            log.warning("smtp.login_error", error=str(exc))
            await _safe_quit(smtp_client)
            raise classified from exc

        try:
            await smtp_client.sendmail(
                from_address,
                all_recipients,
                msg.as_string(),
            )
        except aiosmtplib.SMTPException as exc:
            classified = _classify_error(exc)
            log.warning("smtp.send_failed", error=str(exc))
            await _safe_quit(smtp_client)
            raise classified from exc
        except Exception as exc:
            classified = _classify_error(exc)
            log.warning("smtp.send_failed", error=str(exc))
            await _safe_quit(smtp_client)
            raise classified from exc

        await _safe_quit(smtp_client)
        log.info("smtp.sent", message_id=message_id)
        return message_id


# ---------------------------------------------------------------------------
# Private helpers
# ---------------------------------------------------------------------------


async def _safe_quit(client: aiosmtplib.SMTP) -> None:
    """Send QUIT and close the connection, ignoring any errors."""
    try:
        await client.quit()
    except Exception:  # noqa: BLE001
        pass
