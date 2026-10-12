import { createServer } from 'vite';

export async function withChromeModule(path, check) {
  const server = await createServer({
    configFile: false,
    server: { middlewareMode: true, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: 'custom',
  });
  try {
    await check(await server.ssrLoadModule(path), await server.ssrLoadModule('/src/i18n.js'));
  } finally {
    await server.close();
  }
}
