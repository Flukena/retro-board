import { useEffect, useState } from 'react';

export function startSavedBoardRead(read, accept, fail) {
  let active = true;
  // React may immediately discard the first mount. Only the committed effect uses a relay request.
  queueMicrotask(async () => {
    if (!active) return;
    try {
      const result = await read();
      if (active) accept(result);
    } catch { if (active) fail(); }
  });
  return () => { active = false; };
}

export function useSavedBoardQuery(read) {
  const [value, setValue] = useState(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => startSavedBoardRead(read, setValue, () => setFailed(true)), [read, attempt]);
  function retry() {
    setFailed(false);
    setValue(null);
    setAttempt(count => count + 1);
  }
  return { value, setValue, failed, setFailed, retry };
}
