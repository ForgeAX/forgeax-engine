import { useTranslation } from '../i18n';

export function setDockTitleHidden(
  group: HTMLElement,
  hidden: boolean,
): void {
  group.dataset.fxDockTitleState = hidden ? 'hidden' : 'visible';
}

export function isDockTitleHidden(group: HTMLElement): boolean {
  return group.dataset.fxDockTitleState === 'hidden';
}

/** Apply claim default once; user toggles persist via `data-fx-dock-title-state`. */
export function applyDefaultDockTitleHidden(
  group: HTMLElement | null | undefined,
  hiddenByDefault: boolean,
): void {
  if (!group || !hiddenByDefault) return;
  if (group.dataset.fxDockTitleState !== undefined) return;
  setDockTitleHidden(group, true);
}

export function DockTitleRestoreButton() {
  const { t } = useTranslation();
  const label = t('view.dock.restoreTitleBar');
  return (
    <button
      type="button"
      className="fx-dock-title-restore"
      aria-label={label}
      title={label}
      onClick={(event) => {
        const button = event.currentTarget;
        let group = button.closest<HTMLElement>('.dv-groupview, .groupview');
        if (!group && button.closest('.fx-edge-drawer-portal-host')) {
          group = document.querySelector<HTMLElement>(
            '.fx-view-workspace-row.is-active .dv-groupview-edge.fx-edge-drawer-open',
          );
        }
        if (group) {
          setDockTitleHidden(group, false);
          const flyout = button.closest('.dv-content-container');
          if (flyout instanceof HTMLElement) flyout.setAttribute('data-fx-dock-title-state', 'visible');
        }
      }}
    />
  );
}
