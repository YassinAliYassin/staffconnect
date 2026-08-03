import express from 'express';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5184;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WA_NUMBER = process.env.WA_NUMBER || '27672961272';
const ADMIN_CODE = process.env.ADMIN_CODE || 'fresh-admin';

import fs from 'node:fs';
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'bookings.db'));
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

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---- helpers ----
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

// ---- API ----
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/api/bookings', (req, res) => {
  const { role, event_date, start_time, end_time, headcount, venue, name, phone, email, notes } = req.body || {};
  if (!role || !event_date || !headcount || !venue || !name || !phone) {
    return res.status(400).json({ error: 'Missing required fields: role, event_date, headcount, venue, name, phone.' });
  }
  const ref = genRef();
  const whatsapp_text = composeWhatsApp({
    role, event_date, start_time: start_time || '', end_time: end_time || '', headcount,
    venue, name, phone, notes, ref,
  });
  const stmt = db.prepare(`INSERT INTO bookings
    (ref, role, event_date, start_time, end_time, headcount, venue, name, phone, email, notes, whatsapp_text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  stmt.run(ref, role, event_date, start_time || '', end_time || '', Number(headcount), venue, name, phone, email || '', notes || '', whatsapp_text);
  const row = db.prepare('SELECT * FROM bookings WHERE ref = ?').get(ref);
  const waLink = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(whatsapp_text)}`;
  res.status(201).json({ booking: row, waLink });
});

// admin list + status update (guarded by admin code)
function checkAdmin(req, res) {
  const code = req.get('x-admin-code') || (req.query && req.query.code);
  if (code !== ADMIN_CODE) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  return true;
}

app.get('/api/admin/bookings', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { status } = req.query;
  let rows;
  if (status && ['new','quoted','confirmed','cancelled'].includes(status)) {
    rows = db.prepare('SELECT id, ref, role, event_date, start_time, end_time, headcount, venue, name, phone, email, status, whatsapp_text, created_at FROM bookings WHERE status = ? ORDER BY created_at DESC LIMIT 200').all(status);
  } else {
    rows = db.prepare('SELECT id, ref, role, event_date, start_time, end_time, headcount, venue, name, phone, email, status, whatsapp_text, created_at FROM bookings ORDER BY created_at DESC LIMIT 200').all();
  }
  res.json({ bookings: rows });
});

app.patch('/api/admin/bookings/:ref', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { status } = req.body || {};
  const allowed = ['new', 'confirmed', 'quoted', 'cancelled'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: 'Invalid status. Allowed: ' + allowed.join(', ') });
  }
  const r = db.prepare('UPDATE bookings SET status = ? WHERE ref = ?').run(status, req.params.ref);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true, ref: req.params.ref, status });
});

// ---- pages ----
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.listen(PORT, () => {
  console.log(`Fresh People Book listening on http://localhost:${PORT} (WA ${WA_NUMBER})`);
});
