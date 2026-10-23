import { IconButton, Tooltip } from '@forgeax/view-components';
import { Box, Cylinder, Globe2, Square } from 'lucide-react';
import type { MaterialPreviewMesh } from '@forgeax/view-workspace-core/contract';
import { useTranslation } from '../i18n/useTranslation';

const choices = [{ mesh: 'sphere', icon: Globe2 }, { mesh: 'cylinder', icon: Cylinder },
  { mesh: 'plane', icon: Square }, { mesh: 'cube', icon: Box }] as const;

export function MaterialPreviewMeshControls({ mesh, disabled, onChange }: {
  mesh?: MaterialPreviewMesh; disabled: boolean; onChange: (mesh: MaterialPreviewMesh) => void;
}) {
  const { t } = useTranslation();
  return <div className="fx-material-mesh-controls" role="group" aria-label={t('material.previewMesh')}>
    {choices.map(({ mesh: choice, icon: Icon }) => <Tooltip key={choice} title={t(`material.mesh.${choice}`)} placement="bottom" portaled>
      <IconButton label={t(`material.mesh.${choice}`)} title="" icon={<Icon className="fx-icon" />} size="compact"
        variant={mesh === choice ? 'primary' : 'secondary'} aria-pressed={mesh === choice}
        data-testid={`material-mesh-${choice}`} disabled={disabled} onClick={() => onChange(choice)} />
    </Tooltip>)}
  </div>;
}
