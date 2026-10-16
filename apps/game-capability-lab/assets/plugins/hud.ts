import { mountUi, type UiAsset, type UiError, type UiInstance } from '@forgeax/engine-ui';
import { AssetGuid, PackageId } from '@forgeax/engine-pack/guid';
import type { AssetLabAction, AssetLabActionResult } from './asset-lab-actions';
import type { GameplayPhase } from './gameplay-state';
import { GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE } from './resources/gameplay';
import type { TargetRelaySnapshot } from './target-relay';
import type { EnergyCoreExtractionSnapshot } from './energy-core-extraction';
import type { RewardChoiceSnapshot } from './reward-choice';
import { deriveCounterattackPressure, PLAYER_MAX_HEALTH } from './counterattack';
import type { LightingModeName } from './components/gameplay';

export type ViewMode = 'topdown' | 'orbit' | 'fps' | 'pan';
const HUD_UI_PACKAGE_NAMESPACE = (() => {
  const parsed = PackageId.parse('019fb264-1000-7000-8000-000000000040');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();
export const HUD_UI_GUID = AssetGuid.format(AssetGuid.derive(HUD_UI_PACKAGE_NAMESPACE, 'ui/hud'));

export interface HudHandle {
  readonly error?: UiError;
  setScore(n: number): void;
  setHealth(current: number, max: number): void;
  setPhase(phase: GameplayPhase): void;
  setTargetProfileActive(active: boolean, precisionHits?: number): void;
  setTargetRelay(snapshot: TargetRelaySnapshot): void;
  setExtraction(snapshot: EnergyCoreExtractionSnapshot): void;
  setRewardChoice(snapshot: RewardChoiceSnapshot): void;
  setTargetStatus(text: string, state: 'ready' | 'damaged' | 'disabled'): void;
  setChargeStatus(text: string, state: 'ready' | 'charging' | 'released', progress?: number): void;
  setComboStatus(text: string, state: 'ready' | 'active' | 'expired'): void;
  setLightingMode(mode: LightingModeName): void;
  setAssetLabStatus(text: string, state: AssetLabActionResult['state'] | 'idle'): void;
  setAssetLabActionHandler(handler: (action: AssetLabAction) => AssetLabActionResult): void;
  setMode(mode: ViewMode): void;
  setLockStatus(text: string): void;
  floatScore(text: string, screenX: number, screenY: number): void;
  resetTransientFeedback(): void;
  dispose(): void;
}

function failedHud(error: UiError): HudHandle {
  return { error, setScore() {}, setHealth() {}, setPhase() {}, setTargetProfileActive() {}, setTargetRelay() {}, setExtraction() {}, setRewardChoice() {}, setTargetStatus() {}, setChargeStatus() {}, setComboStatus() {}, setLightingMode() {}, setAssetLabStatus() {}, setAssetLabActionHandler() {}, setMode() {}, setLockStatus() {}, floatScore() {}, resetTransientFeedback() {}, dispose() {} };
}

function slot<T extends HTMLElement>(shadow: ShadowRoot, name: string): T | null {
  return shadow.querySelector<T>(`[data-ui-slot="${name}"]`);
}

export function installHud(opts: {
  asset: UiAsset | null;
  initialMode: ViewMode;
  onToggle: () => void;
  onSettings?: () => void;
  host?: HTMLElement;
  error?: UiError;
}): HudHandle {
  if (!opts.asset) return failedHud(opts.error ?? { code: 'invalid-asset', expected: 'a loaded HUD UiAsset', hint: 'Load the HUD UI asset before installing it.', detail: { message: 'HUD asset is missing', asset: 'HUD UiAsset' } });
  const root = opts.host ?? document.body;
  let assetLabActionHandler: ((action: AssetLabAction) => AssetLabActionResult) | undefined;
  let currentPhase: GameplayPhase = 'Play';
  const mounted = mountUi(opts.asset, {
    root,
    layer: 50,
    onAction: (action) => {
      if (action === 'toggle-mode') opts.onToggle();
      if (action === 'open-settings') opts.onSettings?.();
      if (action === 'target-profile' || action === 'jpeg-texture' || action === 'video-texture' || action === 'sprite-atlas' || action === 'font-source' || action === 'fbx-companion') {
        if (currentPhase !== 'Play') return;
        const result = assetLabActionHandler?.(action);
        if (result !== undefined) setAssetLabStatus(result.text, result.state);
      }
    },
  });
  if (!mounted.ok) {
    return failedHud(mounted.error);
  }
  const instance: UiInstance = mounted.value;
  const shadow = instance.host.shadowRoot;
  if (!shadow) return { ...failedHud({ code: 'invalid-asset', expected: 'a mounted UI with an open shadow root', hint: 'Check the HUD UI asset markup.', detail: { message: 'Mounted HUD has no shadow root', asset: 'mounted HUD' } }), dispose: instance.dispose };
  const score = slot<HTMLElement>(shadow, 'score');
  const health = slot<HTMLElement>(shadow, 'health');
  const mission = slot<HTMLElement>(shadow, 'mission');
  const targetStatus = slot<HTMLElement>(shadow, 'target-status');
  const chargeStatus = slot<HTMLElement>(shadow, 'charge');
  const chargeLabel = chargeStatus?.querySelector<HTMLElement>('[data-ui-slot="charge-label"]') ?? chargeStatus;
  const chargeMeter = chargeStatus?.querySelector<HTMLElement>('[data-ui-slot="charge-meter"]');
  const chargeFill = chargeStatus?.querySelector<HTMLElement>('[data-ui-slot="charge-fill"]');
  const comboStatus = slot<HTMLElement>(shadow, 'combo');
  const lightingMode = slot<HTMLElement>(shadow, 'lighting-mode') ?? (() => {
    // The canonical HUD pack is a single cooked JSON payload, so this keeps
    // copied packs with no lighting slot equally observable without a second
    // HUD owner or a settings ledger.
    const fallback = document.createElement('aside');
    fallback.dataset.uiSlot = 'lighting-mode';
    Object.assign(fallback.style, {
      position: 'absolute',
      top: '180px',
      left: '14px',
      padding: '6px 10px',
      color: '#bdefff',
      background: 'rgb(10 18 34 / 84%)',
      border: '1px solid rgb(98 214 255 / 52%)',
      borderRadius: '8px',
      fontSize: '12px',
    });
    (shadow.querySelector<HTMLElement>('.hud') ?? shadow).append(fallback);
    return fallback;
  })();
  const assetLabStatus = slot<HTMLElement>(shadow, 'asset-lab-status');
  const button = shadow.querySelector<HTMLButtonElement>('[data-ui-action="toggle-mode"]');
  const targetProfileButton = shadow.querySelector<HTMLButtonElement>('[data-ui-action="target-profile"]');
  const fbxCompanionButton = shadow.querySelector<HTMLButtonElement>('[data-ui-action="fbx-companion"]');
  const spriteAtlasButton = shadow.querySelector<HTMLButtonElement>('[data-ui-action="sprite-atlas"]');
  const assetButtons = [...shadow.querySelectorAll<HTMLButtonElement>('.asset-control')];
  const crosshair = slot<HTMLElement>(shadow, 'crosshair');
  const hint = slot<HTMLElement>(shadow, 'hint');
  const lockStatus = slot<HTMLElement>(shadow, 'lock-status');
  const popups = slot<HTMLElement>(shadow, 'popups');
  const popupTemplate = shadow.querySelector<HTMLTemplateElement>('[data-ui-template="score-popup"]');
  let currentScore = 0;
  let targetProfileActive = false;
  let targetProfilePrecisionHits = 0;
  let targetRelay: TargetRelaySnapshot = {
    status: 'locked', currentStep: 0, cleared: 0, total: 0, activeTarget: null,
    activeTargetName: null, acceptedHits: 0, rejectedHits: 0, variationActive: false,
  };
  let extraction: Pick<EnergyCoreExtractionSnapshot, 'collected' | 'total' | 'active'> = {
    collected: 0,
    total: 3,
    active: false,
  };
  let rewardChoice: Pick<RewardChoiceSnapshot, 'state' | 'available'> = { state: 'none', available: false };
  spriteAtlasButton?.setAttribute('aria-label', 'PNG projectile');
  const applyMission = (): void => {
    const pressureTier = deriveCounterattackPressure(extraction.collected).tier;
    const profileUnlocked = currentScore >= GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE;
    const precisionComplete = targetProfileActive && targetProfilePrecisionHits > 0;
    if (mission) mission.textContent = currentPhase === 'Victory'
      ? `Victory · Final score ${currentScore} · R to replay`
      : currentPhase === 'Defeat'
        ? `Defeat · incoming attack · R to replay`
      : currentPhase === 'Reset'
        ? 'Replay reset · returning to Play'
        : currentScore < GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE
          ? `Mission 1/3 · Score ${GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE} · ${currentScore}/${GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE}`
          : !targetProfileActive
            ? 'Mission 2/3 · Press P to apply the authored target profile'
            : !precisionComplete
              ? 'Mission 3/3 · Hit the rotating precision target'
              : targetRelay.status === 'active'
                ? `Relay ${targetRelay.currentStep}/${targetRelay.total} · ${targetRelay.activeTargetName ?? 'authored target'} · hit active target`
                : targetRelay.status === 'complete' && extraction.active && rewardChoice.state === 'none'
                  ? `Reward choice · Threat ${pressureTier}/3 · enter Shield or Overcharge pedestal`
                  : targetRelay.status === 'complete' && extraction.active
                    ? `Extraction ${extraction.collected}/${extraction.total} · Threat ${pressureTier}/3 · reward ${rewardChoice.state} · return`
                  : targetRelay.status === 'complete'
                    ? `Extraction ${extraction.collected}/${extraction.total} · Threat ${pressureTier}/3 · collect EnergyCores`
                    : 'Precision confirmed · relay preparing';
    if (mission) {
      mission.dataset.complete = currentPhase === 'Victory' ? 'true' : 'false';
      mission.dataset.phase = currentPhase;
    }
    if (targetProfileButton) {
      targetProfileButton.disabled = currentPhase !== 'Play' || !profileUnlocked;
      targetProfileButton.setAttribute('aria-disabled', String(currentPhase !== 'Play' || !profileUnlocked));
      targetProfileButton.title = profileUnlocked ? 'Apply or restore the authored target profile' : `Score ${GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE} to unlock`;
    }
    if (fbxCompanionButton) {
      fbxCompanionButton.disabled = currentPhase !== 'Play' || !precisionComplete;
      fbxCompanionButton.setAttribute('aria-disabled', String(currentPhase !== 'Play' || !precisionComplete));
      fbxCompanionButton.title = precisionComplete ? 'Show the imported humanoid on the scored target' : 'Complete the precision mission first';
    }
  };
  let currentMode = opts.initialMode;
  const applyMode = (mode: ViewMode): void => {
    currentMode = mode;
    if (button) button.textContent = mode === 'topdown' ? 'View: Top-down > Orbit' : mode === 'orbit' ? 'View: Orbit > FPS' : mode === 'fps' ? 'View: FPS > Map' : 'View: Map > Top-down';
    if (crosshair) crosshair.style.display = mode === 'fps' ? 'block' : 'none';
    if (hint) hint.textContent = mode === 'fps'
      ? 'WASD move · click/F shoot · hold C charge · release · T lighting · R restart'
      : mode === 'orbit'
        ? 'WASD move · drag to orbit · click/F shoot · hold C charge · release · T lighting · R restart'
        : mode === 'pan'
          ? 'Arrows pan · wheel zoom · click/F shoot · hold C charge · release · T lighting · R restart'
          : 'WASD move · aim/click shoot · hold C charge · release · T lighting · R restart';
    if (lockStatus) lockStatus.style.display = mode === 'fps' || mode === 'orbit' ? 'block' : 'none';
  };
  const setScore = (n: number): void => {
    currentScore = n;
    if (score) score.textContent = `Score  ${n}`;
    applyMission();
  };
  const setHealth = (current: number, max: number): void => {
    if (!health) return;
    const safeMax = Math.max(0, Math.floor(max));
    const safeCurrent = Math.max(0, Math.min(safeMax, Math.floor(current)));
    health.textContent = `${'♥'.repeat(safeCurrent)}${'♡'.repeat(safeMax - safeCurrent)}`;
    health.dataset.current = String(safeCurrent);
    health.dataset.max = String(safeMax);
    health.dataset.state = safeCurrent === 0 ? 'defeated' : safeCurrent < safeMax ? 'damaged' : 'ready';
    health.setAttribute('aria-label', `Player health ${safeCurrent} of ${safeMax}`);
  };
  const setPhase = (phase: GameplayPhase): void => {
    currentPhase = phase;
    for (const assetButton of assetButtons) assetButton.disabled = phase !== 'Play';
    applyMission();
  };
  const setTargetProfileActive = (active: boolean, precisionHits = 0): void => {
    targetProfileActive = active;
    targetProfilePrecisionHits = precisionHits;
    applyMission();
  };
  const setTargetRelay = (snapshot: TargetRelaySnapshot): void => {
    targetRelay = snapshot;
    applyMission();
  };
  const setExtraction = (snapshot: EnergyCoreExtractionSnapshot): void => {
    extraction = snapshot;
    applyMission();
  };
  const setRewardChoice = (snapshot: RewardChoiceSnapshot): void => {
    rewardChoice = snapshot;
    applyMission();
  };
  const setTargetStatus = (text: string, state: 'ready' | 'damaged' | 'disabled'): void => {
    if (!targetStatus) return;
    targetStatus.textContent = text;
    targetStatus.dataset.state = state;
  };
  const setChargeStatus = (text: string, state: 'ready' | 'charging' | 'released', progress = state === 'released' ? 1 : 0): void => {
    if (chargeStatus) {
      const ratio = Math.max(0, Math.min(1, progress));
      if (chargeLabel) chargeLabel.textContent = text;
      chargeStatus.dataset.state = state;
      chargeMeter?.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      if (chargeFill) chargeFill.style.width = `${Math.round(ratio * 100)}%`;
      return;
    }
    // Older copied HUD packs have no charge slot yet. Keep the mechanic
    // discoverable through their authored hint instead of adding a DOM owner.
    if (state === 'ready') applyMode(currentMode);
    else if (hint) hint.textContent = text;
  };
  const setComboStatus = (text: string, state: 'ready' | 'active' | 'expired'): void => {
    if (!comboStatus) return;
    comboStatus.textContent = text;
    comboStatus.dataset.state = state;
  };
  const setLightingMode = (mode: LightingModeName): void => {
    if (lightingMode) {
      lightingMode.textContent = `Lighting · ${mode} · T toggle`;
      lightingMode.dataset.mode = mode.toLowerCase();
    }
  };
  const setAssetLabStatus = (text: string, state: AssetLabActionResult['state'] | 'idle'): void => {
    if (!assetLabStatus) return;
    assetLabStatus.textContent = text;
    assetLabStatus.dataset.state = state;
  };
  const setAssetLabActionHandler = (handler: (action: AssetLabAction) => AssetLabActionResult): void => {
    assetLabActionHandler = handler;
  };
  const setLockStatus = (text: string): void => { if (lockStatus) lockStatus.textContent = text; };
  const floatScore = (text: string, x: number, y: number): void => {
    if (!popups) return;
    const node = popupTemplate?.content.firstElementChild?.cloneNode(true) as HTMLElement | null;
    const popup = node ?? document.createElement('span');
    popup.textContent = text;
    popup.classList.add('score-popup');
    Object.assign(popup.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, pointerEvents: 'none' });
    popups.append(popup);
    setTimeout(() => popup.remove(), 1000);
  };
  const resetTransientFeedback = (): void => {
    popups?.replaceChildren();
  };
  setScore(0);
  setHealth(PLAYER_MAX_HEALTH, PLAYER_MAX_HEALTH);
  applyMode(opts.initialMode);
  setChargeStatus('Hold C to charge · release to fire', 'ready', 0);
  setComboStatus('Combo ready · chain hits for a bonus', 'ready');
  setLightingMode('Day');
  setLockStatus('Click canvas to lock pointer');
  setAssetLabStatus(`Score ${GAME_DEFAULT_TARGET_PROFILE_UNLOCK_SCORE} to unlock Target profile.`, 'idle');
  return { setScore, setHealth, setPhase, setTargetProfileActive, setTargetRelay, setExtraction, setRewardChoice, setTargetStatus, setChargeStatus, setComboStatus, setLightingMode, setAssetLabStatus, setAssetLabActionHandler, setMode: applyMode, setLockStatus, floatScore, resetTransientFeedback, dispose: instance.dispose };
}
