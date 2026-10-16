import { resolve } from 'node:path';
import type { Page } from 'playwright';

const guardPath = resolve(import.meta.dirname, '../../../../../config/browser-host-guard.mjs');

export async function installBrowserHostGraphicsGuard(page: Page): Promise<void> {
  await page.addInitScript({ path: guardPath });
}
