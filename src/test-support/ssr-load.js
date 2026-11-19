import { createServer } from 'vite';

// `plugins` can stand in for a module's heavy dependencies; `load` reaches the same module instances the subject uses.
export async function withSsrModule(path, check, { plugins = [] } = {}) {
  const server = await createServer({
    configFile: false,
    plugins,
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    const load = (modulePath) => server.ssrLoadModule(modulePath);
    await check(await load(path), { load });
  } finally {
    await server.close();
  }
}
