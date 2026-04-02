from __future__ import annotations

from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models.protocol import Protocol, ProtocolStatus
from app.schemas.protocol import (
    DoctorErrorsStat,
    DoctorProtocolsItem,
    DoctorProtocolsResponse,
    DoctorRatingItem,
    DoctorsRatingResponse,
    ErrorsTimelineItem,
    ErrorsTimelineResponse,
)

router = APIRouter()


def _resolve_period_to_cutoff(period: str) -> Optional[datetime]:
    now = datetime.now(timezone.utc)
    if period == "day":
        return now - timedelta(days=1)
    if period == "week":
        return now - timedelta(days=7)
    if period == "month":
        return now - timedelta(days=30)
    if period == "year":
        return now - timedelta(days=365)
    if period == "all":
        return None
    raise ValueError("period must be one of day|week|month|year|all")


@router.get("/stats/doctors-errors/export")
def doctors_errors_export(
    format: str = Query("csv", pattern="^(csv|pdf)$"),
    doctorFio: Optional[str] = Query(None, min_length=1),
    period: str = Query("all", pattern="^(day|week|month|year|all)$"),
    limit: int = Query(5000, ge=1, le=50000),
    db: Session = Depends(get_db),
):
    """
    Экспорт статистики ошибок по врачам (CSV/PDF).
    - doctorFio: если задан, экспорт только по одному врачу
    - period: фильтр по analyzed_at (если есть) иначе created_at
    """
    cutoff = _resolve_period_to_cutoff(period)
    base_dt = func.coalesce(Protocol.analyzed_at, Protocol.created_at)

    with_errors = func.sum(case((Protocol.status == ProtocolStatus.ERROR, 1), else_=0)).label("with_errors")
    total = func.count(Protocol.id).label("total")

    q = (
        db.query(Protocol.doctor_fio.label("doctor_fio"), with_errors, total)
        .filter(Protocol.doctor_fio.isnot(None))
    )
    if doctorFio:
        q = q.filter(Protocol.doctor_fio == doctorFio)
    if cutoff is not None:
        q = q.filter(base_dt >= cutoff)

    q = q.group_by(Protocol.doctor_fio).order_by(with_errors.desc()).limit(limit)
    rows = q.all()

    def _row_to_values(r):
        with_err = int(r.with_errors or 0)
        tot = int(r.total or 0)
        rate = (with_err / tot) if tot else 0.0
        return (r.doctor_fio, with_err, tot, round(rate * 100, 2))

    items = [_row_to_values(r) for r in rows]

    safe_period = period
    name_part = "all" if not doctorFio else "one"
    filename = f"doctors_errors_{name_part}_{safe_period}.{format}"

    if format == "csv":
        import csv

        out = BytesIO()
        # utf-8-sig for Excel-friendly CSV
        out.write(b"\xef\xbb\xbf")
        writer = csv.writer(out)
        writer.writerow(["doctorFio", "withErrors", "total", "errorRatePercent"])
        for fio, with_err, tot, rate_pct in items:
            writer.writerow([fio, with_err, tot, rate_pct])
        out.seek(0)
        return StreamingResponse(
            out,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # pdf
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle

    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=landscape(A4), title="Doctors errors report")
    styles = getSampleStyleSheet()
    title = f"Ошибки по врачам · период: {period}" + (f" · врач: {doctorFio}" if doctorFio else "")

    table_data = [["Врач", "Ошибок", "Всего", "% ошибок"]]
    for fio, with_err, tot, rate_pct in items:
        table_data.append([fio, str(with_err), str(tot), f"{rate_pct}%"])

    tbl = Table(table_data, repeatRows=1)
    tbl.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.black),
                ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
            ]
        )
    )

    story = [Paragraph(title, styles["Title"]), Spacer(1, 12), tbl]
    doc.build(story)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/stats/doctors-errors", response_model=List[DoctorErrorsStat])
def doctors_errors(
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
):
    with_errors = func.sum(
        case((Protocol.status == ProtocolStatus.ERROR, 1), else_=0)
    ).label("with_errors")

    total = func.count(Protocol.id).label("total")

    q = (
        db.query(Protocol.doctor_fio.label("doctor_fio"), with_errors, total)
        .filter(Protocol.doctor_fio.isnot(None))
        .group_by(Protocol.doctor_fio)
        .order_by(with_errors.desc())
        .limit(limit)
    )

    rows = q.all()
    out: List[DoctorErrorsStat] = []
    for r in rows:
        out.append(
            DoctorErrorsStat(
                doctorFio=r.doctor_fio,
                withErrors=int(r.with_errors),
                total=int(r.total),
            )
        )
    return out


@router.get("/stats/doctor-protocols", response_model=DoctorProtocolsResponse)
def doctor_protocols(
    doctorFio: str = Query(..., min_length=1),
    period: str = Query("recent", pattern="^(recent|week|month|all)$"),
    limit: int = Query(200, ge=1, le=2000),
    db: Session = Depends(get_db),
):
    """
    Возвращает протоколы конкретного врача.
    period:
      - recent: последние (по дате анализа/создания), limit
      - week: за 7 дней
      - month: за 30 дней
      - all: все, limit
    """
    now = datetime.now(timezone.utc)
    cutoff = None
    if period == "week":
        cutoff = now - timedelta(days=7)
    elif period == "month":
        cutoff = now - timedelta(days=30)

    q = db.query(Protocol).filter(Protocol.doctor_fio == doctorFio)

    if cutoff is not None:
        # Используем analyzed_at, если есть, иначе created_at
        q = q.filter(func.coalesce(Protocol.analyzed_at, Protocol.created_at) >= cutoff)

    q = q.order_by(func.coalesce(Protocol.analyzed_at, Protocol.created_at).desc()).limit(limit)
    rows = q.all()

    items: List[DoctorProtocolsItem] = []
    for p in rows:
        items.append(
            DoctorProtocolsItem(
                url=p.external_url,
                fileName=p.file_name or p.external_url.split("/")[-1],
                status=p.status.value,
                analyzedAt=p.analyzed_at.isoformat() if p.analyzed_at else None,
            )
        )

    return DoctorProtocolsResponse(
        doctorFio=doctorFio,
        period=period,
        total=len(items),
        items=items,
    )


@router.get("/stats/doctors-rating", response_model=DoctorsRatingResponse)
def doctors_rating(
    top: int = Query(10, ge=1, le=100),
    minSamples: int = Query(3, ge=1, le=100),
    okThreshold: float = Query(0.7, ge=0.0, le=1.0),
    db: Session = Depends(get_db),
):
    # Рейтинг считаем только по проверенным протоколам (OK/ERROR),
    # чтобы "битые/пустые" NEW не искажали проценты.
    with_errors_expr = func.sum(
        case((Protocol.status == ProtocolStatus.ERROR, 1), else_=0)
    )
    ok_expr = func.sum(case((Protocol.status == ProtocolStatus.OK, 1), else_=0))
    checked_total_expr = func.sum(
        case(
            (Protocol.status.in_([ProtocolStatus.OK, ProtocolStatus.ERROR]), 1),
            else_=0,
        )
    )

    with_errors = with_errors_expr.label("with_errors")
    ok_cnt = ok_expr.label("ok_cnt")
    checked_total = checked_total_expr.label("checked_total")
    error_rate = (with_errors_expr * 1.0 / func.nullif(checked_total_expr, 0)).label("error_rate")
    ok_rate = (ok_expr * 1.0 / func.nullif(checked_total_expr, 0)).label("ok_rate")

    q = (
        db.query(
            Protocol.doctor_fio.label("doctor_fio"),
            with_errors,
            ok_cnt,
            checked_total,
            error_rate,
            ok_rate,
        )
        .filter(Protocol.doctor_fio.isnot(None))
        .group_by(Protocol.doctor_fio)
        .having(checked_total_expr >= minSamples)
    )

    # Худшие: только те, у кого % OK ниже порога
    rows_worst = (
        q.having(ok_rate < okThreshold)
        .order_by(ok_rate.asc(), checked_total.desc())
        .limit(top)
        .all()
    )

    # Лучшие: те, у кого % OK не ниже порога
    rows_best = (
        q.having(ok_rate >= okThreshold)
        .order_by(ok_rate.desc(), checked_total.desc())
        .limit(top)
        .all()
    )

    def _map_row(r) -> DoctorRatingItem:
        er = float(r.error_rate or 0.0)
        okr = float(r.ok_rate or 0.0)
        return DoctorRatingItem(
            doctorFio=r.doctor_fio,
            withErrors=int(r.with_errors or 0),
            total=int(r.checked_total or 0),
            errorRate=round(er, 4),
            okRate=round(okr, 4),
        )

    return DoctorsRatingResponse(
        minSamples=minSamples,
        topBest=[_map_row(r) for r in rows_best],
        topWorst=[_map_row(r) for r in rows_worst],
    )


@router.get("/stats/errors-timeline", response_model=ErrorsTimelineResponse)
def errors_timeline(
    period: str = Query("month", pattern="^(week|month|all)$"),
    db: Session = Depends(get_db),
):
    now = datetime.now(timezone.utc)
    cutoff = None
    if period == "week":
        cutoff = now - timedelta(days=7)
    elif period == "month":
        cutoff = now - timedelta(days=30)

    base_dt = func.coalesce(Protocol.analyzed_at, Protocol.created_at)
    day_bucket = func.date_trunc("day", base_dt).label("day")
    with_errors = func.sum(
        case((Protocol.status == ProtocolStatus.ERROR, 1), else_=0)
    ).label("with_errors")
    total = func.count(Protocol.id).label("total")

    q = db.query(day_bucket, with_errors, total)
    if cutoff is not None:
        q = q.filter(base_dt >= cutoff)
    q = q.group_by(day_bucket).order_by(day_bucket.asc())

    rows = q.all()
    items: List[ErrorsTimelineItem] = []
    for r in rows:
        total_i = int(r.total or 0)
        err_i = int(r.with_errors or 0)
        ok_i = max(total_i - err_i, 0)
        rate = (err_i / total_i) if total_i else 0.0
        items.append(
            ErrorsTimelineItem(
                date=r.day.date().isoformat(),
                total=total_i,
                withErrors=err_i,
                ok=ok_i,
                errorRate=round(rate, 4),
            )
        )

    return ErrorsTimelineResponse(period=period, items=items)

