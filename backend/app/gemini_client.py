"""
7.3 AI Analysis (Google Gemini Integration)
FR-3.1/FR-3.2: Sends extracted resume text to Gemini with the fixed prompt.
FR-3.3: Streams Gemini's response token-by-token (relayed to frontend via
        SSE by app/main.py).
FR-3.4: On API failure, attempt one retry; if it fails again, raise a
        GeminiServiceError so the caller can show a clear error message.
"""

import os
import asyncio
from typing import AsyncGenerator

from dotenv import load_dotenv
from google import genai
from google.genai import types

from app.prompt_template import build_prompt

# Load variables from backend/.env into the process environment. Without
# this, GEMINI_API_KEY only exists if it happens to be set in whichever
# terminal session launched uvicorn -- a value set with `set` (cmd.exe) or
# `$env:` (PowerShell) in one window is invisible to every other window,
# and to any window opened after that one is closed.
load_dotenv()

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODEL_NAME = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

_client = genai.Client(api_key=GEMINI_API_KEY) if GEMINI_API_KEY else None


class GeminiServiceError(Exception):
    """Raised when the Gemini API fails after the allowed retry."""


class NotAResumeError(Exception):
    """Raised when the uploaded document's text doesn't look like a resume/CV.

    Detected from within the single existing analysis stream: the prompt
    (see prompt_template.py) instructs the model to respond with a fixed
    NOT_A_RESUME sentinel line instead of the five analysis sections when
    the input isn't a resume. This is a distinct, non-failure outcome (not
    a service error) -- it's surfaced to the frontend as its own SSE event
    so the UI can show a friendly "please upload a resume" message instead
    of a generic service-unavailable error.
    """


def _sync_stream_call(resume_text: str):
    """Blocking generator wrapping the Gemini SDK's streaming call.

    Runs in a worker thread via run_in_executor since the SDK's streaming
    interface is synchronous.
    """
    prompt = build_prompt(resume_text)
    response_stream = _client.models.generate_content_stream(
        model=GEMINI_MODEL_NAME,
        contents=prompt,
        config=types.GenerateContentConfig(
            max_output_tokens=4096,
            # NOTE: thinking_level (Gemini 3.x's replacement for
            # thinking_budget) requires google-genai >= ~1.51.0 -- on
            # this project's pinned google-genai==1.20.0, ThinkingConfig
            # is a strict pydantic model and raises
            # "ValidationError: thinking_level Extra inputs are not
            # permitted" because the field doesn't exist yet in this
            # version's schema.
            # thinking_budget is the field this SDK version actually
            # supports, and Google's docs for gemini-3.5-flash on this
            # same generateContent/generateContentStream API confirm
            # thinking_budget=0 still disables thinking here (the
            # separate reports of gemini-3.5-flash streaming to an empty
            # response were specific to automatic function calling,
            # which this app does not use).
            # If google-genai is upgraded past ~1.51.0, thinking_level
            # ("low"/"minimal") becomes available and is the
            # forward-looking way to control Gemini 3.x thinking.
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    for chunk in response_stream:
        if getattr(chunk, "text", None):
            yield chunk.text


STREAM_CHUNK_TIMEOUT_SECONDS = 30

# Must match the exact string prompt_template.py instructs the model to
# respond with when the input isn't a resume/CV.
NOT_A_RESUME_SENTINEL = "NOT_A_RESUME"
# Long enough to reliably distinguish NOT_A_RESUME (12 chars) from the
# start of a real analysis ("RESUME_SCORE:", 14 chars), short enough that
# buffering this many characters before the first yield is imperceptible.
SENTINEL_DECISION_CHARS = 20


def _looks_like_not_a_resume(text: str) -> bool:
    cleaned = text.strip().strip("*_\"'").upper()
    return cleaned.startswith(NOT_A_RESUME_SENTINEL)


# ---------------------------------------------------------------------------
# Pre-check: cheap keyword heuristic + (only if inconclusive) a tiny,
# preview-only AI classification call.
#
# Why: a large non-resume PDF (e.g. a 30-slide deck converted to PDF) was
# being sent in full to the main streaming analysis call, which sometimes
# returned Gemini 503 UNAVAILABLE. That full call is expensive (thousands of
# input characters, up to 4096 output tokens, streamed) and is wasted work
# whenever the document was never a resume in the first place. This
# pre-check runs before that call and, in the common cases, avoids it
# entirely:
#
#   1. Keyword heuristic (no AI call at all) -- resumes almost always
#      contain several of a small set of section-header words. If enough of
#      them are present, we skip straight to the existing full analysis
#      unchanged.
#   2. Only when the heuristic is inconclusive do we make one small,
#      non-streaming Gemini call that sends just the first ~1000 characters
#      (not the full, possibly-truncated-to-12000-char document) and asks
#      for a single YES/NO word (max_output_tokens=5). If that says NO, we
#      raise NotAResumeError immediately -- the exact same outcome the
#      frontend already handles via the "not_resume" SSE event -- without
#      ever touching the full streaming call.
#
# This never changes behavior for documents that pass either check: they
# flow into the existing, untouched stream_gemini_analysis logic below. If
# the quick AI check itself errors out (e.g. transient network issue), we
# fail open (treat it as "proceed") rather than block a possibly-valid
# resume -- worst case that's identical to current behavior.
# ---------------------------------------------------------------------------

RESUME_KEYWORDS = [
    "experience",
    "education",
    "skills",
    "projects",
    "certification",
    "employment",
    "work history",
    "objective",
    "summary",
    "references",
    "linkedin",
    "resume",
    "curriculum vitae",
    "contact",
    "phone",
    "achievements",
    "responsibilities",
    "internship",
    "qualifications",
]
# Resumes reliably contain several of these section-style words; most other
# document types (slide decks, articles, textbooks) don't cluster them.
HEURISTIC_KEYWORD_THRESHOLD = 3

# Only a short preview is sent to the AI pre-check -- never the full
# (possibly multi-thousand-character) extracted document.
AI_PRECHECK_PREVIEW_CHARS = 1000


def _heuristic_looks_like_resume(text: str) -> bool:
    lowered = text.lower()
    matches = sum(1 for keyword in RESUME_KEYWORDS if keyword in lowered)
    return matches >= HEURISTIC_KEYWORD_THRESHOLD


def _build_precheck_prompt(preview_text: str) -> str:
    return f"""Look at this excerpt from the beginning of a document. Answer with exactly
one word: YES if it looks like it could plausibly be part of a resume/CV
(work experience, education, skills, or contact details written for a job
application), or NO if it clearly is not (for example a textbook excerpt,
slide deck, article, or report). Respond with only YES or NO -- no
punctuation, no explanation.

EXCERPT:
\"\"\"
{preview_text}
\"\"\"
"""


def _quick_ai_resume_precheck(preview_text: str) -> bool:
    """Minimal-token, non-streaming classification call using only a preview.

    Returns True ("proceed to full analysis") whenever the result is
    anything other than a confident NO -- including when the call itself
    fails -- so this pre-check can only ever skip the full call for
    documents it is confident are not resumes, never block a real one.
    """
    if _client is None:
        return True

    try:
        response = _client.models.generate_content(
            model=GEMINI_MODEL_NAME,
            contents=_build_precheck_prompt(preview_text),
            config=types.GenerateContentConfig(
                max_output_tokens=5,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        answer = (getattr(response, "text", "") or "").strip().upper()
        return not answer.startswith("NO")
    except Exception as exc:
        print(
            "GEMINI WARN: quick resume pre-check failed, falling back to "
            f"full analysis: {type(exc).__name__}: {exc}"
        )
        return True


async def _run_stream_once(resume_text: str) -> AsyncGenerator[str, None]:
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()
    sentinel = object()

    def producer():
        try:
            for piece in _sync_stream_call(resume_text):
                loop.call_soon_threadsafe(queue.put_nowait, piece)
        except Exception as exc:
            print("GEMINI ERROR:", repr(exc))
            import traceback
            traceback.print_exc()
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)

    loop.run_in_executor(None, producer)

    while True:
        try:
            item = await asyncio.wait_for(queue.get(), timeout=STREAM_CHUNK_TIMEOUT_SECONDS)
        except asyncio.TimeoutError as exc:
            print(
                f"GEMINI ERROR: no stream chunk received within "
                f"{STREAM_CHUNK_TIMEOUT_SECONDS}s (model={GEMINI_MODEL_NAME})"
            )
            raise GeminiServiceError("Gemini API timed out") from exc
        if item is sentinel:
            return
        if isinstance(item, Exception):
            raise item
        yield item


async def stream_gemini_analysis(resume_text: str) -> AsyncGenerator[str, None]:
    """Yields text chunks from Gemini. Retries once on failure (FR-3.4).

    If a failure happens after some content has already been streamed to the
    caller, we cannot silently retry (partial output was already sent), so we
    surface the error immediately in that case instead.
    """
    if not GEMINI_API_KEY:
        print("GEMINI ERROR: GEMINI_API_KEY is not set in this process's environment")
        raise GeminiServiceError("Gemini API key is not configured")

    # Pre-check (see block above): skip straight through for anything that
    # already looks like a resume via keywords -- zero extra Gemini calls,
    # zero change in behavior. Only fall back to a tiny preview-only AI call
    # when the heuristic can't tell, and only ever raise NotAResumeError
    # from it on a confident NO.
    if not _heuristic_looks_like_resume(resume_text):
        preview = resume_text[:AI_PRECHECK_PREVIEW_CHARS]
        if not _quick_ai_resume_precheck(preview):
            print("GEMINI INFO: pre-check classified input as not a resume (preview-only call)")
            raise NotAResumeError(
                "This document doesn't look like a resume. Please upload a resume PDF."
            )

    max_attempts = 2
    for attempt in range(1, max_attempts + 1):
        yielded_any = False
        decision_buffer = ""
        decided = False
        is_not_resume = False
        try:
            async for piece in _run_stream_once(resume_text):
                if not decided:
                    decision_buffer += piece
                    if len(decision_buffer.lstrip()) >= SENTINEL_DECISION_CHARS:
                        decided = True
                        if _looks_like_not_a_resume(decision_buffer):
                            is_not_resume = True
                        else:
                            yielded_any = True
                            yield decision_buffer
                    continue
                if is_not_resume:
                    # Not surfaced to the frontend -- this is a short,
                    # already-fully-decided sentinel response, not a real
                    # analysis. Let the rest drain without yielding it.
                    continue
                yielded_any = True
                yield piece

            if not decided:
                # Stream ended before reaching the decision threshold
                # (an unusually short response) -- decide with whatever
                # was buffered.
                if _looks_like_not_a_resume(decision_buffer):
                    is_not_resume = True
                elif decision_buffer:
                    yielded_any = True
                    yield decision_buffer

            if is_not_resume:
                raise NotAResumeError(
                    "This document doesn't look like a resume. Please upload a resume PDF."
                )

            if not yielded_any:
                # SDK call completed without error but produced no visible
                # text (e.g. the model's entire budget went to internal
                # "thinking" tokens) -- treat as a failure rather than a
                # silent empty success.
                print(
                    f"GEMINI ERROR: attempt {attempt}/{max_attempts} completed "
                    f"with zero visible text chunks (model={GEMINI_MODEL_NAME})"
                )
                raise GeminiServiceError("Gemini returned no content")
            return
        except NotAResumeError:
            # Not a service failure -- a valid classification outcome from
            # this same request. Never retried, never rewrapped into the
            # generic GeminiServiceError below.
            raise
        except Exception as exc:
            # This is the only place ALL of the above silent raises pass
            # through before being rewrapped into the generic
            # "Gemini API failed" message sent to the frontend. Logging the
            # real exception here is what makes the true cause visible.
            print(
                f"GEMINI ERROR: attempt {attempt}/{max_attempts} failed: "
                f"{type(exc).__name__}: {exc}"
            )
            if yielded_any or attempt == max_attempts:
                raise GeminiServiceError("Gemini API failed") from exc
            await asyncio.sleep(1)
