from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.background_queue import background_analysis_queue


router = APIRouter()


class BackgroundRunRequest(BaseModel):
    limit: int | None = Field(default=None, ge=1, le=5000)


@router.post("/protocols/background-run")
def background_run(req: BackgroundRunRequest):
    try:
        state = background_analysis_queue.start(limit=req.limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"External server unavailable: {e}")
    return {"started": True, "state": state}


@router.post("/protocols/background-stop")
def background_stop():
    state = background_analysis_queue.stop()
    return {"stopped": True, "state": state}


@router.get("/protocols/background-status")
def background_status():
    return background_analysis_queue.get_state()

