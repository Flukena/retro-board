# RetroBoard architecture

RetroBoard uses three runtime layers. Each feature keeps its implementation,
styles and tests together; imports name the actual module rather than a barrel.

```text
RetroBoard.jsx                 React application coordinator
yjs-server.mjs                Relay startup and connection coordinator
src/
  client/
    app/                      Bootstrap, routing, landing, error recovery
    board/                    Canvas, cards, gestures, selection, minimap
    chrome/                   Navigation and tool docks
    legal/                    Privacy policy and terms pages
    public-wall/              Public entry, snapshots and previews
    session/                  Yjs adapter, local identity, presence, undo
    templates/                Template picker and workflow
    transfer/                 Import/export, downloads and image transport
    ui/                       Shared UI, theme tokens and translations
    voting/                   Timer, voting setup and result presentation
  domain/                     Portable board rules and validated contracts
  server/                     HTTP, sessions, protocol, storage and maintenance
  test-support/               Development-only render/style test helpers
scripts/
  project-files.mjs           Shared recursive source/test discovery
  test.mjs                    Node test runner; forwards CLI flags
```

## Dependency direction

Client and server modules may import their own layer and `domain`. Domain
modules have no client/server, React, Node or browser-host dependencies.
The app bootstrap is the composition entry: it imports the root React
coordinator. Server startup similarly wires lower-owned peers. Neither
runtime imports test support.

`src/architecture.test.js` enforces these directions, portable domain code
and an acyclic import graph. `src/rule-ratchets.test.js` recursively checks all
JSX colors and limits the two root coordinators to 4,177 and 1,881 lines.

## Client flow

1. Bootstrap exchanges the private capability or establishes a Public session.
2. Only then does it dynamically load the singleton Yjs storage adapter.
3. UI actions apply granular writes and local optimistic state.
4. Remote snapshots pass through `domain/board-reconciliation.js`. It preserves
   active/recent local geometry and pending local creates while honoring
   explicit peer deletions and undo/redo.
5. Transfer intake normalizes an entire manifest before confirmation. Image
   preparation, import limits, room identity and zone-session reset are owned
   by `client/transfer/board-transfer.js`; the coordinator commits exactly one
   `storage.importBundle` transaction. ZIP code remains lazy-loaded.

Browser-specific operations stay in client modules. The export filename's
current-location fallback therefore belongs in transfer, not domain.

## Relay flow

1. Startup loads validated configuration, persistence and the room registry.
2. `server/relay-session.js` owns signed cookies, expiry, canonical signature
   spelling, duplicate-cookie rejection and room binding.
3. WebSocket admission applies origin/session/capacity/traffic checks.
4. `server/relay-protocol.js` validates a complete binary envelope before any
   upstream Yjs/Awareness mutation; identity ownership remains a separate check.
5. Existing persistence/maintenance modules preserve durable writes and drain
   behavior. The relay retains one CJS Yjs instance shared with y-websocket.

`Dockerfile.yjs` ships explicit domain/server source lists. A transitive-import
contract checks the image includes every local relay dependency. Client code
and tests are excluded from the relay runtime image.

## Verification

```sh
npm test -- --test-concurrency=1
npm run build
```

The runner discovers root, nested source and script tests. Tests remain next
to the behavior they exercise; moving a feature cannot silently remove its
coverage. Existing browser checks in `scripts/README.md` cover real two-context
sync, undo/redo, both languages, mobile gestures, public tools and transfers.
