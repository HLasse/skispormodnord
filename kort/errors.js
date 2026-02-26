// errors.js -- Error classification, user-facing messages, retry logic, display routing
// Zero dependencies -- imports NOTHING from other app modules.

/**
 * Application error with user-facing message and technical details.
 * - message: User-facing text (Danish) -- shown by default
 * - technical: Developer details (HTTP status, endpoint, error type) -- behind "Show details"
 * - recoverable: true = toast (auto-dismiss), false = banner (blocks action)
 * - retryable: true = can be silently retried before showing to user
 */
export class AppError extends Error {
  constructor(message, { technical, recoverable = false, retryable = false } = {}) {
    super(message);
    this.name = "AppError";
    this.technical = technical ?? null;
    this.recoverable = recoverable;
    this.retryable = retryable;
  }
}

/**
 * Classify tile fetch errors based on failure ratio.
 * High failure ratio = fatal (cannot produce usable map).
 * Low failure ratio = recoverable (map has some blank tiles).
 */
export function classifyTileError(error, failedCount, totalCount) {
  const ratio = totalCount > 0 ? failedCount / totalCount : 1;
  if (ratio > 0.2) {
    return new AppError(
      "For mange kortfliser fejlede. Tjek din internetforbindelse.",
      { technical: `${failedCount}/${totalCount} tiles failed: ${error?.message || error}`, recoverable: false }
    );
  }
  return new AppError(
    "Nogle kortfliser kunne ikke hentes. Kortet kan have blanke felter.",
    { technical: `${failedCount}/${totalCount} tiles failed: ${error?.message || error}`, recoverable: true }
  );
}

/**
 * Classify projection errors (wrong EPSG, unsupported area, etc.)
 * Always fatal -- cannot produce correct output with wrong projection.
 */
export function classifyProjectionError(error) {
  return new AppError(
    "Projektionfejl: Omraadet understoettes ikke. Kun Norge, Sverige og Finland er tilgaengelige.",
    { technical: error?.message || String(error), recoverable: false }
  );
}

/**
 * Retry an async function with exponential backoff.
 * Useful for transient network errors (tile fetches, WMS requests).
 */
export async function withRetry(fn, { maxRetries = 2, delay = 1000 } = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries) throw error;
      await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
    }
  }
}

// --- Error display ---

let _toastContainer = null;
let _toastTimeout = null;

function ensureToastContainer() {
  if (_toastContainer) return _toastContainer;
  _toastContainer = document.createElement("div");
  _toastContainer.className = "app-error-toast-container";
  _toastContainer.setAttribute("aria-live", "polite");
  document.body.appendChild(_toastContainer);
  return _toastContainer;
}

function createErrorElement(error, type) {
  const el = document.createElement("div");
  el.className = `app-error app-error--${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");

  const messageEl = document.createElement("span");
  messageEl.className = "app-error__message";
  messageEl.textContent = error.message;
  el.appendChild(messageEl);

  if (error.technical) {
    const detailsLink = document.createElement("button");
    detailsLink.className = "app-error__details-toggle";
    detailsLink.textContent = "Vis detaljer";
    detailsLink.type = "button";

    const detailsEl = document.createElement("pre");
    detailsEl.className = "app-error__details";
    detailsEl.textContent = error.technical;
    detailsEl.hidden = true;

    detailsLink.addEventListener("click", () => {
      const isHidden = detailsEl.hidden;
      detailsEl.hidden = !isHidden;
      detailsLink.textContent = isHidden ? "Skjul detaljer" : "Vis detaljer";
    });

    el.appendChild(detailsLink);
    el.appendChild(detailsEl);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "app-error__close";
  closeBtn.textContent = "\u00d7";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Luk");
  closeBtn.addEventListener("click", () => el.remove());
  el.appendChild(closeBtn);

  return el;
}

/**
 * Show an error to the user.
 * Recoverable errors show as toasts (auto-dismiss after 10s).
 * Fatal errors show as banners that stay until dismissed.
 */
export function showError(error) {
  if (!(error instanceof AppError)) {
    error = new AppError(
      error?.message || String(error),
      { technical: error?.stack, recoverable: true }
    );
  }

  if (error.recoverable) {
    // Toast: auto-dismiss after 10 seconds
    const container = ensureToastContainer();
    const el = createErrorElement(error, "warning");
    container.appendChild(el);

    if (_toastTimeout) clearTimeout(_toastTimeout);
    _toastTimeout = setTimeout(() => {
      el.remove();
      _toastTimeout = null;
    }, 10000);
  } else {
    // Banner: stays until user dismisses
    const container = ensureToastContainer();
    const el = createErrorElement(error, "error");
    container.appendChild(el);
  }
}
