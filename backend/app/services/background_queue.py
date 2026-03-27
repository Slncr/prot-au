from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from sqlalchemy import and_

from app.db.session import SessionLocal
from app.models.protocol import Protocol, ProtocolStatus
from app.services.protocol_service import analyze_protocol, sync_protocols_list


@dataclass
class BackgroundQueueState:
    running: bool
    stopRequested: bool
    queued: int
    processed: int
    failed: int
    currentUrl: Optional[str]
    startedAt: Optional[str]


class BackgroundAnalysisQueue:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._queue: list[str] = []
        self._queue_set: set[str] = set()
        self._current_url: Optional[str] = None
        self._processed = 0
        self._failed = 0
        self._started_at: Optional[datetime] = None

    def start(self, *, limit: Optional[int] = None) -> BackgroundQueueState:
        self.enqueue_pending(limit=limit)
        with self._lock:
            if not self.is_running():
                self._stop_event.clear()
                self._processed = 0
                self._failed = 0
                self._started_at = datetime.utcnow()
                self._thread = threading.Thread(
                    target=self._worker_loop,
                    name="background-analysis-queue",
                    daemon=True,
                )
                self._thread.start()
        return self.get_state()

    def stop(self) -> BackgroundQueueState:
        with self._lock:
            self._stop_event.set()
            self._queue.clear()
            self._queue_set.clear()
        return self.get_state()

    def enqueue_pending(self, *, limit: Optional[int] = None) -> int:
        db = SessionLocal()
        try:
            sync_protocols_list(db)
            q = (
                db.query(Protocol.external_url)
                .filter(and_(Protocol.analysis_json.is_(None), Protocol.status == ProtocolStatus.NEW))
                .order_by(Protocol.created_at.asc())
            )
            if limit is not None:
                q = q.limit(limit)
            rows = q.all()
            urls = [r.external_url for r in rows if r.external_url]
        finally:
            db.close()

        added = 0
        with self._lock:
            for url in urls:
                if url in self._queue_set:
                    continue
                self._queue.append(url)
                self._queue_set.add(url)
                added += 1
        return added

    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def get_state(self) -> BackgroundQueueState:
        with self._lock:
            running = self.is_running()
            return BackgroundQueueState(
                running=running,
                stopRequested=self._stop_event.is_set(),
                queued=len(self._queue),
                processed=self._processed,
                failed=self._failed,
                currentUrl=self._current_url,
                startedAt=self._started_at.isoformat() if self._started_at else None,
            )

    def _pop_next(self) -> Optional[str]:
        with self._lock:
            if not self._queue:
                return None
            url = self._queue.pop(0)
            self._queue_set.discard(url)
            self._current_url = url
            return url

    def _mark_done(self, *, failed: bool) -> None:
        with self._lock:
            if failed:
                self._failed += 1
            else:
                self._processed += 1
            self._current_url = None

    def _worker_loop(self) -> None:
        while not self._stop_event.is_set():
            next_url = self._pop_next()
            if not next_url:
                with self._lock:
                    self._current_url = None
                break

            db = SessionLocal()
            failed = False
            try:
                analyze_protocol(db, next_url, force=False)
            except Exception:
                failed = True
            finally:
                db.close()
                self._mark_done(failed=failed)

        with self._lock:
            self._current_url = None
            self._thread = None
            self._stop_event.clear()


background_analysis_queue = BackgroundAnalysisQueue()

