import { utf8fromStringLoose, utf8toString } from '@exodus/bytes/utf8.js';
import { digest, sendPhoneReport } from './phone_report_transport.js';

const MAX_BYTES = 24 * 1024 * 1024;
const MAX_PATHS = 4;
const PAGE_CHARS = 700;
const OWNED_REPORT =
  /^forgeax-(?:gameplay|stationary-checkpoint|stationary-first-terminal)-[A-Za-z0-9_-]+\/report\.json$/;

function bounded(value, limit = 240) {
  const text = String(value);
  if (text.length <= limit) return text;
  let end = limit - 1;
  if (/^[\uD800-\uDBFF]$/.test(text[end - 1])) end--;
  return `${text.slice(0, end)}…`;
}

function failure(error) {
  return bounded(error?.message ?? error?.errMsg ?? error, 400);
}

function identifiers(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(0, 12);
  const result = {};
  for (const [key, item] of entries)
    Object.defineProperty(result, bounded(key, 80), {
      value: item !== null && typeof item === 'object' ? '[nested value omitted]' : bounded(item),
      enumerable: true,
      configurable: true,
    });
  return result;
}

function validatedPaths(wx, options) {
  const root = wx.env?.USER_DATA_PATH;
  if (typeof root !== 'string' || root.length === 0) throw new Error('native-sandbox-unavailable');
  if (
    !Array.isArray(options.reports) ||
    options.reports.length < 1 ||
    options.reports.length > MAX_PATHS
  )
    throw new Error(`reports must contain 1..${MAX_PATHS} explicit owned paths`);
  const seen = new Set();
  for (const report of options.reports) {
    const path = report?.path;
    if (typeof path !== 'string' || path.length > root.length + 220 || !path.startsWith(`${root}/`))
      throw new Error('report-path-outside-sandbox');
    const relative = path.slice(root.length + 1);
    const match = OWNED_REPORT.exec(relative);
    if (!match || match[0] !== relative || seen.has(path))
      throw new Error('report-path-not-owned-or-duplicate');
    if (
      report.bytes !== undefined &&
      (!Number.isSafeInteger(report.bytes) || report.bytes < 1 || report.bytes > MAX_BYTES)
    )
      throw new Error('invalid-expected-bytes');
    if (report.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(report.sha256))
      throw new Error('invalid-expected-sha256');
    seen.add(path);
  }
  return options.reports;
}

async function transfer(wx, reportUrl, state, payload) {
  if (reportUrl === undefined) return;
  try {
    const observed = wx.getAppBaseInfo();
    state.appBaseInfo = identifiers(observed);
    // The operator prepares a separate debug-enabled launch. Recovery never changes it.
    if (observed?.enableDebug !== true) {
      state.transfer = { status: 'unavailable', reason: 'debug-not-enabled-at-recovery-start' };
      return;
    }
  } catch (error) {
    state.transfer = {
      status: 'unavailable',
      reason: 'debug-state-unavailable',
      error: failure(error),
    };
    return;
  }
  sendPhoneReport(wx, { reportUrl }, state, payload, 'recovery');
  while (state.transfer?.status === 'pending')
    await new Promise((resolve) => setTimeout(resolve, 50));
}

async function showSummary(wx, state) {
  if (typeof wx.showModal !== 'function') return { status: 'unavailable', pagesShown: 0 };
  const lines = [`Recovery: ${state.status}`, ...(state.error ? [state.error] : [])];
  for (const entry of state.reports) {
    lines.push(`Path: ${entry.path}`, `Read: ${entry.status}`);
    for (const key of ['bytes', 'sha256', 'error'])
      if (entry[key] !== undefined) lines.push(`${key}: ${entry[key]}`);
    for (const [key, value] of Object.entries(entry.summary ?? {}))
      lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    if (entry.transfer) lines.push(`Transfer: ${JSON.stringify(entry.transfer)}`);
  }
  const text = lines.join('\n');
  const pages = [];
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + PAGE_CHARS, text.length);
    if (end < text.length && /^[\uD800-\uDBFF]$/.test(text[end - 1])) end--;
    pages.push(text.slice(start, end));
    start = end;
  }
  let pagesShown = 0;
  for (const content of pages) {
    try {
      const confirmed = await new Promise((resolve, reject) =>
        wx.showModal({
          title: `Report ${pagesShown + 1}/${pages.length}`,
          content,
          showCancel: true,
          confirmText: pagesShown + 1 === pages.length ? '\u5b8c\u6210' : '\u7ee7\u7eed',
          cancelText: '\u5173\u95ed',
          success: (response) => resolve(response?.confirm === true),
          fail: reject,
        }),
      );
      pagesShown++;
      if (!confirmed) return { status: 'dismissed', pagesShown, totalPages: pages.length };
    } catch (error) {
      return { status: 'failed', pagesShown, error: failure(error) };
    }
  }
  return { status: 'complete', pagesShown };
}

/**
 * Separate recovery-only root game.js entry. Native wx + USER_DATA_PATH are the
 * authority; no Engine/Host globals, debugger, input, directory walk or file write.
 * Each reports item is {path, bytes?, sha256?}; popup defaults to true. An explicit
 * reportUrl reuses the original bounded sender and its SHA/size receipt protocol.
 * The original file is never rewritten or reserialized, including on failure.
 */
export async function recoverPhoneReports(wx, options = {}) {
  const state = {
    schemaVersion: 'forgeax-phone-report-recovery/1',
    status: 'complete',
    reports: [],
  };
  try {
    const reports = validatedPaths(wx, options);
    const fs = wx.getFileSystemManager();
    // Validate the entire bounded request before reading any report contents.
    let totalBytes = 0;
    const stats = reports.map(({ path }) => {
      const stat = fs.statSync(path);
      if (
        !stat.isFile() ||
        !Number.isSafeInteger(stat.size) ||
        stat.size < 1 ||
        stat.size > MAX_BYTES
      )
        throw new Error('report-not-file-or-over-limit');
      totalBytes += stat.size;
      if (totalBytes > MAX_BYTES) throw new Error('total-report-bytes-over-limit');
      return stat;
    });
    for (const [index, expected] of reports.entries()) {
      const entry = { path: expected.path, status: 'failed' };
      state.reports.push(entry);
      try {
        const raw = fs.readFileSync(expected.path);
        if (!(raw instanceof ArrayBuffer)) throw new Error('native-binary-read-unavailable');
        const bytes = new Uint8Array(raw);
        if (bytes.length !== stats[index].size) throw new Error('report-size-changed-during-read');
        entry.bytes = bytes.length;
        entry.sha256 = digest(bytes);
        const body = utf8toString(bytes);
        const roundtrip = utf8fromStringLoose(body);
        if (roundtrip.length !== bytes.length || digest(roundtrip) !== entry.sha256)
          throw new Error('utf8-roundtrip-mismatch');
        const report = JSON.parse(body);
        if (report === null || typeof report !== 'object' || Array.isArray(report))
          throw new Error('report-json-not-object');
        entry.summary = {
          schemaVersion: bounded(report.schemaVersion),
          runId: bounded(report.runId),
          mode: bounded(report.mode),
          status: bounded(report.status),
          failure: bounded(report.failure, 600),
          source: identifiers(report.source),
          artifact: identifiers(report.artifact),
        };
        if (expected.bytes !== undefined && expected.bytes !== entry.bytes)
          throw new Error('expected-byte-count-mismatch');
        if (expected.sha256 !== undefined && expected.sha256 !== entry.sha256)
          throw new Error('expected-sha256-mismatch');
        entry.status = 'verified';
        await transfer(wx, options.reportUrl, entry, {
          body,
          bytes: entry.bytes,
          sha256: entry.sha256,
        });
      } catch (error) {
        entry.error = failure(error);
        state.status = 'partial';
      }
    }
  } catch (error) {
    state.status = 'failed';
    state.error = failure(error);
  }
  if (options.popup !== false) state.popup = await showSummary(wx, state);
  return state;
}
