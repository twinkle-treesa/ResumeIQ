# ResumeIQ

AI-powered resume reviewer — IBM SkillsBuild capstone project.
Built per `ResumeIQ_PRD.pdf` (v2.0). Upload a PDF resume, get a streamed
Gemini-powered analysis broken into five sections: Summary, Strengths,
Weaknesses, Missing Skills, and ATS Suggestions.

## Project Structure

```
resumeiq/
  backend/
    app/
      main.py            # FastAPI app: /api/upload, /api/analyze/stream/{id}, /api/health
      pdf_extractor.py    # PyMuPDF text extraction + sanitization
      gemini_client.py    # Gemini streaming client + retry logic
      prompt_template.py  # Fixed 5-section prompt template
    requirements.txt
    Dockerfile
    .env.example
    .gitignore
  frontend/
    index.html
    style.css
    app.js
  README.md
```

## Tech Stack (per PRD Section 9.1)

- Frontend: HTML, CSS, JavaScript
- Backend: Python FastAPI
- AI: Google Gemini API (streaming)
- PDF parsing: PyMuPDF
- Containerization: Docker
- Hosting: AWS App Runner
- Transport: REST + Server-Sent Events (SSE)

## Local Development

### Backend

```bash
cd backend
python -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# edit .env and set GEMINI_API_KEY=your_actual_key

uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

The API key is loaded from the environment (`os.environ`) in
`gemini_client.py`. `.env` is git-ignored and never committed
(FR-6.1–FR-6.4).

### Frontend

The frontend is static — no build step. Serve it with any static file
server, e.g.:

```bash
cd frontend
python -m http.server 5500
```

Then open `http://localhost:5500`. If the frontend is served from a
different origin than the backend, set `API_BASE_URL` at the top of
`app.js` to the backend's URL (e.g. `http://localhost:8000`); CORS is
already open on the backend for this.

## API Endpoints (per PRD Section 9.3)

| Endpoint | Method | Description |
|---|---|---|
| `/api/upload` | POST | Accepts a PDF (`multipart/form-data`, field `file`), returns `{ session_id, status }` |
| `/api/analyze/stream/{session_id}` | GET (SSE) | Streams the Gemini analysis for that session |
| `/api/health` | GET | Health check for App Runner |

Extracted resume text is held only in memory for the request lifecycle
and discarded once streaming completes or fails — no database is used.

## Docker

```bash
cd backend
docker build -t resumeiq-backend .
docker run -p 8000:8000 -e GEMINI_API_KEY=your_actual_key resumeiq-backend
```

The image never bakes in the API key — it's supplied via `-e` locally
and via App Runner's environment variable configuration in production.

## Deploying to AWS App Runner

1. Push the built image to Amazon ECR (or connect App Runner directly to
   your source repo, per your team's preference).
2. Create an App Runner service from that image/repo.
3. Under the service's configuration, add an environment variable:
   `GEMINI_API_KEY = <your key>` (and optionally `GEMINI_MODEL`).
4. Deploy. App Runner provides HTTPS by default.
5. Verify `/api/health` returns `{"status": "ok"}` on the live URL.
6. Host the static `frontend/` files (e.g. via S3 + CloudFront, or any
   static host) and confirm `API_BASE_URL` in `app.js` points at the
   deployed backend URL.

## Definition of Done Checklist (PRD Section 3.3)

- [ ] PDF upload works end-to-end, desktop and mobile
- [ ] Extracted text is non-empty and readable for a standard resume
- [ ] All five sections stream into the UI
- [ ] Invalid file type / oversized file / API failure each show a clear
      message, not a crash
- [ ] UI usable without horizontal scroll at 375px width
- [ ] Docker image builds cleanly; app reachable via a live App Runner URL
- [ ] Gemini API key never appears in frontend code, network tab, or the
      public repo

## Notes

- OCR is explicitly out of scope for this MVP (PRD Section 16). Scanned,
  image-only PDFs will be rejected with "We couldn't read this file,
  please try another PDF."
- Everything in PRD Section 5.2 (accounts, DOCX support, job-description
  matching, payments, history, etc.) is intentionally not implemented.
