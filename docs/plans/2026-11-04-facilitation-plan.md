# แผน 4–6: Follow presenter, ช่วงของประชุม, Mood check (2026-11-04)

สถานะ: **แผน ยังไม่ได้ implement** ต่อยอดจาก branch `feat/retro-outcomes` (action items, summary, PNG/PDF)

## ข้อจำกัดร่วม (จากโค้ดปัจจุบัน)

- **`RetroBoard.jsx` ต่อสายได้อย่างเดียว ห้ามใส่ logic** เพดานบรรทัดอยู่ที่ 4023 (`src/rule-ratchets.test.js`) ดังนั้นต้องสร้างโมดูลใหม่ใต้ `src/` พร้อม `*.test.js` และถ้าจำเป็นให้ย้ายโค้ดเดิมออกเพื่อเปิดที่ให้สายเชื่อมต่อ
- **การควบคุมของ admin เป็นแค่ workflow ฝั่ง client ไม่ใช่ขอบเขตความปลอดภัย** (`SECURITY.md:60-74`) presence/view ปลอมได้ ทุกฟีเจอร์ด้านล่างจึงเป็น "ตัวช่วยคนที่ร่วมมือกัน" ไม่ใช่สิทธิ์
- **meta field ใหม่ต้องลงทะเบียน 4 ที่** ไม่อย่างนั้นจะหายเงียบตอนอ่าน:
  1. `META_FIELDS` ใน `remote-board-decoder.js` พร้อม validator
  2. ค่าเริ่มต้นใน `board-state.js`
  3. `normalizeBoardMeta` ใน `import-schema.js`
  4. รายการ meta ฝั่ง export/import ใน `board-transfer.js`

  และต้อง reset ใน `adminClearBoard`
- **Undo:** การเขียน `meta` แบบ `'local'` จะเข้า undo stack ของคนกด ทุกสถานะของห้อง (presenter, phase, mood round) จึงเขียนด้วย `{silent:true}` ตามแบบ admin election (`admin-role-model.js:90-96`) ส่วนการเปลี่ยนการ์ดยังคง undo ได้ตามเดิม
- **Public board:** relay ตรวจแค่การสร้าง item ใน `items` (`public-action-limit.js`) จึงห้ามเพิ่ม item type ใหม่ meta/kv ใหม่ผ่านได้ ในโหมด public ทุกคนจัดการห้องได้ ห้องแบบนี้จึงต้องมีกติกาเพิ่ม (ดูแต่ละข้อ)
- **i18n:** คีย์ใหม่ต้องมีครบ 11 ภาษา (`i18n-keys.test.js`)

---

## 4. Follow presenter (ทุกคนตามจอของคนดำเนินประชุม)

**สิ่งที่มีอยู่แล้ว:** การ follow รายคนทำงานในเครื่องผู้ใช้แต่ละคน
- เริ่มด้วย `startFollowing`/`stopFollowing` ที่ `RetroBoard.jsx:1631-1695`
- เปิดได้จาก `PlayerRow` ใน `TopBarPopovers.jsx:174-207` และมีแบนเนอร์ `FollowBanner`
- view ของแต่ละคนกระจายผ่าน awareness ทุก 100 ms (`awareness-transport.js`)
- การเลื่อนหรือซูมเองจะเรียก `stopFollowing` อยู่ราว 12 จุด

แผนข้อนี้จึงแค่เพิ่ม **สัญญาณระดับห้อง** ให้ทุกคนเริ่ม follow เอง โดยไม่ต้องเขียนกลไก follow ใหม่

**ข้อมูล**
- เพิ่ม `meta.presenterUserId` เป็น string id หรือ null และเขียนแบบ silent
- validator ใช้ `isSafeId`
- import และ clear board จะ reset เป็น null เพราะเป็นสถานะของประชุมครั้งนั้น ไม่ใช่เนื้อหาของบอร์ด

**โมดูลใหม่**
- `src/domain/presenter.js` เป็นฟังก์ชันล้วน `presenterFollowDecision({presenterUserId, userId, onlineIds, optedOutFor, followedUserId})` คืนค่า `follow | stop | none` และ `isValidPresenter`
- `src/client/board/use-presenter-follow.js` เป็น hook ที่:
  - เรียก `startFollowing(presenter)` เมื่อมี presenter ใหม่
  - จำ `optedOutFor = presenterUserId` เมื่อผู้ชมเลื่อนหรือซูมเอง จนกว่าจะกด "กลับไปตาม" หรือ presenter เปลี่ยนคน
  - หยุดตามเมื่อ presenter ออฟไลน์ ซึ่งใช้ toast `follow.ended` ที่มีอยู่แล้ว

**UI**
- เมนู More ของ admin มีรายการ "เริ่มนำเสนอ" และ "หยุดนำเสนอ"
- ปุ่ม 👁 ใน `PlayerRow` ให้ admin "ให้ทุกคนตามคนนี้" ได้
- `FollowBanner` แสดงคำว่า "กำลังตาม presenter" และปุ่ม "เลิกตาม" ระหว่างตาม ถ้าผู้ชมเลิกตามไปแล้ว แบนเนอร์เปลี่ยนเป็นปุ่ม "กลับไปตาม"
- presenter เห็นป้าย "คุณกำลังนำเสนอ · N คนกำลังตาม" ตัวเลข N มาจากการเพิ่มฟิลด์ awareness `following` เข้าไปใน `createMotionPublisher` (ปัจจุบันรับได้แค่ `cursor`/`view` ที่บรรทัด 35)

**Public board:** ปิดฟีเจอร์นี้ เพราะทุกคนเป็น manager จะแย่งกันเป็น presenter ได้ ให้แสดงเมนูเฉพาะห้อง private ซึ่งตรงกับที่ admin claim/transfer เป็น private-only (`SECURITY.md:271`)

**เทสต์**
- unit ของ `presenterFollowDecision` ครอบ 4 กรณี: opt-out, presenter เปลี่ยนคน, presenter คือตัวเอง, presenter ออฟไลน์
- decoder ปฏิเสธ id ที่ไม่ปลอดภัย
- import และ clear reset ค่าเป็น null
- live check 2 เบราว์เซอร์:
  - A เริ่มนำเสนอ → B ตามจอ
  - B เลื่อนเอง → B หยุดตาม
  - B กด "กลับไปตาม" → ตามต่อ
  - A หยุด → B หยุด
  - undo ของ A ไม่ยกเลิกโหมดนำเสนอ

**ขนาดงาน:** เล็ก–กลาง (ประมาณ 3 โมดูล + i18n) **ควรทำก่อน** เพราะต่อยอดของเดิมเกือบทั้งหมด

---

## 5. ช่วงของประชุม (เขียน → เปิดเผย → จัดกลุ่ม → โหวต → คุย → action items)

**สิ่งที่มีอยู่แล้ว:** สวิตช์แยกกันเป็นชิ้น ๆ
- `editingLocked` อยู่ระดับบอร์ด
- การเปิดเผยการ์ดอยู่ **ระดับโซน** (`zone.revealed`, `toggleReveal`)
- ตัวจับเวลาและโหวตอยู่ **ระดับโซน** (`zone.voteTimer`, `startVoteSession`, และ relay จะปิดโหวตเองเมื่อหมดเวลา)
- ฟิลด์ `meta.allRevealed`, `meta.votingLocked` และ `meta.timer` เป็นของเก่า ใช้แค่ตอน reset

**สิ่งที่ต้องตัดสินใจ (ค่าเริ่มต้นที่เสนอ):** ช่วงเป็น **ตัวนำทาง + ปุ่มลัด** ไม่ใช่ state machine ที่ล็อกทุกอย่างอัตโนมัติ
- การเปลี่ยนช่วงเขียนแค่ `meta.phase`
- ผลที่เกิดขึ้นตามมาเรียกฟังก์ชันเดิมที่ undo ได้อยู่แล้ว

เหตุผล: การเปิดเผยและการโหวตเป็นระดับโซน การเลือกให้อัตโนมัติว่าโซนไหนจะเดาผิดได้ง่าย

**ข้อมูล**
- เพิ่ม `meta.phase = { id, startedAt } | null` โดย id เป็นหนึ่งใน `write | reveal | group | vote | discuss | actions` และเขียนแบบ silent
- import และ clear reset เป็น null

**โมดูลใหม่**
- `src/domain/retro-phase.js` เป็นฟังก์ชันล้วน:
  - `RETRO_PHASES` เรียงตามลำดับ
  - `nextPhase(id)`
  - `phaseActions(phase, board)` คืน "การกระทำที่แนะนำ" เป็นข้อมูล ไม่ใช่ side effect:
    - `write` → ปลดล็อกการแก้ไข
    - `reveal` → รายชื่อโซนบนสุดที่ยังไม่เปิดเผย ให้กด "เปิดทั้งหมด"
    - `vote` → โซนที่แนะนำ แล้วเปิด `TimerSetup` ของโซนนั้น
    - `discuss` → ล็อกการแก้ไข และแสดงการ์ดยอดนิยมจาก `vote-results`
    - `actions` → เปิดแผง Action items
  - `isPhaseState` ใช้เป็น validator
- `src/client/board/PhaseBar.jsx` และ `phase-bar-model.js`:
  - เป็นแถบลำดับขั้นใน `TopCenterStack` เหนือ `TimerDock`
  - แสดงช่วงปัจจุบันและเวลาที่ผ่านไป
  - admin มีปุ่ม "ช่วงถัดไป" และปุ่มลัดของช่วงนั้น คนอื่นเห็นแบบอ่านอย่างเดียว
- `src/client/board/use-retro-phase.js` ผูกปุ่มลัดเข้ากับฟังก์ชันเดิม คือ `adminToggle('editingLocked')`, `toggleReveal` ของแต่ละโซน, `setTimerSetupZoneId` และ `actionItems.show`

**ต่อกับฟีเจอร์ 2:** ถ้ามี `phase` ให้สรุป Markdown บอกด้วยว่าประชุมไปถึงช่วงไหน (ไม่บังคับ)

**Public board:** แสดง PhaseBar ได้ แต่ทุกคนกด "ถัดไป" ได้ ต้องเลือกระหว่าง ซ่อนปุ่มใน public หรือ ยอมให้เป็นแบบนั้น ค่าเริ่มต้นที่เสนอคือ **ซ่อนใน public**

**เทสต์**
- unit: ลำดับช่วง, ช่วงสุดท้ายไม่มีช่วงถัดไป, `phaseActions` เลือกเฉพาะโซนบนสุดที่ยังไม่เปิดเผย, validator ปฏิเสธ id แปลก
- live: admin กดถัดไปครบ 6 ช่วงในภาษา th/en โดยฝั่ง B เห็นช่วงเปลี่ยน
- ยืนยันว่ากด undo ของ admin แล้ว `phase` ไม่ย้อน แต่ reveal ที่กดผ่านปุ่มลัดยังย้อนได้

**ขนาดงาน:** กลาง เหตุผลหลักคือ UI ของแถบ และต้องหาบรรทัดว่างใน `RetroBoard.jsx` ควรทำหลังข้อ 4

---

## 6. Icebreaker / Mood check ตอนเริ่มประชุม

**สิ่งที่มีอยู่แล้ว:** reaction ของ Planning Poker (`poker-reactions.js`)
- อยู่ใน awareness อย่างเดียว อายุ 2.4 วินาที
- หายเมื่อ reload และปลอมได้

เหมาะกับ "ปฏิกิริยาชั่วคราว" แต่ **ไม่เหมาะกับ mood check** ที่ต้องเก็บผลรวมไว้ใส่ในสรุปและ backup จึงใช้ซ้ำแค่ชุด emoji และ CSS ลอยของ `SeatReactions`

**ข้อมูล**
- รอบการเช็ก: `meta.moodCheck = { id, startedAt, open } | null` เขียนแบบ silent โดยเปิดและปิดได้เฉพาะ admin
- คำตอบ: เก็บใน `kv` เป็นคีย์ `s||mood:<roundId>:<userId>` ค่า 1–5 ตามแบบ votes/comments
  - ได้ sync และ undo ของคนตอบเองโดยอัตโนมัติ
  - relay ของ public ไม่ตรวจ kv
- backup: เพิ่ม `moods` ใน manifest (`createJsonBackupArtifact` → `normalizeImportManifest` → `importBundle`) พร้อม validator และเพดานจำนวนระเบียน ตามกฎ round-trip ใน `AGENTS.md`
- จุดที่ต้องตัดสินใจ: ถ้าไม่อยากให้ mood เข้า backup ต้องเขียนไว้ใน `CONTEXT.md` ว่าเป็นข้อมูลชั่วคราว ค่าเริ่มต้นที่เสนอคือ **ให้เข้า backup** เพื่อให้ export/import ได้บอร์ดเดิมครบ

**ความเป็นส่วนตัว:** ระหว่างรอบยังเปิดอยู่ แสดงแค่จำนวนคนที่ตอบแล้ว ปิดรอบแล้วจึงแสดง histogram แบบไม่ระบุชื่อ ไม่แสดงว่าใครตอบอะไร (ถึงอย่างนั้นข้อมูลใน kv ยังอ่านได้ทั้งห้องตาม `SECURITY.md`)

**โมดูลใหม่**
- `src/domain/mood-check.js` เป็นฟังก์ชันล้วน:
  - `MOOD_SCALE` ค่า 1–5 คู่กับ emoji
  - `normalizeMoodEntry`
  - `moodSummary(entries, roundId)` คืน `{count, histogram, average}`
  - `moodKey`
- `src/client/board/MoodCheckDialog.jsx`: ป๊อปอัปเลือก emoji ที่เด้งขึ้นให้ทุกคนเมื่อ admin เปิดรอบ ผู้ใช้กด "ข้ามไปก่อน" ได้
- `MoodResultCard.jsx`: การ์ดแสดงผลหลังปิดรอบ ใช้แบบเดียวกับ `VoteResultsCard`
- `storage-bridge`: เพิ่ม `setMood`/`snapshotMoods` ตามแบบ comments

**ต่อกับฟีเจอร์ 2:** สรุป Markdown มีหัวข้อ "Mood" (histogram + ค่าเฉลี่ย) เมื่อมีรอบที่ปิดแล้ว

**Public board:** ใช้ได้ แต่ต้องเพิ่มเพดานจำนวนคำตอบต่อรอบใน validator

**เทสต์**
- unit: histogram/average, ปฏิเสธค่า 0, 6, ไม่ใช่ตัวเลข และ id ไม่ปลอดภัย, คำตอบของรอบเก่าไม่ถูกนับ
- round-trip ของ backup
- live: A เปิดรอบ → B ตอบ → A เห็นจำนวนคนตอบเพิ่ม → ปิดรอบ → ทั้งสองฝั่งเห็น histogram เดียวกัน → summary มีหัวข้อ Mood

**ขนาดงาน:** กลาง–ใหญ่ เพราะต้องแตะ storage-bridge และ manifest ของ backup ควรทำเป็นข้อสุดท้าย

---

## สิ่งที่ทำจริงต่างจากแผน (2026-11-04)

- **ข้อ 4:** ไม่มีตัวนับจำนวนคนที่ดูตาม และไม่มีปุ่ม "ให้ทุกคนดูตามคนนี้" ในรายชื่อผู้เล่น เริ่ม/หยุดนำเสนอได้จากเมนูเพิ่มเติม คนที่เลื่อนจอออกเองจะเห็นปุ่ม "กลับไปดูตาม"
- **ข้อ 5:** ทั้งแถบช่วงประชุมใช้ได้เฉพาะห้อง private (ห้อง public ไม่มีปุ่มเริ่ม) ปุ่มลัดช่วง vote เลือกโซนบนสุดตัวแรกที่ยังไม่มีโหวต ไล่จากบนลงล่าง ซ้ายไปขวา สรุป Markdown ยังไม่บอกช่วงที่ประชุมไปถึง
- **ข้อ 6:** ใช้ได้เฉพาะห้อง private (แผนเดิมให้ public ใช้ได้) ห้องเก็บได้ทีละรอบ เริ่มรอบใหม่จะล้างคำตอบเก่า backup มี `board.moodCheck` และ `moods` (userId → คะแนน) พอ import แล้วรอบจะถูกปิด
- **ล้างบอร์ด:** reset `phase` และ `moodCheck` ด้วย ส่วน presenter ไม่ได้ reset

## ลำดับที่แนะนำ

1. **ข้อ 4** ต่อยอด follow เดิม เสี่ยงน้อยที่สุด
2. **ข้อ 5** ใช้ action items และ summary จากรอบนี้ในช่วง `actions`/`discuss`
3. **ข้อ 6** แตะ backup schema ควรรีวิว round-trip ให้ละเอียด

## งานค้างจากรอบก่อนที่ควรรู้

- ภาพ PNG/PDF ตัดบรรทัดภาษาไทยกลางคำ เช่น "โค้ดเ|ร็ว" เพราะ `rasterTextLines` ตัดทีละ grapheme ทางแก้คือใช้ `Intl.Segmenter` แบบ `granularity: 'word'` ในฟังก์ชันกลางตัวนี้ ซึ่งจะช่วยภาพ Public Wall ไปด้วย
- ส่งต่อ action items ที่ยังไม่เสร็จไปบอร์ด retro รอบถัดไป ทำได้หลังข้อ 5 เพราะช่วง `actions` เป็นจุดที่เหมาะจะกด "ส่งต่อ"
