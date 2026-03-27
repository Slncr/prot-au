from __future__ import annotations

import threading
import time
from datetime import datetime

from app.core.config import settings
from app.services.background_queue import background_analysis_queue


def _sleep_until_next_check(interval_s: int = 30) -> None:
    time.sleep(interval_s)


class DailyAnalysisScheduler:
    """
    Простейший внутренний планировщик без внешних зависимостей.
    Триггерится в 00:{minute} каждый день.
    """

    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_ran_date: str | None = None
        self._lock = threading.Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run_loop, name="daily-analysis", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            now = datetime.now()
            run_date = now.date().isoformat()
            try:
                should_run = (
                    now.hour == settings.BACKGROUND_ANALYSIS_HOUR
                    and now.minute == settings.BACKGROUND_ANALYSIS_MINUTE
                    and now.second < 40
                )
                if should_run and self._last_ran_date != run_date:
                    with self._lock:
                        self._last_ran_date = run_date
                        self._run_once()
            except Exception:
                # Не даем планировщику умереть
                pass

            _sleep_until_next_check(interval_s=20)

    def _run_once(self) -> None:
        try:
            background_analysis_queue.start(limit=None)
        except Exception:
            # Внешний сервер может быть недоступен. Планировщик не должен падать.
            pass

