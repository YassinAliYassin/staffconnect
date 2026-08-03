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

// ── DB-agnostic helpers (Supabase or SQLite) ──
async function findBookingByPhone(phone) {
  const clean = String(phone || '').replace(/\D/g, '');
  if (!clean) return null;
  const digits = (p) => String(p || '').replace(/\D/g, '');
  if (useSupabase) {
    const { data } = await supabase.from('bookings').select('*').order('created_at', { ascending: false }).limit(500);
    const rows = data || [];
    return rows.find((r) => digits(r.phone).endsWith(clean.slice(-9)) && r.status === 'new') || null;
  }
  const rows = db.prepare('SELECT * FROM bookings ORDER BY created_at DESC LIMIT 500').all();
  const found = rows.find((r) => digits(r.phone).endsWith(clean.slice(-9)) && r.status === 'new');
  return found || null;
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
    // Only treat short affirmative/negative replies as availability answers
    if (!/^(yes|yep|yeah|ya|sure|ok|y|no|nope|nah|not available|busy|can'?t|cant)/.test(lower)) continue;
    const isYes = /^(yes|yep|yeah|ya|sure|ok|y)\b/.test(lower);
    seenReplyIds.add(row.id); // mark seen regardless so history doesn't replay repeatedly

    // Freshness guard: skip replies that are too old to belong to a live booking.
    const replyTime = row.timestamp ? new Date(row.timestamp.replace(' ', 'T') + (row.timestamp.includes('Z') ? '' : 'Z')).getTime() : 0;
    if (!replyTime || (nowMs - replyTime) > WINDOW) continue;

    let phone = String(row.sender || '').split('@')[0];
    // WhatsApp LIDs obscure the real number — resolve to the phone via lid_map so we
    // can match the reply to the booking we sent. Fall back to the raw sender digits.
    const lidPhone = await resolveLid(row.sender);
    if (lidPhone) phone = lidPhone;
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
      console.log(`[bridge] ${booking.ref} staff YES → available; stage-2 sent live=${sent.live} (${sent.reason || 'ok'})`);
    } else {
      await setBookingStatus(booking.ref, 'cancelled');
      console.log(`[bridge] ${booking.ref} staff NO → cancelled`);
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
    let b;
    if (useSupabase) {
      const { data, error } = await supabase.from('bookings').select('*').eq('ref', req.params.ref).maybeSingle();
      if (error) throw error;
      b = data;
    } else {
      b = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(req.params.ref);
    }
    if (!b) return res.status(404).json({ error: 'Not found.' });
    const clean = (n) => String(n || '').replace(/\D/g, '');
    const staffJid = clean(b.phone);
    const availability_text = composeAvailabilityMessage(b);
    const details_text = composeBookingDetails(b);
    res.json({
      phone: b.phone,
      linkAvailability: `https://wa.me/${staffJid}?text=${encodeURIComponent(availability_text)}`,
      linkDetails: `https://wa.me/${staffJid}?text=${encodeURIComponent(details_text)}`,
      linkOffice: `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(availability_text)}`,
      availability_text,
      details_text,
    });
  } catch (err) {
    console.error('compose messages error:', err.message);
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
      setInterval(() => pollBridgeReplies().catch((e) => console.error('[bridge] poll error:', e.message)), BRIDGE_POLL_MS);
    }
    setInterval(() => bridgeHealth().catch(() => {}), 15000);
  }
});
