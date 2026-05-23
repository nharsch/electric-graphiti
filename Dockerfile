FROM python:3.11-slim

WORKDIR /app

RUN pip install --no-cache-dir \
    "graphiti-core[anthropic]" \
    httpx \
    fastembed \
    aiohttp

COPY memory_processor.py .

CMD ["python", "memory_processor.py"]
