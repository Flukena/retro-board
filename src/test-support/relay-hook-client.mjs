// Test-side client of room-deletion-hook.mjs: preload it into a spawned relay, then call its actions.
const HOOK_URL = new URL('./room-deletion-hook.mjs', import.meta.url).href;
const HOOK_PORT_RE = /\[deletion-hook\] port (\d+)/;
const WAIT_MS = 5_000;
const POLL_MS = 10;

/** startRelay's `preload` value that installs the hook. */
export const HOOK_PRELOAD = `import ${JSON.stringify(HOOK_URL)};`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `{ call(action, docName) }` for a relay started with HOOK_PRELOAD; throws if the hook never reports its port. */
export async function hookOf(relay) {
  const deadline = Date.now() + WAIT_MS;
  let match = relay.output().match(HOOK_PORT_RE);
  while (!match) {
    if (Date.now() > deadline) throw new Error(`no deletion hook\n${relay.output()}`);
    await sleep(POLL_MS);
    match = relay.output().match(HOOK_PORT_RE);
  }
  const call = async (action, docName = '') => (await fetch(`http://127.0.0.1:${match[1]}/${action}?doc=${encodeURIComponent(docName)}`, { method: 'POST' })).json();
  return { call };
}
