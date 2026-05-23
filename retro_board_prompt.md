# Prompt: Miro-Style Retrospective Board with Admin Controls

## บทบาทและเป้าหมาย

คุณคือ senior frontend engineer สร้าง **React artifact ไฟล์เดียว** (`.jsx`, default export) ที่ทำงานเป็น infinite-canvas retrospective board แบบ Miro สำหรับทีม agile โดยมีระบบ admin, voting timer, และ private card

---

## ข้อจำกัดทางเทคนิค

- React functional component เดียว, default export
- ใช้ hooks เท่านั้น: `useState`, `useEffect`, `useRef`, `useCallback`, `useMemo`
- Inline styles หรือ Tailwind core utilities (ห้ามใช้ Tailwind config นอก base)
- Icons: `lucide-react`
- **State ทั้งหมดเก็บผ่าน `window.storage` เท่านั้น** — ห้ามใช้ `localStorage`/`sessionStorage`
  - `await window.storage.get(key, shared?)` → `{value} | null`
  - `await window.storage.set(key, value, shared?)`
  - `shared: true` = ทุกคนเห็นข้อมูลเดียวกัน (ข้อมูล board)
  - `shared: false` = แยกเฉพาะแต่ละ user (identity, viewport)
- ห้าม import library อื่นนอกจาก `react` และ `lucide-react`

---

## สถาปัตยกรรมหลัก

### Data model
ทุก item อยู่ใน array เดียว แต่มี `type` ต่างกัน:

```ts
type Item = StickyNote | TextLabel | Zone

interface Common {
  id: string
  type: 'sticky' | 'text' | 'zone'
  x: number   // world coord
  y: number
  authorId: string
  authorName: string
  createdAt: number
}

interface StickyNote extends Common {
  type: 'sticky'
  text: string
  color: 0..5         // index ใน COLORS palette
  rotation: number    // ±1.5° random
  votes: string[]     // array of userId ที่โหวต
  private: boolean    // ดูข้อ Private Cards
  zoneId?: string     // อ้างถึง zone ที่ครอบอยู่ (auto-compute)
}

interface TextLabel extends Common {
  type: 'text'
  text: string
}

interface Zone extends Common {
  type: 'zone'
  title: string
  color: 0..5
  w: number
  h: number
}
```

### Coordinate system
- ทุก item เก็บพิกัด `(x, y)` ใน **world space** (ไม่ใช่ screen)
- `viewport = { x, y, zoom }` เป็น screen offset และ scale
- Render layer ใช้: `transform: translate(viewport.x, viewport.y) scale(viewport.zoom)`
- แปลง screen → world: `worldX = (screenX - viewport.x) / viewport.zoom`
- Zoom รอบ cursor:
  ```js
  const worldX = (cursorX - viewport.x) / viewport.zoom
  const newViewportX = cursorX - worldX * newZoom
  ```
- Render order: zones ก่อน (อยู่หลัง) แล้วค่อย sticky/text (อยู่หน้า)

---

## ฟีเจอร์

### 1. Infinite Canvas
- ลากพื้นที่ว่าง → pan
- Mouse wheel → zoom (range 0.15–3.0)
- Toolbar ขวาล่าง: ZoomIn / ZoomOut / `xx%` / Fit-to-content
- Background: dotted grid ที่ scale ตาม zoom และเลื่อนตาม viewport
  ```css
  background-image: radial-gradient(circle, rgba(0,0,0,0.13) 1px, transparent 1px);
  background-size: ${24 * zoom}px ${24 * zoom}px;
  background-position: ${viewport.x}px ${viewport.y}px;
  ```
- Empty state: ข้อความตรงกลาง "ดับเบิลคลิกเพื่อเริ่ม · เลือก template ด้านล่าง"

### 2. Sticky Notes
- **ดับเบิลคลิกพื้นที่ว่าง** → สร้าง sticky ที่ world point นั้น, เข้า edit mode อัตโนมัติ
- **คลิก** → select (เด้ง action toolbar เหนือ note)
- **Action toolbar**: 6 color swatches | toggle private 🔒/🔓 | delete
- **ดับเบิลคลิก** → edit; Enter = save, Esc = cancel (ลบถ้าว่าง), Shift+Enter = newline
- **ลาก** → move
- Vote button ด้านล่าง: per-user 1 vote (toggle)
- ผู้เขียน label เล็กๆ มุมล่าง
- Rotation ±1.5° random ตอนสร้าง, แต่ตั้งเป็น 0 ตอน selected
- ขนาด 200x180

### 3. Text Labels
- หัวข้อ handwritten-style ตัวใหญ่ (Caveat font หรือใกล้เคียง)
- ไม่มีพื้นหลัง, ใช้ label พื้นที่ภายนอก zone
- Edit/move/delete เหมือน sticky

### 4. Zones (Frames) — ⭐ สำคัญ
- กล่องสี่เหลี่ยมโปร่งใส + title bar เหนือ zone
- **Title bar** (สูง ~32px, อยู่ที่ `top: -32px`):
  - แสดงชื่อ zone + count ของ sticky ข้างใน
  - **ลาก** → ย้าย zone **พร้อม sticky/text ที่อยู่ข้างใน**
    - ที่ mousedown: หา children ทั้งหมดที่ center อยู่ใน bounds ของ zone
    - ระหว่าง mousemove: apply delta เดียวกันกับ zone และ children
  - **ดับเบิลคลิก** → edit title
- **Zone body**: `pointer-events: none` — events ทะลุไปที่ canvas ข้างใต้
  - ผู้ใช้ยังสามารถ pan, ดับเบิลคลิกสร้าง note ในพื้นที่ zone ได้ตามปกติ
- **Resize handles** ที่ 4 มุม (nw/ne/sw/se) — แสดงเฉพาะตอน selected
  - มุมตรงข้ามคงที่, ปรับ x/y/w/h ตาม corner
  - Min size: 240x200
- **Color**: zone background ใช้ tint 10% opacity จาก palette, border 2px สีเข้ม
- **Templates dropdown** — คลิกเลือก preset แล้ว zones ถูกวางที่กลาง viewport:

  ```js
  const TEMPLATES = {
    'retro3': [
      { title: '😊 ที่ทำได้ดี', color: 2, x: 0,   y: 0, w: 380, h: 520 },
      { title: '😞 ที่ควรปรับปรุง', color: 1, x: 400, y: 0, w: 380, h: 520 },
      { title: '🚀 สิ่งที่จะทำต่อ', color: 3, x: 800, y: 0, w: 380, h: 520 },
    ],
    'ssc': [ // Start / Stop / Continue
      { title: '▶️ Start', color: 2, ... },
      { title: '⏹ Stop', color: 1, ... },
      { title: '⏩ Continue', color: 3, ... },
    ],
    'fourLs': [ // Liked / Learned / Lacked / Longed for (2x2 grid)
      ...
    ],
    'sailboat': [ // Wind / Anchor / Rocks / Island (2x2)
      ...
    ],
  }
  ```

### 5. Admin Role System ⭐
- **2 roles**: `admin`, `participant`
- ระบุตัวตน: แต่ละ user มี `userId` (uuid random) เก็บใน per-user storage, และ `userName` ที่แก้ได้
- **ครั้งแรก** ที่เปิด board ว่าง → user นั้นเป็น admin อัตโนมัติ (เก็บ `adminUserId` ใน shared storage)
- **Admin badge** แสดงในแถบบน
- **Admin actions** (participant เห็นปุ่มเหล่านี้แต่ disabled + tooltip "admin only"):
  - 🔒 Lock/unlock voting (ห้ามคนอื่นโหวต)
  - ✏️ Lock/unlock editing (participants ดูได้แต่แก้/เพิ่มไม่ได้)
  - 👁 Reveal/hide all private cards
  - ⏱ Start/stop/extend voting timer
  - 🧹 Clear board
  - 👑 Transfer admin: dropdown รายชื่อ user online → โอนสิทธิ์
- **Presence**: ทุก user เขียน `users:{userId}` ใน shared storage ทุก 8 วินาที (heartbeat: `{name, lastSeen, isAdmin}`)
  - ถือว่า online ถ้า `Date.now() - lastSeen < 20000`
  - แสดง avatar (initial + สี hash จาก userId) ในแถบบน
  - ถ้า admin หาย > 60 วินาที → user ที่ online เก่าสุด auto-promote (ทุก client ตรวจสอบและพยายาม claim พร้อมกัน — ใช้ deterministic election: เลือก userId ที่น้อยที่สุด)

### 6. Voting Timer ⭐
- Admin กดปุ่ม Timer → เปิด popover เลือก:
  - Preset: 1 / 3 / 5 / 10 นาที + custom input
  - Votes per user: default 3 (1–10)
- เก็บใน shared storage:
  ```js
  timer: {
    endsAt: number,       // Date.now() + duration
    voteLimit: number,
    startedAt: number,
  } | null
  ```
- **ระหว่าง timer ทำงาน**:
  - Big countdown ตรงกลางด้านบน (mm:ss) — สีแดงเข้มเมื่อ <30s, pulse animation
  - Voting unlocked สำหรับทุกคน (override voting lock)
  - Badge เล็กข้าง avatar: "X votes left" (`voteLimit - userVotesUsed`)
  - User กดโหวตเกิน limit → ปุ่ม disabled + toast "หมดโควต้าโหวต"
- **เมื่อหมดเวลา**:
  - Voting auto-lock
  - Cards เรียงตามคะแนนโหวต (สูง→ต่ำ) ที่ด้านบนของแต่ละ zone (smooth animation)
  - Top 3 cards ใน scope ทั้ง board ถูก highlight ด้วย glow effect
  - Admin เห็นสรุป "ผลโหวต: 12 votes จาก 4 users"
- Admin extend ได้: เพิ่ม 1/2/5 นาที
- Admin stop ก่อนหมดเวลาได้

### 7. Private Cards ⭐
- ฟีเจอร์เด่นของ retro แบบ Miro — **brainstorm แบบเงียบ** เพื่อหลีกเลี่ยง groupthink และ recency bias
- ทุก sticky ใหม่ default เป็น `private: true`
- **มุมมองของแต่ละคน**:
  - **เจ้าของ card**: เห็นข้อความเต็ม + icon 🔒 มุมขวาบน
  - **คนอื่น**: เห็น blur effect บนข้อความ + overlay "🔒 ซ่อนอยู่" + ชื่อผู้เขียน
    ```css
    filter: blur(8px);
    user-select: none;
    ```
  - Vote button **disabled** ตอนยังถูกซ่อน (โหวตของที่อ่านไม่ได้ไม่ make sense)
- **Toggle ที่ระดับ card** (เจ้าของหรือ admin):
  - ปุ่ม 🔒/🔓 ใน action toolbar ของ card
- **Toggle ที่ระดับ board** (admin only):
  - ปุ่มใหญ่ "👁 Reveal All" ในแถบบน
  - เปลี่ยน `boardState.allRevealed = true` → ทุก private card กลายเป็น public พร้อมกัน
  - ใช้ตอน "เปิดไพ่พร้อมกัน" หลัง brainstorm phase
  - Admin "Hide All" ก็ทำได้ (reset เป็น private อีกรอบ — เฉพาะ cards ที่ originally private)

---

## Persistence Schema

### Shared (`shared: true`) — ทุก client เห็นเหมือนกัน
```js
"boardState" → {
  items: Item[],
  adminUserId: string,
  votingLocked: boolean,
  editingLocked: boolean,
  allRevealed: boolean,
  timer: { endsAt, voteLimit, startedAt } | null,
}

"users:{userId}" → {
  userId: string,
  name: string,
  lastSeen: number,
}
```

### Per-user (`shared: false`)
```js
"userId" → string (uuid)
"userName" → string
"viewport" → { x, y, zoom }   // แต่ละคนเก็บมุมมองของตัวเอง
"votesUsed:{timerStartedAt}" → number   // นับโควต้าโหวตในรอบ timer ปัจจุบัน
```

### Sync pattern
- Polling shared storage ทุก 2 วินาที (หรือเร็วกว่าตอน timer running: ทุก 500ms)
- Optimistic update: เขียน local state ก่อน แล้วยิง storage.set async
- Debounce save ของ `boardState` 250ms เพื่อกัน thrash ตอนลาก

---

## Visual Design Direction

- **Theme**: Light, paper-like, warm
- **Background**: `#f8f7f4` พร้อม dotted grid โปร่งๆ
- **Fonts**:
  - UI: `'Plus Jakarta Sans'` (Google Fonts)
  - Body ภาษาไทย: `'Sarabun'`
  - Text labels บน canvas: `'Caveat'` (cursive)
- **Color palette** (สำหรับทั้ง sticky และ zone):
  ```js
  COLORS = [
    { bg:'#fef3c7', border:'#f59e0b', zoneBg:'rgba(251,191,36,0.12)' }, // yellow
    { bg:'#fecaca', border:'#ef4444', zoneBg:'rgba(239,68,68,0.10)'  }, // red
    { bg:'#bbf7d0', border:'#22c55e', zoneBg:'rgba(34,197,94,0.10)'  }, // green
    { bg:'#bae6fd', border:'#0ea5e9', zoneBg:'rgba(14,165,233,0.10)' }, // blue
    { bg:'#e9d5ff', border:'#a855f7', zoneBg:'rgba(168,85,247,0.10)' }, // purple
    { bg:'#fed7aa', border:'#f97316', zoneBg:'rgba(249,115,22,0.10)' }, // orange
  ]
  ```
- **Selected items**: 2px outline + offset 6px (ไม่ใช้ solid border ทับ)
- **Shadows**: นุ่ม `0 6px 14px rgba(0,0,0,0.12)` สำหรับ sticky
- **Top bar**: 60px สูง, `rgba(255,255,255,0.92)` + backdrop-filter blur
- **Floating toolbars**: rounded 10px, white bg, soft shadow, มุมล่างซ้าย/ขวา
- **Timer**: ใหญ่ ตรงกลางบน, font tabular-nums, animate pulse เมื่อ <30s

---

## Interactions & Shortcuts

| Action | Trigger |
|---|---|
| Pan canvas | ลากพื้นที่ว่าง |
| Zoom | Mouse wheel (รอบ cursor) |
| Create sticky | ดับเบิลคลิกพื้นที่ว่าง |
| Select item | คลิก |
| Edit item | ดับเบิลคลิก |
| Save edit | Enter |
| New line in edit | Shift + Enter |
| Cancel edit | Esc |
| Delete selected | Delete / Backspace |
| Deselect | Esc / คลิกพื้นที่ว่าง |
| Drag zone with contents | ลาก title bar ของ zone |
| Resize zone | ลาก corner handle |

---

## Edge Cases & Constraints

- **Storage failure**: ทุก `storage.set` ใน try/catch, optimistic UI ไม่ block
- **Concurrent edit**: last-write-wins (KV store ไม่มี CRDT — ระบุใน comment ของ code)
- **Admin disconnect**: หลัง 60s ไม่มี heartbeat → election (userId ตัวเล็กสุดที่ online ชนะ)
- **Empty board ครั้งแรก**: เปิด templates panel อัตโนมัติเป็น hint
- **No userName ตอนแรก**: เปิด modal ถามชื่อก่อนใช้งาน, default = "Guest-{4 digits}"
- **Voting limit overflow**: นับ `votesUsed` per timer session, reset เมื่อ timer ใหม่
- **Private card vote**: นับเข้าโควต้า user แม้คนอื่นยังเห็นเป็น blur
- **Right-click**: `preventDefault()` ทั้งหมด (เผื่อ context menu อนาคต)

---

## Deliverable

- ไฟล์เดียว `.jsx`, default export
- โครงสร้างชัดเจน แบ่งเป็น section: imports → constants → component → state → storage hooks → coordinate helpers → item ops → interactions → render
- มี comment สั้นๆ อธิบาย section
- Code production-grade, ไม่มี TODO, ไม่มี dead code
- UI โปรเฟสชันแนล ไม่เหมือน AI-generated default

---

## ขั้นตอนแนะนำในการสร้าง

1. เริ่มจาก infinite canvas + sticky ก่อน (ฟีเจอร์ 1+2)
2. เพิ่ม zones + templates (ฟีเจอร์ 4)
3. เพิ่ม user identity + admin election (ฟีเจอร์ 5)
4. เพิ่ม voting timer (ฟีเจอร์ 6)
5. เพิ่ม private cards (ฟีเจอร์ 7)
6. Polish: animations, presence avatars, sort-on-timer-end
