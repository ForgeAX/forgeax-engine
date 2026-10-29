/* One private artifact and one opt-in loopback request; shared by phone diagnostics. */
import { sha256 } from '@noble/hashes/sha2.js';
import { utf8fromStringLoose } from '@exodus/bytes/utf8.js';
function message(error) {
  try { return String(error && error.message !== undefined ? error.message : error); }
  catch (ignored) { return 'unreadable error'; }
}
export function digest(bytes) {
  return Array.from(sha256(bytes), function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
}
export function encodePhoneReport(report) {
  var body = JSON.stringify(report);
  var bytes = utf8fromStringLoose(body);
  return { body: body, bytes: bytes.length, sha256: digest(bytes) };
}
export function persistPhoneReport(wx, report, label) {
  var payload;
  try {
    payload = encodePhoneReport(report);
    var body = payload.body;
    if (typeof wx.getFileSystemManager !== 'function' || !wx.env || !wx.env.USER_DATA_PATH) {
      report.artifact = { status: 'unavailable', reason: 'native-filesystem-unavailable' };
    } else {
      var fs = wx.getFileSystemManager();
      var directory = wx.env.USER_DATA_PATH + '/forgeax-' + label + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
      // mkdir is exclusive: an existing path is an error, never overwritten.
      fs.mkdirSync(directory);
      var path = directory + '/report.json';
      fs.writeFileSync(path, body, 'utf8');
      report.artifact = { status: 'saved', path: path, bytes: payload.bytes, sha256: payload.sha256 };
    }
  } catch (error) { report.artifact = { status: 'failed', error: message(error) }; }
  try { console.info('[forgeax.phone.' + label + '.artifact]', JSON.stringify(report.artifact)); }
  catch (ignored) { /* The retained report remains readable without console or native files. */ }
  return payload;
}
export function sendPhoneReport(wx, options, report, payload, label) {
  if (options.reportUrl === undefined) return;
  var requestTimer, task, settled = false;
  function state(status, detail) {
    report.transfer = Object.assign({ status: status }, detail);
    try { console.info('[forgeax.phone.' + label + '.transfer]', JSON.stringify(report.transfer)); }
    catch (ignored) { /* Transfer reporting must preserve the game exception. */ }
  }
  function complete(status, detail) {
    if (settled) return false;
    settled = true;
    clearTimeout(requestTimer);
    state(status, detail);
    return true;
  }
  try {
    var match = typeof options.reportUrl === 'string'
      && /^http:\/\/127\.0\.0\.1:([0-9]{1,5})(\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.exec(options.reportUrl);
    if (!match || match[0] !== options.reportUrl || Number(match[1]) < 1 || Number(match[1]) > 65535) {
      complete('failed', { reason: 'invalid-loopback-url' });
      return;
    }
    if (!payload) { complete('failed', { reason: 'serialization-failed' }); return; }
    if (payload.bytes > 24 * 1024 * 1024) {
      complete('failed', { reason: 'report-over-limit', bytes: payload.bytes, maxBytes: 24 * 1024 * 1024 });
      return;
    }
    if (typeof wx.request !== 'function') { complete('unavailable', { reason: 'native-request-unavailable' }); return; }
    state('pending', { bytes: payload.bytes, sha256: payload.sha256 });
    requestTimer = setTimeout(function () {
      if (complete('timeout', { reason: 'deadline' }) && task && typeof task.abort === 'function') {
        try { task.abort(); } catch (ignored) { /* Only the owned request is cancelled. */ }
      }
    }, 10000);
    task = wx.request({
      url: options.reportUrl, method: 'POST', data: payload.body,
      header: { 'content-type': 'application/json',
        'X-Forgeax-Report-Bytes': String(payload.bytes), 'X-Forgeax-Report-Sha256': payload.sha256 },
      dataType: 'json', timeout: 10000,
      success: function (response) {
        if (!response || response.statusCode !== 200) {
          complete('failed', { reason: 'http-status', statusCode: response && response.statusCode });
        } else if (!response.data || response.data.status !== 'saved'
            || response.data.bytes !== payload.bytes || response.data.sha256 !== payload.sha256) {
          complete('failed', { reason: 'receipt-mismatch' });
        } else complete('sent', { bytes: payload.bytes, sha256: payload.sha256 });
      },
      fail: function (error) {
        var detail = message(error && error.errMsg !== undefined ? error.errMsg : error);
        complete(/timeout/i.test(detail) ? 'timeout' : 'failed', { reason: 'native-request', error: detail });
      }
    });
  } catch (error) { complete('failed', { reason: 'native-request-threw', error: message(error) }); }
}
