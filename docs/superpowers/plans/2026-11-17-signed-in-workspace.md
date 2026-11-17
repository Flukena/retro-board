# Signed-in Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A signed-in person who opens `/` gets a workspace that manages their boards: a card grid with real zone thumbnails, search, sort, rename, delete, a create menu and the account menu. Guests keep today's landing page.

**Architecture:**
- **Relay:** the account room list gains a geometry-only `preview` for each plain board. It is read from the same document load the title already uses, and a pure domain function validates and caps it.
- **Client account state:** one shared store holds the account session and keeps a non-secret "signed in last time" hint in localStorage.
- **Home:** a new `HomeRoute` chooses between `Landing` and `Workspace`. A tiny blocking head script plus a CSS rule hide the prerendered landing for hinted visitors, so the marketing page does not flash first.

**Tech Stack:** React 18 + Vite, Yjs relay (`yjs-server.mjs`), `node --test`, Playwright 1.64 (global) for the live check.

**Spec:** `docs/superpowers/specs/2026-11-17-signed-in-workspace-design.md` (approved 2026-11-17). Context brief with file:line citations: `/private/tmp/claude-501/-Users-sakontheerasuwanajak-Documents-miro/62b61f23-b1a6-4f7b-be8b-24831c5b9be8/scratchpad/workspace-context.md`.

## Global Constraints

**Repo rules and limits**
- `RetroBoard.jsx` is at its ceiling of 3993 lines: zero net lines. `yjs-server.mjs` has 1445 lines against a ceiling of 1446: change only line `:58` (the import) and line `:1047` (the reader wiring), in place.
- No colour literals in `.jsx` files. CSS uses `var(--…)` tokens from `src/client/ui/theme.js`; any new token is added there, in both themes.
- Every new `t('…')` key goes into th and en (`src/client/ui/i18n.js`) **and** into the 9 locale files (`src/client/ui/locales/{zh,ja,ko,es,pt,de,fr,vi,id}.js`), with matching `{placeholders}`. Reuse existing keys where the meaning matches: `myBoards.open`, `myBoards.rename`, `myBoards.loading`, `myBoards.lastActive`, `myBoards.error.*`, `myBoards.delete*`, `account.retry`, `account.signIn`.
- Sonar-clean, cognitive complexity ≤15 per function, named constants with units, imports at the top. No `skip`/`NOSONAR`, and no raised ceilings.
- Relay code goes in `src/server/`, pure rules in `src/domain/`, workspace UI in `src/client/workspace/`. Dependencies point toward the domain.

**Preview, hint and guest page**
- Preview contents: only `{ x, y, w, h, color }` per zone; never zone titles, card text, names or images. Locked rooms and Poker rooms get `preview: null`. One document load per room, under the existing bounded loader. A storage failure still gives 503 plus the latch.
- Hint: localStorage key `rb_signed_in`, value `'1'`, nothing else stored.
- The guest landing page and the prerender output stay unchanged. Do not edit `Landing.jsx` or `src/client/seo/prerender-entry.jsx`.

**Running and committing**
- Tests: `node --test <file>` for one file. Gate: `(npm test -- --test-concurrency=2 && npm run build) > "$TMPDIR/ws-gate.log" 2>&1`, run as ONE bounded command; read only `tail`/`rg` of the log. Host load limit: run at most one Chromium.
- Live runs:
  - Write output to `/Volumes/ssd-fluke/BaseData/retro-board/workspace-20261117/`, with a symlink at `~/basedata/retro-board/workspace-20261117`.
  - Start servers with background Bash, and give every script a hard timeout (`perl -e 'alarm 600; exec @ARGV' node …`).
  - Poll only in bounded loops, never `wait`. Kill everything you start and confirm its ports are free.
- Never read `.env`. Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01YMhR1CNNoCRLB1mKDDdt9m
  ```

### Fixed copy (th / en)

Write these new keys exactly. For the 9 locales, write natural translations of the en text.

**Page and list**

| key | th | en |
|---|---|---|
| `workspace.title` | บอร์ดของฉัน | My boards |
| `workspace.intro` | บอร์ดที่คุณสร้างขณะล็อกอิน เปิด เปลี่ยนชื่อ หรือลบได้จากที่นี่ | Boards you created while signed in. Open, rename or delete them here. |
| `workspace.search` | ค้นหาชื่อหรือรหัสบอร์ด | Search by name or code |
| `workspace.sort` | เรียง | Sort |
| `workspace.sort.recent` | ใช้ล่าสุด | Last used |
| `workspace.sort.created` | สร้างล่าสุด | Newest |
| `workspace.sort.name` | ชื่อ ก–ฮ | Name A–Z |
| `workspace.noMatch` | ไม่พบบอร์ดที่ตรงกับคำค้น | No boards match your search. |
| `workspace.oldBoards` | บอร์ดที่สร้างก่อน 17 พ.ย. 2026 ยังไม่อยู่ในรายการนี้ เปิดได้จากลิงก์เดิมเหมือนเดิม | Boards made before 17 Nov 2026 aren't listed here. Open them from their link as before. |
| `workspace.empty.title` | ยังไม่มีบอร์ด | No boards yet |
| `workspace.empty.body` | บอร์ดที่คุณสร้างขณะล็อกอินจะแสดงที่นี่ เปิด เปลี่ยนชื่อ หรือลบได้จากหน้านี้ | Boards you create while signed in show up here, ready to open, rename or delete. |
| `workspace.empty.create` | สร้างบอร์ดแรก | Create your first board |

**Cards**

| key | th | en |
|---|---|---|
| `workspace.badge.locked` | ล็อกรหัส | Locked |
| `workspace.card.poker` | Planning Poker · {code} | Planning Poker · {code} |
| `workspace.card.noZones` | ยังไม่มีโซน | No zones yet |
| `workspace.card.options` | ตัวเลือกของ {title} | Options for {title} |
| `workspace.card.renameLocked` | บอร์ดล็อกรหัสเปลี่ยนชื่อได้ในบอร์ด | Rename a locked board from inside it. |
| `workspace.card.delete` | ลบบอร์ด… | Delete board… |

**Create menu**

| key | th | en |
|---|---|---|
| `workspace.create` | สร้างบอร์ด | New board |
| `workspace.create.new` | บอร์ดใหม่ | Blank board |
| `workspace.create.newDesc` | บอร์ดว่าง ตั้งชื่อก่อนหรือทีหลังก็ได้ | An empty board. Name it now or later. |
| `workspace.create.name` | ชื่อบอร์ด (ไม่บังคับ) | Board name (optional) |
| `workspace.create.submit` | สร้าง | Create |
| `workspace.create.locked` | บอร์ดล็อกรหัส | Password-locked board |
| `workspace.create.lockedDesc` | เข้ารหัสทั้งบอร์ด ต้องมีรหัสผ่านถึงเปิดได้ | Fully encrypted. Only people with the password can open it. |
| `workspace.create.template` | เริ่มจากเทมเพลต | Start from a template |
| `workspace.create.templateDesc` | เลือกจาก 4 รูปแบบ retro ที่วางโซนไว้แล้ว | Pick one of 4 retro formats with zones ready. |
| `workspace.create.poker` | ห้อง Planning Poker | Planning Poker room |
| `workspace.create.pokerDesc` | โหวตประมาณขนาดงานพร้อมทีม | Estimate work together with your team. |

The visual reference is the owner-reviewed mockup at https://claude.ai/artifact/M4SNnBfTk28YAaVnswLLD8. Match its layout, not its hex values; tokens come from `theme.js`.

## Review Focus

1. **Hostile or huge board contents.** A board with hundreds of zones, NaN/∞ geometry, coordinates beyond ±10,000,000, colour `'red'`/`7`/`1.5`, or zone titles holding private text. The list still answers 200, carries at most `MAX_PREVIEW_ZONES` zones, and never includes the text. Owned by Tasks 1–2.
2. **A stale or broken hint.** The person signed out on another device, or the JS bundle fails to load. A hinted visitor must never be left on a blank page: they fall back to the landing, and the CSS reveal fallback shows it after `--home-hint-reveal-delay`. Owned by Task 7.
3. **Relay unavailable or rate limited while hinted.** The workspace shows an inline error with Retry, or the rate-limited copy, never an empty grid that claims "No boards yet". Owned by Task 5.
4. **Sign-out from the workspace.** Signing out switches `/` to the landing at once, without a reload, and clears the hint. Owned by Tasks 3 and 7.
5. **Names that sort or search oddly.** Thai titles, an untitled board (sorted and searched by code), a title that differs from the query only in case or surrounding spaces, and very long titles (one line, with an ellipsis). Owned by Tasks 4–5.

---

### Task 0 (controller step, no implementer): bring in the rounded thumbnails

- [ ] Once `fix/landing-polish` has passed its own review, run `git merge --no-ff fix/landing-polish` into `feat/signed-in-workspace`. Use a merge message with the attribution lines, and confirm that `TemplateThumbnail.test.js` passes.
- [ ] If that branch is not ready before Task 5 starts, record a ledger ruling and continue: Task 5 adds only the size props, and the rounding arrives with the merge before the final review.

### Task 1: Domain — palette index and board preview

**Files:**
- Create: `src/domain/palette-index.js`, `src/domain/palette-index.test.js`, `src/domain/board-preview.js`, `src/domain/board-preview.test.js`
- Modify: `src/domain/import-schema.js:86-90` (`normalizeColor` uses `isPaletteIndex`), `src/client/ui/palette.test.js` (add one assertion)

**Interfaces:**
- Produces:
  - `PALETTE_COLOR_COUNT = 6`, `DEFAULT_PALETTE_INDEX = 0`, `isPaletteIndex(value: unknown) -> boolean` (a safe integer in `0..PALETTE_COLOR_COUNT-1`).
  - `MAX_PREVIEW_ZONES = 24`.
  - `boardPreviewFromItems(items: Iterable<object>) -> { zones: Array<{x,y,w,h,color}> } | null`.

- [ ] **Step 1: Failing tests** in `board-preview.test.js`:
  - `keeps only geometry and colour of valid zones`: one zone carries `title: 'private retro text'` and `text: 'x'`. The result deep-equals `{ zones: [{ x: 10, y: 20, w: 300, h: 200, color: 2 }] }`, and `JSON.stringify(result)` does not include `'private'`.
  - `skips zones whose geometry fails the board rules`: zones with `x: NaN`, `w: 0`, `h: -1`, `x: 10_000_001`, and `w: 100_001` → `null`.
  - `colour outside the palette falls back to the default index`: colours `6, -1, 1.5, 'red', undefined` → each `0`; colour `5` is kept.
  - `caps at MAX_PREVIEW_ZONES keeping the largest by area`: 30 zones with `w = h = i + 1` (i = 0…29). The result has 24 zones, its smallest `w` is `7`, and the 24 entries keep input order.
  - `non-zone items and empty input give null`: two sticky items → `null`; `[]` → `null`.

  In `palette-index.test.js`, `isPaletteIndex` accepts 0 and 5 and rejects 6, -1, 1.5, '1' and NaN. In `palette.test.js`, `PALETTE.length === PALETTE_COLOR_COUNT`.
- [ ] **Step 2:** `node --test src/domain/board-preview.test.js src/domain/palette-index.test.js` → FAIL (module not found).
- [ ] **Step 3: Implement.**
  - Validate geometry with `geometryErrorForItem` from `board-geometry.js`; never re-implement the bounds.
  - Select the zones to keep by area (largest first, ties by input index), then return them in input order.
  - `import-schema.js` must keep identical behaviour; its existing tests are the check.
- [ ] **Step 4:** Re-run both new tests, plus `node --test src/domain/import-schema.test.js src/client/ui/palette.test.js` → PASS.
- [ ] **Step 5: Revert check.** Remove the cap (`slice`). The cap test must fail; restore it. Then commit: `feat(domain): geometry-only board preview with palette index rules`.

### Task 2: Relay — summary reader and `preview` in the list

**Files:**
- Create: `src/server/board-preview-reader.js`, `src/server/board-preview-reader.test.mjs`
- Modify: `src/server/room-title-writer.js:50-66`, `yjs-server.mjs:58,1047`, `src/server/account-room-routes.js:41-69`, `src/server/room-title-writer.test.mjs:170-231`, `src/server/account-room-routes.test.mjs:73-94,155`, `src/server/account-rooms-relay.test.mjs`

**Interfaces:**
- Consumes: `boardPreviewFromItems` (Task 1).
- Produces:
  - `boardPreviewOfDoc(doc: Y.Doc) -> BoardPreview|null`.
  - `createRoomSummaryReader({ docs, roomReady, readStoredDoc, limit = MAX_CONCURRENT_TITLE_READS }) -> async (docName) => { title, preview }`. It replaces `createRoomTitleReader`; the constant name stays the same, since it still bounds the same document loads.
  - The route port `readSummary` replaces `readTitle`. Each list entry gains `preview`.

- [ ] **Step 1: Failing tests.**
  - `board-preview-reader.test.mjs`:
    - `reads zones from Y.Map items and ignores everything else`: build `doc.getMap('items')` with a zone `new Y.Map(Object.entries({ type: 'zone', x: 0, y: 0, w: 400, h: 300, color: 3, title: 'private' }))`, a sticky, and a non-Y.Map value. The result is `{ zones: [{ x: 0, y: 0, w: 400, h: 300, color: 3 }] }`.
    - `a doc without zones gives null`.
  - `room-title-writer.test.mjs` (rename the reader tests to summary):
    - `cold summary reads title and preview from one stored doc and destroys it`: `readStoredDoc` is called exactly once per read, the doc is destroyed, and the result is `{ title, preview }`.
    - Keep the null-title, storage-failure (`rejects` with `STORAGE_FAILURE_CODE`) and concurrency-peak tests, adapted.
  - `account-room-routes.test.mjs`:
    - The key-set assertion at :155 gains `'preview'`.
    - New `board entries carry the preview; locked and poker entries carry null`: `ports.previews` is a Map; `readSummary` records each `docName`. Assert that a locked room's `docName` is never read, and that the Poker entry has `preview: null` even when a preview is stubbed.
    - The 503 latch test stays green with `readSummary` throwing.
  - `account-rooms-relay.test.mjs`, new `the list carries a zone preview written over the wire and no zone text`:
    1. Create an owned room and open a peer.
    2. Set the zone Y.Map `{ type: 'zone', x: 100, y: 50, w: 600, h: 400, color: 1, title: 'private zone words' }`.
    3. Wait for the relay to store the change, then list.
    4. Assert `rooms[0].preview` deep-equals `{ zones: [{ x: 100, y: 50, w: 600, h: 400, color: 1 }] }`, and that the raw response body does not include `'private zone words'`.
- [ ] **Step 2:** Run the four files → FAIL.
- [ ] **Step 3: Implement.**
  - `entryOf`:
    - Read: `const summary = locked ? NO_SUMMARY : await readSummary(docName)`, where `NO_SUMMARY = Object.freeze({ title: null, preview: null })`.
    - Entry fields: `title: summary.title` and `preview: kind === ROOM_KIND.BOARD ? summary.preview : null`.
  - `yjs-server.mjs`: rename the import at :58. Change :1047 to `readSummary: createRoomSummaryReader({ docs, roomReady, readStoredDoc: checkedGetYDoc }),`. `wc -l yjs-server.mjs` must still print 1445.
  - Remove `createRoomTitleReader` entirely (no alias).
- [ ] **Step 4:** Run the four files, plus `node --test src/rule-ratchets.test.js` → PASS.
- [ ] **Step 5:** Revert check: make `entryOf` return `summary.preview` for Poker. The Poker assertion must fail; restore it. Commit: `feat(relay): geometry-only zone preview in the account room list`.

### Task 3: Client — shared account session store and signed-in hint

**Files:**
- Create: `src/client/account/signed-in-hint.js`, `signed-in-hint.test.js`, `account-session-store.js`, `account-session-store.test.js` (all in `src/client/account/`)
- Modify: `src/client/account/use-account-session.js`, `src/client/account/use-account-menu.js:34-43`

**Interfaces:**
- Produces:
  - Hint module:
    - `SIGNED_IN_HINT_KEY = 'rb_signed_in'`, `SIGNED_IN_HINT_VALUE = '1'`.
    - `readSignedInHint(storage = globalThis.localStorage) -> boolean`, `rememberSignedIn(storage)`, `forgetSignedIn(storage)`.
    - `syncSignedInHint(session, storage)`: SIGNED_IN remembers; SIGNED_OUT and DISABLED forget; UNAVAILABLE leaves the hint as it is.
    - Every function is a no-op or `false` when storage is missing or throws, following the pattern of the existing `rb_recents` helpers in `router.js`.
  - Store:
    - `createAccountSessionStore({ fetchAccount, storage }) -> { getSnapshot(): Session|null, subscribe(listener) -> unsubscribe, load({ force = false } = {}) -> Promise<Session>, markSignedOut() }`.
    - Exported singleton: `accountSessionStore`.
  - `useAccountSession() -> Session|null` (same contract as today), built on `useSyncExternalStore(store.subscribe, store.getSnapshot, () => null)` plus `store.load()` in an effect.

- [ ] **Step 1: Failing tests.** Use a fake `fetchAccount` and a Map-backed storage.
  - `concurrent loads share one fetch`: three `load()` calls → fetch is called once.
  - `signed-in stores only the hint value; signed-out and disabled clear it; unavailable keeps it`: after SIGNED_IN, the storage entries are exactly `[['rb_signed_in', '1']]`.
  - `load({ force: true }) fetches again`.
  - `markSignedOut sets SIGNED_OUT, clears the hint and notifies subscribers`.
  - `storage that throws reads as not signed in and never breaks a load`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** In `use-account-menu.js`, take the session from `useAccountSession()`. `reload` becomes `accountSessionStore.load({ force: true })`. A successful `run('logout'|'logoutAll'|'deleteAccount')` calls `accountSessionStore.markSignedOut()` instead of local `setSession`. Keep the `readAuthError()` toast as it is.
- [ ] **Step 4:** Run the new tests, plus `node --test src/client/account/*.test.js src/client/room-lock/*.test.js` → PASS.
- [ ] **Step 5:** Commit: `feat(account): one shared account session with a signed-in hint`.

### Task 4: Client — workspace model (pure)

**Files:** Create `src/client/workspace/workspace-model.js`, `src/client/workspace/workspace-model.test.js`.

**Interfaces:**
- Consumes: `boardPreviewFromItems` (Task 1); the room entry shape `{ code, kind, locked, title, link, createdAt, lastActiveAt, preview }`.
- Produces:
  - Enums: `WORKSPACE_SORT = { RECENT: 'recent', CREATED: 'created', NAME: 'name' }`, `CARD_THUMBNAIL = { ZONES, LOCKED, POKER, EMPTY }`, `RENAME_ACTION = { ENABLED, DISABLED, HIDDEN }`.
  - `visibleRooms(rooms, { query = '', sort = WORKSPACE_SORT.RECENT, locale }) -> Room[]`.
  - `cardThumbnailOf(room) -> { kind, zones }`.
  - `renameActionOf(room) -> RENAME_ACTION`.
  - `roomNameOf(room) -> string` (the title, falling back to the code).

- [ ] **Step 1: Failing tests.**
  - `search matches title or code, ignoring case and surrounding spaces`: query `'  SPRINT '` matches `'Sprint 42'`; query `'k7m2'` matches code `'k7m2qx'`.
  - `recent sorts by lastActiveAt newest first, falling back to createdAt`.
  - `created sorts newest first`.
  - `name sorts with the given locale and uses the code for untitled rooms`: `locale: 'th'` orders `'ขยับ'` after `'กล้า'`.
  - `does not mutate the input array`.
  - `thumbnail`:
    - Poker → POKER; locked → LOCKED.
    - Valid preview → ZONES with the zones.
    - `preview: null` → EMPTY.
    - Malformed `preview: { zones: 'x' }` or zones holding NaN → EMPTY. The client re-validates through `boardPreviewFromItems`.
  - `rename`: Poker → HIDDEN, locked → DISABLED, plain board → ENABLED.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; ties sort by `code`. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat(workspace): pure list, search, sort and card rules`.

### Task 5: Client — workspace page and cards

**Files:**
- Create in `src/client/workspace/`: `Workspace.jsx`, `WorkspaceCard.jsx`, `workspace.css`, `room-delete-copy.js` (holds `DELETE_COPY_KEYS`, moved out of `MyBoardsDialog.jsx`, which now imports it), `Workspace.test.js`.
- Modify: `src/client/templates/TemplateThumbnail.jsx` (props `width = 48, height = 32, padding = 2, className`; defaults unchanged), `TemplateThumbnail.test.js`, `src/client/ui/i18n.js` plus the 9 locales (page and card keys), `src/client/account/MyBoardsDialog.jsx` (import only).

**Interfaces:**
- Consumes: Task 4 model; `createMyBoardsController`, `MY_BOARDS_STATUS`, `MY_BOARDS_ERROR`; `BoardTitleDialog`, `TypeToConfirmDialog`; `formatRelativeTime`; `useDismiss`; `SiteMasthead({ homeHref, BrandIcon, titleKey, links, action })`.
- Produces:
  - `Workspace({ account, createAction })`. `createAction` is a node placed in the masthead `action` slot; Task 6 supplies `<CreateMenu/>`.
  - The stateless `WorkspaceView({ state, query, sort, now, signInUrl, creating, onQuery, onSort, onRetry, onCreateFirst, onAskRename, onAskDelete, menuCode, onToggleMenu })` for tests. `onCreateFirst` is wired in `Workspace` to `useCreateBoard().createBoard({})`, a blank board, and drives the empty state's `workspace.empty.create` button.
  - `WORKSPACE_LINKS = [{ href: PLANNING_POKER_PATH, labelKey: 'poker.title' }, { href: AGILE_GUIDE_PATH, labelKey: 'agileGuide.nav.guide' }]`.
  - `WORKSPACE_SKELETON_CARDS = 4`.

- [ ] **Step 1: Failing SSR tests.** Use `withChromeModule`, with a loop over th and en and `NOW = 1_800_000_000_000`.
  - `loading renders WORKSPACE_SKELETON_CARDS busy placeholders and no empty-state copy`.
  - `ready with no rooms shows the empty state, the create call to action and the old-boards note`.
  - `ready lists one card per room`:
    - The board card shows an svg with as many `<rect` as preview zones, its title and `myBoards.lastActive` text.
    - The locked card shows the code and the `workspace.badge.locked` badge.
    - The Poker card shows `Planning Poker · <code>`.
    - Each card has exactly one link, to `room.link`.
  - `the open card menu offers rename by rule`: plain board → enabled Rename; locked → disabled Rename plus the `workspace.card.renameLocked` hint; Poker → no Rename.
  - `a failed list shows the matching error copy and a Retry button, never the empty state`: for `UNAVAILABLE`, `RATE_LIMITED` and `SIGN_IN` (a sign-in link instead of Retry).
  - `a query with no match shows workspace.noMatch`.
  - `TemplateThumbnail sizes its viewBox from width and height props`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - `Workspace` holds the controller the same way `MyBoardsDialog` does: `useSyncExternalStore` plus `load()` on mount. Rename and Delete reuse the same dialog wiring as `MyBoardsDialog.jsx:115-142`.
  - Only one card menu is open at a time; Escape and an outside click close it (`useDismiss`).
  - The title is one line with an ellipsis.
  - The grid is `repeat(auto-fill, minmax(…, 1fr))`, giving 1 column at 390 px and up to 4 at 1440 px.
  - Tap targets are ≥44 px. Every colour, radius and shadow comes from tokens.
- [ ] **Step 4:** Run the tests, plus `node --test src/client/ui/i18n-keys.test.js src/rule-ratchets.test.js` → PASS.
- [ ] **Step 5:** Revert check: render the empty state when `status === FAILED`. The error test must fail; restore it. Commit: `feat(workspace): my boards page with zone thumbnails`.

### Task 6: Client — create menu

**Files:**
- Create: `src/client/workspace/CreateMenu.jsx`, `src/client/workspace/CreateMenu.test.js`
- Modify: i18n (create-menu keys) and `workspace.css`.

**Interfaces:**
- Consumes: `useCreateBoard()` → `{ creating, createError, createBoard({ name, starter, kind, lock }) }`; `canOfferLockedRoom(account)` and the `CreateLockedRoom` exports; `FormatChips({ onStart, disabled })`; `CreateBoardError`; `ROOM_KIND`; `DISPLAY_NAME_MAX_LENGTH`.
- Produces:
  - `CreateMenu({ account })` and the stateless `CreateMenuView({ open, panel, account, creating, createError, onToggle, onPanel, onCreate, onStartFormat, onCreatePoker, onCreateLocked })`.
  - `CREATE_PANEL = { NONE, NEW, LOCKED, TEMPLATE }`.

- [ ] **Step 1: Failing SSR tests** (th and en):
  - `closed menu renders the workspace.create button with aria-expanded false`.
  - `open menu lists blank, template and poker, and lists locked only when the account may create locked rooms`: use one account fixture with `entitlements.canCreateLockedRoom: true` and one with `false`.
  - `the NEW panel shows an optional name field limited to DISPLAY_NAME_MAX_LENGTH and a submit button`.
  - `the TEMPLATE panel renders the four format chips`.
  - `a create error renders CreateBoardError copy inside the menu`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Wire the actions:
    - Blank: `createBoard({ name })`.
    - Template: `createBoard({ starter })`.
    - Poker: `createBoard({ kind: ROOM_KIND.POKER })`.
    - Locked: the existing locked-room form calling `createBoard({ name, lock })`.
  - The menu uses `useDismiss`; items are `role="menuitem"` buttons. `HomeRoute` (Task 7) mounts it through `Workspace`'s `createAction` slot; `CreateMenu` does not import `Workspace`.
- [ ] **Step 4:** Run the tests plus the i18n keys test → PASS.
- [ ] **Step 5:** Commit: `feat(workspace): create menu for every room kind`.

### Task 7: Home switching, flash guard, account menu, dialog removal

**Files:**
- Create: `src/client/app/home-view.js`, `home-view.test.js`, `HomeRoute.jsx`, `home.css` (all in `src/client/app/`), and `public/home-hint.js`.
- Modify:
  - `index.html`: add `<script src="/home-hint.js"></script>` in `<head>`, before the font stylesheet.
  - `src/client/app/main.jsx:103`: the fallback becomes `() => <HomeRoute />`.
  - `src/client/account/AccountMenu.jsx`: `SignedInMenu` gets a `myBoardsHref` prop and the dialog wiring is removed.
  - `src/client/account/use-account-menu.js`: drop `showingBoards`.
  - `AccountMenu.test.js`.
  - Delete `MyBoardsDialog.jsx` and `MyBoardsDialog.test.js`.
  - Remove i18n keys that only the deleted dialog used (check each with `rg` before deleting, across all 11 dictionaries).

**Interfaces:**
- Consumes: Task 3 `useAccountSession`, `readSignedInHint`, `SIGNED_IN_HINT_KEY`, `SIGNED_IN_HINT_VALUE`; Task 5 `Workspace`; Task 6 `CreateMenu`.
- Produces:
  - `HOME_VIEW = { LANDING: 'landing', WORKSPACE: 'workspace' }`.
  - `homeViewFor({ hinted: boolean, session: Session|null }) -> HOME_VIEW`.
  - `HOME_HINT_CLASS = 'rb-home-hinted'`.
  - `HomeRoute()`.

- [ ] **Step 1: Failing tests.**
  - `home-view.test.js`, `homeViewFor` matrix:
    - pending session: `null` with hint → WORKSPACE; without hint → LANDING;
    - SIGNED_IN → WORKSPACE, hinted or not;
    - SIGNED_OUT or DISABLED → LANDING, even when hinted;
    - UNAVAILABLE → WORKSPACE when hinted, LANDING when not.
  - `the head script and the module agree`: read `public/home-hint.js` as text and assert it contains `SIGNED_IN_HINT_KEY`, `SIGNED_IN_HINT_VALUE` and `HOME_HINT_CLASS`. The script wraps storage access in try/catch and only adds a class.
  - `index.html loads /home-hint.js in head before the stylesheet`.
  - `home.css hides the landing only for hinted pages and reveals it after the fallback delay`: the text contains `.rb-home-hinted .rb-landing__page`, `visibility: hidden`, an `animation` using `--home-hint-reveal-delay`, and `:root { --home-hint-reveal-delay: 3s; }`.
  - `AccountMenu.test.js`:
    - `SignedInMenu` with `myBoardsHref="/"` renders a link to `/` labelled `account.myBoards`;
    - with `myBoardsHref={null}`, it renders no My boards item.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - `HomeRoute`:
    - Read `hinted` once with `useState(readSignedInHint)`.
    - Remove `HOME_HINT_CLASS` from `document.documentElement` in a mount effect.
    - Render `Landing` or `<Workspace account={session?.account ?? null} createAction={<CreateMenu …/>} />`.
  - `AccountMenu`: pass `myBoardsHref = isLandingPath(location.pathname) ? null : '/'`. Export `isLandingPath` from `router.js` and reuse `LANDING_PATHS` plus the language-prefix rule from `parseRoute`. Add a router test for it.
- [ ] **Step 4:** Run the new and changed tests, `node --test src/client/app/router.test.js src/client/ui/i18n-keys.test.js`, then the full gate → PASS. Check that `rg -n "MyBoardsDialog" src` is empty.
- [ ] **Step 5:** Revert check: make `homeViewFor` return WORKSPACE for SIGNED_OUT when hinted. The matrix test must fail; restore it. Commit: `feat(home): signed-in people land in their workspace`.

### Task 8: Live check against the real stack

**Files:**
- Modify: `scripts/room-management-live-check.mjs`. Replace the My boards dialog steps (`openMyBoards`, `myBoardsDialog`) with workspace steps.
- Modify: `scripts/board-live-helpers.mjs`, only if `openLanding` must accept the workspace for signed-in contexts. Add `openWorkspace(page, baseUrl)`, which waits for the `workspace.title` heading in either language.

**Interfaces:** Consumes the whole branch. Produces a passing live run plus screenshots.

- [ ] **Step 1: Steps.** Use the stack documented in the script header (fake Google OIDC on port 4475). Context A signs in.
  1. A creates a board from the "Start · Stop · Continue" template, a locked board and a Poker room, all from the workspace create menu.
  2. On `/`, the three cards show the right thumbnails: the template board's svg has ≥3 `rect`s, the locked card shows the lock thumbnail, and the Poker card shows the Poker thumbnail.
  3. Context B opens the plain board. A renames it from the card; B sees the new title live.
  4. Search for the code narrows the list to one card. Sort by name changes the order as expected.
  5. A deletes the board from the card; B sees the deleted screen.
  6. On reload, `.rb-landing__page` is absent or hidden at `domcontentloaded` (no flash).
  7. A signs out from the workspace; `/` shows the landing's Create button without a reload.
  8. A fresh guest context sees the unchanged landing.
  9. Screenshots, th and en, at 1440×900 and 390×844.
- [ ] **Step 2:** Run it with `perl -e 'alarm 600; exec @ARGV' node scripts/room-management-live-check.mjs http://localhost:5201 <out>` → every step PASS and 0 page errors. Read the screenshots.
- [ ] **Step 3:** Kill the servers and confirm the ports are free. Commit: `test(live): workspace flows in the room-management live check`.
