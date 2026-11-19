import assert from 'node:assert/strict';

/** Observe the Engine-owned document without navigating the retained Shell. */
export async function projectDocument(page, timeout = 90_000) {
  const deadline = Date.now() + timeout;
  const remaining = () => Math.max(1, deadline - Date.now());
  const element = await page.locator('iframe[data-forgeax-project-document]').elementHandle({ timeout: remaining() });
  assert.ok(element, 'The elected presenter must own a project document');
  try {
    const frame = await element.contentFrame();
    assert.ok(frame, 'The Engine project document must remain attached');
    await frame.waitForURL(url => url.searchParams.has('forgeaxWorkspaceTarget'), { timeout: remaining() });
    // Artifact pages can hide the project iframe, where rAF does not run.
    await frame.waitForFunction(() => document.documentElement.dataset.forgeaxWorkspaceReady === 'true',
      undefined, { timeout: remaining(), polling: 100 });
    return frame;
  } finally {
    await element.dispose();
  }
}
