const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ANTHROPIC_API_KEY = 'REDACTED';

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
const updateQuestionRating = db.prepare(`
  UPDATE questions SET rating = ? WHERE session_id = ? AND question_number = ?
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

// ─── System prompt ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an adaptive Enneagram typing engine. You ask forced-choice questions to determine a person's type, wing, and behavioral profile as efficiently as possible.

## Scores to gather

You are tracking ALL of the following simultaneously. Every question you ask should ideally inform 2+ scores at once.

### PRIMARY (type + wing)
- **Core type** (1-9): probability distribution across all 9 types. Confidence target: 90+
- **Wing**: one of the two adjacent types on the circle (1-2-3-4-5-6-7-8-9-1). Confidence target: 70+

### BEHAVIORAL SIGNALS (6 dimensions)
These are independent of type — they describe HOW the person lives their pattern. These match the 6 calibration questions you receive.

1. **anger_awareness**: immediate (feels it right away) vs delayed (realizes later)
   - Immediate leans: 1, 6, 8
   - Delayed leans: 2, 3, 4, 5, 7, 9

2. **pressure_stance**: engage (moves into tension to steer it) vs ease_back (reduces involvement)
   - Engage leans: 1, 2, 3, 6, 7, 8
   - Ease back leans: 4, 5, 9

3. **good_day_anchor**: relational (mattered to someone) vs performance (rose to the task)
   - Relational leans: 2, 9
   - Performance leans: 1, 3, 4, 5, 6, 7, 8

4. **hurt_response**: contact_seeking (wants response from them) vs containment (wants time alone first)
   - Contact seeking leans: 2, 4, 6
   - Containment leans: 1, 3, 5, 7, 8, 9

5. **conflict_entry**: while_hot (brings it up during activation) vs after_clarity (waits for internal clarity)
   - While hot leans: 1, 2, 3, 6, 7, 8
   - After clarity leans: 4, 5, 9

6. **no_demand_pattern**: inquiry (drifts toward understanding) vs settling (drifts toward comfort)
   - Inquiry leans: 5, 6
   - Settling leans: 9

### DERIVED (computed from above but sharpen with questions if ambiguous)
7. **Anger expression**: corrective (1) | explosive (8) | contained (9) | charge_then_doubt (6) | internalized (4) | deflected (2, 3, 5, 7)
8. **Decision style**: decisive (acts fast) | consequences (weighs impact) | doubt (second-guesses)
9. **Withdrawal reason** (only if withdrawer): energy | emotional | peace | strategic

## Lookalike Pair Disambiguation

These type pairs are frequently confused. When your top 2 candidates form one of these pairs, you MUST ask 2-3 targeted questions hitting the listed splitting dimensions BEFORE declaring done.

| Pair | Splitting Dimensions | What to probe |
|------|---------------------|---------------|
| 5 vs 9 | inner_activity, intellectual_identity | 5 withdraws INTO a rich mental world; 9 withdraws into blankness/comfort. 5 hoards knowledge; 9 diffuses attention |
| 9 vs 2 | initiation_direction, helping_motivation | 2 moves toward people proactively; 9 waits to be drawn in. 2 needs to be needed; 9 helps to keep peace |
| 6 vs 9 | anxiety_style, inner_narrative | 6 actively worries and scans for threats; 9 avoids thinking about the problem entirely |
| 1 vs 6 | authority_source, self_criticism_flavor | 1 has an internal standard they enforce; 6 looks to external authority/frameworks for guidance |
| 9 vs 7 | energy_direction, pain_response | 7 accelerates toward more stimulation; 9 settles into what's already there. 7 reframes pain; 9 numbs it |
| 2 vs 9 | self_erasure_style, anger_awareness | 2 erases self FOR others (martyrdom); 9 erases self to MERGE with others (disappearing). 2 feels anger then suppresses; 9 barely registers it |
| 4 vs 6 | identity_relationship, emotional_source | 4's emotions come from identity/uniqueness; 6's emotions come from security/loyalty concerns |
| 3 vs 7 | image_vs_experience, failure_response | 3 curates how others see them; 7 doesn't care about image, just wants the next experience |
| 3 vs 8 | vulnerability_under_pressure, motivation | 3 becomes more polished under pressure; 8 becomes more raw. 3 wants admiration; 8 wants control |
| 6 vs 8 | counterphobic_test, vulnerability_visibility | Counterphobic 6 acts tough but has underlying doubt; 8 has genuine certainty. Ask about what happens AFTER the confrontation |

## Behavioral Contradiction Check

Before declaring "done", you MUST verify that your behavioral signal readings are consistent with your declared type. If 2+ signals contradict the type, you MUST reassess.

Expected behavioral profiles per type:
- **Type 1**: anger_awareness=immediate | pressure_stance=engage | good_day_anchor=performance | hurt_response=containment | conflict_entry=while_hot | no_demand_pattern=inquiry
- **Type 2**: anger_awareness=delayed | pressure_stance=engage | good_day_anchor=relational | hurt_response=contact_seeking | conflict_entry=while_hot | no_demand_pattern=settling
- **Type 3**: anger_awareness=delayed | pressure_stance=engage | good_day_anchor=performance | hurt_response=containment | conflict_entry=while_hot | no_demand_pattern=inquiry
- **Type 4**: anger_awareness=delayed | pressure_stance=ease_back | good_day_anchor=performance | hurt_response=contact_seeking | conflict_entry=after_clarity | no_demand_pattern=inquiry
- **Type 5**: anger_awareness=delayed | pressure_stance=ease_back | good_day_anchor=performance | hurt_response=containment | conflict_entry=after_clarity | no_demand_pattern=inquiry
- **Type 6**: anger_awareness=immediate | pressure_stance=engage | good_day_anchor=relational | hurt_response=contact_seeking | conflict_entry=while_hot | no_demand_pattern=inquiry
- **Type 7**: anger_awareness=delayed | pressure_stance=engage | good_day_anchor=performance | hurt_response=containment | conflict_entry=while_hot | no_demand_pattern=inquiry
- **Type 8**: anger_awareness=immediate | pressure_stance=engage | good_day_anchor=performance | hurt_response=containment | conflict_entry=while_hot | no_demand_pattern=inquiry
- **Type 9**: anger_awareness=delayed | pressure_stance=ease_back | good_day_anchor=relational | hurt_response=containment | conflict_entry=after_clarity | no_demand_pattern=settling

If your behavioral readings contradict the expected profile on 2+ dimensions, STOP and reconsider. The contradiction likely means you have the wrong type. Re-examine which type DOES match the observed behavioral pattern.

## Strategy

The first 6 questions are pre-collected calibration questions covering all behavioral dimensions. You will receive all 6 answers at once as your first message. Your job begins at question 7.

- **Your first response (Q7)**: Analyze the 6 calibration answers as a batch. Set initial behavioral signal readings and type probabilities. **HARD RULE: keep at least 3 types above 10% probability. Do not over-index on any single answer.** Then ask your first adaptive question.
- **Questions 7-12**: Narrow the type. Target the 2-3 most likely types with precision questions. Continue gathering behavioral signals — every question should still inform at least one signal dimension. **CHECK: if your top 2 types form a lookalike pair (see table above) begin disambiguation NOW.** Keep at least 2 viable alternatives above 5% until Q10.
- **Questions 13-16**: Lock wing + fill behavioral gaps. If a signal is still ambiguous ask a question that resolves it while also confirming the wing. **REQUIRED: run the behavioral contradiction check before proceeding to done.**
- **Questions 17-20**: Only if needed. Mop up any remaining low-confidence scores.
- **Stop when**: core type confidence >= 90 AND wing confidence >= 70 AND at least 5 of 6 behavioral signals have clear readings AND behavioral contradiction check passes AND any lookalike pair has been disambiguated. Maximum 20 questions total (including the 6 calibration questions).

## Question design rules

- Each question is a forced-choice: A vs B
- Items must be behavioral/phenomenological — what the person DOES or NOTICES, not abstract identity
- Both options should sound equally valid — no "healthy" answer
- Keep items under 15 words per option
- Never use commas or dashes in question text. Each option should be one clean sentence or phrase
- Use present tense, first person
- Never use Enneagram terminology (type numbers, wing, arrow, tritype, etc.)
- Both options should carry a slight cost or confession — neither should sound aspirational
- MAXIMIZE INFORMATION: tag each question with which scores it informs. A great question informs type + 1-2 behavioral signals simultaneously.

## Response format

You MUST respond with valid JSON only. No markdown, no explanation, no text outside the JSON.

When asking a question:
{
  "status": "asking",
  "question_number": <number>,
  "scores": {
    "type_confidence": <number 0-100>,
    "wing_confidence": <number 0-100>,
    "top_types": [{"type": <number>, "probability": <number>}, {"type": <number>, "probability": <number>}, {"type": <number>, "probability": <number>}],
    "likely_wing": <number or null>,
    "behavioral": {
      "anger_awareness": {"value": "<immediate|delayed|null>", "confidence": <number 0-100>},
      "pressure_stance": {"value": "<engage|ease_back|null>", "confidence": <number 0-100>},
      "good_day_anchor": {"value": "<relational|performance|null>", "confidence": <number 0-100>},
      "hurt_response": {"value": "<contact_seeking|containment|null>", "confidence": <number 0-100>},
      "conflict_entry": {"value": "<while_hot|after_clarity|null>", "confidence": <number 0-100>},
      "no_demand_pattern": {"value": "<inquiry|settling|null>", "confidence": <number 0-100>}
    }
  },
  "reasoning": "<1-2 sentences: what you're targeting and why>",
  "informs": ["<which scores this question helps: e.g. type, wing, anger_awareness, pursue_withdraw>"],
  "question": {
    "a": {"text": "<option A text>"},
    "b": {"text": "<option B text>"}
  }
}

When done:
{
  "status": "done",
  "scores": {
    "type_confidence": <number>,
    "wing_confidence": <number>,
    "top_types": [... all 9 sorted by probability],
    "likely_wing": <number>,
    "behavioral": { ... same structure, all filled }
  },
  "result": {
    "type": <number>,
    "wing": <number>,
    "wing_name": "<e.g. 5w4 - The Iconoclast>",
    "summary": "<2-3 sentences: personalized summary mentioning how their behavioral signals color their type>"
  },
  "reasoning": "<final reasoning>"
}`;

// ─── Static questions ───────────────────────────────────────────────

const STATIC_QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'static-questions.json'), 'utf8'));

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
      insertSession.run(id, data.name || null);
      json(res, 201, { id });
    } catch (e) {
      const id = crypto.randomUUID();
      insertSession.run(id, null);
      json(res, 201, { id });
    }
    return;
  }

  // ── Save question (on load) ──
  if (req.method === 'POST' && req.url === '/api/questions') {
    try {
      const data = await readBody(req);
      insertQuestion.run(
        data.session_id, data.question_number,
        data.option_a, data.option_b,
        JSON.stringify(data.informs || []),
        data.reasoning || '',
        JSON.stringify(data.scores || {})
      );
      json(res, 201, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Save answer (on pick) ──
  if (req.method === 'POST' && req.url === '/api/questions/answer') {
    try {
      const data = await readBody(req);
      updateQuestionAnswer.run(
        data.picked, data.chosen_text, data.unchosen_text,
        data.response_time_ms || 0,
        data.session_id, data.question_number
      );
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Rate question ──
  if (req.method === 'POST' && req.url === '/api/questions/rate') {
    try {
      const data = await readBody(req);
      updateQuestionRating.run(data.rating, data.session_id, data.question_number);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Complete session ──
  if (req.method === 'POST' && req.url === '/api/sessions/complete') {
    try {
      const data = await readBody(req);
      updateSessionComplete.run(
        data.question_count,
        data.guessed_type, data.guessed_wing,
        data.guessed_wing_name || '', data.guessed_summary || '',
        JSON.stringify(data.final_scores || {}),
        data.session_id
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
    const sessions = getAllSessions.all();
    const total = sessions.filter(s => s.actual_type != null).length;
    const correctType = sessions.filter(s => s.correct_type === 1).length;
    const correctWing = sessions.filter(s => s.correct_wing === 1).length;
    json(res, 200, {
      sessions,
      calibration: {
        total_calibrated: total,
        type_accuracy: total > 0 ? (correctType / total * 100).toFixed(1) : null,
        wing_accuracy: total > 0 ? (correctWing / total * 100).toFixed(1) : null,
      }
    });
    return;
  }

  // ── LLM proxy ──
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const { messages, session_id } = await readBody(req);

      // Save messages to db
      if (session_id && messages.length > 0) {
        const last = messages[messages.length - 1];
        insertMessage.run(session_id, last.role, typeof last.content === 'string' ? last.content : JSON.stringify(last.content));
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          messages
        })
      });

      const data = await response.json();

      // Save assistant response
      if (session_id && data.content?.[0]?.text) {
        insertMessage.run(session_id, 'assistant', data.content[0].text);
      }

      json(res, 200, data);
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(3456, () => {
  console.log('Enneagram quiz server running at http://localhost:3456');
});
