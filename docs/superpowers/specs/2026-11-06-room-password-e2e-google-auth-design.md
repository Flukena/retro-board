# Room password + E2E encryption + Google sign-in — design

สถานะ: design ที่ owner อนุมัติในแชต 2026-11-06 รอรีวิว spec ฉบับเขียน → จากนั้นทำ implementation plan
ต่อยอดจาก `docs/plans/2026-10-15-tier-system-draft.md` (ร่างนั้นมี path/บรรทัดเก่า เช่น `src/useAdminRole.js`, `src/router.js`; ให้ยึด spec นี้)

## 1. เป้าหมายและการตัดสินใจของ owner

| เรื่อง | ตัดสินใจ |
|---|---|
| ล็อคห้อง | **รหัสผ่านห้อง**: เข้าห้องได้ต้องมีทั้งลิงก์และรหัสผ่าน |
| การเข้ารหัส | **E2E เต็มรูปแบบ**: server/เจ้าของ server เข้าถึงเนื้อหาห้องที่มีรหัสไม่ได้เลย รวม presence |
| รูปแบบ E2E | **ทาง 1**: protocol ของเราเอง — encrypted update log + client snapshot บน relay เดิม |
| Google login | ฐานบัญชีสำหรับ tier เสียเงินในอนาคต; login เป็นทางเลือก ไม่บังคับ |
| สิทธิ์สร้างห้องที่มีรหัส | ตาราง entitlement: ตั้งใจให้เป็นของแพ็กเกจเสียเงิน แต่**ช่วงแรก free = pro** (เปิดให้ทุกบัญชีที่ login) |
| ที่มาของแพ็กเกจ | ไม่มี billing รอบนี้; owner grant/revoke `pro` เองใน maintainer console |

### สิทธิ์ตามประเภทผู้ใช้

| | Guest | Login (free) | Login (pro) |
|---|---|---|---|
| เข้าห้องจากลิงก์ / เข้าห้องที่มีรหัส (ใส่รหัส) | ✅ | ✅ | ✅ |
| สร้างห้องปกติ | ✅ เหมือนเดิม | ✅ | ✅ |
| สร้างห้องที่มีรหัส + E2E | ❌ | ✅ (ช่วงแรก) | ✅ |
| เปลี่ยนรหัส / ตัดสิทธิ์ทุกคน | ❌ | เจ้าของห้องเท่านั้น | เจ้าของห้องเท่านั้น |

แพ็กเกจหมด/ถูก revoke: ห้องที่มีรหัสเดิมยังเปิดและจัดการได้; สร้างห้องที่มีรหัสใหม่ไม่ได้เมื่อ entitlement ปิด

### นอกขอบเขต (YAGNI)

- Billing, ใบเสร็จ, VAT — เฟสถัดไปของ tier
- ย้ายห้องที่สร้างตอนเป็น guest เข้าบัญชี (claim)
- แปลงห้องปกติเดิมเป็นห้องเข้ารหัสในที่ — ทำได้ด้วย export → สร้างห้องเข้ารหัส → import
- ห้อง Poker (`/p/`) และ Public Wall — ทำงานเหมือนเดิม
- "จำรหัสผ่านบนเครื่องนี้"
- Provider อื่นนอกจาก Google

## 2. ข้อเท็จจริงจากโค้ดปัจจุบันที่ design อิง

- ลิงก์ห้องคือ bearer capability; `POST /yjs/api/room-session` แลก `{code, token}` เป็น cookie HMAC ผูก handle/expiry/docName (`yjs-server.mjs:1012-1050`, `src/server/relay-session.js`)
- จุดรับเข้า: session exchange → WS upgrade (`yjs-server.mjs:1672-1787`) → per-message gate (`:1576-1667`). Private renewal ส่ง code+token ซ้ำ
- Board/zone lock, admin PIN, `adminUserId` เป็น client-only; relay ไม่อ่าน field เหล่านี้
- `card.text` / zone `title` เป็น `Y.Text` (`src/client/session/collaborative-text.js`) — E2E ระดับ field จะทำลายการพิมพ์ร่วม จึงเลือกเข้ารหัสระดับ update
- Relay เขียนเข้า doc เองตอนโหวตหมดเวลา (`src/server/relay-vote-maintenance.js`, `yjs-server.mjs:600-635`) และอ่าน items ตอน image migration (`:790-815`)
- `/yjs/*` วิ่งผ่าน cloudflared ตรงไป relay (`cloudflared.prod.yml:14-16`) → route ใหม่ใต้ `/yjs/api/` ไม่ต้องแก้ nginx/cloudflared
- CSP ของหน้าเว็บ (`nginx.conf:23`): `connect-src 'self'`, `form-action 'self'`, `img-src ... blob:`; COOP `same-origin` (`:15`). Redirect flow แบบ top-level navigation ไม่ชน CSP/COOP; ไม่โหลด script ของ Google
- Relay อยู่บน network `app_internal` ที่ `internal: true` (`docker-compose.prod.yml:216-217`) → ออกอินเทอร์เน็ตไม่ได้
- Ratchet: `RetroBoard.jsx` / `yjs-server.mjs` อยู่ที่เพดานพอดี (`src/rule-ratchets.test.js`) → ทุกอย่างใหม่อยู่ใน module แยก, coordinator แค่ wire

## 3. โครงสร้าง module

ชื่อเป็นข้อเสนอ ปรับได้ใน plan ตามที่เจอจริง

```text
src/domain/
  plan-entitlements.js        plan → entitlements (pure, ตารางเดียว)
  e2e-envelope.js             binary framing ของข้อความ E2E (encode/decode/limits; ไม่มี crypto)
src/server/
  auth-google.js              OIDC start/callback, แลก code, ตรวจ id_token
  auth-session.js             account cookie (HMAC, expiry, session generation)
  account-store.js            บัญชีใน LevelDB (prefix แยก)
  room-password.js            ตรวจ verifier, ตัวนับครั้งผิด, owner actions
  e2e-room-log.js             append/snapshot/replay ของห้องเข้ารหัสใน LevelDB
  e2e-relay.js                WS handler ของห้องเข้ารหัส (fan-out, ephemeral)
  e2e-blobs.js                upload/read รูปที่เข้ารหัส (opaque, ตรวจขนาด)
src/client/account/           ปุ่ม login, เมนูบัญชี, in-app browser notice
src/client/room-lock/         dialog ตั้งรหัส/ใส่รหัส/เปลี่ยนรหัส/ตัดสิทธิ์
src/client/session/
  e2e-crypto.js               WebCrypto: PBKDF2, HKDF, AES-GCM, wrap/unwrap
  e2e-provider.js             provider ของห้องเข้ารหัส (interface เดียวกับของเดิม)
src/client/maintainer/        หน้า Accounts: ค้น email, grant/revoke pro
```

Dependency: client/server → domain เท่านั้น (`src/architecture.test.js`). `Dockerfile.yjs` ต้องเพิ่ม server/domain module ใหม่ใน source list (มี contract test ตรวจ)

## 4. เฟส 1 — Google sign-in, บัญชี, entitlement

### 4.1 OIDC flow (authorization code + PKCE, redirect mode)

1. `GET /yjs/api/auth/google/start?return=<same-origin path>` → relay สร้าง `state`, `nonce`, PKCE `code_verifier`; เก็บใน cookie ชั่วคราวลงลายเซ็น (`HttpOnly; Secure; SameSite=Lax`, path `/yjs/api/auth`, อายุ 10 นาที) → 302 ไป Google (`scope=openid email profile`)
2. Google → `GET /yjs/api/auth/google/callback?code&state`
3. Relay ตรวจ `state` กับ cookie (ใช้ครั้งเดียว ลบทันที), แลก code ที่ token endpoint ด้วย client secret + `code_verifier`
4. ตรวจ `id_token`: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud` = client ID, `exp`, `nonce`, `email_verified`; ไม่ตรวจลายเซ็นด้วย JWKS: token มาจาก token endpoint ของ Google ผ่าน TLS โดยตรง (OIDC Core §3.1.3.7 ข้อ 6) — ดู §4.7 ข้อ 1
5. Upsert บัญชีด้วย `sub` → ออก account cookie → 302 ไป `return` (ตรวจว่าเป็น path ภายในเท่านั้น กัน open redirect)

Error ทุกกรณี (state ไม่ตรง, Google ปฏิเสธ, ผู้ใช้กดยกเลิก, timeout) → 302 ไปหน้าเดิมพร้อม `?auth_error=<code>` ที่ client แปลเป็นข้อความ `t()`; log แค่ error code ไม่ log token/email

In-app browser (LINE/Facebook/Messenger): client ตรวจ user agent แล้วแสดงคำแนะนำ "เปิดใน Chrome/Safari" แทนปุ่ม login (Google บล็อก `disallowed_useragent`)

### 4.2 Account session

- Cookie แยกจาก room cookie: `HttpOnly; Secure; SameSite=Lax`, path `/yjs/api`, อายุ 30 วัน, HMAC ด้วย key แยกจาก room-session key
- Payload: `accountId`, `sessionGeneration`, `expiresAt`. ตรวจ generation กับ account-store ทุกครั้ง → "ออกจากระบบทุกเครื่อง" = เพิ่ม generation
- `GET /yjs/api/account` → `{ name, email, plan, entitlements }` หรือ 401; `POST /yjs/api/account/logout`, `POST /yjs/api/account/logout-all`, `POST /yjs/api/account/delete`
- POST ทั้งหมดตรวจ Origin แบบเดียวกับ endpoint เดิม (`acceptCredentialOrigin`)

### 4.3 Account store (LevelDB เดิม, prefix แยก)

Record: `{ id, googleSub, email, name, plan: 'free'|'pro', planGrantedAt, sessionGeneration, createdAt }`. Index `email → id` สำหรับ maintainer ค้นหา. ลบบัญชี = ลบ record + index; ห้องที่บัญชีเป็นเจ้าของยังอยู่จนหมดอายุตาม retention เดิม และไม่มีเจ้าของจัดการอีก (บันทึกใน privacy policy)

### 4.4 Entitlements

`src/domain/plan-entitlements.js`: ตารางเดียว `{ free: { canCreateLockedRoom: true }, pro: { canCreateLockedRoom: true } }` (free = pro ช่วงแรก). โค้ดตรวจ entitlement ไม่ตรวจชื่อ plan. จุดตรวจรอบนี้มีจุดเดียว: สร้างห้องที่มีรหัส

### 4.5 Maintainer console

หน้า Accounts ใน console เดิม (listener/owner key เดิม): ค้นด้วย email → แสดง plan → grant/revoke pro. การเปลี่ยน plan เป็น durable record (เขียน LevelDB เป็น batch เดียวด้วย `sync: true` — registry เดิมใช้ `db.put` ที่ไม่ sync (`y-leveldb.js:135`) จึงใช้แบบเดียวกันไม่ได้ ดู §4.7 ข้อ 4) ไม่ใช่ log

### 4.6 Config / secret

ENV ใหม่ (ชื่อเท่านั้น): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REDIRECT_URI`, `YJS_ACCOUNT_SESSION_SECRET` (ไม่ตั้ง = ใช้ไฟล์ `<YJS_DB_DIR>/.account-session-key` ตามแบบ room key; ดู §4.7 ข้อ 2). ไม่ตั้ง client ID → ปุ่ม login ไม่แสดง, endpoint auth ตอบ 404, ฟีเจอร์อื่นทำงานปกติ (dev/test ไม่ต้องมี Google)

Network: relay ต้องออกไป `oauth2.googleapis.com` ได้ (ไม่ต้องใช้ `www.googleapis.com` เพราะไม่ใช้ JWKS) — เพิ่ม network ที่มี egress ให้ service `yjs` (ทางเลือกสำรอง: auth container แยก; ไม่เลือกเพราะเพิ่มชิ้นส่วน + ต้องแชร์ signing key)

### 4.7 ข้อที่ต่างจากร่างแรก (ตัดสินระหว่างทำ 2026-11-06)

1. **ตรวจ `id_token` ผ่าน TLS อย่างเดียว ไม่ใช้ JWKS.** token มาจาก token endpoint ที่ตายตัวของ Google ผ่าน HTTPS โดยตรง ซึ่ง OIDC Core §3.1.3.7 ข้อ 6 และเอกสาร Google อนุญาตแทนการตรวจลายเซ็น. ขอบเขตความเชื่อใจ: endpoint เป็นค่าคงที่ใน production (override ได้เฉพาะ dev ที่เปิด insecure HTTP), ตรวจ certificate ปกติ, `redirect: 'error'`, ไม่รับ ID token จากเบราว์เซอร์เด็ดขาด. claims ยังตรวจครบ (`iss`, `aud`, `exp` พร้อมเพดานบน, `iat`, `nonce`, `email_verified`). ผลต่อ deploy: relay ต้อง egress ออก `oauth2.googleapis.com:443` แบบทั่วไป ไม่ใช่กรองตามชื่อโฮสต์ (`www.googleapis.com` ไม่ต้องใช้แล้ว)
2. **Key ของ account cookie ตามแบบ room key:** `YJS_ACCOUNT_SESSION_SECRET` หรือไฟล์ `<YJS_DB_DIR>/.account-session-key` (สร้างเองและเก็บถาวร) ไม่ใช่ env ชื่อ `ACCOUNT_SESSION_KEY`
3. **Redirect URI ตอน dev** คือ `http://localhost:1234/api/auth/google/callback` (relay dev ไม่มี prefix `/yjs` และอยู่พอร์ต 1234)
4. **การเขียน registry ไม่ใช่ sync** (`y-leveldb.js:135` ใช้ `db.put` ไม่มี option). บัญชีจึงเขียนด้วย batch เดียวที่ `sync: true` ผ่าน `durableMetaBatch` ใน `relay-storage.js`
5. Sign-in ปิดเสมอบน relay Public Wall และเมื่อ `YJS_ALLOWED_ORIGINS` ว่าง (ทุก route ตอบ 404)

## 5. เฟส 2 — รหัสผ่านห้อง

### 5.1 Key hierarchy (ทำใน browser ด้วย WebCrypto เท่านั้น)

```text
password ──PBKDF2-SHA-256(salt 16B, 600,000 iter)──► master (256 bit)
master ──HKDF "retroroom/kek/v1"──► KEK   (AES-GCM 256, ห่อ DEK)
master ──HKDF "retroroom/auth/v1"─► authKey (ส่งให้ server ตอนพิสูจน์รหัส)
DEK = room data key สุ่ม 256 bit, มี keyEpoch
server เก็บ: salt, kdfParams, verifier = SHA-256(authKey), wrappedDEK (+IV), keyEpoch, ownerAccountId
```

Server ไม่เคยเห็น password, master, KEK หรือ DEK. authKey ผ่าน TLS แต่แยก domain จาก KEK จึงใช้ unwrap DEK ไม่ได้

### 5.2 สร้างห้องที่มีรหัส

`POST /yjs/api/rooms` พร้อม `{ lock: { salt, kdf, verifier, wrappedDek, wrapIv } }` + account cookie → relay ตรวจ entitlement `canCreateLockedRoom` → registry บันทึก room แบบ `e2e` พร้อม `ownerAccountId`. ไม่มี account/entitlement → 401/403; ห้องปกติไม่เปลี่ยน

UI: รหัสอย่างน้อย 10 ตัวอักษร, ช่องยืนยันรหัส, checkbox บังคับ "ถ้าลืมรหัส ไม่มีใครกู้ข้อมูลได้ รวมถึงผู้ดูแลระบบ"

### 5.3 เข้าห้อง

1. `POST /yjs/api/room-session {code, token}` → ห้อง e2e ตอบ `409 { locked: true, salt, kdf }` (ไม่ออก cookie, ไม่ส่ง wrappedDEK)
2. Client ถามรหัส → derive → `POST /yjs/api/room-session {code, token, authKey}` → relay เทียบ `SHA-256(authKey)` กับ verifier แบบ constant-time → ถูก: cookie + `{ wrappedDek, wrapIv, keyEpoch }`
3. Client unwrap DEK ด้วย KEK. password/master/authKey/DEK อยู่ใน memory ของหน้าเท่านั้น; refresh = ใส่รหัสใหม่
4. Renewal ของห้อง e2e ต้องส่ง authKey ทุกครั้ง (ไม่อย่างนั้น renewal เป็นทางเลี่ยงการตรวจรหัส)

Rate limit ครั้งผิด: 5 ครั้ง / 15 นาที ต่อ (IP, ห้อง) + เพดานรวมต่อห้อง; เกิน → 429 + `retry-after`. นับเฉพาะครั้งผิด. ใช้ `relay-rate-bucket.js` เดิม

### 5.4 Owner actions

Endpoint อยู่ใต้ `/yjs/api/rooms/<handle>/lock/...` เพื่อให้ account cookie (path `/yjs/api`) ถูกส่งมา; room cookie (path `/yjs/rooms/<handle>`) ไม่ถูกส่งมาที่นี่ จึงพิสูจน์สิทธิ์ด้วย account cookie ที่ตรง `ownerAccountId` **และ** authKey ของรหัสปัจจุบัน (กันกรณี cookie บัญชีหลุดอย่างเดียว)

- **เปลี่ยนรหัส**: client unwrap DEK ด้วย KEK เดิม → wrap ด้วย KEK ใหม่ → `POST /yjs/api/rooms/<handle>/lock/password { oldAuthKey, salt, kdf, verifier, wrappedDek, wrapIv }`. DEK ไม่เปลี่ยน ข้อมูลไม่ต้องเข้ารหัสใหม่. Session ที่เปิดอยู่ยังอยู่จนหมดอายุ แล้ว renewal ต้องใช้รหัสใหม่
- **ตัดสิทธิ์ทุกคน (rotate DEK)**: ดู 6.5

### 5.5 ข้อจำกัดที่ต้องเขียนใน SECURITY.md

ผู้ที่ได้ salt + verifier หรือ wrappedDEK (เช่น จาก backup ที่หลุด) ลองเดารหัสแบบ offline ได้ ความปลอดภัยจึงขึ้นกับความยากของรหัส. ลืมรหัส = ข้อมูลหายถาวร. คนที่รู้รหัสยังเป็นผู้ร่วมงานที่เชื่อใจได้เต็มที่เหมือนลิงก์วันนี้ (ลบ/ป่วนบอร์ดได้)

## 6. เฟส 3 — E2E (ทาง 1: encrypted log + snapshot)

### 6.1 Relay ของห้อง e2e

- Registry มี flag `e2e` → relay **ไม่สร้าง Y.Doc** ไม่ hydrate และไม่ผ่าน y-websocket สำหรับห้องนี้; ใช้ WS path แยก `/yjs/e2e/<handle>` ผ่าน origin/session/capacity/traffic gate เดิม
- ข้อความ (framing ใน `src/domain/e2e-envelope.js`, ตรวจ framing/ขนาดครบก่อนทำอะไร):
  - `append { ciphertext }` → relay ให้ `seq` เพิ่มทีละ 1, บันทึก, ส่งต่อทุกคน (รวม ack ให้ผู้ส่ง)
  - `snapshot { baseSeq, ciphertext }` → แทน snapshot เดิมและลบ update `≤ baseSeq` ใน LevelDB batch เดียว; รับเฉพาะ `baseSeq` > snapshot ปัจจุบันและ ≤ head
  - `ephemeral { ciphertext }` → presence/cursor ส่งต่ออย่างเดียว ไม่บันทึก
  - Join: relay ส่ง snapshot ล่าสุด + update หลัง `baseSeq` ตามลำดับ แล้ว `synced`
- Quota: ใช้เพดาน update/document/room bytes และ traffic limit เดิม; ห้องเกินเพดานรวม → ปฏิเสธ append จนกว่าจะมี snapshot ที่ลดขนาด

### 6.2 Client provider

- `e2e-provider.js` ถือ Y.Doc ใน browser เหมือนเดิม: local update → encrypt → `append`; remote → decrypt → `Y.applyUpdate`. Awareness encode → encrypt → `ephemeral`
- ใช้ interface เดียวกับ provider เดิมที่ storage-bridge เรียก → UI, undo/redo, reconciliation, local-optimism guard ไม่แก้
- Snapshot: client ที่ synced ส่ง snapshot เมื่อ update หลัง snapshot > 500 ชิ้น หรือ > 1 MiB (ค่าตั้งต้น ปรับใน plan) พร้อม jitter เพื่อไม่ให้ทุกคนส่งพร้อมกัน
- เพดาน geometry/schema ที่ relay เคยตรวจ ย้ายไปตรวจใน client ตอน decrypt+apply (decoder เดิมใน `src/domain/`); update ที่ decrypt ไม่ได้หรือ schema ผิด → ข้ามและแจ้งเตือน ไม่ทำให้บอร์ดพัง

### 6.3 Crypto ต่อข้อความ

AES-GCM 256 ด้วย DEK, IV สุ่ม 96 bit ต่อข้อความ, AAD = `roomHandle | keyEpoch | messageType` กันการนำ ciphertext ข้ามห้อง/ข้ามรุ่น key/ข้ามชนิด. GCM tag ไม่ผ่าน → ปฏิเสธ. Server ลบ/ไม่ส่งข้อความได้ (อ่านไม่ได้แต่ทิ้งได้) — ตรวจจับการทิ้งข้อความอยู่นอกขอบเขต

### 6.4 รูปภาพ

Client เข้ารหัส bytes ด้วย DEK ก่อน upload → `POST /yjs/rooms/<handle>/e2e-blobs` (opaque, ตรวจแค่ขนาด ≤ 5 MiB + overhead และ quota ห้องเดิม). อ่านต้องมี room session. Client fetch → decrypt → `blob:` URL (CSP `img-src blob:` มีอยู่แล้ว). ห้อง e2e ข้ามการตรวจ magic-byte/dimension ฝั่ง server (ตรวจฝั่ง client แทน)

### 6.5 ตัดสิทธิ์ทุกคน (rotate DEK)

Owner client: สร้าง DEK ใหม่ (`keyEpoch + 1`) → encrypt snapshot เต็มของ Y.Doc ปัจจุบันด้วย DEK ใหม่ → ตั้งรหัสใหม่ → `POST /yjs/api/rooms/<handle>/lock/rotate` พร้อม authKey ปัจจุบัน + salt/verifier/wrappedDek ใหม่ + snapshot → relay แทน log ทั้งหมดแบบ atomic, เพิ่ม epoch, ปิดทุก socket ของห้อง (close code แยก "key rotated") → ทุกคนต้องใส่รหัสใหม่. รูปเดิมถูก re-encrypt และ upload ใหม่ด้วย DEK ใหม่ใน flow เดียวกัน; blob เก่าลบหลัง rotate สำเร็จ

### 6.6 ความสามารถที่ห้อง e2e เสีย (แสดงใน UI ตอนสร้างห้อง + SECURITY.md)

- Relay สรุปผลโหวตตอนไม่มีใครออนไลน์ไม่ได้ → client คนแรกที่เปิดห้องหลังหมดเวลาเป็นผู้สรุป (ใช้ `planVoteFinalization` เดิม; plan ต้องยืนยันว่า client path นี้มีอยู่หรือต้องเพิ่ม)
- Maintainer console แสดงห้อง e2e ว่า "encrypted" พร้อมขนาด/กิจกรรม; ไม่มีการดูเนื้อหา
- Image migration และ decode-scan ข้ามห้อง e2e
- Backup verify ตรวจได้แค่ความครบ: seq ต่อเนื่อง, snapshot มีอยู่, และทุก blob id ที่ relay ลงทะเบียนตอน upload มีไฟล์อยู่. ตรวจไม่ได้ว่าบอร์ดอ้าง blob ไหนหรือเนื้อหาถูกต้อง

### 6.7 การเปลี่ยน invariant (ต้องแก้ CONTEXT.md)

- "relay ไม่รู้ชนิดห้อง" → relay รู้ flag `e2e` ใน registry
- "Yjs room state เป็น canonical และ relay ตรวจ geometry" → ห้อง e2e: canonical state คือ encrypted log; ขอบเขต geometry บังคับที่ client
- Export → import round-trip ยังต้องตรงทุกไบต์ (export/import ทำฝั่ง client อยู่แล้ว)

## 7. การทดสอบ

Unit (colocated, ทุก test ต้อง fail เมื่อ revert โค้ด):
- `plan-entitlements`: free/pro, plan ไม่รู้จัก → ไม่มีสิทธิ์
- `auth-google`: state ผิด/ใช้ซ้ำ, nonce ผิด, aud/iss ผิด, token หมดอายุ, `return` ภายนอก → ปฏิเสธ (mock แค่ HTTP ของ Google ไม่ mock unit)
- `auth-session`: ลายเซ็นผิด, หมดอายุ, generation เก่า → 401
- `room-password`: verifier ถูก/ผิด, constant-time compare, rate limit 5/15 นาที, renewal ไม่มี authKey → ปฏิเสธ, non-owner เปลี่ยนรหัสไม่ได้
- `e2e-crypto`: round-trip, รหัสผิด unwrap ไม่ได้, ciphertext ถูกแก้/AAD ต่างห้อง/epoch เก่า → ปฏิเสธ
- `e2e-envelope`: framing เกินขนาด/ชนิดไม่รู้จัก → ปฏิเสธก่อน mutate
- `e2e-room-log`: seq ต่อเนื่อง, snapshot แทนแบบ atomic, snapshot `baseSeq` เก่า → ปฏิเสธ, replay ถูกลำดับหลัง restart
- Relay test: ห้อง e2e ไม่มี plaintext ใน LevelDB (เขียนข้อความรู้ค่าแล้ว scan bytes), ห้องปกติไม่เปลี่ยนพฤติกรรม

Live (ตาม AGENTS.md): `yjs:dev` + `dev`, สอง browser context: login (Google mock ใน dev หรือ client ID ทดสอบ), สร้างห้องมีรหัส, อีก context ใส่รหัสผิด/ถูก, แก้ไข sync สองทาง, พิมพ์การ์ดเดียวกันพร้อมกัน, undo/redo, รูปภาพแสดง, เปลี่ยนรหัส, rotate แล้วอีกฝั่งถูกเตะ, th/en

Release gate: `DEPLOYMENT.md` §Release gate + backup/verify script ที่แก้แล้ว

## 8. ลำดับ implement

1. **เฟส 1**: account store, auth session, Google OIDC, entitlement, account UI, maintainer Accounts, privacy policy/SECURITY.md
2. **เฟส 2**: registry flag `e2e` + lock metadata, room-session สองขั้น, rate limit, owner change-password
3. **เฟส 3**: envelope, e2e log/relay, e2e provider, รูปภาพ, rotate, backup verify, CONTEXT.md

เฟส 2 และ 3 ต้อง ship พร้อมกันสู่ production (ห้องที่มีรหัสแต่ยังไม่ E2E จะขัดกับสิ่งที่ UI สัญญา); เฟส 1 ship แยกได้

## 9. ต้องได้รับอนุมัติ owner (เตรียมแล้วหยุด)

- สร้าง Google OAuth client, ใส่ secret ใน `.env`
- `docker-compose.prod.yml`: network egress ให้ `yjs`
- แก้ `SECURITY.md` (security model เปลี่ยน), privacy policy/terms (เก็บ email)
- `scripts/backup-production.sh` / `verify-production-backup.sh` (เพิ่ม account data + ห้อง e2e)
- Production deploy ทุกครั้ง

## 10. คำถามที่เหลือให้ plan ตรวจ

- Client มี path สรุปโหวตหมดเวลาอยู่แล้วหรือไม่ (`storage-bridge.js` อ้าง finalize)
- y-websocket reconnect หลัง close 1008 หรือไม่ (scout ยังไม่ยืนยัน) — กระทบ UX ตอน session หมดอายุของห้องปกติเท่านั้น
- ค่าตั้งต้น snapshot threshold และเพดานรวมต่อห้องหลัง load test
- Google mock สำหรับ dev/live test (fake issuer ในโหมด insecure dev เท่านั้น)
