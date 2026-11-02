#!/usr/bin/env node
import { createMaintainerIpGateway } from '../src/server/maintainer-ip-gateway.js';

const GATEWAY_PORT = 1242;
const UPSTREAM_PORT = 1240;
const EXTERNAL_ORIGIN = 'http://100.92.238.57:1240';
const server = createMaintainerIpGateway({ externalOrigin: EXTERNAL_ORIGIN, upstreamPort: UPSTREAM_PORT });
const shutdown = () => { server.close(); server.closeAllConnections(); };
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
server.listen(GATEWAY_PORT, '127.0.0.1');
