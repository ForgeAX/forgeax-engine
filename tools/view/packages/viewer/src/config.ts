import type { Plugin, Context } from '@forgeax/engine-plugin';
import type { EngineWorkspacePresentation } from '@forgeax/engine/app';
import type { FrontendConfig, SlotRegistry } from '@forgeax/view-workspace-core/frontend-contract';
import type { createViewPageTypeRegistry } from './host/page-registry.ts';

import type { FrontendPlatform } from '@forgeax/engine-host/platform';

export type ViewFrontendConfig = FrontendConfig & {
  platform?: FrontendPlatform;
  /** Borrow the native realm that already owns its optional platform plugin. */
  context?: Context;
  embedded?: boolean; embeddedShell?: Plugin;
  displayCarrier?: boolean; viewportSurface?: HTMLElement;
  presentation?: EngineWorkspacePresentation; targetPresentation?: EngineWorkspacePresentation;
  viewSlotRegistry?: SlotRegistry; pageRegistry?: ReturnType<typeof createViewPageTypeRegistry>;
  window?: Window & typeof globalThis;
  workspaceMountId?: string; clientId?: string; resourceBrowser?: boolean;
  workspace?: { endpoint?: string; clientId?: string; token?: string; frontendTicket?: string; mountId?: string; resourceBrowser?: boolean };
};

export type ViewCliCapabilities = {
  operations?: readonly string[];
  descriptions?: readonly { id: string; summary: string }[];
};
export type ViewCliOptions = { capabilities?: readonly string[] | ViewCliCapabilities };

declare global {
  var __forgeaxViewSlotRegistry: SlotRegistry | undefined;
  var __forgeaxViewPanelsUrl: string | undefined;
  var __forgeaxViewPanelsPromise: Promise<unknown> | undefined;
  var __forgeaxViewReady: { mounted?: unknown; error?: string; unconfigured?: boolean; reason?: string } | undefined;
}
