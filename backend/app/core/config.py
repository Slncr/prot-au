from typing import Optional

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # DB
    DATABASE_URL: str

    # LLM (OpenAI only)
    OPENAI_API_KEY: Optional[str] = None
    OPENAI_MODEL: str = "gpt-4.1-mini"

    # External server (where original PDFs are stored)
    EXTERNAL_BASE_URL: str
    EXTERNAL_SHOWALL_URL: str
    EXTERNAL_BASIC_USERNAME: str
    EXTERNAL_BASIC_PASSWORD: str

    # Storage
    PDF_STORAGE_DIR: str = "/app/data/protocol_pdfs"

    # Background analysis schedule
    BACKGROUND_ANALYSIS_HOUR: int = 0
    BACKGROUND_ANALYSIS_MINUTE: int = 30
    BACKGROUND_ANALYSIS_MAX_PER_RUN: int = 10

    class Config:
        env_file = ".env"
        case_sensitive = True
        extra = "ignore"


settings = Settings()

