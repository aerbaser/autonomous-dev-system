from pydantic import BaseModel, ConfigDict, EmailStr, SecretStr


class AccountCreate(BaseModel):
    email: EmailStr
    display_name: str | None = None
    imap_host: str
    imap_port: int = 993
    smtp_host: str
    smtp_port: int = 587
    username: str
    password: SecretStr


class AccountResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    display_name: str | None
    is_active: bool
    created_at: str


class AccountTestResult(BaseModel):
    imap_ok: bool
    smtp_ok: bool
    inbox_count: int
    error: str | None = None
