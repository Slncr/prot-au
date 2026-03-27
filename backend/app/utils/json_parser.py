import json
import re
from typing import Any, Dict, Tuple


def _extract_outer_json(text: str) -> str:
    first = text.find("{")
    last = text.rfind("}")
    if first != -1 and last != -1 and last > first:
        return text[first : last + 1]
    return text


def _escape_real_newlines_in_strings(raw: str) -> str:
    # Пытаемся исправить ситуацию, когда переносы строк попали "внутрь строк" JSON.
    result = []
    in_string = False
    escaped = False
    for ch in raw:
        if escaped:
            result.append(ch)
            escaped = False
            continue
        if ch == "\\":
            result.append(ch)
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            result.append(ch)
            continue
        if in_string and ch in ("\n", "\r"):
            result.append("\\\\n")
            continue
        result.append(ch)
    return "".join(result)


def normalize_json_like(raw: Any) -> str:
    if raw is None:
        return "{}"

    if not isinstance(raw, str):
        raw = json.dumps(raw, ensure_ascii=False)

    s = raw.strip()
    # Убираем маркер и BOM
    s = re.sub(r"^\s*###JSON###\s*", "", s, flags=re.IGNORECASE)
    s = s.lstrip("\ufeff").strip()

    s = _extract_outer_json(s)

    # Приводим “умные” кавычки к обычным
    s = s.replace("“", '"').replace("”", '"').replace("‘", "'").replace("’", "'")

    # Убираем комментарии (очень грубо, но помогает в кейсах из LLM-вывода)
    s = re.sub(r"/\*[\s\S]*?\*/", "", s)
    s = re.sub(r"//.*$", "", s, flags=re.MULTILINE)

    s = _escape_real_newlines_in_strings(s)

    # Удаляем хвостовые запятые перед } или ]
    s = re.sub(r",\s*(?=[}\]])", "", s)

    # Приводим одиночные-кавычки-строки к двойным-кавычкам
    def _single_to_double(m: re.Match) -> str:
        inner = m.group(1)
        inner = inner.replace('"', '\\"')
        return f'"{inner}"'

    s = re.sub(r"'((?:[^'\\]|\\.)*)'", _single_to_double, s)

    # Ключи без кавычек
    s = re.sub(r"([{,\s])([A-Za-z0-9_$@-]+)\s*:", r'\1"\2":', s)

    return s.strip()


def parse_ai_json(output: Any) -> Tuple[bool, Dict[str, Any]]:
    """
    Возвращает (ok, data).
    Даже при ошибке парсинга пытаемся вернуть структурированный объект,
    чтобы UI мог показать причину.
    """
    raw = output if isinstance(output, str) else json.dumps(output, ensure_ascii=False)
    raw = raw.strip()
    raw = re.sub(r"^\s*###JSON###\s*", "", raw, flags=re.IGNORECASE).strip()

    # Попытка 1: прямой JSON
    try:
        return True, json.loads(_extract_outer_json(raw))
    except Exception:
        pass

    # Попытка 2: нормализация
    cleaned = normalize_json_like(raw)
    try:
        return True, json.loads(_extract_outer_json(cleaned))
    except Exception as e:
        return False, {
            "error": "Ошибка парсинга JSON",
            "details": str(e),
            "rawOriginalPreview": raw[:1000],
            "rawCleanedPreview": cleaned[:1000],
        }

