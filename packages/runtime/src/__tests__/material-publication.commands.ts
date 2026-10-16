import { serializeCookedMaterialRecord, validateCookedMaterialRecord } from '@forgeax/engine-pack';
import type { MaterialAsset } from '@forgeax/engine-types';
import { createMaterialPackCooker } from '../../../shader-compiler/src/material/pack-cooker';
import { startClippingPlanesServer } from './clipping-planes.server';
import { CHANNEL_PHYSICAL_GUID } from './lighting-channels-material.fixture';
import { startMaterialMrtServer } from './material-mrt.server';
import { startVertexColorPublicationServer } from './vertex-color-publication.server';

const mrtServers = new Map<string, Awaited<ReturnType<typeof startMaterialMrtServer>>>();

import {
  type SurfaceMaterialPublicationValue,
  startMaterialPublicationServer,
  startSurfaceMaterialPublicationServer,
} from './material-publication.server';

const servers = new Map<string, Awaited<ReturnType<typeof startMaterialPublicationServer>>>();
const surfaceServers = new Map<
  string,
  Awaited<ReturnType<typeof startSurfaceMaterialPublicationServer>>
>();

const clippingServers = new Map<string, Awaited<ReturnType<typeof startClippingPlanesServer>>>();
const vertexColorServers = new Map<
  string,
  Awaited<ReturnType<typeof startVertexColorPublicationServer>>
>();
export const materialPublicationCommands = {
  async prepareChannelPhysicalMaterial(_context: unknown, source: MaterialAsset) {
    const cooked = await createMaterialPackCooker().cook({ guid: CHANNEL_PHYSICAL_GUID, source });
    const record = validateCookedMaterialRecord(
      (cooked.payload as { cooked: unknown }).cooked,
    ).unwrap();
    return serializeCookedMaterialRecord(record);
  },
  async startVertexColorPublication(_context: unknown) {
    const server = await startVertexColorPublicationServer();
    vertexColorServers.set(server.url, server);
    return { guid: server.guid, url: server.url };
  },
  async stopVertexColorPublication(_context: unknown, url: string) {
    const server = vertexColorServers.get(url);
    vertexColorServers.delete(url);
    await server?.close();
  },
  async startClippingPlanes(_context: unknown) {
    const server = await startClippingPlanesServer();
    const id = server.binding.catalogUrl;
    clippingServers.set(id, server);
    return { id, binding: server.binding, guids: server.guids };
  },
  async stopClippingPlanes(_context: unknown, id: string) {
    const server = clippingServers.get(id);
    clippingServers.delete(id);
    await server?.close();
  },
  async startMaterialMrt(_context: unknown) {
    const server = await startMaterialMrtServer();
    const id = server.binding.catalogUrl;
    mrtServers.set(id, server);
    return { id, binding: server.binding, guid: server.guid };
  },
  async stopMaterialMrt(_context: unknown, id: string) {
    const server = mrtServers.get(id);
    if (server === undefined) return;
    mrtServers.delete(id);
    await server.close();
  },
  async startMaterialPublication(_context: unknown) {
    const server = await startMaterialPublicationServer();
    const id = server.binding.catalogUrl;
    servers.set(id, server);
    return { id, binding: server.binding, guids: server.guids };
  },
  async updateMaterialPublication(_context: unknown, id: string, value: 'red' | 'blue' | 'broken') {
    const server = servers.get(id);
    if (server === undefined) throw new Error('unknown material publication test host');
    await server.update(value);
  },
  async stopMaterialPublication(_context: unknown, id: string) {
    const server = servers.get(id);
    if (server === undefined) return;
    servers.delete(id);
    await server.close();
  },
  async startSurfaceMaterialPublication(_context: unknown) {
    const server = await startSurfaceMaterialPublicationServer();
    const id = server.binding.catalogUrl;
    surfaceServers.set(id, server);
    return {
      id,
      binding: server.binding,
      baseUrl: server.baseUrl,
      hmrToken: server.hmrToken,
      guid: server.guid,
    };
  },
  async updateSurfaceMaterialPublication(
    _context: unknown,
    id: string,
    value: SurfaceMaterialPublicationValue,
  ) {
    const server = surfaceServers.get(id);
    if (server === undefined) throw new Error('unknown Surface publication test host');
    await server.update(value);
  },
  async stopSurfaceMaterialPublication(_context: unknown, id: string) {
    const server = surfaceServers.get(id);
    if (server === undefined) return;
    surfaceServers.delete(id);
    await server.close();
  },
};
