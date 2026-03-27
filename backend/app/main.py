from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.api import api_router
from app.core.config import settings
from app.db.session import Base, engine
from app.services.scheduler import DailyAnalysisScheduler


app = FastAPI(
    title="Protocol Auditor",
    version="0.1.0",
)

app.include_router(api_router, prefix="/api/v1")

# Для простоты разрешаем CORS (если frontend не через nginx прокси)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    # В новом проекте: создаем таблицы автоматически.
    # В production лучше перейти на Alembic.
    Base.metadata.create_all(bind=engine)

    # Фоновый ежедневный анализ (по умолчанию 00:30)
    # Планировщик внутри контейнера, не требует внешнего cron.
    try:
        DailyAnalysisScheduler().start()
    except Exception:
        pass


@app.get("/")
def root():
    return {"message": "Protocol Auditor API", "prefix": "/api/v1"}


@app.get("/health")
def health():
    return {"status": "healthy"}

