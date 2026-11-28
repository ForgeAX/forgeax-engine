import { CLOUD_MODE_ACTIONS, CLOUD_MODES, CLOUD_RENDER_ACTIONS, CLOUD_TEXTURE_SETS, isSampledCloudMode } from '../cloud-controls.ts';
import {
  FORGEAX_FRAME_COMPLETED_EVENT, subscribeBrowserFrameSubmitted, type BrowserFrameCompleted,
} from '@forgeax/engine/app';
import type { Plugin } from '@forgeax/engine/plugin';
import { mountUi, uiAssetContribution } from '@forgeax/engine/ui';
import { readSunFields, type SunFields } from '../sun-controls.ts';
import {
  isRecord, observeCloudRenderer, unavailableParameter, validateCloudEdit, type CloudEdit, type CloudMode, type CloudRenderEvidence,
} from '../cloud-controls.ts';
import { cloudParameterLabels, cookedParameterLabels, type CloudParameterKey } from '../parameter-labels.ts';

type FrameIdentity = Pick<BrowserFrameCompleted, 'frameId' | 'deviceGeneration' | 'worldIdentity' | 'presentation'>;

/** Counts notifications, not the differences between renderer sequence IDs. */
export function completedFrameStats() {
  let last: FrameIdentity | undefined;
  const retiredWorlds = new Set<string | undefined>();
  let count = 0;
  let start = 0;
  let startCount = 0;
  let fps: number | undefined;
  return {
    accept(frame: FrameIdentity, now: number) {
      if (frame.presentation !== 'ready' || !Number.isFinite(now) || retiredWorlds.has(frame.worldIdentity)) return;
      const sameWorld = last?.worldIdentity === frame.worldIdentity;
      if (last && !sameWorld) retiredWorlds.add(last.worldIdentity);
      if (last && sameWorld && (frame.deviceGeneration < last.deviceGeneration ||
        (frame.deviceGeneration === last.deviceGeneration && frame.frameId <= last.frameId))) return;
      if (!last || !sameWorld || frame.deviceGeneration !== last.deviceGeneration) {
        count = 0;
        start = now;
        startCount = 1;
        fps = undefined;
      }
      last = frame;
      count++;
      const elapsed = now - start;
      if (elapsed >= 500) {
        fps = (count - startCount) * 1000 / elapsed;
        start = now;
        startCount = count;
      }
      return { count, fps };
    },
  };
}

const CHANNEL = 'vc-ue5/ground';

export const frontend: Plugin.Object<{ readonly hud: string }> = {
  name: 'vc-ue5/hud',
  inject: ['assets', 'gameHost'],
  async apply(ctx, config) {
    const { assets, gameHost } = ctx;
    const root = gameHost?.uiRoot;
    if (!assets || !root) throw new Error('界面需要应用显示宿主与资产服务。');
    const port = gameHost.presentationPort ?? gameHost.port;
    await ctx.effect(async function* () {
      const decoder = assets.installDecoder(uiAssetContribution.kind, uiAssetContribution.decoder);
      yield () => decoder.dispose();
      const loaded = (await assets.load(config.hud, uiAssetContribution.kind)).unwrap();
      yield () => assets.release(loaded).unwrap();
      let dispatch = (_action: string, _event: Event) => {};
      const mounted = mountUi(assets.read(loaded).unwrap(), { root, layer: 50, onAction: (action, event) => dispatch(action, event) });
      if (!mounted.ok) throw mounted.error;
      const ui = mounted.value;
      yield () => ui.dispose();

      const part = (key: string) => ui.host.shadowRoot?.querySelector<HTMLElement>(`[data-ui-part="${key}"]`);
      const frameLabel = part('frame');
      const fpsLabel = part('fps');
      const fixtureButton = part('fixture');
      const cloudStatus = part('cloud-status');
      const snapshotJson = part('snapshot-json') as HTMLTextAreaElement | undefined;
      const snapshotStatus = part('snapshot-status');
      const doc = root.ownerDocument;
      const storageKey = 'vc-ue5.cloud.snapshot.v1';
      try {
        if (snapshotJson) snapshotJson.value = doc.defaultView?.localStorage.getItem(storageKey) ?? '';
      } catch { /* JSON remains available for manual export. */ }
      const fields = new Map<CloudParameterKey, {
        input: HTMLInputElement | HTMLSelectElement;
        label: HTMLElement;
        condition: HTMLElement;
      }>();
      const pending = new Set<CloudParameterKey>();
      const submitted = new Map<CloudParameterKey, { requestId: number; value: number | boolean }>();
      const options: Partial<Record<CloudParameterKey, readonly string[]>> = {
        shadowMode: ['二级光路', 'Beer 阴影图'],
        atmosphereTransmittanceMode: ['地面全局照度', '逐样点透射'],
      };
      const installFields = () => {
        for (const key of Object.keys(cloudParameterLabels) as CloudParameterKey[]) {
          const meta = cloudParameterLabels[key];
          if (key === 'sunElevation' || key === 'sunAzimuth') continue;
          const group = part(`group-${meta.group}`);
          if (!group) continue;
          const label = doc.createElement('label');
          label.className = meta.kind === 'boolean' ? 'property-row cloud-check' : 'property-row';
          label.title = `${meta.ue} · ${meta.owner}`;
          const name = doc.createElement('span');
          name.textContent = meta.label + (meta.unit && meta.unit !== 'ratio' && meta.unit !== 'enum' ? `（${meta.unit}）` : '');
          const condition = doc.createElement('small');
          const values = options[key];
          let input: HTMLInputElement | HTMLSelectElement;
          if (values) {
            const select = doc.createElement('select');
            values.forEach((text, index) => {
              const option = doc.createElement('option');
              option.value = String(index);
              option.textContent = text;
              select.append(option);
            });
            input = select;
          } else {
            const field = doc.createElement('input');
            field.type = meta.kind === 'boolean' ? 'checkbox' : 'number';
            if (meta.kind === 'number') {
              field.min = String(meta.min);
              field.max = String(meta.max);
              field.step = meta.integer ? '1' : 'any';
            }
            input = field;
          }
          input.dataset.uiPart = meta.part;
          input.setAttribute('aria-label', name.textContent);
          input.addEventListener('input', () => onFieldInput(key));
          label.append(name, input, condition);
          group.append(label);
          fields.set(key, { input, label, condition });
        }
      };
      const readField = (key: CloudParameterKey, control: HTMLInputElement | HTMLSelectElement) => {
        const meta = cloudParameterLabels[key];
        return meta.kind === 'boolean' ? (control as HTMLInputElement).checked
          : control.value === '' ? NaN : Number(control.value);
      };
      let layerMode: CloudMode = 'shape';
      let lastFields: CloudEdit = {};
      const updateConditions = () => {
        const draft = { ...lastFields, ...Object.fromEntries([...pending].flatMap(key => {
          const value = readField(key, fields.get(key)!.input);
          return 'edit' in validateCloudEdit({ [key]: value }) ? [[key, value]] : [];
        })) };
        for (const [key, { input, label, condition }] of fields) {
          const reason = unavailableParameter(key, layerMode, draft);
          input.disabled = reason !== undefined;
          label.classList.toggle('field-inactive', reason !== undefined);
          condition.textContent = reason ?? '';
          condition.hidden = reason === undefined;
          if (reason) input.title = reason;
          else input.removeAttribute('title');
        }
      };
      const solarInputs = {
        sunElevation: part('sun-elevation') as HTMLInputElement | undefined,
        sunAzimuth: part('sun-azimuth') as HTMLInputElement | undefined,
      };
      const solarNumbers = {
        sunElevation: part('sun-elevation-number') as HTMLInputElement | undefined,
        sunAzimuth: part('sun-azimuth-number') as HTMLInputElement | undefined,
      };
      const solarDrafts = new Set<HTMLInputElement>();
      let solarRequest = 0;
      let solarAcknowledged = 0;
      let cloudRequest = 0;
      let cloudAcknowledged = 0;
      let handledSnapshotId: number | undefined;
      let latestReady: BrowserFrameCompleted | undefined;
      const projectedFrame = () => latestReady && {
        frameId: latestReady.frameId, deviceGeneration: latestReady.deviceGeneration, worldIdentity: latestReady.worldIdentity ?? null,
      };
      const request = (action: string, payload: object = {}) => {
        if (['cloud-preset', 'cloud-reset', 'cloud-snapshot-load', 'daytime-toggle', 'daytime-play', 'daytime-jump',
          ...CLOUD_RENDER_ACTIONS].includes(action)) {
          pending.clear();
          submitted.clear();
        }
        const requestId = ++cloudRequest;
        port?.postMessage({ channel: CHANNEL, action, requestId, ...payload });
        if (cloudStatus) {
          cloudStatus.textContent = '更新中';
          cloudStatus.dataset.state = 'pending';
        }
        return requestId;
      };
      const validateDrafts = () => {
        let error: string | undefined;
        for (const [key, { input }] of fields) {
          const invalid = pending.has(key) && !input.disabled &&
            !('edit' in validateCloudEdit({ [key]: readField(key, input) }));
          input.setAttribute('aria-invalid', String(invalid));
          if (invalid) error ??= `${cloudParameterLabels[key].label}：参数须在允许范围内。`;
        }
        if (error && cloudStatus) {
          cloudStatus.textContent = error;
          cloudStatus.dataset.state = 'invalid';
        }
      };
      const onFieldInput = (key: CloudParameterKey) => {
        pending.add(key);
        updateConditions();
        const control = fields.get(key)!.input;
        if (!control.disabled && 'edit' in validateCloudEdit({ [key]: readField(key, control) })) {
          const value = readField(key, control);
          const requestId = request('cloud-update', { fields: { [key]: value } });
          submitted.set(key, { requestId, value });
        }
        validateDrafts();
      };
      installFields();
      const showSun = (sun: SunFields) => {
        for (const key of ['sunElevation', 'sunAzimuth'] as const) {
          const control = solarInputs[key];
          const value = sun[key];
          if (control) {
            control.value = String(value);
            control.setAttribute('aria-valuetext', `${value.toFixed(2)} 度`);
          }
          const number = solarNumbers[key];
          if (number && !solarDrafts.has(number)) number.value = String(Number(value.toFixed(6)));
        }
      };
      const currentSunInputs = () => ({
        sunElevation: solarInputs.sunElevation?.valueAsNumber,
        sunAzimuth: solarInputs.sunAzimuth?.valueAsNumber,
      });
      const submitSun = (sun: SunFields) => {
        showSun(sun);
        port?.postMessage({ channel: CHANNEL, action: 'sun-update', sun, requestId: ++solarRequest });
      };
      const onSunInput = () => {
        const sun = readSunFields(currentSunInputs());
        if (sun) submitSun(sun);
      };
      for (const key of ['sunElevation', 'sunAzimuth'] as const) {
        const slider = solarInputs[key];
        const number = solarNumbers[key];
        if (!slider || !number) continue;
        const editNumber = () => solarDrafts.add(number);
        const commitNumber = () => {
          if (!solarDrafts.delete(number)) return;
          const sun = readSunFields({ ...currentSunInputs(), [key]: number.valueAsNumber });
          if (sun) submitSun(sun);
          else number.value = String(Number(slider.valueAsNumber.toFixed(6)));
        };
        const onNumberKey = (event: KeyboardEvent) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          number.blur();
        };
        slider.addEventListener('input', onSunInput);
        number.addEventListener('input', editNumber);
        number.addEventListener('blur', commitNumber);
        number.addEventListener('keydown', onNumberKey);
        yield () => {
          slider.removeEventListener('input', onSunInput);
          number.removeEventListener('input', editNumber);
          number.removeEventListener('blur', commitNumber);
          number.removeEventListener('keydown', onNumberKey);
        };
      }
      dispatch = (action, event) => {
        if (action === 'cloud-initialize') {
          const time = fields.get('referenceTimeSeconds');
          request(action, { value: time && readField('referenceTimeSeconds', time.input) });
        } else if (action === 'cloud-preset') {
          const clicked = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-preset]');
          request(action, { preset: clicked?.dataset.preset });
        } else if (action === 'daytime-speed') {
          const clicked = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-speed]');
          request(action, { speed: Number(clicked?.dataset.speed) });
        } else if (action === 'daytime-jump') {
          const clicked = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-stage]');
          request(action, { stage: clicked?.dataset.stage });
        } else if (action === 'daytime-toggle' || action === 'daytime-play') {
          request(action);
        } else if (action === 'cloud-snapshot-load') {
          let snapshot: unknown;
          try { snapshot = JSON.parse(snapshotJson?.value ?? ''); } catch { snapshot = null; }
          request(action, { snapshot });
        } else if (['cloud-pause', 'cloud-reset', 'cloud-snapshot-save', ...CLOUD_MODE_ACTIONS].includes(action)) {
          request(action, action === 'cloud-snapshot-save' ? { frame: projectedFrame() } : {});
        } else if (action === 'shadow-comparison') {
          port?.postMessage({ channel: CHANNEL, action, sunRequestId: solarRequest });
        } else if (['reset', 'fixture', 'route', 'cut', 'camera-shadow', 'camera-ground-shadow',
          'cloud-view-normal', 'cloud-view-transmittance', 'cloud-view-contour'].includes(action)) {
          port?.postMessage({ channel: CHANNEL, action });
        }
      };
      const stats = completedFrameStats();
      let acceptTimingEpoch = () => {};
      const accept = (frame: BrowserFrameCompleted) => {
        const sample = stats.accept(frame, performance.now());
        if (!sample) return;
        const previous = latestReady;
        latestReady = frame;
        if (previous && (previous.worldIdentity !== frame.worldIdentity || previous.deviceGeneration !== frame.deviceGeneration)) {
          acceptTimingEpoch();
        }
        if (frameLabel) {
          frameLabel.textContent = `#${frame.frameId}`;
          frameLabel.dataset.count = String(sample.count);
          frameLabel.dataset.deviceGeneration = String(frame.deviceGeneration);
          frameLabel.dataset.worldIdentity = frame.worldIdentity ?? '';
        }
        if (fpsLabel) fpsLabel.textContent = sample.fps === undefined ? '预热中' : sample.fps.toFixed(1);
      };
      const onFrame = (event: Event) => {
        const canvas = gameHost.canvas;
        if (event.composedPath()[0] === canvas) accept((event as CustomEvent<BrowserFrameCompleted>).detail);
      };
      const onContextMenu = (event: Event) => {
        if (event.composedPath()[0] === gameHost.canvas) event.preventDefault();
      };
      doc.addEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onFrame, true);
      doc.addEventListener('contextmenu', onContextMenu, true);
      yield () => {
        doc.removeEventListener(FORGEAX_FRAME_COMPLETED_EVENT, onFrame, true);
        doc.removeEventListener('contextmenu', onContextMenu, true);
      };
      const canvas = gameHost.canvas;
      if (canvas instanceof HTMLCanvasElement && canvas.forgeaxFrameProgress?.completed) {
        accept(canvas.forgeaxFrameProgress.completed);
      }

      const write = (key: string, value: string) => {
        const output = part(key);
        if (output && output.textContent !== value) output.textContent = value;
      };
      const timingRows = {
        cpu: part('cpu-frame'), frame: part('gpu-frame'), p50: part('gpu-p50'),
        sky: part('gpu'), cloud: part('cloud-budget'), passes: part('gpu-raw'),
      };
      const passDetails = part('gpu-details') as HTMLDetailsElement | undefined;
      const passList = part('gpu-passes');
      const statuses: Record<string, string> = {
        'warming-up': '预热中', 'no-data': '无数据', unavailable: '不可用', failed: '查询失败',
      };
      const timingStatus = (status: string) => statuses[status] ?? '无数据';
      let shownObservation: NonNullable<CloudRenderEvidence['gpu']['raw']>['observation'] | undefined;
      const writeTimingRow = (
        output: HTMLElement | null | undefined,
        sourceFrame: CloudRenderEvidence['gpu']['sourceFrame'],
        status: string,
        text: string,
        reason?: string | null,
      ) => {
        if (!output) return;
        const display = sourceFrame ? `${text} · #${sourceFrame.frameId}` : text;
        if (output.textContent !== display) output.textContent = display;
        output.dataset.status = status;
        output.dataset.frameId = sourceFrame ? String(sourceFrame.frameId) : '';
        output.dataset.worldIdentity = sourceFrame?.worldIdentity ?? '';
        output.dataset.deviceGeneration = sourceFrame ? String(sourceFrame.deviceGeneration) : '';
        output.dataset.graphGeneration = sourceFrame?.graphGeneration == null ? '' : String(sourceFrame.graphGeneration);
        output.title = reason ?? '';
      };
      const showRawTiming = (gpu: CloudRenderEvidence['gpu']) => {
        const { sourceFrame } = gpu;
        const observation = gpu.raw?.observation;
        const timed = observation && 'frame' in observation ? observation.frame : undefined;
        const rawReason = observation && 'reason' in observation ? observation.reason.code
          : observation?.status === 'failed' ? observation.error.code : gpu.raw?.reason;
        writeTimingRow(timingRows.passes, sourceFrame, gpu.rawStatus, timed
          ? `${timed.measuredPassCount}/${timed.executedPassCount} 个` : timingStatus(gpu.rawStatus), rawReason);
        if (passDetails) passDetails.hidden = !timed;
        if (passList && observation !== shownObservation) {
          shownObservation = observation;
          passList.replaceChildren(...(timed?.passes ?? []).map(pass => {
            const entry = doc.createElement('li');
            entry.dataset.passIndex = String(pass.executionIndex);
            entry.dataset.status = pass.status;
            const view = pass.viewId === undefined ? '' : `（视图 ${pass.viewId}）`;
            entry.textContent = `${pass.passName}${view}：${pass.status === 'measured'
              ? `${(pass.durationNanoseconds / 1e6).toFixed(3)} ms` : '未测量'}`;
            if (pass.status === 'unmeasured') entry.title = pass.reason.code;
            return entry;
          }));
        }
      };
      const showEvidence = (value: CloudRenderEvidence) => {
        const { gpu, renderer } = value;
        const { sourceFrame, completeSky, cloudBudget, frameTiming } = gpu;
        writeTimingRow(timingRows.frame, sourceFrame, frameTiming.status,
          frameTiming.milliseconds === null ? timingStatus(frameTiming.status) : `${frameTiming.milliseconds.toFixed(2)} ms`,
          frameTiming.reason ?? '此帧最早 GPU Pass 开始至最晚 GPU Pass 结束');
        writeTimingRow(timingRows.p50, sourceFrame, frameTiming.status,
          frameTiming.p50Milliseconds === null ? timingStatus(frameTiming.status) : `${frameTiming.p50Milliseconds.toFixed(2)} ms`,
          frameTiming.reason ?? `最近 ${frameTiming.sampleCount} 个有效 GPU 样本的中位数`);
        writeTimingRow(timingRows.sky, sourceFrame, completeSky.status,
          completeSky.status === 'ready' ? `${completeSky.milliseconds.toFixed(2)} ms` : timingStatus(completeSky.status),
          completeSky.status === 'ready' ? `天空 Pass 时间区间并集 · ${completeSky.passCount} 个 Pass` : completeSky.reason);
        writeTimingRow(timingRows.cloud, sourceFrame, cloudBudget.status, cloudBudget.p95GpuMs !== null
          ? `P95 ${cloudBudget.p95GpuMs.toFixed(2)} ms` : cloudBudget.status === 'warming-up' && cloudBudget.sampleCount > 0
            ? `预热中 ${cloudBudget.sampleCount}/${cloudBudget.minimumSamples}` : timingStatus(cloudBudget.status),
          cloudBudget.status === 'ready' ? `${cloudBudget.sampleCount} 个有效云帧 · #${cloudBudget.firstFrameId} 至 #${sourceFrame?.frameId}`
            : cloudBudget.reason);
        showRawTiming(gpu);
        const layer: unknown = renderer.layer;
        const mode0 = isRecord(layer) && isRecord(layer.mode0) ? layer.mode0 : undefined;
        write('adoption', mode0 ? `Mode 0 #${mode0.acceptedFrame ?? '—'}；逐字段不可用` : '逐字段不可用');
        write('history', mode0 ? `${mode0.historyValid ? '有效' : '未建立'} · phase ${mode0.acceptedPhase ?? '—'}` : '无公开帧事实');
        const history = part('history');
        if (history) history.title = mode0 ? JSON.stringify(mode0.resetReasons) : '';
      };
      const renderer = gameHost.renderer ?? ('renderer' in gameHost.app ? gameHost.app.renderer : undefined);
      const rendering = observeCloudRenderer(renderer, undefined, reason => {
        const status = reason === 'epoch-changed' ? 'warming-up' : 'unavailable';
        for (const output of Object.values(timingRows)) writeTimingRow(output, null, status, timingStatus(status), reason);
        if (passDetails) passDetails.hidden = true;
        shownObservation = undefined;
        passList?.replaceChildren();
      });
      acceptTimingEpoch = () => {
        const frame = projectedFrame();
        if (frame) rendering.acceptCompletedEpoch(frame);
      };
      const stopSubmitted = canvas instanceof HTMLCanvasElement ? subscribeBrowserFrameSubmitted(canvas, rendering.submit) : undefined;
      const publishEvidence = () => {
        const frame = projectedFrame() ?? null;
        const evidence = rendering.read(frame);
        showEvidence(evidence);
        const activeCanvas = gameHost.canvas;
        const submitted = activeCanvas instanceof HTMLCanvasElement ? activeCanvas.forgeaxFrameProgress?.submitted : undefined;
        const cpuMs = submitted?.renderDrawCpuMs;
        if (frame && submitted && cpuMs !== undefined && Number.isFinite(cpuMs) && cpuMs >= 0 &&
          (renderer === undefined || renderer.state() === 'alive') &&
          submitted.worldIdentity === frame.worldIdentity && submitted.deviceGeneration === frame.deviceGeneration) {
          writeTimingRow(timingRows.cpu, { ...submitted, worldIdentity: frame.worldIdentity, graphGeneration: submitted.graphGeneration ?? null },
            'ready', `${cpuMs.toFixed(2)} ms`, 'CPU 执行单帧渲染的耗时');
        } else {
          const status = !frame ? 'warming-up' : 'unavailable';
          writeTimingRow(timingRows.cpu, null, status, timingStatus(status));
        }
        port?.postMessage({ channel: CHANNEL, action: 'cloud-evidence', frame, evidence });
      };
      publishEvidence();
      const evidencePoll = doc.defaultView?.setInterval(publishEvidence, 500);
      yield () => {
        if (evidencePoll !== undefined) doc.defaultView?.clearInterval(evidencePoll);
        stopSubmitted?.();
        rendering.dispose();
      };

      let lastMaterial = '';
      const showMaterial = (cloud: Record<string, unknown>) => {
        const list = part('material-source');
        if (!list) return;
        const authoring = isRecord(cloud.authoring) ? cloud.authoring : {};
        const defaults = isRecord(authoring.defaults) ? authoring.defaults : {};
        const overrides = isRecord(authoring.instanceOverrides) ? authoring.instanceOverrides : {};
        const entries: [string, unknown][] = [
          ['材质 GUID', cloud.materialGuid], ['继承实例 GUID', cloud.instanceGuid ?? '无'],
          ['Cook 选择的程序', cloud.programIdentity ?? '解析材质'], ['Cook 标识', cloud.cookIdentity],
          ['来源', isRecord(authoring.materialPublication) ? authoring.materialPublication.sourcePath ?? '—' : '—'],
          ...Object.entries(defaults).map(([key, value]): [string, unknown] => [
            cookedParameterLabels[key] ?? cloudParameterLabels[key as CloudParameterKey]?.ue ?? key,
            Object.hasOwn(overrides, key) ? `${JSON.stringify(value)} → 实例 ${JSON.stringify(overrides[key])}` : value,
          ]),
        ];
        const serialized = JSON.stringify(entries);
        if (serialized === lastMaterial) return;
        lastMaterial = serialized;
        list.replaceChildren(...entries.map(([key, value]) => {
          const row = doc.createElement('div');
          const name = doc.createElement('dt');
          const fact = doc.createElement('dd');
          name.textContent = key;
          fact.textContent = typeof value === 'string' ? value : JSON.stringify(value);
          row.append(name, fact);
          return row;
        }));
      };
      const showDaytimeControls = (value: unknown) => {
        const daytime = isRecord(value) ? value : undefined;
        const daytimeActive = daytime?.active === true;
        const daytimePlaying = daytime?.playing === true;
        const daytimeCompleted = daytime?.completed === true;
        part('daytime-toggle')?.setAttribute('aria-pressed', String(daytimeActive));
        const playButton = part('daytime-play') as HTMLButtonElement | undefined;
        if (playButton) {
          playButton.disabled = !daytimeActive;
          playButton.setAttribute('aria-pressed', String(daytimePlaying));
          playButton.textContent = daytimeCompleted ? '重播' : daytimePlaying ? '暂停' : '继续';
        }
        const stage = isRecord(daytime?.stage) ? daytime.stage : undefined;
        const elevation = typeof daytime?.elevation === 'number' ? daytime.elevation : undefined;
        const progress = typeof stage?.progress === 'number' ? Math.round(stage.progress * 100) : 0;
        write('daytime-stage', daytimeActive && typeof stage?.label === 'string' && elevation !== undefined
          ? `${stage.label}（${elevation.toFixed(1)}° · ${daytimeCompleted ? '已到终点' : `${progress}%`}）`
          : '未开启 · 默认 UE 原纹理');
        for (const button of ui.host.shadowRoot?.querySelectorAll<HTMLElement>('[data-ui-action="daytime-speed"]') ?? []) {
          button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === daytime?.speed));
        }
        for (const button of ui.host.shadowRoot?.querySelectorAll<HTMLElement>('[data-ui-action="daytime-jump"]') ?? []) {
          const activeStage = daytimeActive && stage?.transitioning !== true && button.dataset.stage === stage?.id;
          button.setAttribute('aria-pressed', String(activeStage));
        }
      };
      const showCloudControls = (cloud: Record<string, unknown>) => {
        part('route')?.setAttribute('aria-pressed', String(cloud.routeRunning === true));
        part('camera-ground')?.setAttribute('aria-pressed', String(cloud.cameraView === 'ground'));
        part('camera-shadow')?.setAttribute('aria-pressed', String(cloud.cameraView === 'shadow'));
        part('camera-ground-shadow')?.setAttribute('aria-pressed', String(cloud.cameraView === 'ground-shadow'));
        for (const button of ui.host.shadowRoot?.querySelectorAll<HTMLElement>('[data-preset]') ?? []) {
          const selected = button.hasAttribute('data-quality') ? cloud.qualityPreset : cloud.preset;
          button.setAttribute('aria-pressed', String(selected === button.dataset.preset));
        }
        const pause = part('clock-pause');
        pause?.setAttribute('aria-pressed', String(cloud.paused === true));
        write('clock-pause', cloud.paused === true ? '继续' : '暂停');
        showDaytimeControls(cloud.daytime);
        const sampled = isSampledCloudMode(cloud.mode);
        part('cloud-textured')?.setAttribute('aria-pressed', String(sampled));
        for (const mode of ['off', ...CLOUD_MODES])
          part(`cloud-${mode}`)?.setAttribute('aria-pressed', String(cloud.mode === mode));
        for (const set of CLOUD_TEXTURE_SETS) {
          const button = part(`cloud-${set}`) as HTMLButtonElement | undefined;
          if (button) button.disabled = !sampled;
        }
        for (const mode of ['normal', 'transmittance', 'contour']) {
          const button = part(`cloud-view-${mode}`) as HTMLButtonElement | undefined;
          button?.setAttribute('aria-pressed', String(cloud.viewMode === mode));
          if (button) button.disabled = !sampled;
        }
      };
      const showCloudFields = (cloud: Record<string, unknown>, ack: Record<string, unknown> | undefined) => {
        layerMode = cloud.mode as CloudMode;
        lastFields = Object.fromEntries([...fields.keys()].map(key => [key, cloud[key]]));
        for (const [key, { input }] of fields) {
          const value = cloud[key];
          const sent = submitted.get(key);
          // Match the submitted draft, since ECS f32 values can round on readback.
          if (sent && ack?.status === 'cpu-applied' && typeof ack.clientId === 'number' &&
            ack.clientId >= sent.requestId && readField(key, input) === sent.value) {
            pending.delete(key);
            submitted.delete(key);
          }
          if (pending.has(key) || ui.host.shadowRoot?.activeElement === input) continue;
          if (cloudParameterLabels[key].kind === 'boolean') (input as HTMLInputElement).checked = value === true;
          else input.value = typeof value === 'number' ? String(Number(value.toPrecision(8))) : '';
        }
        updateConditions();
      };
      const showSnapshot = (cloud: Record<string, unknown>, ack: Record<string, unknown> | undefined) => {
        const isNewSnapshotAck = ack && typeof ack.id === 'number' && handledSnapshotId !== ack.id &&
          (ack.action === 'cloud-snapshot-save' || ack.action === 'cloud-snapshot-load');
        if (isNewSnapshotAck && typeof ack.id === 'number') handledSnapshotId = ack.id;
        if (isNewSnapshotAck && ack.action === 'cloud-snapshot-save' && ack.status === 'cpu-applied' && isRecord(cloud.snapshot) && snapshotJson) {
          snapshotJson.value = JSON.stringify(cloud.snapshot, null, 2);
          try { doc.defaultView?.localStorage.setItem(storageKey, snapshotJson.value); } catch { /* Export can still be copied. */ }
          if (snapshotStatus) {
            const frame = isRecord(cloud.snapshot.frame) ? cloud.snapshot.frame : undefined;
            snapshotStatus.textContent = `快照 v1 · ${frame ? `完成帧 #${frame.frameId}` : '无公开完成帧'}`;
          }
        }
        if (isNewSnapshotAck && ack.action === 'cloud-snapshot-load' && snapshotStatus) snapshotStatus.textContent =
          ack.status === 'rejected' ? String(ack.reason) : '已加载快照 v1。';
      };
      const showCloudStatus = (status: unknown, ack: Record<string, unknown> | undefined) => {
        if (cloudStatus) {
          cloudStatus.textContent = typeof status === 'string' ? status : '参数已应用（CPU）';
          cloudStatus.dataset.state = ack?.status === 'rejected' ? 'invalid' : 'applied';
        }
        validateDrafts();
      };
      const onState = ({ data }: MessageEvent<unknown>) => {
        if (!isRecord(data) || data.channel !== CHANNEL) return;
        if ('sun' in data) {
          const sun = readSunFields(data.sun);
          if (sun && data.requestId === solarRequest) {
            solarAcknowledged = solarRequest;
            showSun(sun);
          }
          return;
        }
        if (typeof data.fixtureVisible === 'boolean' && fixtureButton) {
          fixtureButton.setAttribute('aria-pressed', String(data.fixtureVisible));
          fixtureButton.textContent = data.fixtureVisible ? '遮挡物：开启' : '遮挡物：关闭';
        }
        if (!isRecord(data.cloud)) return;
        const cloud = data.cloud;
        const ack = isRecord(cloud.request) ? cloud.request : undefined;
        if (cloudAcknowledged < cloudRequest) {
          if (!ack || ack.clientId !== cloudRequest) return;
          cloudAcknowledged = cloudRequest;
        }
        const solar = readSunFields(cloud);
        if (solar && solarAcknowledged === solarRequest) showSun(solar);
        showCloudControls(cloud);
        showCloudFields(cloud, ack);
        showCloudStatus(data.cloudStatus, ack);
        write('request', ack ? `#${ack.id} ${ack.status === 'rejected' ? '已拒绝' : 'CPU 已处理'}` : '初始配置');
        showSnapshot(cloud, ack);
        showMaterial(cloud);
      };
      port?.addEventListener('message', onState);
      port?.start();
      port?.postMessage({ channel: CHANNEL, action: 'cloud-read' });
      yield () => port?.removeEventListener('message', onState);
    });
  },
};
