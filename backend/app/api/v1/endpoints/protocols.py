from __future__ import annotations

import logging
import uuid
from typing import List

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.protocol import Protocol, ProtocolStatus
from app.schemas.protocol import (
    AnalyzeRequest,
    AnalyzeResponse,
    ProtocolListItem,
    UpdateProtocolStatusRequest,
    UploadProtocolResponse,
)
from app.services.protocol_service import (
    analyze_protocol,
    create_uploaded_protocol,
    get_protocol_pdf_path,
    sync_protocols_list,
    update_protocol_status,
)

router = APIRouter()
logger = logging.getLogger(__name__)


@router.post("/protocols/sync-list", response_model=dict)
def sync_list(db: Session = Depends(get_db)):
    try:
        protocols = sync_protocols_list(db)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"External server unavailable: {e}")
    files: List[ProtocolListItem] = []
    for p in protocols:
        files.append(
            ProtocolListItem(
                url=p.external_url,
                fileName=p.file_name or p.external_url.split("/")[-1],
                status=p.status.value,
                analyzedAt=p.analyzed_at.isoformat() if p.analyzed_at else None,
                doctorFio=p.doctor_fio,
                patientFio=p.pacient_fio,
            )
        )
    return {"files": files}


@router.post("/protocols/analyze", response_model=AnalyzeResponse)
def analyze(req: AnalyzeRequest, db: Session = Depends(get_db)):
    if not req.url:
        raise HTTPException(status_code=400, detail="url is required")
    request_id = str(uuid.uuid4())
    try:
        analysis = analyze_protocol(db, req.url, force=bool(req.force), request_id=request_id)
    except Exception as e:
        logger.exception("Analyze endpoint failed (request_id=%s, url=%s)", request_id, req.url)
        msg = str(e)
        if "unsupported_country_region_territory" in msg:
            raise HTTPException(
                status_code=503,
                detail=(
                    "OpenAI API недоступен для текущего региона аккаунта "
                    "(unsupported_country_region_territory)."
                ),
            )
        if "Error code: 401" in msg:
            raise HTTPException(status_code=401, detail="OpenAI API key invalid or expired.")
        if "Error code: 429" in msg:
            raise HTTPException(status_code=429, detail="OpenAI rate limit exceeded.")
        raise HTTPException(
            status_code=502,
            detail=f"External server unavailable or analysis failed (request_id={request_id}): {e}",
        )
    return AnalyzeResponse(analysis=analysis)


@router.get("/protocols/original")
def original(
    url: str = Query(..., description="External PDF URL"),
    db: Session = Depends(get_db),
):
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    # Убедимся, что запись и файл существуют
    try:
        pdf_path = get_protocol_pdf_path(db, url)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not download/get original PDF: {e}")
    proto = db.query(Protocol).filter(Protocol.external_url == url).first()
    file_name = proto.file_name if proto and proto.file_name else url.split("/")[-1]

    return FileResponse(
        pdf_path,
        media_type="application/pdf",
        filename=file_name,
    )


@router.post("/protocols/upload", response_model=UploadProtocolResponse)
async def upload_protocol(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """
    Загрузка PDF с компьютера. Создаёт протокол upload:<sha256>,
    сохраняет PDF и запускает анализ (как обычный протокол).
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="filename is required")
    if not (file.filename.lower().endswith(".pdf") or file.content_type == "application/pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    pdf_bytes = await file.read()
    if not pdf_bytes:
        raise HTTPException(status_code=400, detail="Empty file")

    proto = create_uploaded_protocol(db, file_name=file.filename, pdf_bytes=pdf_bytes)

    request_id = str(uuid.uuid4())
    try:
        analysis = analyze_protocol(db, proto.external_url, force=True, request_id=request_id)
    except Exception as e:
        logger.exception("Upload analyze failed (request_id=%s, url=%s)", request_id, proto.external_url)
        raise HTTPException(status_code=502, detail=f"Upload analysis failed (request_id={request_id}): {e}")

    return UploadProtocolResponse(url=proto.external_url, analysis=analysis)


@router.post("/protocols/update-status")
def protocols_update_status(
    body: UpdateProtocolStatusRequest,
    db: Session = Depends(get_db),
):
    if not body.url:
        raise HTTPException(status_code=400, detail="url is required")
    try:
        try:
            status = ProtocolStatus(body.status)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported status: {body.status}",
            )
        proto = update_protocol_status(db, body.url, status)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Failed to update protocol status (url=%s)", body.url)
        raise HTTPException(status_code=500, detail=f"Failed to update status: {e}")

    return {
        "url": proto.external_url,
        "status": proto.status.value,
        "analyzedAt": proto.analyzed_at.isoformat() if proto.analyzed_at else None,
    }
