// Clinic server: database + safety rules + local model (LM Studio) + doctor console + patient app.
// Requires Node 22.13+ (built-in SQLite). No npm dependencies.
// Run:  node server/server.mjs      then open  http://127.0.0.1:8787/doctor   and  http://127.0.0.1:8787/patient/
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, getPatient, listPatients, upsertPatient, setIntake, addMessage, messagesAfter,
  recentMessages, addAlert, listAlerts, answerAlert, openAlertCount, patientCount } from './db.mjs';
import { EMERGENCY, MED_CHANGE, REVIEW_MARK, TEXT, needIntake, intakeQuestion, penicillinConflict } from './rules.mjs';
import { buildMessages, askModel, LM_URL, LM_MODEL } from './llm.mjs';
import { seedIfEmpty } from './seed.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(here, 'data');
const MAX_BODY = 12 * 1024 * 1024;

/* ---------- setup ---------- */
await fs.mkdir(DATA_DIR, { recursive: true });
const db = openDb(path.join(DATA_DIR, 'clinic.db'));
seedIfEmpty(db);

// Doctor token: from DOCTOR_TOKEN, or generated once and kept in data/doctor-token.txt.
const tokenFile = path.join(DATA_DIR, 'doctor-token.txt');
let DOCTOR_TOKEN = process.env.DOCTOR_TOKEN || '';
if (!DOCTOR_TOKEN) {
  try { DOCTOR_TOKEN = (await fs.readFile(tokenFile, 'utf8')).trim(); } catch {}
  if (!DOCTOR_TOKEN) {
    DOCTOR_TOKEN = crypto.randomBytes(16).toString('hex');
    await fs.writeFile(tokenFile, DOCTOR_TOKEN, 'utf8');
  }
}

/* ---------- patient chat ---------- */
const ok = body => ({ status: 200, body });

async function answer(p, question, image) {
  if (penicillinConflict(p, question)) {
    addAlert(db, p.id, 'penicillin', question);
    return { type: 'refer', kind: 'pending', reply: TEXT.penicillin };
  }
  if (MED_CHANGE.test(question)) {
    addAlert(db, p.id, 'medication', question);
    return { type: 'refer', kind: 'pending', reply: TEXT.refer };
  }
  // The question itself is already stored; the history is everything before it.
  const history = recentMessages(db, p.id, 11).slice(0, -1);
  let out;
  try {
    out = await askModel(buildMessages(getPatient(db, p.id), history, question, image));
  } catch (e) {
    console.error('model:', e.message);
    addAlert(db, p.id, 'model-error', question || 'صورة');
    return { type: 'refer', kind: 'pending', reply: TEXT.fallback };
  }
  if (image) {
    addAlert(db, p.id, 'image', question || 'صورة');
    return { type: 'answer', kind: 'pending', reply: `${out.replace(REVIEW_MARK, '').trim()}\n\n(الصورة أُرسلت للدكتور للمراجعة.)` };
  }
  if (REVIEW_MARK.test(out)) {
    addAlert(db, p.id, 'review', question);
    return { type: 'answer', kind: 'pending', reply: `${out.replace(REVIEW_MARK, '').trim()}\n\n${TEXT.review}` };
  }
  return { type: 'answer', kind: 'ok', reply: out };
}

async function handleChat(body) {
  const patientId = String(body.patientId || '');
  const text = String(body.message || '').trim().slice(0, 2000);
  const image = typeof body.image === 'string' && body.image.startsWith('data:image/') ? body.image : '';
  if (!text && !image) return { status: 400, body: { error: 'empty message' } };
  let p = getPatient(db, patientId);
  if (!p) return { status: 404, body: { error: 'unknown patient' } };

  // Every question is read against the patient's current record, right now.
  addMessage(db, patientId, 'patient', text || '[صورة]');

  let out;
  if (EMERGENCY.test(text)) {
    addAlert(db, patientId, 'emergency', text);
    out = { type: 'emergency', kind: 'emergency', reply: TEXT.emergency() };
  } else if (p.intake.asked && !p.intake.done) {
    // The patient is answering the intake questions; then the pending question is answered.
    const pending = p.intake.pendingQuestion;
    setIntake(db, patientId, { asked: false, done: true, raw: text, pendingQuestion: '' });
    p = getPatient(db, patientId);
    if (!pending) out = { type: 'saved', kind: 'plain', reply: TEXT.askNext };
    else {
      const res = await answer(p, pending, '');
      out = { ...res, reply: `${TEXT.saved}\n\n${res.reply}` };
    }
  } else if (needIntake(p)) {
    setIntake(db, patientId, { asked: true, done: false, raw: '', pendingQuestion: text });
    out = { type: 'intake', kind: 'plain', reply: intakeQuestion(p) };
  } else {
    out = await answer(p, text, image);
  }
  addMessage(db, patientId, 'bot', out.reply, out.kind);
  return ok(out);
}

/* ---------- doctor side ---------- */
const trimList = v => {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s) return null;                                   // empty = not recorded
  if (/^(لا يوجد|لا توجد|لا شي|لا شيء|none)$/i.test(s)) return [];   // explicit "none"
  return s.split(/[,،\n]/).map(x => x.trim()).filter(Boolean);
};
const pregnantValue = v => (v === true || v === 'yes' || v === 'نعم' ? true : v === false || v === 'no' || v === 'لا' ? false : null);

function patientFromBody(body, old) {
  const next = { ...(old || {}) };
  const set = (k, v) => { if (v !== undefined) next[k] = v; };
  if (body.id !== undefined) next.id = String(body.id).trim();
  if (body.name !== undefined) next.name = String(body.name).trim();
  if (body.sex !== undefined) next.sex = body.sex === 'f' ? 'f' : 'm';
  if (body.age !== undefined) set('age', body.age === '' || body.age == null ? null : Number(body.age));
  if (body.phone !== undefined) next.phone = String(body.phone).trim();
  if (body.allergies !== undefined) next.allergies = trimList(body.allergies);
  if (body.chronic !== undefined) next.chronic = trimList(body.chronic);
  if (body.pregnant !== undefined) next.pregnant = pregnantValue(body.pregnant);
  if (body.medications !== undefined) next.medications = trimList(body.medications) || [];
  if (body.treatment !== undefined) next.treatment = String(body.treatment || '');
  if (body.doctorNotes !== undefined) next.doctorNotes = String(body.doctorNotes || '');
  if (body.details !== undefined) next.details = String(body.details || '');
  if (next.sex !== 'f') next.pregnant = null;
  return next;
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function send(res, status, body) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Doctor-Token',
    'Access-Control-Allow-Private-Network': 'true',
  };
  if (status === 204) { res.writeHead(204, headers); return res.end(); }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function sendFile(res, file) {
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); reject(Object.assign(new Error('payload too large'), { status: 413 })); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const requireDoctor = req => {
  const given = String(req.headers['x-doctor-token'] || '');
  const a = Buffer.from(given), b = Buffer.from(DOCTOR_TOKEN);
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    const e = new Error('unauthorized'); e.status = 401; throw e;
  }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    // Pages
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/doctor')) return sendFile(res, path.join(here, 'public', 'doctor.html'));
    if (req.method === 'GET' && (url.pathname === '/patient' || url.pathname === '/patient/')) return sendFile(res, path.join(ROOT, 'docs', 'patient', 'index.html'));

    // Public API
    if (req.method === 'GET' && url.pathname === '/api/health') {
      let lm = 'unreachable';
      try { lm = (await fetch(`${LM_URL}/models`)).ok ? 'ok' : 'error'; } catch {}
      return send(res, 200, { server: 'ok', lmstudio: lm, model: LM_MODEL, patients: patientCount(db), openAlerts: openAlertCount(db) });
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const out = await handleChat(await readBody(req));
      return send(res, out.status, out.body);
    }
    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'patients' && parts[3] === 'messages') {
      const id = decodeURIComponent(parts[2]);
      if (!getPatient(db, id)) return send(res, 404, { error: 'unknown patient' });
      const after = Number(url.searchParams.get('after') || 0);
      return send(res, 200, { messages: messagesAfter(db, id, after) });
    }

    // Doctor API (token required)
    if (parts[0] === 'api' && parts[1] === 'doctor') {
      requireDoctor(req);
      if (req.method === 'GET' && parts[2] === 'patients' && !parts[3]) return send(res, 200, { patients: listPatients(db) });
      if (req.method === 'GET' && parts[2] === 'patients' && parts[3]) {
        const p = getPatient(db, decodeURIComponent(parts[3]));
        return p ? send(res, 200, { patient: p }) : send(res, 404, { error: 'unknown patient' });
      }
      if (req.method === 'PUT' && parts[2] === 'patients' && parts[3]) {
        const id = decodeURIComponent(parts[3]);
        const body = await readBody(req);
        const next = patientFromBody({ ...body, id: body.id || id }, getPatient(db, id));
        if (!next.id || !next.name) return send(res, 400, { error: 'id and name are required' });
        return send(res, 200, { patient: upsertPatient(db, next) });
      }
      if (req.method === 'GET' && parts[2] === 'alerts') return send(res, 200, { open: openAlertCount(db), alerts: listAlerts(db) });
      if (req.method === 'POST' && parts[2] === 'alerts' && parts[4] === 'reply') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return send(res, 400, { error: 'empty reply' });
        const pid = answerAlert(db, Number(parts[3]), text);
        return pid ? send(res, 200, { ok: true, patientId: pid }) : send(res, 404, { error: 'unknown alert' });
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.status && e.status < 500) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'server error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`clinic server on http://${HOST}:${PORT}`);
  console.log(`  doctor console: http://${HOST}:${PORT}/doctor   (token: ${DOCTOR_TOKEN})`);
  console.log(`  patient app:    http://${HOST}:${PORT}/patient/`);
  console.log(`  model:          ${LM_URL}  (${LM_MODEL})`);
});
