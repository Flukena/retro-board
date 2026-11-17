# Signed-in workspace: the home page for people who are signed in

Status: approved by the owner ("ok", 2026-11-17). A builder check ran; its
questions were all settled as calls marked "my call" below.

## 1. Intent

A signed-in person who opens retroroom.party should land in a place to manage
their own work. Today they see the same marketing page as a guest, and
everything they own sits behind the account menu's small "My boards" dialog.

Owner request (2026-11-17): "ทำ design ให้หน้า landing ของคนที่สมัครแล้วมี ui
จัดการต่างๆ".

Owner decisions (2026-11-17):

1. **The home page becomes a workspace** for signed-in people. Guests keep
   today's landing page unchanged.
2. **What it manages:**
   - My boards: open, rename, delete, search, sort.
   - Creating every kind of room: a normal board, a password-locked board, a
     board from a template, a Planning Poker room.
   - The account: who you are, sign out, sign out everywhere, delete account.
3. **"Recently opened on this device" is not part of it.** The owner did not
   pick it.
4. **Boards are shown as a grid of cards.**
5. **Each card shows a real thumbnail of the board's zones** (option 2 of 3).
   This needs the relay to send zone geometry with the list.

## 2. Goals, non-goals, anti-goals

Goals:

- One screen after sign-in where a person finds, opens, renames and deletes
  their boards, and starts new ones.
- A board is recognisable at a glance by its zone layout.

Non-goals:

- folders, tags, favourites or pins;
- team or shared workspaces, transferring ownership;
- claiming boards created before ownership existed;
- live-updating the list while it is open;
- the recents section;
- a separate settings page.

Anti-goals (a failure even if it works):

- Any change to the guest landing page, its prerendered HTML or its SEO.
- Guests waiting longer for the landing page.
- A signed-in person seeing the marketing page flash before the workspace on
  repeat visits.
- Card contents (sticky text, names, comments, images) leaving the relay in
  the list response.
- Thumbnails or titles for locked boards. The relay cannot read them, and it
  must not try.

## 3. Constraints

- **Existing rooms are not listed.** Ownership is recorded only for rooms
  created from the room-management release (2026-11-17) on. Boards made
  earlier are not listed, and the empty state must say so plainly.
- **Existing list API:** `GET /api/account/rooms` returns
  `{ code, kind, locked, title, link, createdAt, lastActiveAt }`, newest first.
  Its limits:
  - one shared 30-per-minute account bucket covers list, rename and delete;
  - cold rooms are read through `createRoomTitleReader` with
    `MAX_CONCURRENT_TITLE_READS = 4`;
  - the 404 for a room you do not own is indistinguishable from a missing one.
- **Frozen file:** `RetroBoard.jsx` is frozen. All new code goes in focused
  modules with colocated tests (AGENTS.md).
- **UI rules:**
  - Warm Studio tokens only, from `src/client/ui/theme.js`;
  - every string through `t()` in all 11 languages: th and en in `i18n.js`,
    plus the 9 files in `src/client/ui/locales/`;
  - Sonar-clean, complexity at most 15.
- **Deploy:** this release needs the relay (`yjs`) as well as `web`.
  Recreating `yjs` disconnects open boards for a few seconds, and they
  reconnect on their own.

## 4. Approaches considered (thumbnails)

| | Approach | Trade-off |
|---|---|---|
| 1 | Kind icon only (board, locked, Poker), from data the list already has | Web-only deploy, but boards are hard to tell apart. |
| **2** | **Relay adds a bounded zone summary to each plain board's list entry; the client draws it with the template thumbnail** | **Same thumbnail on every device and recognisable at a glance. Needs a relay change. Locked boards get a lock pattern instead.** |
| 3 | The client stores each board's zone layout locally when it is opened | Works for locked boards, but only on devices where the board was opened, so it differs per device. |

**The owner picked 2.**

## 5. Design

### 5.1 Who sees what at `/`

- **Guest** (account status is not signed in): today's `Landing`, unchanged.
- **Signed in:** the `Workspace` replaces the landing content.
- **Avoiding the marketing flash:** keep a non-secret local hint that this
  browser was signed in last time, holding no account data. When the hint is
  present, render a workspace skeleton straight away, then confirm with
  `fetchAccount()`.
  - Hint present but the account is no longer signed in: clear the hint and
    show the landing.
  - No hint: render the landing as today, and switch only once
    `fetchAccount()` says signed in, as happens on a first visit after
    signing in.

  The prerendered HTML stays the guest landing.
- **The rest of the site stays reachable:** the marketing sections are not
  shown to signed-in people at `/`. Today's landing links "templates" and
  "FAQ" are in-page anchors (`#landing-guide-templates`, `#landing-guide-faq`)
  that do not exist in the workspace. My call: the workspace masthead keeps
  only links to real pages (Planning Poker, Agile guide), and templates are
  reached through the create menu.
- **Getting in from the landing page** (owner asked, 2026-11-17). The guest
  landing keeps the sign-in button it already has: "เข้าสู่ระบบด้วย Google",
  top right, from `AccountMenu` in `SiteMasthead`. Google returns the person
  to the page they left (`signInHref` passes `return=` with the current path),
  so on `/` the workspace appears at once. Later visits open straight into the
  workspace through the hint. Signing out clears the hint and returns the
  person to the guest landing. The guest landing itself does not change.

### 5.2 Layout

```
[RetroRoom]   templates · Poker · guide      [+ สร้างบอร์ด ▾] [ฟลุค ▾]

บอร์ดของฉัน (12)            [ค้นหา…]   [ใช้ล่าสุด ▾]
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ ▭▭▭▭     │ │ 🔒 ░░░░  │ │   🃏      │ │ ▭▭       │
│ Sprint 42│ │ ทีม A     │ │ Poker 7  │ │ (code)   │
│ 2 ชม.  ⋯ │ │ เมื่อวาน ⋯│ │ 3 วัน   ⋯│ │ 1 สัปดาห์ ⋯│
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```

- **Grid:** responsive, with 1 column on phones and up to 4 on wide screens.
- **Card contents:**
  - Thumbnail:
    - plain board: its zones;
    - board with no zones yet: an empty-board pattern;
    - locked board: a lock pattern;
    - Poker: a cards icon.
  - Title: the board title, or the room code when it has no title, or when it
    is locked.
  - Kind badge, for locked boards and Poker.
  - Last active, as relative time.
  - A `⋯` menu with Open, Rename and Delete:
    - Rename works on plain boards only. Poker rooms show no title anywhere
      (`poker/` never reads `meta.title`), so they have no Rename and their
      card reads "Planning Poker · <code>" (my call). For a locked board it is
      disabled, with a hint to rename it inside the board (owner menu).
    - Delete uses the existing type-the-code confirmation.
- **Clicking the card** opens the room (its site-relative `link`).
- **Search** filters by title or code on the client.
- **Sort:**
  - last used (default, `lastActiveAt`);
  - newest created (`createdAt`);
  - name (title, falling back to code).
- **Empty state:** "บอร์ดที่คุณสร้างตอนล็อกอินจะแสดงที่นี่", a create button,
  and one line noting that boards made before 17 Nov 2026 open from their
  link and are not listed.
- **Error state:** shown inline with Retry. A 429 shows the existing
  "try again shortly" copy.

### 5.3 Create menu ("+ สร้างบอร์ด")

- **บอร์ดใหม่:** an optional name, then create. This uses the existing
  `useCreateBoard`.
- **บอร์ดล็อกรหัส:** the existing `CreateLockedRoom` flow.
- **เริ่มจากเทมเพลต:** the existing 4 formats (`FormatChips` / starters).
- **ห้อง Planning Poker:** creates a Poker room the same way the Poker page
  does.

Every create is owned, because the person is signed in, so the room appears in
the list next time it is loaded.

### 5.4 Account menu

- Header: name and email, from `/api/account`.
- Items: sign out, sign out on all devices, delete account (existing
  confirmation).
- The "My boards" item goes away on `/`, because the page itself is My boards.
  If the My boards dialog then has no remaining caller, it is removed
  together with its now-orphaned code.

### 5.5 Relay: zone preview in the list

Each list entry gains `preview`:

- **Plain board:** `{ zones: [{ x, y, w, h, color }] }`, taken from the same
  document load the title already uses. The title comes from the `meta` map
  and the zones from the `items` map of that one document. That means the
  same bounded loader, with no extra document load and no registration of
  cold docs. My call: the title reader becomes one room-summary reader
  returning `{ title, preview }`, and its one caller in `yjs-server.mjs` is
  updated. It does not become a second function that loads the doc twice.
- **Locked board, Poker room, or a board with no valid zones:** `null`.

Bounds and validation:

- Zone geometry must pass the existing domain geometry rules: finite numbers
  within board bounds, positive bounded `w`/`h`.
- `color` must be a valid palette index; anything else falls back to the
  palette fallback.
- At most `MAX_PREVIEW_ZONES` zones. My call: draw all zones, nested ones
  included (they carry absolute coordinates), exactly as `templateThumbnail`
  already does, and keep the largest by area when there are more than the
  cap. The builder picks the cap value and names it.
- List size: an account owns at most `MAX_OWNED_ROOMS_PER_ACCOUNT` (500)
  rooms. My call: no paging. Previews ride on the document load the list
  already pays for, so the extra cost per room is only reading the `items`
  map. Paging is a later change if real accounts grow large.

Privacy: only zone rectangles and colour indexes leave the relay. Zone titles,
card text, names and images do not. The owner already has full access to
these rooms; even so, the list stays geometry-only.

Failure handling: a preview read failure follows the title read rules
(storage failure → 503 and the failure latch; a room deleted mid-read is
dropped).

### 5.6 Client reuse

- `my-boards-controller.js` holds list, rename and delete, plus local updates
  without refetching. Search and sort are added as pure functions beside it.
- Dialogs: `TypeToConfirmDialog` and `BoardTitleDialog`.
- Thumbnails: `TemplateThumbnail` / `templateThumbnail()`. The component
  hardcodes 48×32 px today, so it gains size props, keeping 48×32 as the
  default. The rounded zone corners come from the landing-polish branch
  (`fix/landing-polish`), which is merged first.
- Poker card icon and the empty-board pattern are new, designed by the
  builder from Warm Studio tokens and lucide icons.
- `useCreateBoard`, `CreateLockedRoom` and `FormatChips` handle creation.

## 6. Testing

- **Relay:**
  - preview extraction (unit): cap, invalid zones skipped, bad colour
    fallback, locked or Poker gives `null`, no text fields leak;
  - route test on a real registry: one read per room, preview beside title,
    the 404 still indistinguishable;
  - storage failure gives 503.
- **Client:**
  - search and sort (pure);
  - workspace render (SSR) in th and en: loading skeleton, empty, list, error;
  - card menu rules (locked rename disabled);
  - home routing: guest gets landing; signed-in with hint gets workspace with
    no landing flash; stale hint falls back to landing; no hint shows landing
    and then workspace.
- **Live:** two contexts, with fake Google OIDC as in
  `room-management-live-check.mjs`.
  1. A signs in, creates a board with zones, a locked board and a Poker room.
  2. `/` shows all three cards with the right thumbnails.
  3. Rename from the card; B, inside the board, sees it live.
  4. Delete from the card; B sees the deleted screen.
  5. Search and sort work.
  6. A guest context sees the unchanged landing.

  Capture th and en at 1440 px and 390 px, and read the screenshots.

## 7. Left to the builder

- Card size and the skeleton look, within Warm Studio tokens.
- The `MAX_PREVIEW_ZONES` value and its selection rule.
- The hint's storage key and lifetime.
- Whether the masthead site links collapse into a menu on phones.
