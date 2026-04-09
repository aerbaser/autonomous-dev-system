from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    FERNET_KEY: str = ""
    OLLAMA_HOST: str = "http://localhost:11434"
    OLLAMA_MODEL: str = "gemma4:12b"
    SYNC_INTERVAL_MIN: int = 5
    DB_PATH: str = "data/email_bot.db"
    LOG_LEVEL: str = "INFO"


settings = Settings()
