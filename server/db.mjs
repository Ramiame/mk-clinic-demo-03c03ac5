// Clinic database (SQLite, built into Node 22.13+ / 24+ / 26).
// Tables: patients (doctor-entered records), messages (conversation with the patient), alerts (items for the doctor).
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS patients (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      sex           TEXT NOT NULL DEFAULT 'm',       -- 'm' | 'f'
      age           INTEGER,
      phone         TEXT,
      allergies     TEXT,                             -- JSON array; NULL = not recorded; [] = none
      chronic       TEXT,                             -- JSON array; NULL = not recorded; [] = none
      pregnant      INTEGER,                          -- NULL = not recorded, 0 / 1
      medications   TEXT NOT NULL DEFAULT '[]',       -- JSON array
      treatment     TEXT NOT NULL DEFAULT '',
      doctor_notes  TEXT NOT NULL DEFAULT '',
      details       TEXT NOT NULL DEFAULT '',         -- any other details the doctor writes
      intake_asked  INTEGER NOT NULL DEFAULT 0,
      intake_done   INTEGER NOT NULL DEFAULT 0,
      intake_raw    TEXT NOT NULL DEFAULT '',         -- what the patient said when asked
      intake_pending TEXT NOT NULL DEFAULT '',        -- the question waiting for the intake answer
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id  TEXT NOT NULL REFERENCES patients(id),
      role        TEXT NOT NULL,                      -- 'patient' | 'bot' | 'doctor'
      text        TEXT NOT NULL,
      kind        TEXT NOT NULL DEFAULT 'plain',      -- 'ok' | 'pending' | 'emergency' | 'doctor' | 'plain'
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_patient ON messages(patient_id, id);
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_id  TEXT NOT NULL REFERENCES patients(id),
      type        TEXT NOT NULL,                      -- emergency | penicillin | medication | review | image | model-error
      question    TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'open',       -- 'open' | 'answered'
      reply       TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL,
      answered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS alerts_status ON alerts(status, id);
  `);
  return db;
}

const now = () => new Date().toISOString();
const j = v => JSON.stringify(v ?? null);
const parse = (s, fallback = null) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };

function rowToPatient(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    sex: r.sex,
    age: r.age,
    phone: r.phone || '',
    allergies: parse(r.allergies, null),
    chronic: parse(r.chronic, null),
    pregnant: r.pregnant == null ? null : !!r.pregnant,
    medications: parse(r.medications, []),
    treatment: r.treatment,
    doctorNotes: r.doctor_notes,
    details: r.details,
    intake: { asked: !!r.intake_asked, done: !!r.intake_done, raw: r.intake_raw, pendingQuestion: r.intake_pending },
    updatedAt: r.updated_at,
  };
}

export function getPatient(db, id) {
  return rowToPatient(db.prepare('SELECT * FROM patients WHERE id = ?').get(id));
}

export function listPatients(db) {
  return db.prepare('SELECT * FROM patients ORDER BY name').all().map(rowToPatient);
}

// Create or update a patient record from the doctor's form. Intake fields are kept unless passed.
export function upsertPatient(db, p) {
  const old = getPatient(db, p.id);
  const merged = { ...(old || {}), ...p, intake: { ...(old?.intake || { asked: false, done: false, raw: '', pendingQuestion: '' }), ...(p.intake || {}) } };
  db.prepare(`INSERT INTO patients (id,name,sex,age,phone,allergies,chronic,pregnant,medications,treatment,doctor_notes,details,
      intake_asked,intake_done,intake_raw,intake_pending,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, sex=excluded.sex, age=excluded.age, phone=excluded.phone,
      allergies=excluded.allergies, chronic=excluded.chronic, pregnant=excluded.pregnant, medications=excluded.medications,
      treatment=excluded.treatment, doctor_notes=excluded.doctor_notes, details=excluded.details, updated_at=excluded.updated_at`)
    .run(
      merged.id, merged.name, merged.sex || 'm', merged.age ?? null, merged.phone || '',
      j(merged.allergies), j(merged.chronic), merged.pregnant == null ? null : merged.pregnant ? 1 : 0,
      j(merged.medications || []), merged.treatment || '', merged.doctorNotes || '', merged.details || '',
      merged.intake.asked ? 1 : 0, merged.intake.done ? 1 : 0, merged.intake.raw || '', merged.intake.pendingQuestion || '',
      now());
  return getPatient(db, p.id);
}

export function setIntake(db, id, intake) {
  db.prepare('UPDATE patients SET intake_asked=?, intake_done=?, intake_raw=?, intake_pending=? WHERE id=?')
    .run(intake.asked ? 1 : 0, intake.done ? 1 : 0, intake.raw || '', intake.pendingQuestion || '', id);
}

export function addMessage(db, patientId, role, text, kind = 'plain') {
  const r = db.prepare('INSERT INTO messages (patient_id, role, text, kind, created_at) VALUES (?,?,?,?,?)')
    .run(patientId, role, text, kind, now());
  return Number(r.lastInsertRowid);
}

export function messagesAfter(db, patientId, afterId = 0) {
  return db.prepare('SELECT id, role, text, kind, created_at FROM messages WHERE patient_id = ? AND id > ? ORDER BY id')
    .all(patientId, afterId);
}

export function recentMessages(db, patientId, limit = 8) {
  return db.prepare('SELECT role, text FROM messages WHERE patient_id = ? ORDER BY id DESC LIMIT ?')
    .all(patientId, limit).reverse();
}

export function addAlert(db, patientId, type, question) {
  const r = db.prepare('INSERT INTO alerts (patient_id, type, question, created_at) VALUES (?,?,?,?)')
    .run(patientId, type, question, now());
  return Number(r.lastInsertRowid);
}

export function listAlerts(db) {
  return db.prepare(`SELECT a.id, a.patient_id, p.name AS patient_name, a.type, a.question, a.status, a.reply, a.created_at, a.answered_at
    FROM alerts a JOIN patients p ON p.id = a.patient_id
    WHERE a.status = 'open' OR a.id IN (SELECT id FROM alerts WHERE status = 'answered' ORDER BY id DESC LIMIT 20)
    ORDER BY a.status = 'open' DESC, a.id DESC`).all();
}

// The doctor answers an alert: the reply is stored as a message, so the patient sees it on the next sync.
export function answerAlert(db, alertId, text) {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(alertId);
  if (!a) return null;
  db.prepare("UPDATE alerts SET status='answered', reply=?, answered_at=? WHERE id=?").run(text, now(), alertId);
  addMessage(db, a.patient_id, 'doctor', text, 'doctor');
  return a.patient_id;
}

export function openAlertCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status='open'").get().n;
}

export function patientCount(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM patients').get().n;
}
