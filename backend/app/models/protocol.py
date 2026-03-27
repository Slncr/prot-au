import enum
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Enum, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import BaseModel


class ProtocolStatus(str, enum.Enum):
    NEW = "NEW"
    OK = "OK"
    ERROR = "ERROR"


class Protocol(BaseModel):
    __tablename__ = "protocols"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    external_url: Mapped[str] = mapped_column(Text, nullable=False, unique=True, index=True)
    file_name: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    pdf_storage_path: Mapped[Optional[str]] = mapped_column(String(1024), nullable=True)

    status: Mapped[ProtocolStatus] = mapped_column(Enum(ProtocolStatus), nullable=False, default=ProtocolStatus.NEW)

    doctor_fio: Mapped[Optional[str]] = mapped_column(String(512), nullable=True, index=True)
    pacient_fio: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    date_of_admission: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    analysis_json: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)
    extracted_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    analyzed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

    # удобные поля для статистики
    final_ok: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True, index=True)
    final_errors: Mapped[Optional[dict]] = mapped_column(JSONB, nullable=True)

