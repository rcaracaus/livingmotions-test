const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const engine = require('./engine');
const prompts = require('./prompts');

// Load .env file if present
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && val.length) process.env[key.trim()] = val.join('=').trim();
    });
  }
} catch (_) {}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// ─── Database setup ──────────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'quiz.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
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

const insertSession = db.prepare(`INSERT INTO sessions (id, name) VALUES (?, ?)`);
const updateSessionComplete = db.prepare(`
  UPDATE sessions SET completed_at = datetime('now'), question_count = ?,
  guessed_type = ?, guessed_wing = ?, guessed_wing_name = ?, guessed_summary = ?,
  final_scores = ? WHERE id = ?
`);
const updateSessionActual = db.prepare(`
  UPDATE sessions SET actual_type = ?, actual_wing = ?,
  correct_type = ?, correct_wing = ?, notes = ? WHERE id = ?
`);
const insertQuestion = db.prepare(`
  INSERT INTO questions (session_id, question_number, option_a, option_b, informs, reasoning, scores_snapshot)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateQuestionAnswer = db.prepare(`
  UPDATE questions SET picked = ?, chosen_text = ?, unchosen_text = ?, response_time_ms = ?, answered_at = datetime('now')
  WHERE session_id = ? AND question_number = ?
`);
const insertReport = db.prepare(`
  INSERT INTO reports (session_id, question_number, rating, complaint, option_a, option_b) VALUES (?, ?, ?, ?, ?, ?)
`);
const insertMessage = db.prepare(`
  INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)
`);
const getSession = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
const getQuestions = db.prepare(`SELECT * FROM questions WHERE session_id = ? ORDER BY question_number`);
const getAllSessions = db.prepare(`
  SELECT id, name, created_at, completed_at, question_count, guessed_type, guessed_wing,
  actual_type, actual_wing, correct_type, correct_wing, notes
  FROM sessions ORDER BY created_at DESC
`);

// ─── Static questions ───────────────────────────────────────────────

const STATIC_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'static-questions.json'), 'utf8'));

// ─── In-memory state store ──────────────────────────────────────────

const sessions = new Map(); // sessionId -> state

// ─── Helpers ────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseJSON(text) {
  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i);
  if (fenceMatch) text = fenceMatch[1];
  text = text.trim();
  // Fix trailing commas
  text = text.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(text);
}

async function callLLM(systemPrompt, userPrompt, sessionId) {
  // Save to messages table
  if (sessionId) {
    insertMessage.run(sessionId, 'system', systemPrompt.substring(0, 500));
    insertMessage.run(sessionId, 'user', userPrompt.substring(0, 500));
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty LLM response');

  if (sessionId) {
    insertMessage.run(sessionId, 'assistant', text.substring(0, 1000));
  }

  return parseJSON(text);
}

// ─── Pipeline: Router → Writer → Checker ────────────────────────────

async function generateNextQuestion(state, lastAnswer, calibrationData) {
  const stateSummary = engine.buildStateSummary(state);

  // Step 1: Router — decide what to test
  const routerPrompt = prompts.buildRouterPrompt(stateSummary, lastAnswer, calibrationData);
  const routerOutput = await callLLM(
    'You are an Enneagram typing router. Output valid JSON only.',
    routerPrompt,
    state.session_id
  );

  // Apply router's score updates to state
  engine.applyRouterUpdate(state, routerOutput);

  // Step 2: Check if we should propose done
  const constraints = engine.getRoutingConstraints(state);
  const doneGates = engine.checkDoneGates(state);

  if (doneGates.length === 0 && state.question_number >= 12) {
    // All gates pass — generate final result
    const updatedSummary = engine.buildStateSummary(state);
    const approvalPrompt = prompts.buildApprovalPrompt(state, updatedSummary);
    const result = await callLLM(
      'You are finalizing an Enneagram typing. Output valid JSON only.',
      approvalPrompt,
      state.session_id
    );
    return { done: true, result, state };
  }

  // Hard max
  if (state.budget_remaining <= 0) {
    const updatedSummary = engine.buildStateSummary(state);
    const approvalPrompt = prompts.buildApprovalPrompt(state, updatedSummary);
    const result = await callLLM(
      'You are finalizing an Enneagram typing. Output valid JSON only.',
      approvalPrompt,
      state.session_id
    );
    return { done: true, result, state };
  }

  // Step 3: Writer — generate candidates
  let writerPrompt;
  if (constraints.rephrase_required && state.rephrase_targets.length > 0) {
    // Pick rephrase target
    const target = state.rephrase_targets.shift();
    writerPrompt = prompts.buildRephraseWriterPrompt(target, state);
    state.next_rephrase_question = state.question_number + 7;
  } else {
    writerPrompt = prompts.buildWriterPrompt(routerOutput, state);
  }

  const writerOutput = await callLLM(
    'You are a forced-choice item writer. Output valid JSON only.',
    writerPrompt,
    state.session_id
  );

  // Step 4: Checker — pick best candidate
  const candidates = writerOutput.candidates || [writerOutput];
  const best = engine.selectBestCandidate(candidates, state);
  const item = best.candidate;

  // Record the question in state
  engine.recordQuestion(state, {
    pair: routerOutput.target_pair || null,
    splitter: routerOutput.target_splitter || null,
    domain: routerOutput.target_domain || null,
    option_a: item.a,
    option_b: item.b,
    predicted_signal_a: item.predicted_signal_a || [],
    predicted_signal_b: item.predicted_signal_b || [],
    type_family: routerOutput.target_pair || null
  });

  return {
    done: false,
    question: { a: item.a, b: item.b },
    metadata: {
      pair: routerOutput.target_pair,
      splitter: routerOutput.target_splitter,
      domain: routerOutput.target_domain,
      purpose: routerOutput.question_purpose,
      reasoning: routerOutput.reasoning,
      checker_issues: best.issues,
      predicted_signal_a: item.predicted_signal_a,
      predicted_signal_b: item.predicted_signal_b
    },
    state
  };
}

// ─── Server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Static files
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  // ── Static questions ──
  if (req.method === 'GET' && req.url === '/api/static-questions') {
    json(res, 200, STATIC_QUESTIONS);
    return;
  }

  // ── Create session ──
  if (req.method === 'POST' && req.url === '/api/sessions') {
    try {
      const data = await readBody(req);
      const id = crypto.randomUUID();
      const name = data.name || 'Anonymous';
      insertSession.run(id, name);

      // Create state
      const state = engine.createState(id, name);
      sessions.set(id, state);

      json(res, 201, { id, static_questions: STATIC_QUESTIONS });
    } catch (e) {
      const id = crypto.randomUUID();
      insertSession.run(id, null);
      const state = engine.createState(id, 'Anonymous');
      sessions.set(id, state);
      json(res, 201, { id, static_questions: STATIC_QUESTIONS });
    }
    return;
  }

  // ── Submit calibration answers + get first adaptive question ──
  if (req.method === 'POST' && req.url === '/api/calibration') {
    try {
      const data = await readBody(req);
      const state = sessions.get(data.session_id);
      if (!state) { json(res, 404, { error: 'Session not found' }); return; }

      // Save calibration questions to DB
      for (const ans of data.answers) {
        insertQuestion.run(
          data.session_id, ans.question_number,
          ans.option_a, ans.option_b,
          JSON.stringify([ans.dimension]), 'Static calibration', '{}'
        );
        updateQuestionAnswer.run(
          ans.picked, ans.chosen_text, ans.unchosen_text,
          ans.response_time_ms || 0,
          data.session_id, ans.question_number
        );
      }

      // Apply calibration to state (behavioral signals only, posterior stays flat)
      engine.applyCalibration(state, data.answers);

      // Build calibration data for router
      const calibrationData = data.answers.map(a => ({
        dimension: a.dimension,
        picked: a.picked,
        chosen_text: a.chosen_text,
        unchosen_text: a.unchosen_text,
        response_time_ms: a.response_time_ms,
        signal: a.signal
      }));

      // Generate first adaptive question
      const result = await generateNextQuestion(state, null, calibrationData);

      if (result.done) {
        json(res, 200, { done: true, result: result.result, state: sanitizeState(state) });
      } else {
        // Save question to DB
        insertQuestion.run(
          data.session_id, state.question_number,
          result.question.a, result.question.b,
          JSON.stringify([result.metadata.pair, result.metadata.splitter].filter(Boolean)),
          result.metadata.reasoning || '',
          JSON.stringify(sanitizeState(state))
        );
        json(res, 200, {
          done: false,
          question: result.question,
          metadata: result.metadata,
          state: sanitizeState(state)
        });
      }
    } catch (err) {
      console.error('Calibration error:', err);
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── Submit answer + get next question ──
  if (req.method === 'POST' && req.url === '/api/answer') {
    try {
      const data = await readBody(req);
      const state = sessions.get(data.session_id);
      if (!state) { json(res, 404, { error: 'Session not found' }); return; }

      // Record answer in state
      engine.recordAnswer(state, data.picked);

      // DETERMINISTIC: Apply score changes based on predicted signals
      engine.applyAnswerToScores(state, data.picked);

      // Save answer to DB
      updateQuestionAnswer.run(
        data.picked, data.chosen_text, data.unchosen_text,
        data.response_time_ms || 0,
        data.session_id, state.question_number
      );

      // Build last answer description for router (for pattern inference only)
      const lastQ = state.question_history[state.question_history.length - 1];
      const sigA = lastQ?.predicted_signal_a?.length ? `Types favored by A: [${lastQ.predicted_signal_a.join(',')}]` : '';
      const sigB = lastQ?.predicted_signal_b?.length ? `Types favored by B: [${lastQ.predicted_signal_b.join(',')}]` : '';
      const pairInfo = lastQ?.pair ? `Target pair: ${lastQ.pair}. Splitter: ${lastQ.splitter || 'unknown'}.` : '';
      const lastAnswer = `${pairInfo} ${sigA}. ${sigB}. Picked ${data.picked.toUpperCase()}: "${data.chosen_text}". Response time: ${((data.response_time_ms || 0) / 1000).toFixed(1)}s. NOTE: Type scores have already been updated deterministically. Your job is to update behavioral signals, threat/move/cost patterns, and decide the next routing target only.`;

      // Generate next question (or finish)
      const result = await generateNextQuestion(state, lastAnswer, null);

      if (result.done) {
        // Save completion
        const r = result.result;
        updateSessionComplete.run(
          state.question_number,
          r.type, r.wing, r.wing_name || '', r.summary || '',
          JSON.stringify(sanitizeState(state)),
          data.session_id
        );

        json(res, 200, { done: true, result: r, state: sanitizeState(state) });
      } else {
        // Save question to DB
        insertQuestion.run(
          data.session_id, state.question_number,
          result.question.a, result.question.b,
          JSON.stringify([result.metadata.pair, result.metadata.splitter].filter(Boolean)),
          result.metadata.reasoning || '',
          JSON.stringify(sanitizeState(state))
        );

        json(res, 200, {
          done: false,
          question: result.question,
          metadata: result.metadata,
          state: sanitizeState(state)
        });
      }
    } catch (err) {
      console.error('Answer error:', err);
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── Get session state (debug) ──
  if (req.method === 'GET' && req.url.startsWith('/api/state/')) {
    const id = req.url.split('/api/state/')[1];
    const state = sessions.get(id);
    if (!state) { json(res, 404, { error: 'Session not found' }); return; }
    json(res, 200, sanitizeState(state));
    return;
  }

  // ── Report question ──
  if (req.method === 'POST' && req.url === '/api/questions/report') {
    try {
      const data = await readBody(req);
      insertReport.run(
        data.session_id, data.question_number,
        data.rating || null, data.complaint || '',
        data.option_a || '', data.option_b || ''
      );
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Submit actual type (calibration) ──
  if (req.method === 'POST' && req.url === '/api/sessions/actual') {
    try {
      const data = await readBody(req);
      const session = getSession.get(data.session_id);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }
      const correctType = session.guessed_type === data.actual_type ? 1 : 0;
      const correctWing = session.guessed_wing === data.actual_wing ? 1 : 0;
      updateSessionActual.run(
        data.actual_type, data.actual_wing || null,
        correctType, correctWing,
        data.notes || '',
        data.session_id
      );
      json(res, 200, { ok: true, correct_type: correctType, correct_wing: correctWing });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Get session detail ──
  const sessionMatch = req.url.match(/^\/api\/sessions\/([a-f0-9-]+)$/);
  if (req.method === 'GET' && sessionMatch) {
    const session = getSession.get(sessionMatch[1]);
    if (!session) { json(res, 404, { error: 'Not found' }); return; }
    const answers = getQuestions.all(sessionMatch[1]);
    session.final_scores = session.final_scores ? JSON.parse(session.final_scores) : null;
    json(res, 200, { session, answers });
    return;
  }

  // ── List sessions (calibration dashboard) ──
  if (req.method === 'GET' && req.url === '/api/sessions') {
    const allSessions = getAllSessions.all();
    const total = allSessions.filter(s => s.actual_type != null).length;
    const correctType = allSessions.filter(s => s.correct_type === 1).length;
    const correctWing = allSessions.filter(s => s.correct_wing === 1).length;
    json(res, 200, {
      sessions: allSessions,
      calibration: {
        total_calibrated: total,
        type_accuracy: total > 0 ? (correctType / total * 100).toFixed(1) : null,
        wing_accuracy: total > 0 ? (correctWing / total * 100).toFixed(1) : null,
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function sanitizeState(state) {
  return {
    question_number: state.question_number,
    phase: state.phase,
    budget_remaining: state.budget_remaining,
    posterior: state.posterior,
    behavioral: state.behavioral,
    threat_pattern: state.threat_pattern,
    move_pattern: state.move_pattern,
    repeated_cost_pattern: state.repeated_cost_pattern,
    target_pair: state.target_pair,
    target_splitter: state.target_splitter,
    target_pair_questions: state.target_pair_questions,
    pair_resolved: state.pair_resolved,
    likely_wing: state.likely_wing,
    wing_confidence: state.wing_confidence,
    contradiction_count: state.contradiction_count,
    contradictions: state.contradictions,
    repair_mode: state.repair_mode,
    top_type: state.top_type,
    top_two_gap: state.top_two_gap,
    untested_types_count: state.untested_types_count,
    types_tested: state.types_tested,
    pairs_tested: state.pairs_tested,
    done_gates: engine.checkDoneGates(state)
  };
}

server.listen(3456, () => {
  console.log('Enneagram v2 engine running at http://localhost:3456');
});
