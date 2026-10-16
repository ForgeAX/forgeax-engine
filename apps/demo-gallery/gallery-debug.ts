/** Verbose tracing; off unless FORGEAX_GALLERY_DEBUG=1. Prints to the Vite dev server terminal (stdout). */
export function galleryDebug(message: string, details?: Record<string, unknown>): void {
  if (process.env.FORGEAX_GALLERY_DEBUG !== '1') return;
  if (details === undefined) {
    console.log(`[demo-gallery:debug] ${message}`);
    return;
  }
  console.log(`[demo-gallery:debug] ${message}`, details);
}

/** Always prints to the Vite dev server terminal (stderr). Not visible in browser DevTools. */
export function galleryLog(message: string, details?: Record<string, unknown>): void {
  if (details === undefined) {
    console.warn(`[demo-gallery] ${message}`);
    return;
  }
  console.warn(`[demo-gallery] ${message}`, details);
}
