import * as wgpu from '@forgeax/engine-rhi-wgpu';
import { registerShadowContactCases } from './shadow-contact.fixture';

// Preserve the native owner's complete contact/acne and cascade-crossing oracle.
registerShadowContactCases('column', 1024, { rhi: wgpu });
