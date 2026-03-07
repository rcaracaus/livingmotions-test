const { createClient } = require('@libsql/client');

let db;
let initialized = false;

function getDb() {
  if (!db) {
    if (process.env.TURSO_DATABASE_URL) {
      db = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
      });
    } else {
      db = createClient({ url: 'file:quiz.db' });
    }
  }
  return db;
}

async function ensureTables() {
  if (initialized) return;
  const client = getDb();
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT,
      state_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      question_count INTEGER DEFAULT 0,
      guessed_type INTEGER,
      guessed_wing INTEGER,
      guessed_wing_name TEXT,
      guessed_summary TEXT,
      final_scores TEXT,
      actual_type INTEGER,
      actual_wing INTEGER,
      correct_type INTEGER DEFAULT 0,
      correct_wing INTEGER DEFAULT 0,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      question_number INTEGER NOT NULL,
      option_a TEXT NOT NULL,
      option_b TEXT NOT NULL,
      informs TEXT,
      reasoning TEXT,
      scores_snapshot TEXT,
      picked TEXT,
      chosen_text TEXT,
      unchosen_text TEXT,
      response_time_ms INTEGER,
      rating INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      answered_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      question_number INTEGER NOT NULL,
      rating INTEGER,
      complaint TEXT,
      option_a TEXT,
      option_b TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );
  `);
  initialized = true;
}

async function insertSession(id, name, stateJson) {
  await ensureTables();
  await getDb().execute({
    sql: 'INSERT INTO sessions (id, name, state_json) VALUES (?, ?, ?)',
    args: [id, name, stateJson]
  });
}

async function getSessionState(id) {
  await ensureTables();
  const result = await getDb().execute({
    sql: 'SELECT state_json FROM sessions WHERE id = ?',
    args: [id]
  });
  if (result.rows.length === 0) return null;
  return result.rows[0].state_json ? JSON.parse(result.rows[0].state_json) : null;
}

async function updateSessionState(id, stateJson) {
  await getDb().execute({
    sql: 'UPDATE sessions SET state_json = ? WHERE id = ?',
    args: [stateJson, id]
  });
}

async function updateSessionComplete(id, questionCount, guessedType, guessedWing, guessedWingName, guessedSummary, finalScores) {
  await getDb().execute({
    sql: `UPDATE sessions SET completed_at = datetime('now'), question_count = ?,
          guessed_type = ?, guessed_wing = ?, guessed_wing_name = ?, guessed_summary = ?,
          final_scores = ? WHERE id = ?`,
    args: [questionCount, guessedType, guessedWing, guessedWingName, guessedSummary, finalScores, id]
  });
}

async function updateSessionActual(id, actualType, actualWing, correctType, correctWing, notes) {
  await getDb().execute({
    sql: `UPDATE sessions SET actual_type = ?, actual_wing = ?,
          correct_type = ?, correct_wing = ?, notes = ? WHERE id = ?`,
    args: [actualType, actualWing, correctType, correctWing, notes, id]
  });
}

async function insertQuestion(sessionId, questionNumber, optionA, optionB, informs, reasoning, scoresSnapshot) {
  await getDb().execute({
    sql: `INSERT INTO questions (session_id, question_number, option_a, option_b, informs, reasoning, scores_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [sessionId, questionNumber, optionA, optionB, informs, reasoning, scoresSnapshot]
  });
}

async function updateQuestionAnswer(sessionId, questionNumber, picked, chosenText, unchosenText, responseTimeMs) {
  await getDb().execute({
    sql: `UPDATE questions SET picked = ?, chosen_text = ?, unchosen_text = ?, response_time_ms = ?, answered_at = datetime('now')
          WHERE session_id = ? AND question_number = ?`,
    args: [picked, chosenText, unchosenText, responseTimeMs, sessionId, questionNumber]
  });
}

async function insertReport(sessionId, questionNumber, rating, complaint, optionA, optionB) {
  await getDb().execute({
    sql: 'INSERT INTO reports (session_id, question_number, rating, complaint, option_a, option_b) VALUES (?, ?, ?, ?, ?, ?)',
    args: [sessionId, questionNumber, rating, complaint, optionA, optionB]
  });
}

async function insertMessage(sessionId, role, content) {
  await getDb().execute({
    sql: 'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)',
    args: [sessionId, role, content]
  });
}

async function getSession(id) {
  await ensureTables();
  const result = await getDb().execute({
    sql: 'SELECT * FROM sessions WHERE id = ?',
    args: [id]
  });
  return result.rows[0] || null;
}

async function getQuestions(sessionId) {
  const result = await getDb().execute({
    sql: 'SELECT * FROM questions WHERE session_id = ? ORDER BY question_number',
    args: [sessionId]
  });
  return result.rows;
}

async function getAllSessions() {
  await ensureTables();
  const result = await getDb().execute({
    sql: `SELECT id, name, created_at, completed_at, question_count, guessed_type, guessed_wing,
          actual_type, actual_wing, correct_type, correct_wing, notes
          FROM sessions ORDER BY created_at DESC`
  });
  return result.rows;
}

module.exports = {
  ensureTables,
  insertSession,
  getSessionState,
  updateSessionState,
  updateSessionComplete,
  updateSessionActual,
  insertQuestion,
  updateQuestionAnswer,
  insertReport,
  insertMessage,
  getSession,
  getQuestions,
  getAllSessions
};
