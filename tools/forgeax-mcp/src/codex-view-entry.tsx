import { Context, startNativePlugin } from '@forgeax/engine-plugin';
import { codexPlatformPlugin } from './codex-platform.mts';
const realm = new Context();
const started = await startNativePlugin(realm, codexPlatformPlugin);
if (!started.ok) throw started.error;
