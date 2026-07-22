"""
FR-2.1: Backend extracts text from PDF using PyMuPDF.
FR-2.2: Handle standard single/multi-column resume layouts on a best-effort
        basis (no OCR in MVP).
FR-2.3: Sanitize extracted text before sending to Gemini.
"""

import re

import fitz  # PyMuPDF


class PDFExtractionError(Exception):
    """Raised when a PDF cannot be parsed or opened."""


def _sanitize_text(text: str) -> str:
    # Remove null bytes and control characters (keep newlines/tabs).
    text = text.replace("\x00", "")
    text = re.sub(r"[\x01-\x08\x0b\x0c\x0e-\x1f]", "", text)
    # Collapse excessive blank lines produced by PDF layout artifacts.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_text_from_pdf(file_bytes: bytes) -> str:
    """Extract and sanitize text from PDF bytes.

    Raises PDFExtractionError if the file cannot be opened/parsed at all.
    Returns an empty/short string (handled by the caller per FR-2.4) if the
    PDF opens but contains no meaningful extractable text (e.g. a scanned
    image-only PDF, since OCR is out of scope for the MVP).
    """
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
    except Exception as exc:
        raise PDFExtractionError("Unable to open PDF") from exc

    text_parts = []
    try:
        for page in doc:
            text_parts.append(page.get_text("text"))
    except Exception as exc:
        raise PDFExtractionError("Unable to extract text from PDF") from exc
    finally:
        doc.close()

    raw_text = "\n".join(text_parts)
    return _sanitize_text(raw_text)
