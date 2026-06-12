from __future__ import annotations

import hashlib
import os
import logging
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from sqlalchemy.orm import Session
from sqlalchemy import and_

from app.core.config import settings
from app.models.protocol import Protocol, ProtocolStatus
from app.services.external_client import download_pdf_bytes, fetch_protocol_urls_from_external
from app.services.openai_analyzer import analyze_protocol_text
from app.services.pdf_extractor import extract_text_from_pdf_bytes


logger = logging.getLogger(__name__)

def _sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _safe_filename_from_url(url: str) -> str:
    part = url.split("/")[-1]
    return part or _sha256(url) + ".pdf"


def _parse_date(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        # Часто будет isoformat/без времени
        return datetime.fromisoformat(value.replace(" ", "T"))
    except Exception:
        return None


def ensure_protocol_row(db: Session, external_url: str) -> Protocol:
    proto = db.query(Protocol).filter(Protocol.external_url == external_url).first()
    if proto is None:
        proto = Protocol(
            external_url=external_url,
            file_name=_safe_filename_from_url(external_url),
            status=ProtocolStatus.NEW,
        )
        db.add(proto)
        db.commit()
        db.refresh(proto)
    else:
        # обновляем имя файла (иногда внешние URL отличаются только путём)
        new_name = _safe_filename_from_url(external_url)
        if not proto.file_name:
            proto.file_name = new_name
            db.commit()
            db.refresh(proto)
    return proto


def sync_protocols_list(db: Session):
    urls = fetch_protocol_urls_from_external()
    result_protocols = []

    for url in urls:
        proto = ensure_protocol_row(db, url)
        result_protocols.append(proto)

    # Добавляем локально загруженные протоколы, которых нет во внешнем списке
    uploaded = db.query(Protocol).filter(Protocol.external_url.like("upload:%")).all()
    if uploaded:
        # исключаем дубли (на всякий)
        existing = {p.external_url for p in result_protocols}
        for p in uploaded:
            if p.external_url not in existing:
                result_protocols.append(p)

    # Сортировка: новые/обновленные сверху
    result_protocols.sort(key=lambda p: (p.analyzed_at or p.created_at), reverse=True)
    return result_protocols


def create_uploaded_protocol(
    db: Session,
    *,
    file_name: str,
    pdf_bytes: bytes,
) -> Protocol:
    """
    Создаёт/находит протокол по хешу контента и сохраняет PDF на диск.
    external_url используется как стабильный ключ вида upload:<sha256>.
    """
    os.makedirs(settings.PDF_STORAGE_DIR, exist_ok=True)
    sha = hashlib.sha256(pdf_bytes).hexdigest()
    url = f"upload:{sha}"

    proto = db.query(Protocol).filter(Protocol.external_url == url).first()
    if proto is None:
        proto = Protocol(external_url=url, file_name=file_name, status=ProtocolStatus.NEW)
        db.add(proto)
        db.commit()
        db.refresh(proto)

    # Пишем файл по sha, чтобы избежать дублей
    path = os.path.join(settings.PDF_STORAGE_DIR, f"{sha}.pdf")
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(pdf_bytes)

    proto.pdf_storage_path = path
    if not proto.file_name:
        proto.file_name = file_name
    db.add(proto)
    db.commit()
    db.refresh(proto)
    return proto


def _ensure_pdf_storage(db: Session, proto: Protocol) -> str:
    os.makedirs(settings.PDF_STORAGE_DIR, exist_ok=True)
    if proto.pdf_storage_path and os.path.exists(proto.pdf_storage_path):
        return proto.pdf_storage_path

    content = download_pdf_bytes(proto.external_url)
    ext = ".pdf"
    name = _sha256(proto.external_url) + ext
    path = os.path.join(settings.PDF_STORAGE_DIR, name)

    # Пишем файл (если вдруг параллельно анализ уже сохранил)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(content)

    proto.pdf_storage_path = path
    if not proto.file_name:
        proto.file_name = _safe_filename_from_url(proto.external_url)
    db.add(proto)
    db.commit()
    db.refresh(proto)

    return path


def get_protocol_pdf_path(db: Session, external_url: str) -> str:
    proto = ensure_protocol_row(db, external_url)
    # переносим запись через сервисную функцию
    # _ensure_pdf_storage использует текущий объект с привязанной сессией
    return _ensure_pdf_storage(db, proto)


def analyze_protocol(
    db: Session,
    external_url: str,
    force: bool = False,
    *,
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    proto = ensure_protocol_row(db, external_url)

    needs_analysis = force or proto.analysis_json is None or proto.analyzed_at is None

    extracted_text: Optional[str] = proto.extracted_text

    # extracted_text нужен UI для сравнения; гарантируем, что он есть в БД.
    if extracted_text is None or not str(extracted_text).strip():
        # Гарантируем наличие PDF на диске
        pdf_path = _ensure_pdf_storage(db, proto)
        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()
        extracted_text = extract_text_from_pdf_bytes(pdf_bytes)
        proto.extracted_text = extracted_text
        db.add(proto)
        db.commit()
        db.refresh(proto)

    if not needs_analysis:
        analysis = proto.analysis_json or {}
        if isinstance(analysis, dict):
            analysis.setdefault("extractedText", extracted_text or "")
        return analysis  # type: ignore[return-value]

    try:
        analysis = analyze_protocol_text(extracted_text or "")
    except Exception as e:
        # Не даём ошибке "потеряться": сохраняем диагностическую информацию в БД,
        # чтобы UI мог показать, что конкретно сломалось.
        err_text = str(e) or e.__class__.__name__
        logger.exception(
            "Protocol analysis failed (request_id=%s, url=%s)",
            request_id,
            external_url,
        )

        analysis = {
            "finalCheck": {"ok": False, "errors": [err_text]},
            "recommendations": "",
            "errorType": e.__class__.__name__,
            "error": err_text,
            "debug": {"requestId": request_id},
            "extractedText": extracted_text or "",
        }

        proto.analysis_json = analysis
        proto.final_ok = False
        proto.final_errors = [err_text]
        proto.status = ProtocolStatus.ERROR
        proto.analyzed_at = datetime.utcnow()
        db.add(proto)
        db.commit()
        db.refresh(proto)
        return proto.analysis_json
    final_check = analysis.get("finalCheck") or {}
    final_ok = bool(final_check.get("ok"))
    errors = final_check.get("errors")

    proto.doctor_fio = analysis.get("doctorFio") or analysis.get("doctor_fio")
    # Совместимость: старые анализы могут возвращать `pacientFio`, новые — `patientFio`
    proto.pacient_fio = (
        analysis.get("patientFio")
        or analysis.get("pacientFio")
        or analysis.get("patient_fio")
        or analysis.get("pacient_fio")
    )
    proto.date_of_admission = _parse_date(analysis.get("dateOfAdmission"))
    proto.extracted_text = extracted_text

    proto.analysis_json = analysis
    proto.final_ok = final_ok
    proto.final_errors = errors if errors is not None else None
    proto.status = ProtocolStatus.OK if final_ok else ProtocolStatus.ERROR
    proto.analyzed_at = datetime.utcnow()

    db.add(proto)
    db.commit()
    db.refresh(proto)

    # Для UI возвращаем extractedText тоже (удобно для отладки/просмотра)
    if isinstance(proto.analysis_json, dict):
        proto.analysis_json.setdefault("extractedText", extracted_text or "")
        # Нормализуем ключ пациента в ответе, чтобы UI везде был `patientFio`
        if "patientFio" not in proto.analysis_json and "pacientFio" in proto.analysis_json:
            proto.analysis_json["patientFio"] = proto.analysis_json.get("pacientFio")
    return proto.analysis_json


def run_background_analysis(db: Session, *, limit: int = 10) -> int:
    """
    Фоновый прогон: синхронизирует список и анализирует часть протоколов,
    которые еще не анализировались.
    Возвращает количество реально запущенных анализов.
    """
    # Обновляем список протоколов (при недоступности внешнего сервера упадем наверх)
    sync_protocols_list(db)

    q = (
        db.query(Protocol)
        .filter(and_(Protocol.analysis_json.is_(None), Protocol.status == ProtocolStatus.NEW))
        .order_by(Protocol.created_at.asc())
        .limit(limit)
    )
    targets = q.all()

    ran = 0
    for proto in targets:
        try:
            analyze_protocol(db, proto.external_url, force=False)
            ran += 1
        except Exception:
            # Если один протокол упал по анализу — продолжаем остальные.
            # Протокол останется с NEW, его можно будет перезапустить позже.
            continue

    return ran


def update_protocol_status(db: Session, external_url: str, status: ProtocolStatus) -> Protocol:
    proto = db.query(Protocol).filter(Protocol.external_url == external_url).first()
    if proto is None:
        raise ValueError(f"Protocol not found for url={external_url}")
    proto.status = status
    if status in (ProtocolStatus.OK, ProtocolStatus.ERROR) and proto.analyzed_at is None:
        proto.analyzed_at = datetime.utcnow()
    db.add(proto)
    db.commit()
    db.refresh(proto)
    return proto

