// Tiny i18n: a `t(key, params)` lookup with localStorage persistence and
// browser-language autodetect. No external dependency.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'rb_lang';

const dict = {
  th: {
    // common chrome
    'app.title': 'Retro Board',
    'app.tagline': 'สร้างหรือเข้าร่วมห้อง retrospective แบบ real-time',
    'common.cancel': 'ยกเลิก',
    'common.save': 'บันทึก',
    'common.delete': 'ลบ',
    'common.you': '(คุณ)',
    'common.admin': 'admin',
    'common.adminOnly': 'admin only',
    'common.warnLockEdit': 'การแก้ไขถูกล็อกโดย admin',
    'common.warnEditing': 'การแก้ไขถูกล็อก',
    'common.justNow': 'เมื่อกี้',
    'common.minutesAgo': '{n}m ago',
    'common.hoursAgo': '{n}h ago',
    'common.daysAgo': '{n}d ago',
    'common.optional': 'ตัวเลือก',

    // landing
    'landing.create.head': 'สร้างห้องใหม่',
    'landing.create.desc': 'กด Create เพื่อสุ่มรหัสห้อง 8 ตัว — แชร์ลิงก์ให้ทีมเพื่อเข้าร่วม',
    'landing.create.namePlaceholder': '(ตัวเลือก) ตั้งชื่อบอร์ด เช่น Sprint 42 Retro',
    'landing.create.btn': 'Create',
    'landing.join.head': 'เข้าร่วมด้วย code',
    'landing.join.placeholder': 'วาง code หรือ URL เต็มของห้องที่ได้รับ',
    'landing.join.btn': 'Join',
    'landing.recents.head': 'ห้องล่าสุด',
    'landing.recents.remove': 'ลบออกจากรายการ',
    'landing.footer': 'ทุกห้องเป็น public — ใครมี link ก็เข้าได้ ห้ามแชร์ public space กับข้อมูล sensitive',

    // top bar
    'topbar.home': 'กลับหน้าหลัก',
    'topbar.copyLink': 'คลิกเพื่อคัดลอกลิงก์ห้อง',
    'topbar.copied': 'คัดลอกลิงก์ห้องแล้ว',
    'topbar.shareLink': 'แชร์ลิงก์: /b/{code}',
    'topbar.lockEdit': 'ล็อกการแก้ไข',
    'topbar.unlockEdit': 'ปลดล็อกการแก้ไข',
    'topbar.reveal': 'เปิดทุกการ์ด',
    'topbar.hide': 'ซ่อนทุกการ์ด',
    'topbar.vote': 'Vote',
    'topbar.stopVote': 'Stop Vote',
    'topbar.extend': '+{n}m',
    'topbar.resetVotes': 'Reset votes',
    'topbar.resetVotesTitle': 'รีเซ็ตโหวต',
    'topbar.clear': 'Clear',
    'topbar.clearTitle': 'ล้างบอร์ด',
    'topbar.undo': 'ย้อนกลับ (Ctrl+Z)',
    'topbar.redo': 'ทำซ้ำ (Ctrl+Shift+Z)',
    'topbar.export': 'Export',
    'topbar.exportTitle': 'ดาวน์โหลด board เป็นไฟล์ JSON (รวมรูป)',
    'topbar.exportCsv': 'Export CSV',
    'topbar.exportCsvTitle': 'ดาวน์โหลดการ์ดทั้งหมดเป็น CSV (แยกตาม zone)',
    'export.csv.zone': 'Zone',
    'export.csv.text': 'Text',
    'export.csv.author': 'Author',
    'export.csv.votes': 'Votes',
    'export.csv.color': 'Color',
    'export.csv.createdAt': 'Created at',
    'export.csv.unassigned': '(no zone)',
    'export.csv.hidden': '[hidden]',
    'topbar.import': 'Import',
    'topbar.importTitle': 'โหลด board จากไฟล์ JSON (ทับของเดิม)',
    'export.done': 'ดาวน์โหลด {file} แล้ว',
    'import.confirm.head': 'โหลด board จากไฟล์?',
    'import.confirm.body': 'จะทับ board ปัจจุบันทั้งหมด — {n} item จากไฟล์ "{file}"',
    'import.confirm.ok': 'โหลดทับ',
    'import.done': 'นำเข้า {n} item แล้ว',
    'import.fail': 'ไฟล์ไม่ถูกต้อง — {err}',
    'topbar.transfer': 'Transfer',
    'topbar.transferTitle': 'โอน admin',
    'topbar.editName': 'แก้ชื่อของคุณ',
    'topbar.setName': 'ตั้งชื่อ',
    'topbar.playersTitle': '{n} user online — กดเพื่อดูรายชื่อ',

    // creator toolbar
    'tool.select': 'Select',
    'tool.select.title': 'Select tool — ลากเมาส์คลุม object หลายอัน',
    'tool.select.active': 'Select tool — ลากบน canvas เพื่อคลุมเลือก (Esc เพื่อออก)',
    'tool.select.placeholder': 'ลากบน canvas…',
    'tool.text': 'Text',
    'tool.text.title': 'เพิ่ม text label',
    'tool.zone': 'Zone',
    'tool.zone.title': 'สร้าง zone ด้วยการลากกล่อง',
    'tool.zone.active': 'กำลังสร้าง zone — Esc เพื่อยกเลิก',
    'tool.zone.placeholder': 'ลากบน canvas…',
    'tool.image': 'Image',
    'tool.image.title': 'เพิ่มรูป (วาง Ctrl+V หรือ drag-drop ลง canvas ก็ได้)',

    // templates
    'tmpl.btn': 'Templates',
    'tmpl.head': 'Template',
    // Built-in template names + zone titles
    'tmpl.retro3.name': '😊😞🚀 Retro 3 ช่อง',
    'tmpl.retro3.well': '😊 ที่ทำได้ดี',
    'tmpl.retro3.improve': '😞 ที่ควรปรับปรุง',
    'tmpl.retro3.action': '🚀 สิ่งที่จะทำต่อ',
    'tmpl.ssc.name': '▶️⏹⏩ Start / Stop / Continue',
    'tmpl.4ls.name': '4Ls (Liked / Learned / Lacked / Longed for)',
    'tmpl.sailboat.name': '⛵ Sailboat',
    'tmpl.sailboat.wind': '💨 Wind (พลังขับเคลื่อน)',
    'tmpl.sailboat.anchor': '⚓ Anchor (สิ่งฉุดรั้ง)',
    'tmpl.sailboat.rocks': '🪨 Rocks (ความเสี่ยง)',
    'tmpl.sailboat.island': '🏝 Island (เป้าหมาย)',
    'tmpl.loop.name': '🔄 Retro Loop',
    'tmpl.loop.wrapper': 'Template xx/xx/xxxx',
    'tmpl.loop.prev': 'Previous Action',
    'tmpl.loop.good': '😊 Good',
    'tmpl.loop.bad': '😞 Bad',
    'tmpl.loop.try': '🚀 Try',
    'tmpl.loop.next': 'Next Action',
    'tmpl.save': '+ บันทึก zones ปัจจุบันเป็น template',
    'tmpl.saveDialog.head': 'บันทึก template',
    'tmpl.saveDialog.placeholder': 'ชื่อ template เช่น "Mad/Sad/Glad"',
    'tmpl.empty': 'ยังไม่มี zone บนบอร์ดให้บันทึก',
    'tmpl.saved': 'บันทึก template "{name}"',

    // sticky
    'sticky.placeholder': 'ดับเบิลคลิกเพื่อแก้ไข',
    'sticky.hidden': '🔒 ซ่อนอยู่',
    'sticky.hiddenBy': 'โดย {name}',
    'sticky.hideContent': 'ปลดล็อกก่อนถึงโหวตได้',
    'sticky.privacyToggle.on': 'เปิด: ผู้อื่นเห็นเนื้อหา',
    'sticky.privacyToggle.off': 'ปิด: ซ่อนเนื้อหาจากผู้อื่น',
    'font.decrease': 'ลดขนาดตัวอักษร',
    'font.increase': 'เพิ่มขนาดตัวอักษร',
    'font.color': 'สีตัวอักษร',
    'sticky.duplicate': 'ทำสำเนา',
    'sticky.delete': 'ลบ',
    'sticky.private.placeholder': '••••••',

    // vote
    'vote.notStarted': 'ยังไม่ได้เปิด vote session',
    'vote.notStartedYet': 'ยังไม่เปิด vote session',
    'vote.outOfQuota': 'หมดโควต้าโหวต',
    'vote.tooltip.vote': 'โหวต',
    'vote.tooltip.unvote': 'ถอนโหวต',
    'vote.banner.open': 'Voting open',
    'vote.banner.unlimited': '∞ votes',
    'vote.banner.votesLeft': '{used}/{limit} votes',
    'vote.banner.timeLeft': '{time}',
    'vote.results': 'ผลโหวต: {n} votes จาก {users} users',
    'vote.session.started': 'เริ่ม vote session • {limit} • {time}',
    'vote.session.votesLimit': '{n} โหวต/คน',
    'vote.session.unlimited': 'ไม่จำกัด',
    'vote.session.minutes': '{n} นาที',
    'vote.session.noTime': 'ไม่กำหนดเวลา',
    'vote.setup.head': 'เริ่ม vote session',
    'vote.setup.duration': 'ระยะเวลา (นาที)',
    'vote.setup.unlimitedTime': 'ไม่จำกัดเวลา',
    'vote.setup.voteLimit': 'จำนวนโหวต/คน',
    'vote.setup.unlimitedVotes': 'ไม่จำกัด',
    'vote.setup.start': 'เริ่ม',

    // reset votes / clear / transfer
    'reset.confirm.head': 'รีเซ็ตโหวตทั้งบอร์ด?',
    'reset.confirm.body': 'ลบจำนวนโหวตของทุก sticky ในบอร์ด — sticky และเนื้อหายังอยู่ครบ',
    'reset.confirm.body2': 'โควต้าโหวตของทุกคนจะรีเซ็ตตามอัตโนมัติ',
    'reset.confirm.ok': 'รีเซ็ตโหวต',
    'reset.done': 'รีเซ็ตโหวตทั้งบอร์ดแล้ว',
    'clear.confirm.head': 'ล้างบอร์ดทั้งหมด?',
    'clear.confirm.body': 'การกระทำนี้ลบ sticky, text และ zones ทุกชิ้น และไม่สามารถย้อนกลับได้',
    'clear.confirm.ok': 'ลบทั้งหมด',
    'transfer.list.title': 'online users',
    'transfer.list.empty': 'ไม่มี user คนอื่น',
    'transfer.done': 'โอน admin แล้ว',
    'transfer.becomeAdmin': '👑 คุณกลายเป็น admin',
    'admin.claim': 'รับ admin',
    'admin.claim.title': 'รับสิทธิ์ admin',
    'admin.claim.desc.withPin': 'ห้องนี้ admin คนเดิมไม่อยู่ — ใส่ PIN เพื่อรับสิทธิ์ admin',
    'admin.claim.desc.noPin': 'ห้องนี้ยังไม่มี admin — กด "รับ" เพื่อเป็น admin คนแรก',
    'admin.claim.confirm': 'รับสิทธิ์',
    'admin.claim.wrongPin': 'PIN ไม่ถูกต้อง',

    // player list
    'players.head': 'ผู้เล่นในห้อง ({n})',
    'players.votesTooltip': 'จำนวน vote ที่ใช้ไป / โควต้า',

    // name modal
    'name.head': 'ตั้งชื่อให้คนอื่นเห็น',
    'name.placeholder': 'เช่น "ฟลุค"',
    'name.confirm': 'เข้าห้อง',

    // copy / paste
    'copy.done': 'คัดลอก {n} item',
    'copy.hiddenStripped': 'ก็อปแล้ว — {n} การ์ดที่ซ่อนอยู่ ไม่ได้ก็อป text',

    // settings
    'settings.lang': 'Language',
    'settings.theme': 'Theme',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.theme.auto': 'Auto',
    'empty.hint': 'ดับเบิลคลิกเพื่อเริ่ม · เลือก template ด้านล่าง',
    'loading': 'กำลังโหลด…',
  },
  en: {
    'app.title': 'Retro Board',
    'app.tagline': 'Create or join a real-time retrospective room',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.delete': 'Delete',
    'common.you': '(you)',
    'common.admin': 'admin',
    'common.adminOnly': 'admin only',
    'common.warnLockEdit': 'Editing locked by admin',
    'common.warnEditing': 'Editing locked',
    'common.justNow': 'just now',
    'common.minutesAgo': '{n}m ago',
    'common.hoursAgo': '{n}h ago',
    'common.daysAgo': '{n}d ago',
    'common.optional': 'optional',

    'landing.create.head': 'Create a new room',
    'landing.create.desc': 'Click Create to generate an 8-char code — share the link with your team.',
    'landing.create.namePlaceholder': '(optional) board name e.g. Sprint 42 Retro',
    'landing.create.btn': 'Create',
    'landing.join.head': 'Join with a code',
    'landing.join.placeholder': 'Paste a code or full URL',
    'landing.join.btn': 'Join',
    'landing.recents.head': 'Recent rooms',
    'landing.recents.remove': 'Remove from list',
    'landing.footer': 'All rooms are public — anyone with the link can join. Don\'t share sensitive data.',

    'topbar.home': 'Back to home',
    'topbar.copyLink': 'Click to copy room link',
    'topbar.copied': 'Room link copied',
    'topbar.shareLink': 'Share link: /b/{code}',
    'topbar.lockEdit': 'Lock editing',
    'topbar.unlockEdit': 'Unlock editing',
    'topbar.reveal': 'Reveal all cards',
    'topbar.hide': 'Hide all cards',
    'topbar.vote': 'Vote',
    'topbar.stopVote': 'Stop Vote',
    'topbar.extend': '+{n}m',
    'topbar.resetVotes': 'Reset votes',
    'topbar.resetVotesTitle': 'Reset votes',
    'topbar.clear': 'Clear',
    'topbar.clearTitle': 'Clear board',
    'topbar.undo': 'Undo (Ctrl+Z)',
    'topbar.redo': 'Redo (Ctrl+Shift+Z)',
    'topbar.export': 'Export',
    'topbar.exportTitle': 'Download board as JSON (images included)',
    'topbar.exportCsv': 'Export CSV',
    'topbar.exportCsvTitle': 'Download cards as CSV, grouped by zone',
    'export.csv.zone': 'Zone',
    'export.csv.text': 'Text',
    'export.csv.author': 'Author',
    'export.csv.votes': 'Votes',
    'export.csv.color': 'Color',
    'export.csv.createdAt': 'Created at',
    'export.csv.unassigned': '(no zone)',
    'export.csv.hidden': '[hidden]',
    'topbar.import': 'Import',
    'topbar.importTitle': 'Load board from JSON (overwrites current)',
    'export.done': 'Downloaded {file}',
    'import.confirm.head': 'Load board from file?',
    'import.confirm.body': 'This overwrites the current board — {n} items from "{file}"',
    'import.confirm.ok': 'Overwrite',
    'import.done': 'Imported {n} items',
    'import.fail': 'Invalid file — {err}',
    'topbar.transfer': 'Transfer',
    'topbar.transferTitle': 'Transfer admin',
    'topbar.editName': 'Change your name',
    'topbar.setName': 'Set name',
    'topbar.playersTitle': '{n} users online — click to see list',

    'tool.select': 'Select',
    'tool.select.title': 'Select tool — drag to box-select multiple items',
    'tool.select.active': 'Select tool — drag on canvas to marquee (Esc to exit)',
    'tool.select.placeholder': 'Drag on canvas…',
    'tool.text': 'Text',
    'tool.text.title': 'Add a text label',
    'tool.zone': 'Zone',
    'tool.zone.title': 'Create a zone by dragging a rectangle',
    'tool.zone.active': 'Creating zone — Esc to cancel',
    'tool.zone.placeholder': 'Drag on canvas…',
    'tool.image': 'Image',
    'tool.image.title': 'Add image (Ctrl+V or drag-drop also works)',

    'tmpl.btn': 'Templates',
    'tmpl.head': 'Template',
    'tmpl.retro3.name': '😊😞🚀 Retro 3 columns',
    'tmpl.retro3.well': '😊 What went well',
    'tmpl.retro3.improve': '😞 What to improve',
    'tmpl.retro3.action': '🚀 Action items',
    'tmpl.ssc.name': '▶️⏹⏩ Start / Stop / Continue',
    'tmpl.4ls.name': '4Ls (Liked / Learned / Lacked / Longed for)',
    'tmpl.sailboat.name': '⛵ Sailboat',
    'tmpl.sailboat.wind': '💨 Wind (what propels us)',
    'tmpl.sailboat.anchor': '⚓ Anchor (what holds us back)',
    'tmpl.sailboat.rocks': '🪨 Rocks (risks)',
    'tmpl.sailboat.island': '🏝 Island (the goal)',
    'tmpl.loop.name': '🔄 Retro Loop',
    'tmpl.loop.wrapper': 'Template xx/xx/xxxx',
    'tmpl.loop.prev': 'Previous Action',
    'tmpl.loop.good': '😊 Good',
    'tmpl.loop.bad': '😞 Bad',
    'tmpl.loop.try': '🚀 Try',
    'tmpl.loop.next': 'Next Action',
    'tmpl.save': '+ Save current zones as a template',
    'tmpl.saveDialog.head': 'Save template',
    'tmpl.saveDialog.placeholder': 'Template name e.g. "Mad/Sad/Glad"',
    'tmpl.empty': 'No zones on the board to save',
    'tmpl.saved': 'Saved template "{name}"',

    'sticky.placeholder': 'Double-click to edit',
    'sticky.hidden': '🔒 Hidden',
    'sticky.hiddenBy': 'by {name}',
    'sticky.hideContent': 'Unlock first to vote',
    'sticky.privacyToggle.on': 'On: others can see the content',
    'sticky.privacyToggle.off': 'Off: hide the content from others',
    'font.decrease': 'Decrease font size',
    'font.increase': 'Increase font size',
    'font.color': 'Text color',
    'sticky.duplicate': 'Duplicate',
    'sticky.delete': 'Delete',
    'sticky.private.placeholder': '••••••',

    'vote.notStarted': 'No vote session started',
    'vote.notStartedYet': 'No vote session yet',
    'vote.outOfQuota': 'Out of vote quota',
    'vote.tooltip.vote': 'Vote',
    'vote.tooltip.unvote': 'Unvote',
    'vote.banner.open': 'Voting open',
    'vote.banner.unlimited': '∞ votes',
    'vote.banner.votesLeft': '{used}/{limit} votes',
    'vote.banner.timeLeft': '{time}',
    'vote.results': 'Results: {n} votes from {users} users',
    'vote.session.started': 'Vote session started • {limit} • {time}',
    'vote.session.votesLimit': '{n} votes/person',
    'vote.session.unlimited': 'unlimited',
    'vote.session.minutes': '{n} min',
    'vote.session.noTime': 'no time limit',
    'vote.setup.head': 'Start vote session',
    'vote.setup.duration': 'Duration (minutes)',
    'vote.setup.unlimitedTime': 'No time limit',
    'vote.setup.voteLimit': 'Votes per person',
    'vote.setup.unlimitedVotes': 'Unlimited',
    'vote.setup.start': 'Start',

    'reset.confirm.head': 'Reset all votes?',
    'reset.confirm.body': 'Clears vote counts on every sticky — content is preserved.',
    'reset.confirm.body2': 'Everyone\'s vote quota will reset automatically.',
    'reset.confirm.ok': 'Reset votes',
    'reset.done': 'All votes reset',
    'clear.confirm.head': 'Clear the entire board?',
    'clear.confirm.body': 'This deletes every sticky, text, and zone. Cannot be undone.',
    'clear.confirm.ok': 'Delete all',
    'transfer.list.title': 'online users',
    'transfer.list.empty': 'No other users',
    'transfer.done': 'Admin transferred',
    'transfer.becomeAdmin': '👑 You are now admin',
    'admin.claim': 'Claim admin',
    'admin.claim.title': 'Claim admin role',
    'admin.claim.desc.withPin': 'No active admin in this room — enter the PIN to claim the role.',
    'admin.claim.desc.noPin': 'No admin yet in this room — press Claim to become the first admin.',
    'admin.claim.confirm': 'Claim',
    'admin.claim.wrongPin': 'Wrong PIN',

    'players.head': 'Players in room ({n})',
    'players.votesTooltip': 'Votes used / quota',

    'name.head': 'Set your display name',
    'name.placeholder': 'e.g. "Fluke"',
    'name.confirm': 'Enter room',

    'copy.done': 'Copied {n} item',
    'copy.hiddenStripped': 'Copied — {n} hidden card(s) had their text stripped',

    'settings.lang': 'Language',
    'settings.theme': 'Theme',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.theme.auto': 'Auto',
    'empty.hint': 'Double-click to start · or pick a template below',
    'loading': 'Loading…',
  },
};

function detectInitialLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && dict[saved]) return saved;
  } catch { /* swallow */ }
  const nav = typeof navigator !== 'undefined' ? (navigator.language || '') : '';
  return nav.toLowerCase().startsWith('th') ? 'th' : 'en';
}

let currentLang = detectInitialLang();
const listeners = new Set();

export function getLang() { return currentLang; }

export function setLang(next) {
  if (!dict[next] || next === currentLang) return;
  currentLang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* swallow */ }
  listeners.forEach((fn) => fn(next));
}

export function t(key, params) {
  const table = dict[currentLang] || dict.en;
  let s = table[key] ?? dict.en[key] ?? key;
  if (params && typeof s === 'string') {
    Object.keys(params).forEach((p) => {
      s = s.replace(new RegExp(`\\{${p}\\}`, 'g'), String(params[p]));
    });
  }
  return s;
}

export function useLang() {
  const [lang, setLangState] = useState(currentLang);
  useEffect(() => {
    const fn = (next) => setLangState(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return [lang, setLang];
}
