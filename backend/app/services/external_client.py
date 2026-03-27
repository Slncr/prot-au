from __future__ import annotations

import json
import re
from typing import Any, List
from urllib.parse import urlparse, urlunparse

import requests

from app.core.config import settings


def _basic_auth() -> tuple[str, str]:
    return settings.EXTERNAL_BASIC_USERNAME, settings.EXTERNAL_BASIC_PASSWORD


def _rewrite_to_base_host(url: str) -> str:
    """
    Если showall вернул URL на другом хосте (например 185.*),
    пробуем тот же path на EXTERNAL_BASE_URL (например 172.*).
    """
    try:
        p = urlparse(url)
        b = urlparse(settings.EXTERNAL_BASE_URL)
        if not p.path:
            return url
        return urlunparse((b.scheme or p.scheme, b.netloc, p.path, "", p.query, ""))
    except Exception:
        return url


def _request_with_retry(method: str, url: str, *, timeout: int = 60, attempts: int = 5, **kwargs) -> requests.Response:
    last_err: Exception | None = None
    for i in range(attempts):
        try:
            return requests.request(method, url, timeout=timeout, auth=_basic_auth(), **kwargs)
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last_err = e
            # экспоненциальный бэкофф
            if i < attempts - 1:
                sleep_s = 1 * (2**i)
                import time

                time.sleep(sleep_s)
    assert last_err is not None
    raise last_err


def fetch_protocol_urls_from_external() -> List[str]:
    resp = _request_with_retry("GET", settings.EXTERNAL_SHOWALL_URL, timeout=60)
    resp.raise_for_status()

    content_type = resp.headers.get("content-type", "").lower()
    data: Any = None
    if "application/json" in content_type:
        data = resp.json()
    else:
        text = resp.text.strip()
        # Иногда showall отдает список строк
        if text.startswith("[") or text.startswith("{"):
            try:
                data = json.loads(text)
            except Exception:
                data = None

    urls: List[str] = []
    if isinstance(data, list):
        # Может быть массив строк, либо массив объектов {url, full_path}
        for item in data:
            if isinstance(item, str) and item.startswith("http"):
                urls.append(item)
            elif isinstance(item, dict):
                u = item.get("url")
                if isinstance(u, str) and u.startswith("http"):
                    urls.append(u)
    elif isinstance(data, dict):
        # Частые варианты структуры
        for key in ("files", "urls", "items"):
            if key in data and isinstance(data[key], list):
                extracted: List[str] = []
                for item in data[key]:
                    if isinstance(item, str) and item.startswith("http"):
                        extracted.append(item)
                    elif isinstance(item, dict):
                        u = item.get("url")
                        if isinstance(u, str) and u.startswith("http"):
                            extracted.append(u)
                urls = extracted
                break
        if not urls:
            # fallback: попробовать найти URL-подстроки
            urls = [v for v in data.values() if isinstance(v, str) and v.startswith("http")]
    else:
        # fallback: поиск URL-шаблонов в тексте/HTML
        text = resp.text
        for m in re.finditer(r"https?://[^\s\"'<>]+", text):
            u = m.group(0).strip()
            if u:
                urls.append(u)

    # чистим дубликаты
    urls = list(dict.fromkeys(urls))
    return urls


def download_pdf_bytes(external_url: str) -> bytes:
    try:
        resp = _request_with_retry("GET", external_url, timeout=120)
        resp.raise_for_status()
        return resp.content
    except Exception:
        fallback_url = _rewrite_to_base_host(external_url)
        if fallback_url == external_url:
            raise
        resp = _request_with_retry("GET", fallback_url, timeout=120)
        resp.raise_for_status()
        return resp.content


def delete_external_protocol(external_url: str) -> None:
    # внешнее API ожидало "path" без базового URL
    base = settings.EXTERNAL_BASE_URL.rstrip("/")
    relative = external_url
    if external_url.startswith(base + "/"):
        relative = external_url[len(base + "/") :]
    relative = relative.lstrip("/")

    delete_url = f"{base}/index.php"
    resp = _request_with_retry(
        "POST",
        delete_url,
        timeout=60,
        data={"action": "delete", "path": relative},
    )
    resp.raise_for_status()

