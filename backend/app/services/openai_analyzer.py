from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import httpx
from openai import OpenAI

from app.core.config import settings
from app.utils.json_parser import parse_ai_json


SYSTEM_MESSAGE = """
Ты — главный врач и проверяешь медицинский протокол.

ВАЖНО:

1. Если текст НЕ является протоколом приема врача (например: анализы, исследования, рентген, эпикриз и т.д.),
верни ТОЛЬКО:

{
  "finalCheck": {
    "ok": true,
    "errors": []
  }
}

И больше ничего не добавляй.

2. Если это протокол приема врача — проверь:

Обязательные разделы:
- Жалобы
- Анамнез заболевания
- Объективный статус
- Диагноз (с кодом МКБ-10)
- Назначения

Проверки:
- Все разделы должны быть заполнены
- Диагноз должен соответствовать жалобам
- Код МКБ-10 должен соответствовать диагнозу
- Назначения должны соответствовать диагнозу

Формат ответа:

Верни ответ СТРОГО в JSON.
Начни с ###JSON###

{
  "dateOfAdmission": "",
  "patientFio": "",
  "doctorFio": "",
  "diagnosisAssessment": "",
  "therapyAssessment": "",
  "recommendations": "",
  "sectionsCheck": {
    "жалобы": "",
    "анамнез_заболевания": "",
    "объективный_статус": "",
    "диагноз": "",
    "назначения": ""
  },
  "finalCheck": {
    "ok": true,
    "errors": []
  }
}
"""


USER_TEMPLATE = """
Проверь медицинский протокол.

Текст:
{protocol_text}
"""


def _analyze_with_openai(prompt_text: str) -> Tuple[str, Optional[dict]]:
    if not settings.OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set")

    # Важно ограничить время ожидания, чтобы запросы не "висели" до 504 на прокси.
    timeout = httpx.Timeout(120.0, connect=10.0)
    client = OpenAI(api_key=settings.OPENAI_API_KEY, timeout=timeout, max_retries=2)
    resp = client.chat.completions.create(
        model=settings.OPENAI_MODEL,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": SYSTEM_MESSAGE},
            {"role": "user", "content": prompt_text},
        ],
    )
    content = resp.choices[0].message.content or ""
    usage: Optional[dict] = None
    try:
        if resp.usage is not None:
            usage = {
                "prompt_tokens": getattr(resp.usage, "prompt_tokens", None),
                "completion_tokens": getattr(resp.usage, "completion_tokens", None),
                "total_tokens": getattr(resp.usage, "total_tokens", None),
            }
    except Exception:
        usage = None
    return content, usage

def analyze_protocol_text(protocol_text: str) -> Dict[str, Any]:
    prompt_text = USER_TEMPLATE.format(protocol_text=protocol_text)

    # OpenAI-only: используем только OpenAI
    content, usage = _analyze_with_openai(prompt_text)

    ok, data = parse_ai_json(content)

    if not ok:
        out = {
            "finalCheck": {
                "ok": False,
                "errors": [data.get("error", "JSON parse error")],
            },
            "recommendations": str(data.get("details", "")),
            "rawParseError": data,
        }
        if usage:
            out["_usage"] = usage
        return out

    if isinstance(data, dict) and usage:
        data.setdefault("_usage", usage)
    return data