import { persistPhoneReport, sendPhoneReport } from './phone_report_transport.js';

/** This run's four fixed messages; startup failure survives receiver startup order. */
export function createPhoneGameplayTransport(options, wx, report, { now, canShow }) {
  const connection = {
    attempts: 0,
    firstError: null,
    firstNativeError: null,
    lastError: null,
  };
  report.connection = connection;
  let checkpointSaved = false,
    dialogShown = false;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function retain(error, stage) {
    const native = error?.native;
    const observed = {
      stage,
      atMs: now(),
      error: String(error),
      original: {
        name: error?.name,
        message: error?.message,
        stack: error?.stack,
        code: error?.code,
        detail: error?.detail,
        cause: error?.cause,
      },
      ...(native ? { native } : {}),
    };
    connection.firstError ??= observed;
    if (native) connection.firstNativeError ??= observed;
    connection.lastError = observed;
    globalThis.__forgeaxPhoneGameplayReport = report;
    if (!checkpointSaved) {
      checkpointSaved = true;
      const checkpoint = {
        ...report,
        status: 'partial',
        failure: observed.error,
        finishedAt: Date.now(),
      };
      persistPhoneReport(wx, checkpoint, 'gameplay-request-failure');
      connection.checkpoint = checkpoint.artifact ?? null;
    }
    if (options.transportDiagnostic === true && !dialogShown && canShow()) {
      dialogShown = true;
      const content = native?.errMsg ?? String(error?.message ?? error).slice(0, 1800);
      connection.dialog = { attempted: true, content, nativeErrMsg: native?.errMsg };
      try {
        wx.showModal({
          title: 'ForgeaX diagnostic',
          content,
          showCancel: false,
          fail(value) {
            connection.dialog.error = String(value?.errMsg ?? value);
          },
        });
      } catch (value) {
        connection.dialog.error = String(value);
      }
    }
  }
  return {
    failure: retain,
    request(stage, value, timeout = 20000) {
      connection.attempts++;
      return new Promise((resolve, reject) => {
        let settled = false,
          task;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) {
            retain(error, stage);
            reject(error);
          } else resolve(result);
        };
        const timer = setTimeout(() => {
          finish(new Error(`${stage}: request deadline`));
          task?.abort?.();
        }, timeout);
        try {
          task = wx.request({
            url: `${options.controlUrl}/${stage}`,
            method: 'POST',
            timeout,
            dataType: 'json',
            header: { 'content-type': 'application/json' },
            data: JSON.stringify({
              kind: 'forgeax-phone-gameplay-control/1',
              runId: options.runId,
              source: options.source,
              stage,
              ...value,
            }),
            success(response) {
              if (response?.statusCode !== 200)
                finish(new Error(`${stage}: HTTP ${response?.statusCode}`));
              else if (response.data?.runId !== options.runId || response.data?.stage !== stage)
                finish(new Error(`${stage}: response identity mismatch`));
              else finish(null, response.data);
            },
            fail(value) {
              const error = new Error(`${stage}: ${String(value?.errMsg ?? value)}`);
              error.native = {
                errMsg: String(value?.errMsg ?? value),
                ...(value?.errno !== undefined ? { errno: value.errno } : {}),
                ...(value?.errCode !== undefined ? { errCode: value.errCode } : {}),
              };
              finish(error);
            },
          });
        } catch (error) {
          finish(error);
        }
      });
    },
    async finish() {
      // Serialize and persist once. Every retry uses exactly these bytes and digest.
      const payload = persistPhoneReport(wx, report, 'gameplay');
      const deadline = Date.now() + 120000;
      report.transferAttempts = 0;
      do {
        report.transferAttempts++;
        sendPhoneReport(
          wx,
          { reportUrl: `${options.controlUrl}/report` },
          report,
          payload,
          'gameplay',
        );
        const requestDeadline = Date.now() + 10500;
        while (report.transfer?.status === 'pending' && Date.now() < requestDeadline)
          await wait(100);
        if (report.transfer?.status === 'sent') return;
        if (!payload || report.transfer?.status === 'unavailable') return;
        await wait(1000);
      } while (report.transferAttempts < 60 && Date.now() < deadline);
    },
  };
}
