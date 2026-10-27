# Private maintainer console

The console lists every registered room on its relay, including cold rooms,
connection counts, temporary blocks, image usage and resident collection counts.
It also shows readiness, uptime, database usage, RSS/heap, pending writes and the
active-document budget. Connections count tabs, not unique people. Cold document
sizes and collections remain unknown: monitoring never hydrates a room. The
status response does not disclose capabilities, document names or board content.
An authenticated owner can explicitly enter a room with the same read/write
access as a collaborator. A same-origin POST to `/api/rooms/<handle>/join`
returns that room’s ordinary fragment-based private link only when requested.
Public Wall returns `/public` without its internal capability. These responses
are never cached. The owner key therefore grants collaborator access to all
registered rooms on that relay; protect it accordingly. Logging out of the
console does not revoke a room link or an already-established board session. Private and Public relays each have their own console.

## Local development

Build with `npm run maintainer:build`. Supply a cryptographically random
base64url key (32 random bytes, at least 43 characters) from your password manager
as `YJS_MAINTAINER_KEY` in the relay process environment. Do not put the key in a
URL, command argument, repository or log. Start the relay using the usual local
development command and explicit data-volume directories for its database and
uploads. Open `http://127.0.0.1:1240` and enter the key. `YJS_MAINTAINER_PORT`
changes the default port; Public and private relay processes need distinct ports.

Without the key the listener is disabled. Invalid configured keys fail startup.
The listener normally binds only `127.0.0.1`. Authentication uses a constant-time
comparison of fixed-size digests; Host, Origin and cross-site browser checks
add protection against rebinding and cross-origin access. Nothing trusts
forwarded client-IP or Tailscale identity headers. Status is cached for five
seconds and every response uses `no-store`. Login exchanges the key for an opaque, revocable HttpOnly SameSite=Strict
cookie lasting 30 days (Secure on the configured HTTPS origin). Reloading or
reopening the browser restores the session without retaining the key in browser
storage. Logout revokes the session on the server. Sessions are held in bounded
server memory (32 per relay); restarting the relay, changing its key, or eviction
of the oldest session requires login again. Each relay key and listening port have a separate cookie
name so the private and Public consoles can coexist on the same host. Keep the key private: possession of this key
is the owner credential, not a named user account. Restart with a new key to
revoke it; already displayed information cannot be recalled.

## Monitoring and room entry

The dashboard labels clients as connections/tabs, not unique people. It shows
live totals and per-room counts, updated every five seconds. Filters select
connected, blocked, resident or cold rooms; sorting prioritizes clients, image
storage or known document size (unknown cold sizes remain last).

Resource alerts begin at 80% of each configured budget and become critical at
95%. Database, uploads, resident documents, V8 heap ceiling and pending writes
are checked; readiness and failed polling remain visible independently. RSS is
a measured value, not a percentage of a guessed container memory cap.

Four charts retain up to 720 samples in tab memory (approximately one hour).
They start when this tab receives status, reset on reload/logout, and show gaps
for missing samples rather than interpolating outages. No monitoring history is
written to disk. Room entry leaves the console for the ordinary application;
returning restores the maintainer session, but starts new chart history.
The board origin is the relay's first validated `YJS_ALLOWED_ORIGINS` entry.
Room entry does not hydrate cold rooms until the board itself connects, and
normal blocks, admission limits, undo/redo and collaboration rules still apply.

## Production on this host

The deployed private configuration is
`~/.config/retro-board/maintainer/compose.yml`; its key comes from the adjacent
`credentials` file (directory mode 700, credentials mode 600). Always include
this override when operating the stack:

```sh
docker compose --env-file /dev/null -p miro \
  -f docker-compose.prod.yml \
  -f ~/.config/retro-board/maintainer/compose.yml up -d --no-build --wait
```

Production deployment/recreation still requires owner approval and the release
gate in `DEPLOYMENT.md`. The override pins the release images and the existing
tunnel credential mount paths; omitting those paths can start a tunnel with
missing default credential files. Never print the merged Compose configuration:
it contains the owner key.

The private console is at `http://127.0.0.1:1240`; Public Wall's console is at
`http://127.0.0.1:1241`. Docker does not publish host ports for containers attached
only to the internal network on this host. A separate `maintainer-gateway`
therefore proxies both ports, using the already-scanned unprivileged web image.
It joins `app_internal` and a dedicated host bridge, with both published ports
explicitly bound to `127.0.0.1`. The relays retain their internal-only network
and publish no host ports. The gateway is read-only, drops all capabilities,
uses a bounded tmpfs, has resource limits and rotated logs, and serves only the
console proxies. Its private Nginx configuration is adjacent to the override.

`YJS_MAINTAINER_CONTAINER=true` binds the console inside each relay to `0.0.0.0`
so the gateway can reach it. Internal network peers still need the owner key.
No console route is added to nginx's public website or Cloudflare Tunnel.

Tailscale Serve is enabled on this host:

- Private: `https://sakons-mac-studio.tail522f6a.ts.net:8440/`
- Public: `https://sakons-mac-studio.tail522f6a.ts.net:8441/`

The exact HTTPS origins are configured as `YJS_MAINTAINER_ORIGIN` in the private
Compose override. Effective tailnet rules allow the owner's devices on these
ports and deny other users. The application key is still required; cookies are
Secure over HTTPS. Serve is tailnet-only; Funnel is not enabled. Existing TCP
Serve on port 8080 is preserved. On this Mac, invoke the executable through its
app bundle path (the `/usr/local/bin/tailscale` symlink crashes):

```sh
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8440 http://127.0.0.1:1240
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8441 http://127.0.0.1:1241
```

Check `serve status --json` before changes and preserve unrelated services.
The official [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve)
describes enabling/disabling individual listeners. Keep owner-only tailnet
policy in place when changing access rules.

Rollback image IDs are recorded in the private configuration directory. Use the
rollback override with the original Compose file, remove only the new gateway
service if appropriate, and keep the same `miro` project and data volumes.
Never restore/delete application data as part of an image rollback.

## Checks

`npm test` discovers the server authorization/configuration, non-disclosure and
translated-login tests. `npm run maintainer:build` builds the isolated UI; its
assets are shipped in the relay image. This HTML entry is independent of the
public website build, and no maintainer route is added to the public relay HTTP
server. Runtime status collection reads only existing in-memory metadata.
