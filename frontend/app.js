/* ResumeIQ frontend logic.
 * Talks to: POST /api/upload, GET /api/analyze/stream/{session_id}
 * Set API_BASE_URL to your backend's origin if the frontend is hosted
 * separately from the FastAPI backend. Left as "" because the frontend
 * is now served by FastAPI itself (same origin) -- see main.py.
 */
const API_BASE_URL = "";

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // FR-1.2

const SECTION_LABELS = ["SUMMARY", "STRENGTHS", "WEAKNESSES", "MISSING_SKILLS", "ATS_SUGGESTIONS"];
const SECTION_EL_IDS = {
  SUMMARY: "section-summary",
  STRENGTHS: "section-strengths",
  WEAKNESSES: "section-weaknesses",
  MISSING_SKILLS: "section-missing",
  ATS_SUGGESTIONS: "section-ats",
};

// ---------------- Element references ----------------
const screens = {
  upload: document.getElementById("screen-upload"),
  loading: document.getElementById("screen-loading"),
  results: document.getElementById("screen-results"),
};

const fileInput = document.getElementById("file-input");
const dropzoneForm = document.getElementById("upload-form");
const dropzoneInner = document.getElementById("dropzone-inner");
const browseBtn = document.getElementById("browse-btn");
const fileChip = document.getElementById("file-chip");
const fileNameEl = document.getElementById("file-name");
const clearFileBtn = document.getElementById("clear-file-btn");
const analyzeBtn = document.getElementById("analyze-btn");

const uploadProgress = document.getElementById("upload-progress");
const uploadErrorBanner = document.getElementById("upload-error");
const uploadErrorText = document.getElementById("upload-error-text");
const uploadRetryBtn = document.getElementById("upload-retry-btn");

const scannerLabel = document.getElementById("scanner-label");

const streamErrorBanner = document.getElementById("stream-error");
const streamErrorText = document.getElementById("stream-error-text");
const streamRetryBtn = document.getElementById("stream-retry-btn");
const resetBtn = document.getElementById("reset-btn");
const resultsContainer = document.getElementById("results-container");

// --- New UI-only elements (scores / toolbar / collapsible / loading) ---
const scorePanel = document.getElementById("score-panel");
const resumeScoreValueEl = document.getElementById("resume-score-value");
const atsScoreValueEl = document.getElementById("ats-score-value");
const resumeScoreRingEl = document.getElementById("resume-score-ring");
const atsScoreRingEl = document.getElementById("ats-score-ring");
const copyAnalysisBtn = document.getElementById("copy-analysis-btn");
const downloadPdfBtn = document.getElementById("download-pdf-btn");
const toolbarMsgEl = document.getElementById("toolbar-msg");
const scannerStepsEl = document.getElementById("scanner-steps");
const verdictBanner = document.getElementById("verdict-banner");
const verdictTextEl = document.getElementById("verdict-text");

let selectedFile = null;
let currentEventSource = null;
let currentSessionId = null;

// Raw (un-rendered) section text captured as the stream comes in, purely
// for the new UI features (scores, severity badges, copy, PDF export).
// This is populated from the exact same fullText that renderStreamedContent
// already parses -- it does not change what is parsed, streamed, or sent
// anywhere; it just also keeps a plain-text copy around for reuse.
let latestSections = {};
let analysisFinalized = false;

// ---------------- Initial UI state ----------------
// Nothing else in this file hides the stream error banner until the user
// has already started an analysis (resetResultSections/onmessage/done all
// run later, in response to user action). Without an explicit hide here,
// the banner's visibility on page load is whatever the static HTML markup
// defaults to -- which is why it was showing up before "Analyze My Resume"
// was ever clicked, and appeared to "persist" through a successful run
// (it was never hidden in the first place, so there was nothing for a
// later hide call to visibly change).
// ---------------- Initial UI state ----------------
hideUploadError();
hideStreamError();
fileChip.hidden = true;
dropzoneInner.hidden = false;
analyzeBtn.disabled = true;
// ---------------- Screen management ----------------
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("screen--active", key === name);
  });
}

// ---------------- File selection ----------------
function setSelectedFile(file) {
  hideUploadError();

  if (!file) {
    selectedFile = null;
    fileNameEl.textContent = "";
    fileChip.hidden = true;
    dropzoneInner.hidden = false;
    analyzeBtn.disabled = true;
    return;
  }

  // FR-1.4: client-side validation before upload
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) {
    showUploadError("Only PDF files are accepted. Please choose a .pdf resume.");
    return;
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    showUploadError("File is too large. Please upload a PDF under 5 MB.");
    return;
  }

  selectedFile = file;
  fileNameEl.textContent = file.name;
  fileChip.hidden = false;
  dropzoneInner.hidden = true;
  analyzeBtn.disabled = false;
}

browseBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => setSelectedFile(e.target.files[0] || null));

clearFileBtn.addEventListener("click", () => {
  fileInput.value = "";
  setSelectedFile(null);
});

// Drag and drop (FR-1.3)
["dragenter", "dragover"].forEach((evt) => {
  dropzoneForm.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzoneForm.classList.add("dropzone--drag");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropzoneForm.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzoneForm.classList.remove("dropzone--drag");
  });
});
dropzoneForm.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

// ---------------- Upload error UI ----------------
function showUploadError(message) {
  uploadErrorText.textContent = message;
  uploadErrorBanner.hidden = false;
  uploadErrorBanner.style.display = "";
}
function hideUploadError() {
  uploadErrorBanner.hidden = true;
  uploadErrorBanner.style.display = "none";
}

uploadRetryBtn.addEventListener("click", () => {
  hideUploadError();
});

// ---------------- Upload + kick off analysis ----------------
analyzeBtn.addEventListener("click", (e) => {
  // analyzeBtn is a <button> inside the #upload-form <form> element, so
  // without this it defaults to type="submit" and triggers a native form
  // submission (a GET navigation to the current page) at the same time as
  // this handler's fetch() call. That navigation aborts the in-flight
  // fetch before it reaches the network, which is why no POST /api/upload
  // was ever showing up in the backend terminal.
  e.preventDefault();
  if (!selectedFile) return;
  uploadResume(selectedFile);
});

async function uploadResume(file) {
  hideUploadError();
  analyzeBtn.disabled = true;
  uploadProgress.hidden = false;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const response = await fetch(`${API_BASE_URL}/api/upload`, {
      method: "POST",
      body: formData,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      // FR-9: friendly, specific error messages
      showUploadError(data.detail || "Something went wrong uploading your resume. Please try again.");
      uploadProgress.hidden = true;
      analyzeBtn.disabled = false;
      return;
    }

    currentSessionId = data.session_id;
    uploadProgress.hidden = true;
    startAnalysis(currentSessionId);
  } catch (err) {
    showUploadError("Couldn't reach the server. Please check your connection and try again.");
    uploadProgress.hidden = true;
    analyzeBtn.disabled = false;
  }
}

// ---------------- Streaming analysis ----------------
function resetResultSections() {
  SECTION_LABELS.forEach((label) => {
    const el = document.getElementById(SECTION_EL_IDS[label]);
    el.innerHTML = "";
  });
  document.getElementById("section-summary").innerHTML = '<span class="typing-cursor"></span>';
  hideStreamError();

  // --- Reset new UI-only state for a fresh run ---
  latestSections = {};
  analysisFinalized = false;
  setScore(resumeScoreValueEl, resumeScoreRingEl, null);
  setScore(atsScoreValueEl, atsScoreRingEl, null);
  copyAnalysisBtn.disabled = true;
  downloadPdfBtn.disabled = true;
  toolbarMsgEl.textContent = "";
  verdictBanner.hidden = true;
  verdictTextEl.textContent = "";
  // Expand any cards a previous run left collapsed.
  resultsContainer.querySelectorAll(".result-card.is-collapsed").forEach((card) => {
    card.classList.remove("is-collapsed");
    const toggle = card.querySelector(".result-card__toggle");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
  });
  resetScannerSteps();
}

function startAnalysis(sessionId) {
  resetResultSections();
  showScreen("loading");
  scannerLabel.textContent = "Reading your resume…";
  startScannerSteps();

  if (currentEventSource) {
    currentEventSource.close();
  }

  const es = new EventSource(`${API_BASE_URL}/api/analyze/stream/${sessionId}`);
  currentEventSource = es;

  let rawBuffer = "";
  let hasShownResults = false;
  let receivedAnyData = false;

  es.onmessage = (event) => {
    if (!hasShownResults) {
      hasShownResults = true;
      stopScannerSteps();
      showScreen("results");
    }
    receivedAnyData = true;
    // Real data is flowing successfully -- clear out any error banner
    // left over from an earlier failed attempt/retry.
    hideStreamError();
    // Each SSE message here is one arbitrary Gemini stream chunk, not a
    // line -- chunks routinely split mid-word, mid-bullet, or
    // mid-sentence. Any real newlines Gemini actually produced are
    // already preserved inside event.data by the browser's own SSE
    // multi-line reconstruction, so chunks must be concatenated as-is
    // with no separator inserted, or words/bullets get fragmented across
    // lines that were never there in the original text.
    rawBuffer += event.data;
    renderStreamedContent(rawBuffer);
  };

  es.addEventListener("done", () => {
    hideStreamError();
    es.close();
    currentEventSource = null;
    stopScannerSteps();
    // UI-only: compute estimated scores/severity and enable export actions
    // from the analysis text already received. No new request is made.
    finalizeResults();
  });

  // NOTE: the backend sends "event: stream_error" rather than "event: error"
  // because "error" is reserved by EventSource for native connection
  // failures and can collide with (or be shadowed by) that handling.
  es.addEventListener("stream_error", (event) => {
    const message =
      (event && event.data) ||
      "The AI analysis service is currently unavailable. Please try again shortly.";
    // Always switch off the loading screen here: if no message event ever
    // fired, hasShownResults is still false and the error banner (which
    // lives on the results screen) would otherwise be shown on a screen
    // the user never sees, making the app look like it's hanging forever.
    stopScannerSteps();
    showScreen("results");
    showStreamError(message);
    es.close();
    currentEventSource = null;
  });

  // Distinct from stream_error: this isn't a service failure, it's the
  // backend classifying the uploaded document as not being a resume.
  // Reuses the same banner/retry UI, with a friendly message instead of
  // the generic "service unavailable" one.
  es.addEventListener("not_resume", (event) => {
    const message =
      (event && event.data) ||
      "This doesn't look like a resume. Please upload a resume PDF to continue.";
    stopScannerSteps();
    showScreen("results");
    showStreamError(message);
    es.close();
    currentEventSource = null;
  });

  es.onerror = () => {
    // Only treat as a hard failure if we never got any data and the
    // connection is fully closed (native EventSource network error).
    if (!receivedAnyData && es.readyState === EventSource.CLOSED) {
      stopScannerSteps();
      showScreen("results");
      showStreamError("The AI analysis service is currently unavailable. Please try again shortly.");
    }
  };
}

function hideStreamError() {
  streamErrorBanner.hidden = true;
  streamErrorBanner.style.display = "none";
  // Restore the result cards -- this runs at the start of every new
  // attempt and the moment real content starts arriving, both of which
  // are exactly when the cards should be visible again.
  resultsContainer.hidden = false;
  resultsContainer.style.display = "";
}

function showStreamError(message) {
  streamErrorText.textContent = message;
  streamErrorBanner.hidden = false;
  streamErrorBanner.style.display = "";
  // No real analysis content exists for this attempt (service error or
  // non-resume classification) -- hide the empty result cards so only
  // the message and retry button show.
  resultsContainer.hidden = true;
  resultsContainer.style.display = "none";
}

streamRetryBtn.addEventListener("click", () => {
  if (currentSessionId) {
    startAnalysis(currentSessionId);
  } else {
    showScreen("upload");
  }
});

// Parses the fixed-label prompt output into UI sections (FR-4.1).
// RESUME_SCORE / ATS_SCORE / OVERALL_VERDICT are new labels Gemini now
// includes in this same single response (see prompt_template.py) -- they
// route to the score panel / verdict banner below instead of a result card.
function renderStreamedContent(fullText) {
  const labelPattern = /(RESUME_SCORE|ATS_SCORE|OVERALL_VERDICT|SUMMARY|STRENGTHS|WEAKNESSES|MISSING_SKILLS|ATS_SUGGESTIONS):/g;

  const matches = [];
  let match;
  while ((match = labelPattern.exec(fullText)) !== null) {
    matches.push({ label: match[1], index: match.index, endIndex: match.index + match[0].length });
  }

  if (matches.length === 0) return;

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const sectionText = fullText.slice(current.endIndex, next ? next.index : undefined).trim();
    // A field is "settled" once a later label has appeared (or the stream
    // is fully done) -- used to avoid flashing a half-streamed number
    // ("7" before "78") or a half-written verdict sentence.
    const settled = Boolean(next) || analysisFinalized;

    latestSections[current.label] = sectionText;

    if (current.label === "RESUME_SCORE" || current.label === "ATS_SCORE") {
      if (settled) {
        const score = parseScoreValue(sectionText);
        if (current.label === "RESUME_SCORE") setScore(resumeScoreValueEl, resumeScoreRingEl, score);
        else setScore(atsScoreValueEl, atsScoreRingEl, score);
      }
      continue;
    }

    if (current.label === "OVERALL_VERDICT") {
      if (settled && sectionText) {
        verdictTextEl.textContent = formatVerdictForDisplay(sectionText);
        verdictBanner.hidden = false;
      }
      continue;
    }

    const el = document.getElementById(SECTION_EL_IDS[current.label]);
    if (!el) continue;

    const isLastSection = i === matches.length - 1;
    if (current.label === "WEAKNESSES" && settled) {
      // Only apply severity badges once the section's text is complete
      // (i.e. a later section has started, or the stream is fully done)
      // so bullets don't get misclassified while still mid-word.
      el.innerHTML = formatWeaknessesWithSeverity(sectionText);
    } else {
      el.innerHTML = formatSectionText(sectionText, isLastSection);
    }
  }
}

function formatSectionText(text, appendCursor) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => l.startsWith("- ") || l.startsWith("* "));

  let html;
  if (bulletLines.length > 0 && bulletLines.length === lines.length) {
    html = "<ul>" + lines.map((l) => `<li>${escapeHtml(l.replace(/^[-*]\s+/, ""))}</li>`).join("") + "</ul>";
  } else {
    html = lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("");
  }

  if (appendCursor) {
    html += '<span class="typing-cursor"></span>';
  }
  return html;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// New UI-only additions below: severity badges, estimated scores,
// collapsible cards, copy/PDF export, richer loading indicator.
// None of this touches uploadResume(), startAnalysis()'s SSE handling,
// or any backend call -- it only reads text the stream already delivered.
// ============================================================

// ---------------- Severity badges (heuristic, client-side only) ----------------
// There is no severity field in the backend response -- the prompt only
// asks for five plain-text sections. Rather than changing the prompt or
// backend to add one, this classifies each WEAKNESSES bullet using simple
// keyword matching on text the stream already returned.
const SEVERITY_KEYWORDS = {
  Critical: [
    "missing", "no evidence", "lacks", "lack of", "does not include",
    "doesn't include", "fails to", "no contact", "unclear objective",
    "critical", "absent", "not included", "no measurable",
  ],
  Minor: [
    "minor", "small", "could ", "consider ", "slight", "polish",
    "typo", "formatting could", "inconsistent spacing",
  ],
};

function classifySeverity(bulletText) {
  const lower = bulletText.toLowerCase();
  if (SEVERITY_KEYWORDS.Critical.some((k) => lower.includes(k))) return "Critical";
  if (SEVERITY_KEYWORDS.Minor.some((k) => lower.includes(k))) return "Minor";
  return "Moderate";
}

function formatWeaknessesWithSeverity(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const bulletLines = lines.filter((l) => l.startsWith("- ") || l.startsWith("* "));

  if (bulletLines.length === 0 || bulletLines.length !== lines.length) {
    // Not a clean bullet list (still streaming, or model didn't use one) --
    // fall back to the same plain rendering used elsewhere.
    return formatSectionText(text, false);
  }

  const items = lines.map((l) => {
    const bulletText = l.replace(/^[-*]\s+/, "");
    const severity = classifySeverity(bulletText);
    return `<li><span class="severity-badge severity-badge--${severity.toLowerCase()}">${severity}</span><span>${escapeHtml(bulletText)}</span></li>`;
  });

  return `<ul class="has-severity">${items.join("")}</ul>`;
}

// A genuine OVERALL_VERDICT is 1-2 sentences. If a label is ever omitted
// or reordered, this field's captured text could run on and absorb real
// content meant for a later section -- this only affects the compact
// banner's *display*; the full raw text is still kept in latestSections
// and used as-is by Copy Analysis / Download PDF.
const VERDICT_DISPLAY_MAX_CHARS = 480;

function formatVerdictForDisplay(text) {
  const trimmed = (text || "").trim();
  if (trimmed.length <= VERDICT_DISPLAY_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, VERDICT_DISPLAY_MAX_CHARS).trimEnd()}…`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// ---------------- Real scores (now generated by Gemini itself) ----------------
// RESUME_SCORE / ATS_SCORE come directly from the model's response (see
// prompt_template.py) in this same single request -- this just extracts
// the integer Gemini already wrote and guards against odd formatting
// (e.g. "78/100" or "Score: 78") so the UI never crashes on a stray token.
function parseScoreValue(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (!cleaned) return null;

  // Strip a short leading label Gemini might still add despite
  // instructions (e.g. "Score: 85", "Rating - 85"). Bounded to a few
  // characters on purpose -- see note below.
  cleaned = cleaned.replace(/^[a-zA-Z\s:=-]{0,15}/, "");
  // Strip a trailing parenthetical aside (e.g. "85 (strong resume)").
  cleaned = cleaned.replace(/\([^)]*\)/g, "").trim();

  // IMPORTANT: anchored at the start (^), and the leading-filler strip
  // above is deliberately bounded to ~15 chars, not stripped through an
  // entire sentence. If a label is ever omitted, the previous field's
  // captured text can run on and absorb real prose from a later section
  // (e.g. "...graduated in 2020 with a 3.8 GPA..."). An unbounded strip
  // would tunnel past "graduated in" and misread "2020" as the score; the
  // bound means that kind of leaked-in sentence simply won't have a digit
  // within reach of the start, so this safely falls back to "no score
  // available" instead of guessing a wrong one.
  const match = cleaned.match(/^(\d{1,3})(?:\.\d+)?/);
  if (!match) return null;

  const num = parseInt(match[1], 10);
  if (Number.isNaN(num)) return null;
  return clamp(num, 0, 100);
}

function setScore(valueEl, ringEl, score) {
  if (score === null || score === undefined) {
    valueEl.textContent = "–";
    ringEl.style.setProperty("--pct", 0);
    return;
  }
  valueEl.textContent = String(score);
  ringEl.style.setProperty("--pct", score);
}

// ---------------- Finalize (runs once, after the "done" SSE event) ----------------
function finalizeResults() {
  if (analysisFinalized) return;
  analysisFinalized = true;

  // Re-render WEAKNESSES now that its text is guaranteed complete, so
  // severity badges are based on the final bullets, not a mid-stream guess.
  const weaknessesEl = document.getElementById(SECTION_EL_IDS.WEAKNESSES);
  if (weaknessesEl && latestSections.WEAKNESSES) {
    weaknessesEl.innerHTML = formatWeaknessesWithSeverity(latestSections.WEAKNESSES);
  }

  // Commit final scores/verdict in case the stream ended before a later
  // label ever appeared to mark them "settled" during rendering.
  setScore(resumeScoreValueEl, resumeScoreRingEl, parseScoreValue(latestSections.RESUME_SCORE));
  setScore(atsScoreValueEl, atsScoreRingEl, parseScoreValue(latestSections.ATS_SCORE));
  if (latestSections.OVERALL_VERDICT) {
    verdictTextEl.textContent = formatVerdictForDisplay(latestSections.OVERALL_VERDICT);
    verdictBanner.hidden = false;
  }

  copyAnalysisBtn.disabled = false;
  downloadPdfBtn.disabled = false;
}

// ---------------- Collapsible result cards ----------------
resultsContainer.addEventListener("click", (e) => {
  const toggle = e.target.closest(".result-card__toggle");
  if (!toggle) return;
  const card = toggle.closest(".result-card");
  if (!card) return;
  const collapsed = card.classList.toggle("is-collapsed");
  toggle.setAttribute("aria-expanded", String(!collapsed));
});

// ---------------- Loading indicator: cycling status + step tracker ----------------
const SCANNER_MESSAGES = [
  "Reading your resume…",
  "Checking structure and sections…",
  "Weighing strengths and gaps…",
  "Finishing up your report…",
];
let scannerStepTimer = null;
let scannerStepIndex = 0;

function resetScannerSteps() {
  scannerStepIndex = 0;
  scannerLabel.textContent = SCANNER_MESSAGES[0];
  if (scannerStepsEl) {
    scannerStepsEl.querySelectorAll(".scanner__step").forEach((el, i) => {
      el.classList.toggle("is-active", i === 0);
      el.classList.remove("is-done");
    });
  }
}

function startScannerSteps() {
  stopScannerSteps();
  resetScannerSteps();
  scannerStepTimer = setInterval(() => {
    if (scannerStepIndex >= SCANNER_MESSAGES.length - 1) return; // hold on last step
    const steps = scannerStepsEl ? scannerStepsEl.querySelectorAll(".scanner__step") : [];
    if (steps[scannerStepIndex]) {
      steps[scannerStepIndex].classList.remove("is-active");
      steps[scannerStepIndex].classList.add("is-done");
    }
    scannerStepIndex += 1;
    if (steps[scannerStepIndex]) steps[scannerStepIndex].classList.add("is-active");
    scannerLabel.textContent = SCANNER_MESSAGES[scannerStepIndex];
  }, 2200);
}

function stopScannerSteps() {
  if (scannerStepTimer) {
    clearInterval(scannerStepTimer);
    scannerStepTimer = null;
  }
}

// ---------------- Copy Analysis ----------------
function buildPlainTextAnalysis() {
  const resumeScore = parseScoreValue(latestSections.RESUME_SCORE);
  const atsScore = parseScoreValue(latestSections.ATS_SCORE);
  const lines = [];
  lines.push("ResumeIQ Analysis");
  lines.push(`Resume Score: ${resumeScore !== null ? resumeScore : "N/A"}/100`);
  lines.push(`ATS Score: ${atsScore !== null ? atsScore : "N/A"}/100`);
  lines.push("");
  if (latestSections.OVERALL_VERDICT) {
    lines.push("OVERALL VERDICT:");
    lines.push(latestSections.OVERALL_VERDICT);
    lines.push("");
  }
  SECTION_LABELS.forEach((label) => {
    const heading = label.replace(/_/g, " ");
    lines.push(`${heading}:`);
    lines.push(latestSections[label] || "");
    lines.push("");
  });
  return lines.join("\n").trim();
}

function showToolbarMessage(message) {
  toolbarMsgEl.textContent = message;
  setTimeout(() => {
    if (toolbarMsgEl.textContent === message) toolbarMsgEl.textContent = "";
  }, 2500);
}

copyAnalysisBtn.addEventListener("click", async () => {
  if (copyAnalysisBtn.disabled) return;
  const text = buildPlainTextAnalysis();
  try {
    await navigator.clipboard.writeText(text);
    showToolbarMessage("Copied to clipboard");
  } catch (err) {
    showToolbarMessage("Couldn't copy -- try selecting the text manually");
  }
});

// ---------------- Download Analysis as PDF ----------------
// Renders the analysis text already returned by the backend into a PDF
// entirely client-side. Makes no network request and triggers no
// additional Gemini call.
downloadPdfBtn.addEventListener("click", () => {
  if (downloadPdfBtn.disabled) return;

  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (!jsPDFCtor) {
    showToolbarMessage("PDF export unavailable -- check your connection and reload");
    return;
  }

  const resumeScore = parseScoreValue(latestSections.RESUME_SCORE);
  const atsScore = parseScoreValue(latestSections.ATS_SCORE);
  const doc = new jsPDFCtor({ unit: "pt", format: "a4" });
  const marginX = 48;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - marginX * 2;
  let y = 56;

  function ensureSpace(lineHeight) {
    if (y + lineHeight > pageHeight - 48) {
      doc.addPage();
      y = 56;
    }
  }

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("ResumeIQ Analysis", marginX, y);
  y += 26;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.setTextColor(90, 90, 90);
  doc.text(
    `Resume Score: ${resumeScore !== null ? resumeScore : "N/A"}/100   |   ATS Score: ${atsScore !== null ? atsScore : "N/A"}/100`,
    marginX,
    y
  );
  y += 20;
  doc.setTextColor(20, 20, 20);

  if (latestSections.OVERALL_VERDICT) {
    ensureSpace(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text("OVERALL VERDICT", marginX, y);
    y += 16;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    doc.splitTextToSize(latestSections.OVERALL_VERDICT, maxWidth).forEach((line) => {
      ensureSpace(14);
      doc.text(line, marginX, y);
      y += 14;
    });
    y += 12;
  }

  SECTION_LABELS.forEach((label) => {
    const heading = label.replace(/_/g, " ");
    ensureSpace(20);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(heading, marginX, y);
    y += 16;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(10.5);
    const bodyText = (latestSections[label] || "(no content)").trim();
    const bodyLines = doc.splitTextToSize(bodyText, maxWidth);
    bodyLines.forEach((line) => {
      ensureSpace(14);
      doc.text(line, marginX, y);
      y += 14;
    });
    y += 12;
  });

  doc.save("resumeiq-analysis.pdf");
  showToolbarMessage("PDF downloaded");
});

// ---------------- Reset flow (FR-4.4) ----------------
resetBtn.addEventListener("click", () => {
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }
  stopScannerSteps();
  currentSessionId = null;
  fileInput.value = "";
  setSelectedFile(null);
  hideUploadError();
  // Clears all five result sections and hides the stream error banner --
  // without this, a failed or non-resume analysis left both in place, so
  // the next successful run could briefly flash stale content/errors
  // before its own data arrived.
  resetResultSections();
  showScreen("upload");
});
