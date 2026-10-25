# Tier system — draft (2026-10-15)

สถานะ: **ร่างแนวคิด ยังไม่ใช่แผน implementation** — ยังไม่ผ่าน plan mode / plan-context-scout / review
เป้าหมาย: สมัครด้วย Google, guest mode, subscription แบบเสียเงิน

## 0. ข้อจำกัดจากระบบปัจจุบัน

- `SECURITY.md`: ไม่มี account/ACL; ลิงก์ (`/b/<code>#<token>`) = สิทธิ์อ่าน-เขียน Yjs doc เต็ม
- admin PIN, vote limit, lock, hide card = workflow control ฝั่ง client เท่านั้น
- ⇒ **feature ที่บังคับใน CRDT/client ขายเป็น tier ไม่ได้** ต้องบังคับที่ relay/API:
  สร้างห้อง, จำนวนห้อง, connection ต่อห้อง, upload quota, retention, export,
  template กลาง, members-only room, admin ที่ server รับรอง

## 1. ระบบที่ต้องกำหนด

### A. Identity
- Google OIDC authorization code + PKCE, แลก/ตรวจ `id_token` ที่ server, key = `sub` (ไม่ใช่ email)
- Account session cookie (HttpOnly/Secure/SameSite) แยกจาก room-session cookie
- Guest = anonymous ID ใน browser; สิทธิ์ตามตาราง tier
- Guest → account upgrade: claim บอร์ดด้วย creator capability (`isBoardCreatedByMe` ใน `src/router.js`)
- ลบบัญชี, logout ทุกเครื่อง, export ข้อมูล (PDPA)

### B. Ownership + Authorization
- ห้องมี `owner_account_id`; limit ของห้องมาจาก plan เจ้าของห้อง
- Access mode: `link` (แบบเดิม) | `members` (login + allowlist) ตรวจที่ `POST /yjs/api/room-session`
- Revoke/rotate ลิงก์
- **Admin ที่ server รับรอง** (ดูหัวข้อ 3)

### C. Plan → Entitlements
- ตาราง entitlements เดียว (plan = สิ่งที่ขาย, entitlement = limit ที่โค้ดตรวจ); ห้าม `if plan === 'pro'` กระจาย
- จุดตรวจ: room create, WS admission, upload, export, retention job, templates
- **Fair-share capacity ตาม tier**: ปัจจุบัน global message budget (`YJS_GLOBAL_WS_MESSAGES_PER_SECOND=2048`)
  ตัด connection ของผู้ส่งคนถัดไปไม่ว่าห้องไหน (`yjs-server.mjs` ~2603-2611) → ห้อง free ทำให้ห้องที่จ่ายเงินหลุดได้

### D. Billing
- Provider: Stripe หรือ Omise (PromptPay) — ต้องยืนยันการรองรับธุรกิจไทย
- Webhook = source of truth, ตรวจ signature, idempotent ด้วย event ID
- สถานะ `trialing / active / past_due / canceled` + grace period
- Downgrade: บอร์ดเกิน quota → read-only, ห้ามลบ
- ใบเสร็จ/ใบกำกับภาษี (VAT 7%), refund policy, customer portal
- Billing events = durable records (fsync, audit) ไม่ใช่ log

### E. Data / infra
- Account/subscription/ownership ใน relational DB (SQLite สำหรับ host เดียว; Postgres ถ้า scale แนวนอน)
- เพิ่ม DB เข้า `scripts/backup-production.sh` + verify, snapshot ให้สอดคล้องกับ LevelDB
- Secret ใหม่: Google client secret, payment key, webhook secret
- Migration ห้องเดิมไม่มีเจ้าของ: claim ด้วย creator capability หรือเป็น legacy room = limit Free

### F. Legal / Ops
- Privacy policy, Terms, cookie notice, PDPA consent
- Admin console (ผู้ใช้, grant plan, refund)
- Metrics: conversion, churn, limit hits ต่อ tier

## 2. ร่าง tier (ค่าตั้งต้น ยังไม่ load test)

| | Guest | Free (Google) | Pro | Team |
|---|---|---|---|---|
| เข้าห้องจากลิงก์ | ✅ | ✅ | ✅ | ✅ |
| สร้างห้อง | ❌ / 1 ห้องชั่วคราว 7 วัน | 3 | ไม่จำกัด* | ไม่จำกัด* |
| คนต่อห้อง | – | 10 | 32 | 32+ (ต้อง load test) |
| เก็บบอร์ด | 7 วัน | 90 วัน | ถาวร | ถาวร |
| Upload quota | – | 100 MB | 2 GB | ใช้ร่วมกันใน workspace |
| Export | ❌ | JSON | ZIP | ZIP |
| Members-only / rotate ลิงก์ | ❌ | ❌ | ✅ | ✅ + SSO domain |
| Admin ที่ server รับรอง | ❌ | ✅ | ✅ | ✅ |

\* ยังมีเพดาน host (`MAX_REGISTERED_ROOMS` 10,000)

## 3. Admin ที่ server รับรอง

ปัจจุบัน (`src/useAdminRole.js`, `RetroBoard.jsx`):
- `adminUserId` อยู่ใน Yjs meta ที่ทุกคนเขียนได้; `userId` สุ่มจาก browser
- PIN = `SHA-256(boardCode:pin)` ใน doc ร่วม ตรวจที่ client; brute-force ได้ถ้า PIN สั้น
- ปุ่ม admin ตรวจด้วย `if (!isAdmin)` ฝั่ง client

เป้าหมาย:
1. Admin ผูกบัญชี (`owner_account_id` ใน DB, room-session รู้ตัวตน)
2. คำสั่ง admin ผ่าน API ของ relay → server ตรวจสิทธิ์แล้วเขียน update เอง
3. ฟิลด์สงวน (adminUserId, lock, timer, vote state) — relay ปฏิเสธ update จาก client ทั่วไป
   หรือย้ายออกจาก CRDT ที่ client เขียนได้ ← **งานยากสุด** relay ต้องรู้ schema
4. เลิกใช้ PIN

## 4. ลำดับที่แนะนำ
1. Identity + ownership (ยังไม่เก็บเงิน)
2. Entitlement layer + fair-share capacity
3. Billing + webhook + downgrade
4. Members-only rooms / revoke ลิงก์

## 5. ต้องได้รับอนุมัติ owner (AGENTS.md)
`nginx.conf` CSP, `YJS_ALLOWED_ORIGINS`, `docker-compose.prod.yml`, `.env`/secret ใหม่, การเปลี่ยน security model ใน `SECURITY.md`

## คำถามค้าง
- โมเดลคิดเงิน: (ก) เจ้าของห้องจ่าย ผู้เข้าร่วมฟรี [แนะนำ] หรือ (ข) ต่อที่นั่ง/workspace
- Payment provider: Stripe หรือ Omise
- Relay แกะ Yjs update ได้ลึกแค่ไหน (กระทบความยากของข้อ 3.3)
