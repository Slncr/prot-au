from fastapi import APIRouter

from app.api.v1.endpoints import protocols, stats, background

api_router = APIRouter()

api_router.include_router(protocols.router)
api_router.include_router(stats.router)
api_router.include_router(background.router)

