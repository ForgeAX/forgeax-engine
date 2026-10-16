import { AudioLines, Box, Camera, Clapperboard, Cloud, Layers, Lightbulb, Map, Navigation, Shield, Sparkles, Type, Users } from 'lucide-react';
import type { SceneEntityKind } from '@forgeax/view-workspace-core/scene-entity-classification';

export function InspectorTypeIcon({ kind, size = 13 }: { kind: SceneEntityKind; size?: number }) {
  const props = { size, strokeWidth: 1.7 };
  if (kind === 'camera') return <Camera {...props} />;
  if (['directionalLight', 'pointLight', 'spotLight', 'areaLight', 'skylight'].includes(kind)) return <Lightbulb {...props} />;
  if (['sky', 'fog'].includes(kind)) return <Cloud {...props} />;
  if (kind === 'audio') return <AudioLines {...props} />;
  if (kind === 'video' || kind === 'animation') return <Clapperboard {...props} />;
  if (kind === 'vfx' || kind === 'postProcess') return <Sparkles {...props} />;
  if (kind === 'physics') return <Shield {...props} />;
  if (kind === 'navigation') return <Navigation {...props} />;
  if (kind === 'npc') return <Users {...props} />;
  if (kind === 'text') return <Type {...props} />;
  if (kind === 'terrain' || kind === 'tilemap') return <Map {...props} />;
  if (kind === 'sceneInstance' || kind === 'instancedMesh') return <Layers {...props} />;
  return <Box {...props} />;
}
