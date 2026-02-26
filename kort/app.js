// app.js -- Application entry point
// Imports all modules and wires initialization.
// This is the composition root: the ONLY file that imports from ALL modules.

import { initUI } from "./ui-controller.js";

/**
 * Initialize the application.
 * Calls initUI() which sets up all DOM event handlers, the Leaflet map,
 * sidebar controls, and the PDF render pipeline.
 */
function init() {
  initUI();
}

// Run init when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
