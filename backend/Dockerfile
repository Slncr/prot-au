FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Кириллица в PDF: Noto Sans TTF (без apt; GitHub, urllib следует редиректам).
RUN mkdir -p /app/fonts && python -c "\
import urllib.request;\
base='https://github.com/googlefonts/noto-fonts/raw/main/hinted/ttf/NotoSans';\
urllib.request.urlretrieve(base + '/NotoSans-Regular.ttf', '/app/fonts/NotoSans-Regular.ttf');\
urllib.request.urlretrieve(base + '/NotoSans-Bold.ttf', '/app/fonts/NotoSans-Bold.ttf')"

COPY app /app/app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

