const EXIT_SUCCESS_CODE = 0;
const EXIT_FAILURE_CODE = 1;
const DRAIN_TIMEOUT_LOG = '[yjs] drain timed out — exiting';
const DRAIN_FAILED_LOG = '[yjs] drain failed';
const FATAL_LOG = '[yjs] fatal process error';
const ERROR_ID_FALLBACK = 'unidentified-error';
export const STORAGE_FAILURE_LOG = '[yjs] storage degraded — restarting after drain';
export const STORAGE_FAILURE_REASON = 'storage failure';
export const UNHANDLED_REJECTION_EVENT = 'unhandledRejection';
export const UNCAUGHT_EXCEPTION_EVENT = 'uncaughtException';

export const isRelayReady = (storageFailure, shuttingDown) => !storageFailure && !shuttingDown;

const identifyError = (errorId, err) => {
  try {
    const id = errorId(err);
    return typeof id === 'string' ? id : ERROR_ID_FALLBACK;
  } catch {
    return ERROR_ID_FALLBACK;
  }
};

const writeDiagnostic = (log, ...args) => {
  try { log.error(...args); }
  catch { /* Diagnostic sink failures must not interrupt shutdown. */ }
};

export const createRelayLifecycle = ({ drain, onStart, timeoutMs, log, errorId, exit, setExitCode }) => {
  let started = false;
  let failed = false;
  let fatalLogged = false;
  let completion;
  const shutdown = (reason, failure = false) => {
    failed ||= failure;
    if (failed) setExitCode(EXIT_FAILURE_CODE);
    if (started) return completion;
    started = true;
    const hardStop = setTimeout(() => {
      writeDiagnostic(log, DRAIN_TIMEOUT_LOG);
      exit(EXIT_FAILURE_CODE);
    }, timeoutMs);
    completion = (async () => {
      try {
        onStart(reason);
        await drain();
      } catch (err) {
        failed = true;
        setExitCode(EXIT_FAILURE_CODE);
        writeDiagnostic(log, DRAIN_FAILED_LOG, { errorId: identifyError(errorId, err) });
      }
      clearTimeout(hardStop);
      exit(failed ? EXIT_FAILURE_CODE : EXIT_SUCCESS_CODE);
    })();
    return completion;
  };
  const fatal = (reason, err) => {
    if (!fatalLogged) {
      fatalLogged = true;
      writeDiagnostic(log, FATAL_LOG, { reason, errorId: identifyError(errorId, err) });
    }
    return shutdown(reason, true);
  };
  return { shutdown, fatal };
};

const WS_CLOSED_STATE = 3;
const WS_SHUTDOWN_CODE = 1001;
const WS_SHUTDOWN_REASON = 'server shutting down';
const WS_SHUTDOWN_GRACE_MS = 5_000;
const DRAIN_POLL_INTERVAL_MS = 10;
const terminateSocket = (conn) => {
  try { conn.terminate(); }
  catch { /* The socket is already closed. */ }
};
const closeSocket = (conn) => new Promise((resolveSocket) => {
  if (conn.readyState === WS_CLOSED_STATE) { resolveSocket(); return; }
  const forceTimer = setTimeout(() => terminateSocket(conn), WS_SHUTDOWN_GRACE_MS);
  forceTimer.unref();
  conn.once('close', () => {
    clearTimeout(forceTimer);
    resolveSocket();
  });
  try { conn.close(WS_SHUTDOWN_CODE, WS_SHUTDOWN_REASON); }
  catch { terminateSocket(conn); }
});

export const drainRelay = async ({ server, clients, httpGraceMs, isBusy, compactions, destroyStorage }) => {
  // Start HTTP closure before closing upgraded sockets, then await both.
  const httpClosed = new Promise((resolveClose, rejectClose) => {
    server.close((err) => (err ? rejectClose(err) : resolveClose()));
  });
  const forceHttpTimer = setTimeout(() => server.closeAllConnections(), httpGraceMs);
  forceHttpTimer.unref();
  try {
    await Promise.all([httpClosed, ...[...clients].map(closeSocket)]);
    while (isBusy()) {
      await new Promise((resolveWait) => setTimeout(resolveWait, DRAIN_POLL_INTERVAL_MS));
    }
    await Promise.all(compactions());
    await destroyStorage();
  } finally {
    clearTimeout(forceHttpTimer);
  }
};
