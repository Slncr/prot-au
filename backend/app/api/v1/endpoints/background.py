from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.protocol_service import run_background_analysis


router = APIRouter()


class BackgroundRunRequest(BaseModel):
    limit: int = Field(default=10, ge=1, le=500)


@router.post("/protocols/background-run")
def background_run(req: BackgroundRunRequest, db: Session = Depends(get_db)):
    try:
        ran = run_background_analysis(db, limit=req.limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"External server unavailable: {e}")
    return {"ran": ran}

