"""
ResumeIQ FastAPI backend.

Endpoints (per PRD Section 9.3):
  POST /api/upload                        - accepts PDF, returns extraction status + session ID
  GET  /api/analyze/stream/{session_id}    - SSE stream of Gemini analysis
  GET  /api/health                         - health check for App Runner / Elastic Beanstalk

Frontend:
  GET  /                                   - serves frontend/index.html
  GET  /<static asset>                     - serves frontend/style.css, frontend/app.js, etc.
  (Frontend is baked into the Docker image alongside the backend -- see
  Dockerfile -- so the whole app is reachable from a single Elastic
  Beanstalk URL.)
"""

import time
import uuid
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from app.pdf_extractor import extract_text_from_pdf, PDFExtractionError
from app.gemini_client import stream_gemini_analysis, GeminiServiceError, NotAResumeError

app = FastAPI(title="ResumeIQ API", version="1.0.0")

# CORS is left open (allow_origins=["*"]) even though the frontend is now
# served from the same origin -- this keeps local development (frontend
# opened directly / served by a different dev server) and any future
# split-deployment working without changes.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024  # FR-1.2: 5 MB max
MIN_WORD_COUNT = 50  # FR-2.4 threshold
MAX_INPUT_CHARS = 12000  # FR-3.5: safe truncation length for Gemini input
SESSION_TTL_SECONDS = 600  # stale session cleanup

# Extracted text is held only in memory for the request lifecycle (Section 9.2).
# No database is used for the MVP.
SESSION_STORE: Dict[str, dict] = {}

# Absolute path to the frontend directory, computed from this file's own
# location rather than the process's current working directory -- this
# keeps it correct regardless of how/where uvicorn is launched from.
#
# Two layouts need to resolve correctly:
#   1. Inside the Docker image: main.py lives at <root>/app/main.py and the
#      Dockerfile copies the frontend to <root>/frontend (sibling of "app"),
#      i.e. one level up from this file.
#   2. Local dev checkout: main.py lives at
#      resumeiq/backend/app/main.py and the frontend lives at
#      resumeiq/frontend, i.e. two levels up from this file (out of
#      "backend" entirely).
#
# We try both candidates and use whichever actually exists, so the app runs
# correctly in both environments without any code changes needed.
_APP_DIR = Path(__file__).resolve().parent
_CANDIDATE_FRONTEND_DIRS = [
    _APP_DIR.parent / "frontend",          # Docker layout: <root>/frontend
    _APP_DIR.parent.parent / "frontend",   # Local layout: resumeiq/frontend
]
FRONTEND_DIR = next(
    (p for p in _CANDIDATE_FRONTEND_DIRS if p.is_dir()),
    _CANDIDATE_FRONTEND_DIRS[0],  # fall back to original behavior if neither exists
)


def _cleanup_expired_sessions() -> None:
    now = time.time()
    expired = [
        sid for sid, data in SESSION_STORE.items()
        if now - data["created_at"] > SESSION_TTL_SECONDS
    ]
    for sid in expired:
        SESSION_STORE.pop(sid, None)


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_resume(file: UploadFile = File(...)):
    _cleanup_expired_sessions()

    # FR-1.1: Accept PDF files only (.pdf MIME type validation)
    is_pdf_mime = file.content_type == "application/pdf"
    is_pdf_ext = (file.filename or "").lower().endswith(".pdf")
    if not (is_pdf_mime or is_pdf_ext):
        raise HTTPException(
            status_code=400,
            detail="Only PDF files are accepted. Please upload a .pdf resume.",
        )

    contents = await file.read()

    if len(contents) == 0:
        raise HTTPException(
            status_code=400,
            detail="The uploaded file is empty. Please choose a valid PDF.",
        )

    # FR-1.2: Max file size 5 MB
    if len(contents) > MAX_FILE_SIZE_BYTES:
        raise HTTPException(
            status_code=400,
            detail="File is too large. Please upload a PDF under 5 MB.",
        )

    # FR-2.1 / FR-2.3: extract and sanitize text
    try:
        extracted_text = extract_text_from_pdf(contents)
    except PDFExtractionError:
        raise HTTPException(
            status_code=422,
            detail="We couldn't read this file. Please try another PDF.",
        )

    # FR-2.4: reject if extracted text is empty or under ~50 words
    word_count = len(extracted_text.split())
    if word_count < MIN_WORD_COUNT:
        raise HTTPException(
            status_code=422,
            detail="We couldn't read this file. Please try another PDF.",
        )

    # FR-3.5: truncate extremely long resumes before sending to Gemini
    if len(extracted_text) > MAX_INPUT_CHARS:
        extracted_text = extracted_text[:MAX_INPUT_CHARS]

    session_id = str(uuid.uuid4())
    SESSION_STORE[session_id] = {
        "text": extracted_text,
        "created_at": time.time(),
    }

    return {"session_id": session_id, "status": "extracted"}


@app.get("/api/analyze/stream/{session_id}")
async def analyze_stream(session_id: str):
    session = SESSION_STORE.get(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail="Session not found or has expired. Please upload your resume again.",
        )

    resume_text = session["text"]

    async def event_generator():
        try:
            async for chunk in stream_gemini_analysis(resume_text):
                # Proper multi-line SSE "data:" framing.
                for line in chunk.split("\n"):
                    yield f"data: {line}\n"
                yield "\n"
            yield "event: done\ndata: [DONE]\n\n"
        except NotAResumeError as exc:
            print(f"GEMINI INFO: session {session_id} rejected as non-resume: {exc}")
            yield (
                "event: not_resume\n"
                f"data: {exc}\n\n"
            )
        except GeminiServiceError as exc:
            print(f"GEMINI ERROR: session {session_id} failed: {exc}")
            # NOTE: named "stream_error" (not "error") on purpose --
            # "error" collides with the browser EventSource's own reserved
            # native error event, which can swallow or duplicate-dispatch
            # this message on the frontend. See frontend/app.js.
            yield (
                "event: stream_error\n"
                "data: The AI analysis service is currently unavailable. "
                "Please try again shortly.\n\n"
            )
        finally:
            # Discard extracted text after use (Section 9.2).
            SESSION_STORE.pop(session_id, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# Frontend serving
# ---------------------------------------------------------------------------
# IMPORTANT: this must come AFTER every /api/... route above. StaticFiles is
# mounted at "/", which acts as a catch-all -- if it were registered first,
# it would shadow the /api routes.

@app.get("/")
async def serve_frontend_index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend")
