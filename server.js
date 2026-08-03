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

function composeWhatsApp(b) {
  const fields = [
    'Hi Fresh People! I\'d like to book event staff.',
    '📅 Event date: ' + b.event_date,
    '🕒 Times: ' + b.start_time + ' – ' + b.end_time,
    '👥 Staff needed: ' + b.headcount,
    '🎯 Role: ' + b.role,
    '📍 Venue/area: ' + b.venue,
    '🙋 Name: ' + b.name,
    '📱 Phone: ' + b.phone,
  ];
  if (b.notes) fields.push('📝 Notes: ' + b.notes);
  fields.push('📌 Ref: ' + b.ref);
  return fields.join('\n');
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
  const whatsapp_text = composeWhatsApp({
    role, event_date, start_time: start_time || '', end_time: end_time || '', headcount,
    venue, name, phone, notes, ref,
  });
  const payload = {
    ref, role, event_date,
    start_time: start_time || '', end_time: end_time || '',
    headcount: Number(headcount), venue, name, phone,
    email: email || '', notes: notes || '', status: 'new', whatsapp_text,
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
    const waLink = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(whatsapp_text)}`;
    res.status(201).json({ booking: row, waLink });
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
      if (status && ['new','quoted','confirmed','cancelled'].includes(status)) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      rows = data;
    } else {
      if (status && ['new','quoted','confirmed','cancelled'].includes(status)) {
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

app.patch('/api/admin/bookings/:ref', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { status } = req.body || {};
  const allowed = ['new', 'confirmed', 'quoted', 'cancelled'];
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

app.listen(PORT, () => {
  console.log(`StaffConnect listening on http://localhost:${PORT} (WA ${WA_NUMBER})`);
});
