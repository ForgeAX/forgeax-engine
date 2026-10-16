import { Context, startNativePlugin } from '@forgeax/engine-plugin';
import { createMcpViewPlugin } from './view-plugin';
const realm = new Context();
const started = await startNativePlugin(realm, createMcpViewPlugin());
if (!started.ok) throw started.error;
