import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5184;
const WA_NUMBER = process.env.WA_NUMBER || '27672961272';
const ADMIN_CODE = process.env.ADMIN_CODE || 'fresh-admin';

// ── WhatsApp live bridge (lharries/whatsapp-mcp) ──
// Optional. When the Go bridge is configured AND authenticated, bookings auto-send
// their stage-1 availability check over the wire, and a polling loop reads incoming
// staff replies from the bridge's SQLite store to auto-transition + auto-send stage-2.
const WA_BRIDGE_URL = process.env.WA_BRIDGE_URL || '';
const WA_BRIDGE_DB = process.env.WA_BRIDGE_DB || '';
const BRIDGE_POLL_MS = Number(process.env.BRIDGE_POLL_MS || 5000);

// Autonomous-lifecycle tuning. Deadlines in hours; how many reminders to send before giving up.
const AVAIL_NUDGE_HOURS = Number(process.env.AVAIL_NUDGE_HOURS || 24);     // wait this long for a YES/NO reply
const AVAIL_MAX_NUDGES = Number(process.env.AVAIL_MAX_NUDGES || 2);         // then nudge, up to this many times
const TS_NUDGE_HOURS = Number(process.env.TS_NUDGE_HOURS || 24);            // wait this long for the timesheet reply
const TS_MAX_NUDGES = Number(process.env.TS_MAX_NUDGES || 3);               // then nudge, up to this many times
const HOURS_MS = 3600 * 1000;

let bridge = null; // { url, db, online, authenticated, lastChecked }

async function bridgeHealth() {
  if (!WA_BRIDGE_URL) return { available: false, online: false, authenticated: false, reason: 'not-configured' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(WA_BRIDGE_URL + '/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    bridge = { url: WA_BRIDGE_URL, db: WA_BRIDGE_DB, online: true, authenticated: !!j.authenticated, connected: !!j.connected, reason: null };
    return { ...bridge };
  } catch (e) {
    bridge = { url: WA_BRIDGE_URL, db: WA_BRIDGE_DB, online: false, authenticated: false, reason: e.message };
    return { ...bridge };
  }
}

// Try to send a live WhatsApp message via the bridge. Returns {ok, live, fallback}.
async function sendBroadcast(phone, text) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (WA_BRIDGE_URL) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(WA_BRIDGE_URL + '/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: clean, message: text }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.success) {
        return { ok: true, live: true, fallback: false, message: j.message };
      }
      // Bridge reachable but send failed (likely not connected) → fall back to deep link
      return { ok: false, live: false, reason: j.message || 'bridge send failed', fallbackLink: `https://wa.me/${clean}?text=${encodeURIComponent(text)}` };
    } catch (e) {
      return { ok: false, live: false, reason: e.message, fallbackLink: `https://wa.me/${clean}?text=${encodeURIComponent(text)}` };
    }
  }
  // No bridge → deep link only
  return { ok: false, live: false, reason: 'no bridge', fallbackLink: `https://wa.me/${clean}?text=${encodeURIComponent(text)}` };
}

// ── Storage backend: Supabase (primary) with SQLite fallback ──
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase = null;
let db = null; // sqlite fallback
let useSupabase = false;

if (SUPABASE_URL && SUPABASE_SECRET) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SECRET, { auth: { persistSession: false } });
  // Verify the bookings table actually exists before committing to Supabase;
  // if the migration hasn't been applied yet, fall back to SQLite so the app
  // keeps working. This auto-switches to Supabase once the schema is applied.
  try {
    const { error } = await supabase.from('bookings').select('ref').limit(1);
    useSupabase = !error;
  } catch {
    useSupabase = false;
  }
  console.log(useSupabase
    ? 'Storage: Supabase (' + SUPABASE_URL + ')'
    : 'Storage: Supabase configured but bookings table missing - falling back to SQLite (run migration).');
}

if (!useSupabase) {
  // SQLite fallback (used when no Supabase config, or Supabase table not provisioned)
  const Database = (await import('better-sqlite3')).default;
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, 'bookings.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ref TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL,
      event_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      headcount INTEGER NOT NULL,
      venue TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      whatsapp_text TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  console.log('Storage: SQLite (fallback)');
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

function genRef() {
  return 'FB-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Stage 1 — availability check (sent first; asks the staff member if they're free)
function composeAvailabilityMessage(b) {
  return [
    'Hi ' + b.name + '! 👋',
    'Are you available for this booking? Please reply YES or NO.',
    '',
    '📅 Date: ' + b.event_date,
    '🕒 Times: ' + b.start_time + ' – ' + b.end_time,
    '📍 Area: ' + b.venue,
    '📌 Ref: ' + b.ref,
  ].join('\n');
}

// Stage 2 — full booking details (sent after they confirm availability)
function composeBookingDetails(b) {
  const lines = [
    'Great — you\'re confirmed! 🎉 Here are your full booking details:',
    '',
    '🌟 Role: ' + b.role,
    '📅 Date: ' + b.event_date,
    '🕒 Times: ' + b.start_time + ' – ' + b.end_time,
    '📍 Venue: ' + b.venue,
  ];
  if (b.notes) lines.push('📝 Instructions: ' + b.notes);
  lines.push('Thank you! 🙏');
  lines.push('📌 Ref: ' + b.ref + ' · StaffConnect');
  return lines.join('\n');
}

// Stage 3 — timesheet request (sent after the event ends; asks for time in/out)
function composeTimesheetRequest(b) {
  return [
    'Hi ' + b.name + '! Hope the event went well. 🙌',
    'To close out your timesheet, please reply with your **time in** and **time out**, e.g.:',
    '',
    '08:00 16:00',
    '',
    '📅 Event: ' + b.event_date,
    '📍 Venue: ' + b.venue,
    '📌 Ref: ' + b.ref + ' · StaffConnect',
  ].join('\n');
}

// Follow-up nudge for an unanswered availability check (staff haven't said YES/NO yet).
function composeAvailabilityNudge(b, attempt) {
  return [
    'Hi ' + b.name + ' — quick follow-up 👋',
    'We haven\'t heard back on this yet. Are you available? Reply **YES** or **NO**.',
    '(Attempt ' + attempt + ')',
    '',
    '📅 Date: ' + b.event_date,
    '🕒 Times: ' + b.start_time + ' – ' + b.end_time,
    '📌 Ref: ' + b.ref + ' · StaffConnect',
  ].join('\n');
}

// Follow-up nudge for a missing timesheet (staff confirmed but haven't sent times).
function composeTimesheetNudge(b, attempt) {
  return [
    'Hi ' + b.name + ' — your timesheet is still outstanding 🙏',
    'Please reply with your **time in** and **time out** for the event, e.g.:',
    '',
    '08:00 16:00',
    '(Attempt ' + attempt + ')',
    '',
    '📅 Event: ' + b.event_date,
    '📌 Ref: ' + b.ref + ' · StaffConnect',
  ].join('\n');
}

// Office summary — a short digest of the booking lifecycle sent to the agency number.
function composeOfficeSummary(kind, b, extra) {
  const head = {
    created: '📋 New booking received',
    confirmed: '✅ Staff confirmed available',
    declined: '❌ Staff not available',
    timesheet: '🧾 Timesheet captured',
  }[kind] || 'StaffConnect update';
  const lines = [head + ' — ' + b.ref];
  lines.push('👤 ' + b.name + ' · ' + b.role);
  lines.push('📅 ' + b.event_date + ' · ' + (b.start_time || '') + '–' + (b.end_time || ''));
  lines.push('📍 ' + b.venue + ' · 📞 ' + b.phone);
  if (extra) lines.push(extra);
  lines.push('🔗 ' + (process.env.PUBLIC_URL ? process.env.PUBLIC_URL + '/admin' : 'StaffConnect admin'));
  return lines.join('\n');
}

// Parse a timesheet reply like "08:00 16:00", "8am - 5pm", "08:00 to 16:30"
// into { timeIn, timeOut, totalHours }. Returns null if it doesn't look like one.
function parseTimesheetReply(text) {
  const t = String(text || '').toLowerCase();
  // match two clock times with optional am/pm: H, HH:MM, 8am, 17:30pm
  const re = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/g;
  const times = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    if (times.length >= 2) break;
    const h = Number(m[1]);
    if (h > 23) continue;
    let hour = h;
    const min = m[2] ? Number(m[2]) : 0;
    const ap = (m[3] || '').replace(/\./g, '').toLowerCase();
    if (ap === 'pm' && hour < 12) hour += 12;
    if (ap === 'am' && hour === 12) hour = 0;
    if (min > 59) continue;
    times.push({ hour, min });
  }
  if (times.length < 2) return null;
  const minutes = (x) => x.hour * 60 + x.min;
  let diff = minutes(times[1]) - minutes(times[0]);
  // crossing midnight
  if (diff < 0) diff += 24 * 60;
  const fmt = (x) => String(x.hour).padStart(2, '0') + ':' + String(x.min).padStart(2, '0');
  return {
    timeIn: fmt(times[0]),
    timeOut: fmt(times[1]),
    totalHours: Number((diff / 60).toFixed(2)),
  };
}

// ── DB-agnostic helpers (Supabase or SQLite) ──
async function findBookingByPhone(phone, status = 'new') {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return null;
  const digits = (p) => String(p || '').replace(/\D/g, '');
  const matches = (r) => digits(r.phone).endsWith(clean.slice(-9));
  if (useSupabase) {
    const { data } = await supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(500);
    const rows = data || [];
    return rows.find((r) => matches(r) && (status === 'any' || r.status === status)) || null;
  }
  const rows = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500').all();
  return rows.find((r) => matches(r) && (status === 'any' || r.status === status)) || null;
}

// WhatsApp now keys senders by LID (Linked ID) for privacy. The bridge stores a
// lid→phone map in its whatsmeow DB; resolve any LID sender back to a phone number
// so we can match it to a booking. Returns the phone digits (string) or null.
async function resolveLid(sender) {
  if (!WA_BRIDGE_DB) return null;
  const s = String(sender || '');
  const whatsDB = path.join(path.dirname(WA_BRIDGE_DB), 'whatsapp.db');
  if (!fs.existsSync(whatsDB)) return null;
  try {
    const Database = (await import('better-sqlite3')).default;
    const rdb = new Database(whatsDB, { readonly: true });
    const hit = rdb.prepare('SELECT pn FROM whatsmeow_lid_map WHERE lid = ?').get(s);
    rdb.close();
    return hit ? String(hit.pn) : null;
  } catch (e) {
    return null;
  }
}

async function setBookingStatus(ref, status) {
  if (useSupabase) {
    const { error } = await supabase.from('bookings').update({ status }).eq('ref', ref);
    if (error) throw error;
  } else {
    db.prepare('UPDATE bookings SET status = ? WHERE ref = ?').run(status, ref);
  }
}

async function getBookingByRef(ref) {
  if (useSupabase) {
    const { data, error } = await supabase.from('bookings').select('*').eq('ref', ref).maybeSingle();
    if (error) throw error;
    return data || null;
  }
  return db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref) || null;
}

// ── Reminder/availability-sent registry ──
// We only auto-fire stage-2 when a staff reply matches a booking whose stage-1
// availability check WE actually pushed within a recent window. This prevents the
// bridge's huge initial history-sync (and unrelated historical YES/NO chats) from
// retroactively confirming/cancelling older bookings. Persisted to the data dir so
// it survives restarts; same guarantee as seenReplyIds but scoped per booking.
let sentRegistry = new Map(); // ref -> { phone, at }
const SENT_TTL_MS = Number(process.env.SENT_TTL_HOURS || 24 * 7) * 3600 * 1000; // keep a sent-mark for 7 days
let rrdb = null;
let rrdbDatabase = null; // cached Database class
async function loadSentRegistry() {
  try {
    rrdbDatabase = (await import('better-sqlite3')).default;
    rrdb = new rrdbDatabase(path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'bridge_state.db'));
    rrdb.exec(`CREATE TABLE IF NOT EXISTS sent_availability (
      ref TEXT PRIMARY KEY, phone TEXT, at INTEGER
    );`);
    const rows = rrdb.prepare('SELECT ref, phone, at FROM sent_availability').all();
    const now = Date.now();
    for (const r of rows) {
      if (now - r.at > SENT_TTL_MS) continue;
      sentRegistry.set(r.ref, { phone: r.phone, at: r.at });
    }
  } catch (e) {
    console.error('[bridge] sent-registry load error:', e.message);
  }
}
function markAvailabilitySent(ref, phone) {
  sentRegistry.set(ref, { phone, at: Date.now() });
  try {
    if (rrdb) rrdb.prepare('INSERT OR REPLACE INTO sent_availability (ref, phone, at) VALUES (?,?,?)').run(ref, phone, Date.now());
  } catch (e) {}
}
function wasAvailabilitySent(ref, phone, maxAgeMs = SENT_TTL_MS) {
  const e = sentRegistry.get(ref);
  if (!e) return false;
  if (Date.now() - e.at > maxAgeMs) return false;
  const digits = (p) => String(p || '').replace(/\D/g, '');
  return !phone || digits(e.phone).endsWith(digits(phone).slice(-9));
}

// Poll the bridge's SQLite message store for inbound staff replies (YES/NO).
// On YES → set booking 'available' + auto-send stage-2 details.
// On NO  → set booking 'cancelled' (+ notify office via deep link only, live opt-in below).
const seenReplyIds = new Set();
async function pollBridgeReplies() {
  if (!WA_BRIDGE_DB || !bridge || !bridge.online) return;
  let rows;
  try {
    const Database = (await import('better-sqlite3')).default;
    const rdb = new Database(WA_BRIDGE_DB, { readonly: true });
    rows = rdb.prepare(
      `SELECT id, sender, content, timestamp FROM messages
       WHERE is_from_me = 0 AND content IS NOT NULL
       ORDER BY timestamp ASC`
    ).all();
    rdb.close();
  } catch (e) {
    // store not ready yet — skip this tick, no throw (avoids log spam)
    return;
  }
  // Only consider replies that arrived within the last 7 days — protects against
  // the bridge's initial history-sync replaying old messages and auto-mutating older
  // bookings on startup / restart (seenReplyIds is in-memory and resets on reboot).
  const WINDOW = Number(process.env.BRIDGE_REPLY_WINDOW_HOURS || 24 * 7) * 3600 * 1000;
  const nowMs = Date.now();
  for (const row of rows) {
    if (seenReplyIds.has(row.id)) continue;
    const text = String(row.content || '').trim();
    const lower = text.toLowerCase();

    let phone = String(row.sender || '').split('@')[0];
    // WhatsApp LIDs obscure the real number — resolve to the phone via lid_map so we
    // can match the reply to the booking we sent. Fall back to the raw sender digits.
    const lidPhone = await resolveLid(row.sender);
    if (lidPhone) phone = lidPhone;

    // Timesheet reply (two clock times) — only meaningful once an event has wrapped.
    // Try to capture it before the YES/NO availability check so a "08:00 16:00" reply
    // isn't mistaken for a single-word confirmation.
    if (parseTimesheetReply(text)) {
      const capturedRef = await captureTimesheetReply(row, phone);
      if (capturedRef) { seenReplyIds.add(row.id); continue; }
      // fall through if not a timesheet-targeted booking
    }

    // Only treat short affirmative/negative replies as availability answers
    if (!/^(yes|yep|yeah|ya|sure|ok|y|no|nope|nah|not available|busy|can'?t|cant)/.test(lower)) continue;
    const isYes = /^(yes|yep|yeah|ya|sure|ok|y)\b/.test(lower);
    seenReplyIds.add(row.id); // mark seen regardless so history doesn't replay repeatedly

    // Freshness guard: skip replies that are too old to belong to a live booking.
    const replyTime = row.timestamp ? new Date(row.timestamp.replace(' ', 'T') + (row.timestamp.includes('Z') ? '' : 'Z')).getTime() : 0;
    if (!replyTime || (nowMs - replyTime) > WINDOW) continue;

    const booking = await findBookingByPhone(phone);
    if (!booking) continue; // no pending 'new' booking for that number

    // Guard: the reply must be newer than the booking was created, so a reply sent
    // before a booking existed can't retroactively confirm it.
    const bookingTime = new Date(booking.created_at).getTime();
    if (replyTime && bookingTime && replyTime < bookingTime) continue;

    // CRITICAL: only auto-fire when we actually sent this booking's stage-1
    // availability check to that staff member within the recent window. This stops
    // the bridge's history-sync (and unrelated old YES/NO chats) from auto-mutating
    // older bookings on startup/restart.
    if (!wasAvailabilitySent(booking.ref, phone)) continue;

    if (isYes) {
      await setBookingStatus(booking.ref, 'available');
      const details = composeBookingDetails(booking);
      const sent = await sendBroadcast(booking.phone, details);
      await notifyOffice('confirmed', booking);
      console.log(`[bridge] ${booking.ref} staff YES → available; stage-2 sent live=${sent.live} (${sent.reason || 'ok'})`);
    } else {
      await setBookingStatus(booking.ref, 'cancelled');
      await notifyOffice('declined', booking);
      console.log(`[bridge] ${booking.ref} staff NO → cancelled`);
    }
  }
}

// ── Timesheet stage ──
// After the event's end time passes, we (the agency) close the conversation by
// sending the staff member a timesheet request. Their reply (time in / time out)
// is parsed and stored. State lives in bridge_state.db alongside the sent-registry.
let tsRegistry = new Map(); // ref -> { sentAt }
let tsTimesheets = new Map(); // ref -> { timeIn, timeOut, totalHours, raw, at }
function ensureTsTables() {
  if (!rrdb) return;
  rrdb.exec(`CREATE TABLE IF NOT EXISTS timesheet_sent (ref TEXT PRIMARY KEY, at INTEGER);
             CREATE TABLE IF NOT EXISTS timesheets (ref TEXT PRIMARY KEY, time_in TEXT, time_out TEXT, total_hours REAL, raw TEXT, at INTEGER);`);
}
function loadTsRegistries() {
  try {
    ensureTsTables();
    const sents = rrdb.prepare('SELECT ref, at FROM timesheet_sent').all();
    for (const r of sents) tsRegistry.set(r.ref, { sentAt: r.at });
    const rows = rrdb.prepare('SELECT * FROM timesheets').all();
    for (const r of rows) tsTimesheets.set(r.ref, { timeIn: r.time_in, timeOut: r.time_out, totalHours: r.total_hours, raw: r.raw, at: r.at });
  } catch (e) {
    console.error('[bridge] timesheet registry load error:', e.message);
  }
}
function markTimesheetSent(ref) {
  tsRegistry.set(ref, { sentAt: Date.now() });
  try {
    if (rrdb) { ensureTsTables(); rrdb.prepare('INSERT OR REPLACE INTO timesheet_sent (ref, at) VALUES (?,?)').run(ref, Date.now()); }
  } catch (e) {}
}
function wasTimesheetSent(ref) {
  return tsRegistry.has(ref);
}
function storeTimesheet(ref, data, raw) {
  tsTimesheets.set(ref, { ...data, raw, at: Date.now() });
  try {
    if (rrdb) {
      ensureTsTables();
      rrdb.prepare('INSERT OR REPLACE INTO timesheets (ref, time_in, time_out, total_hours, raw, at) VALUES (?,?,?,?,?,?)')
        .run(ref, data.timeIn, data.timeOut, data.totalHours, raw, Date.now());
    }
  } catch (e) { console.error('[bridge] timesheet store error:', e.message); }
}
function getTimesheet(ref) {
  return tsTimesheets.get(ref) || null;
}

// Auto-send timesheet request once the event has ended, for staff who confirmed.
async function pollTimesheets() {
  if (!WA_BRIDGE_URL || !bridge || !bridge.online || !bridge.authenticated) return;
  let bookings;
  if (useSupabase) {
    const { data } = await supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(500);
    bookings = data || [];
  } else {
    bookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500').all();
  }
  const now = new Date();
  for (const b of bookings) {
    if (!['available', 'confirmed'].includes(b.status)) continue;   // must have confirmed
    if (wasTimesheetSent(b.ref)) continue;                          // don't spam
    const end = eventEndDate(b);
    if (!end || now < end) continue;                                // event not over yet
    const text = composeTimesheetRequest(b);
    const sent = await sendBroadcast(b.phone, text);
    if (sent.live) markTimesheetSent(b.ref);
    console.log(`[bridge] ${b.ref} timesheet request sent live=${sent.live} (${sent.reason || 'ok'})`);
  }
}

// Combine event_date (YYYY-MM-DD) + end_time (HH:MM) into a local Date.
function eventEndDate(b) {
  if (!b.event_date || !b.end_time) return null;
  const m = String(b.end_time).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${b.event_date}T${m[1].padStart(2, '0')}:${m[2]}:00`);
}

// Detect a timesheet reply (two clock times) and capture it against a confirmed booking
// whose timesheet request we sent. Returns the booking ref captured, or null.
async function captureTimesheetReply(row, phone) {
  const parsed = parseTimesheetReply(row.content);
  if (!parsed) return null;
  const booking = await findBookingByPhone(phone, 'any');
  if (!booking) return null;
  if (!wasTimesheetSent(booking.ref)) return null; // we must have asked
  storeTimesheet(booking.ref, parsed, String(row.content));
  console.log(`[bridge] ${booking.ref} timesheet captured: in ${parsed.timeIn} out ${parsed.timeOut} = ${parsed.totalHours}h`);  // Acknowledge to the staff member (agency is the one ending the conversation).
  const ack = [
    `Thanks ${booking.name}! Your timesheet is logged ✅`,
    '',
    `⏰ In: ${parsed.timeIn}`,
    `⏰ Out: ${parsed.timeOut}`,
    `🧮 Total: ${parsed.totalHours} hours`,
    '',
    '📌 Ref: ' + booking.ref + ' · StaffConnect',
  ].join('\n');
  await sendBroadcast(booking.phone, ack);
  // Also notify the office with the captured hours (agency ends the conversation).
  await notifyOffice('timesheet', booking, `🧮 Total: ${parsed.totalHours}h (${parsed.timeIn}–${parsed.timeOut})`);
  return booking.ref;
}

// ── Autonomous lifecycle: nudges + office notifications ──
// Nudge registry persists how many follow-ups we've sent per booking/stage so we
// never spam and never re-fire across restarts.
let nudgeRegistry = new Map(); // `${ref}|${stage}` -> { count, lastNudgeAt }
function ensureNudgeTables() {
  if (!rrdb) return;
  rrdb.exec(`CREATE TABLE IF NOT EXISTS nudges (
    key TEXT PRIMARY KEY, count INTEGER, last_at INTEGER
  );`);
}
function loadNudgeRegistries() {
  try {
    ensureNudgeTables();
    const rows = rrdb.prepare('SELECT key, count, last_at FROM nudges').all();
    for (const r of rows) nudgeRegistry.set(r.key, { count: r.count, lastNudgeAt: r.last_at });
  } catch (e) { console.error('[bridge] nudge registry load error:', e.message); }
}
function nudgeCount(ref, stage) {
  return (nudgeRegistry.get(ref + '|' + stage) || {}).count || 0;
}
function markNudgeSent(ref, stage) {
  const key = ref + '|' + stage;
  const cur = nudgeRegistry.get(key) || { count: 0, lastNudgeAt: 0 };
  nudgeRegistry.set(key, { count: cur.count + 1, lastNudgeAt: Date.now() });
  try {
    if (rrdb) { ensureNudgeTables(); rrdb.prepare('INSERT OR REPLACE INTO nudges (key, count, last_at) VALUES (?,?,?)').run(key, cur.count + 1, Date.now()); }
  } catch (e) {}
}

// Notify the agency office number (we're the one closing the conversation).
async function notifyOffice(kind, b, extra) {
  if (!WA_BRIDGE_URL || !bridge || !bridge.authenticated) return { ok: false, live: false, reason: 'bridge not live' };
  return sendBroadcast(WA_NUMBER, composeOfficeSummary(kind, b, extra));
}

// Autonomous loop — decide which follow-ups to fire on this tick.
async function pollLifecycle() {
  if (!WA_BRIDGE_URL || !bridge || !bridge.online || !bridge.authenticated) return;
  let bookings;
  if (useSupabase) {
    const { data } = await supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(500);
    bookings = data || [];
  } else {
    bookings = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500').all();
  }
  const now = Date.now();
  for (const b of bookings) {
    // 1) Availability nudge — staff got the stage-1 check but never replied (still 'new').
    if (b.status === 'new' && wasAvailabilitySent(b.ref)) {
      const sent = sentRegistry.get(b.ref);
      const age = sent ? now - sent.at : 0;
      const count = nudgeCount(b.ref, 'availability');
      if (age >= AVAIL_NUDGE_HOURS * HOURS_MS && count < AVAIL_MAX_NUDGES) {
        const text = composeAvailabilityNudge(b, count + 1);
        const r = await sendBroadcast(b.phone, text);
        if (r.live) markNudgeSent(b.ref, 'availability');
        console.log(`[lifecycle] ${b.ref} availability nudge ${count + 1}/${AVAIL_MAX_NUDGES} live=${r.live}`);
      }
    }

    // 2) Timesheet nudge — staff confirmed, event ended, we asked, but no timesheet yet.
    if (['available', 'confirmed'].includes(b.status) && wasTimesheetSent(b.ref)) {
      const end = eventEndDate(b);
      if (end && now > end.getTime() && !getTimesheet(b.ref)) {
        const tss = tsRegistry.get(b.ref);
        const age = tss ? now - tss.sentAt : 0;
        const count = nudgeCount(b.ref, 'timesheet');
        if (age >= TS_NUDGE_HOURS * HOURS_MS && count < TS_MAX_NUDGES) {
          const text = composeTimesheetNudge(b, count + 1);
          const r = await sendBroadcast(b.phone, text);
          if (r.live) markNudgeSent(b.ref, 'timesheet');
          console.log(`[lifecycle] ${b.ref} timesheet nudge ${count + 1}/${TS_MAX_NUDGES} live=${r.live}`);
        }
      }
    }
  }
}

// ── API ──
app.get('/api/health', (req, res) => res.json({
  ok: true, storage: useSupabase ? 'supabase' : 'sqlite', time: new Date().toISOString()
}));

app.post('/api/bookings', async (req, res) => {
  const { role, event_date, start_time, end_time, headcount, venue, name, phone, email, notes } = req.body || {};
  if (!role || !event_date || !headcount || !venue || !name || !phone) {
    return res.status(400).json({ error: 'Missing required fields: role, event_date, headcount, venue, name, phone.' });
  }
  const ref = genRef();
  const availability_text = composeAvailabilityMessage({
    name, event_date, start_time: start_time || '', end_time: end_time || '', venue, ref,
  });
  const details_text = composeBookingDetails({
    role, event_date, start_time: start_time || '', end_time: end_time || '', venue, notes, ref,
  });
  const payload = {
    ref, role, event_date,
    start_time: start_time || '', end_time: end_time || '',
    headcount: Number(headcount), venue, name, phone,
    email: email || '', notes: notes || '', status: 'new',
    whatsapp_text: details_text, // store the full details; availability is composed on the fly
  };

  try {
    let row;
    if (useSupabase) {
      const { data, error } = await supabase.from('bookings').insert(payload).select().single();
      if (error) throw error;
      row = data;
    } else {
      const stmt = db.prepare(`INSERT INTO bookings
        (ref, role, event_date, start_time, end_time, headcount, venue, name, phone, email, notes, status, whatsapp_text)
        VALUES (@ref, @role, @event_date, @start_time, @end_time, @headcount, @venue, @name, @phone, @email, @notes, @status, @whatsapp_text)`);
      stmt.run(payload);
      row = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
    }
    const clean = (n) => String(n || '').replace(/\D/g, '');
    const staffJid = clean(phone);
    // Stage 1 — availability check to the staff member
    const waLink = `https://wa.me/${staffJid}?text=${encodeURIComponent(availability_text)}`;
    // Stage 2 — full details to the staff member (send after they confirm)
    const waLinkDetails = `https://wa.me/${staffJid}?text=${encodeURIComponent(details_text)}`;
    // Fallback — to the agency office
    const waLinkOffice = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(availability_text)}`;

    // Live send: if the bridge is authenticated, push stage-1 availability now.
    let liveSend = null;
    let bridgeState = await bridgeHealth();
    if (bridgeState.online && bridgeState.authenticated) {
      liveSend = await sendBroadcast(staffJid, availability_text);
      if (liveSend && liveSend.live) markAvailabilitySent(ref, staffJid);
      await notifyOffice('created', row); // agency gets a summary of the new booking
    }
    res.status(201).json({
      booking: row, waLink, waLinkDetails, waLinkOffice,
      bridge: { available: bridgeState.online, authenticated: bridgeState.authenticated },
      stage1: liveSend, // {ok, live, reason|fallbackLink}
    });
  } catch (err) {
    console.error('create booking error:', err.message);
    res.status(500).json({ error: 'Failed to save booking: ' + err.message });
  }
});

function checkAdmin(req, res) {
  const code = req.get('x-admin-code') || (req.query && req.query.code);
  if (code !== ADMIN_CODE) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  return true;
}

app.get('/api/admin/bookings', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { status } = req.query;
  try {
    let rows;
    if (useSupabase) {
      let q = supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(200);
      if (status && ['new','available','quoted','confirmed','cancelled'].includes(status)) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      rows = data;
    } else {
      if (status && ['new','available','quoted','confirmed','cancelled'].includes(status)) {
        rows = db.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
      } else {
        rows = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 200').all();
      }
    }
    res.json({ bookings: rows });
  } catch (err) {
    console.error('admin list error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/bookings/:ref/messages', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const b = await getBookingByRef(req.params.ref);
    if (!b) return res.status(404).json({ error: 'Not found.' });
    const clean = (n) => String(n || '').replace(/\D/g, '');
    const staffJid = clean(b.phone);
    const availability_text = composeAvailabilityMessage(b);
    const details_text = composeBookingDetails(b);
    const timesheet_text = composeTimesheetRequest(b);
    res.json({
      phone: b.phone,
      linkAvailability: `https://wa.me/${staffJid}?text=${encodeURIComponent(availability_text)}`,
      linkDetails: `https://wa.me/${staffJid}?text=${encodeURIComponent(details_text)}`,
      linkTimesheet: `https://wa.me/${staffJid}?text=${encodeURIComponent(timesheet_text)}`,
      linkOffice: `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(availability_text)}`,
      availability_text,
      details_text,
      timesheet_text,
      timesheet: getTimesheet(b.ref), // captured time-in/out/total, if any
    });
  } catch (err) {
    console.error('compose messages error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── All captured timesheets (admin) ──
app.get('/api/admin/timesheets', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const out = [];
  for (const [ref, ts] of tsTimesheets) {
    const b = await getBookingByRef(ref).catch(() => null);
    out.push({
      ref, timeIn: ts.timeIn, timeOut: ts.timeOut, totalHours: ts.totalHours, raw: ts.raw, at: ts.at,
      name: b ? b.name : null, role: b ? b.role : null, venue: b ? b.venue : null, event_date: b ? b.event_date : null, phone: b ? b.phone : null,
    });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  res.json({ timesheets: out });
});

// ── Manually send a timesheet request now (admin) ──
app.post('/api/admin/bookings/:ref/timesheet', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const b = await getBookingByRef(req.params.ref);
    if (!b) return res.status(404).json({ error: 'Not found.' });
    const text = composeTimesheetRequest(b);
    const result = await sendBroadcast(b.phone, text);
    if (result.live) markTimesheetSent(b.ref);
    res.json({ ref: b.ref, result, text });
  } catch (err) {
    console.error('timesheet send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/bookings/:ref', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { status } = req.body || {};
  const allowed = ['new', 'available', 'quoted', 'confirmed', 'cancelled'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Allowed: ' + allowed.join(', ') });
  }
  try {
    if (useSupabase) {
      const { data, error } = await supabase.from('bookings').update({ status }).eq('ref', req.params.ref).select().maybeSingle();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: 'Not found.' });
      return res.json({ ok: true, ref: req.params.ref, status });
    } else {
      const r = db.prepare('UPDATE bookings SET status = ? WHERE ref = ?').run(status, req.params.ref);
      if (r.changes === 0) return res.status(404).json({ error: 'Not found.' });
      return res.json({ ok: true, ref: req.params.ref, status });
    }
  } catch (err) {
    console.error('status update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── pages ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Bridge status (admin + diagnostic) ──
app.get('/api/bridge/status', async (req, res) => {
  const st = await bridgeHealth();
  res.json({
    configured: !!WA_BRIDGE_URL,
    url: st.url || null,
    online: st.online,
    authenticated: st.authenticated,
    connected: st.connected || false,
    reason: st.reason || null,
    dbPresent: WA_BRIDGE_DB && fs.existsSync(WA_BRIDGE_DB),
  });
});

// ── Live bridge QR code (serves the current code; refreshes ~20s) ──
// The QR lives in the bridge's store dir as qr.png. We stream it with no-cache
// so a browser refresh always shows the current rotating code.
app.get('/qr', (req, res) => {
  if (!WA_BRIDGE_DB) return res.status(404).send('Bridge not configured');
  const qrPath = path.join(path.dirname(WA_BRIDGE_DB), 'qr.png');
  if (!fs.existsSync(qrPath)) return res.status(404).send('No QR yet — bridge starting or already authenticated.');
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.sendFile(qrPath);
});

// ── Live re-send of a booking's stage (admin) ──
app.post('/api/admin/bookings/:ref/send', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { stage } = req.body || {};
  try {
    let b;
    if (useSupabase) {
      const { data, error } = await supabase.from('bookings').select('*').eq('ref', req.params.ref).maybeSingle();
      if (error) throw error;
      b = data;
    } else {
      b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(req.params.ref);
    }
    if (!b) return res.status(404).json({ error: 'Not found.' });
    const text = stage === 'details'
      ? composeBookingDetails(b)
      : composeAvailabilityMessage(b);
    const result = await sendBroadcast(b.phone, text);
    res.json({ ref: b.ref, stage: stage || 'availability', result });
  } catch (err) {
    console.error('live send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`StaffConnect listening on http://localhost:${PORT} (WA ${WA_NUMBER})`);
  // Start bridge health + reply polling loops
  if (WA_BRIDGE_URL) {
    const health = await bridgeHealth();
    console.log(`WhatsApp bridge: ${health.online ? 'online' : 'offline'} · authenticated=${health.authenticated} (${health.reason || 'ok'})`);
    if (WA_BRIDGE_DB) {
      await loadSentRegistry(); // persist which bookings got a live stage-1
      await loadTsRegistries(); // timesheet request-sent + captured data
      await loadNudgeRegistries(); // autonomous follow-up counts
      setInterval(() => pollBridgeReplies().catch((e) => console.error('[bridge] poll error:', e.message)), BRIDGE_POLL_MS);
      setInterval(() => pollTimesheets().catch((e) => console.error('[bridge] timesheet poll error:', e.message)), BRIDGE_POLL_MS);
      setInterval(() => pollLifecycle().catch((e) => console.error('[lifecycle] poll error:', e.message)), Number(process.env.LIFECYCLE_POLL_MS || 60000));
    }
    setInterval(() => bridgeHealth().catch(() => {}), 15000);
  }
});
