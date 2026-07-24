FROM python:3.11-slim

WORKDIR /app

# NOTE: build context is the project root (e.g.
# `docker build -f backend/Dockerfile -t resumeiq .`), so paths below are
# relative to the repo root, not to this backend/ folder.

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/app ./app
# Frontend is now baked into the image so FastAPI can serve it directly --
# this is what makes "/" resolve instead of 404ing.
COPY frontend ./frontend

# Gemini API key is provided at runtime via environment variables
# (local .env during development, AWS Elastic Beanstalk env/secrets in
# production). It is never baked into this image.
ENV PORT=8000
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
