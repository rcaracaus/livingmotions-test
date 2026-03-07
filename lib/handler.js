const crypto = require('crypto');
const engine = require('../engine');
const prompts = require('../prompts');
const db = require('./db');

const STATIC_QUESTIONS = require('../static-questions.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

// ─── Helpers ────────────────────────────────────────────────────────

function readBody(req) {
  if (req.body) return Promise.resolve(req.body);
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
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function parseJSON(text) {
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i);
  if (fenceMatch) text = fenceMatch[1];
  text = text.trim();
  text = text.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(text);
}

async function callLLM(systemPrompt, userPrompt, sessionId) {
  if (sessionId) {
    await db.insertMessage(sessionId, 'system', systemPrompt.substring(0, 500));
    await db.insertMessage(sessionId, 'user', userPrompt.substring(0, 500));
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
    await db.insertMessage(sessionId, 'assistant', text.substring(0, 1000));
  }

  return parseJSON(text);
}

async function callLLMText(systemPrompt, userPrompt, maxTokens = 4096) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.content?.[0]?.text || '';
}

function buildPersonContext(session, questions) {
  const state = session.final_scores ? JSON.parse(session.final_scores) : {};
  const posterior = state.posterior || {};
  const behavioral = state.behavioral || {};

  const typeNames = {1:'Reformer',2:'Helper',3:'Achiever',4:'Individualist',5:'Investigator',6:'Loyalist',7:'Enthusiast',8:'Challenger',9:'Peacemaker'};

  let ctx = `## ${session.name} — Type ${session.guessed_type}w${session.guessed_wing} (${session.guessed_wing_name || ''}) The ${typeNames[session.guessed_type] || 'Unknown'}\n\n`;

  ctx += `### Posterior Distribution\n`;
  for (const [type, prob] of Object.entries(posterior).sort((a,b) => b[1] - a[1])) {
    ctx += `Type ${type}: ${prob}%\n`;
  }

  ctx += `\n### Behavioral Signals\n`;
  for (const [dim, data] of Object.entries(behavioral)) {
    ctx += `${dim}: ${data.value || 'unset'} (confidence: ${data.confidence || 0}%)\n`;
  }

  ctx += `\n### Patterns\n`;
  ctx += `Threat: ${state.threat_pattern || 'unknown'}\n`;
  ctx += `Move: ${state.move_pattern || 'unknown'}\n`;
  ctx += `Repeated cost: ${state.repeated_cost_pattern || 'unknown'}\n`;

  ctx += `\n### Wing\n`;
  ctx += `Wing: ${state.likely_wing} (confidence: ${state.wing_confidence}%)\n`;

  ctx += `\n### Contradictions (${(state.contradictions || []).length})\n`;
  (state.contradictions || []).forEach(c => { ctx += `- ${c}\n`; });

  ctx += `\n### Summary\n${session.guessed_summary || 'No summary'}\n`;

  ctx += `\n### Question/Answer History\n`;
  questions.forEach(q => {
    if (q.picked) {
      ctx += `Q${q.question_number}: Picked ${q.picked.toUpperCase()} — "${q.picked === 'a' ? q.option_a : q.option_b}"\n`;
      ctx += `  (Other option: "${q.picked === 'a' ? q.option_b : q.option_a}")\n`;
    }
  });

  return ctx;
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

  engine.applyRouterUpdate(state, routerOutput);

  // Step 2: Check if we should propose done
  const constraints = engine.getRoutingConstraints(state);
  const doneGates = engine.checkDoneGates(state);

  if (doneGates.length === 0 && state.question_number >= 12) {
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

// ─── Main Handler ───────────────────────────────────────────────────

async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0]; // strip query params
  const method = req.method;

  // ── Static questions ──
  if (method === 'GET' && url === '/api/static-questions') {
    json(res, 200, STATIC_QUESTIONS);
    return;
  }

  // ── Create session ──
  if (method === 'POST' && url === '/api/sessions') {
    try {
      const data = await readBody(req);
      const id = crypto.randomUUID();
      const name = (data && data.name) || 'Anonymous';
      const state = engine.createState(id, name);
      await db.insertSession(id, name, JSON.stringify(state));
      json(res, 201, { id, static_questions: STATIC_QUESTIONS });
    } catch (e) {
      console.error('Create session error:', e);
      const id = crypto.randomUUID();
      const state = engine.createState(id, 'Anonymous');
      await db.insertSession(id, 'Anonymous', JSON.stringify(state));
      json(res, 201, { id, static_questions: STATIC_QUESTIONS });
    }
    return;
  }

  // ── Submit calibration answers + get first adaptive question ──
  if (method === 'POST' && url === '/api/calibration') {
    try {
      const data = await readBody(req);
      const state = await db.getSessionState(data.session_id);
      if (!state) { json(res, 404, { error: 'Session not found' }); return; }

      for (const ans of data.answers) {
        await db.insertQuestion(
          data.session_id, ans.question_number,
          ans.option_a, ans.option_b,
          JSON.stringify([ans.dimension]), 'Static calibration', '{}'
        );
        await db.updateQuestionAnswer(
          data.session_id, ans.question_number,
          ans.picked, ans.chosen_text, ans.unchosen_text,
          ans.response_time_ms || 0
        );
      }

      engine.applyCalibration(state, data.answers);

      const calibrationData = data.answers.map(a => ({
        dimension: a.dimension,
        picked: a.picked,
        chosen_text: a.chosen_text,
        unchosen_text: a.unchosen_text,
        response_time_ms: a.response_time_ms,
        signal: a.signal
      }));

      const result = await generateNextQuestion(state, null, calibrationData);

      // Save state
      await db.updateSessionState(data.session_id, JSON.stringify(state));

      if (result.done) {
        json(res, 200, { done: true, result: result.result, state: sanitizeState(state) });
      } else {
        await db.insertQuestion(
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
  if (method === 'POST' && url === '/api/answer') {
    try {
      const data = await readBody(req);
      const state = await db.getSessionState(data.session_id);
      if (!state) { json(res, 404, { error: 'Session not found' }); return; }

      engine.recordAnswer(state, data.picked);
      engine.applyAnswerToScores(state, data.picked);

      await db.updateQuestionAnswer(
        data.session_id, state.question_number,
        data.picked, data.chosen_text, data.unchosen_text,
        data.response_time_ms || 0
      );

      const lastQ = state.question_history[state.question_history.length - 1];
      const sigA = lastQ?.predicted_signal_a?.length ? `Types favored by A: [${lastQ.predicted_signal_a.join(',')}]` : '';
      const sigB = lastQ?.predicted_signal_b?.length ? `Types favored by B: [${lastQ.predicted_signal_b.join(',')}]` : '';
      const pairInfo = lastQ?.pair ? `Target pair: ${lastQ.pair}. Splitter: ${lastQ.splitter || 'unknown'}.` : '';
      const lastAnswer = `${pairInfo} ${sigA}. ${sigB}. Picked ${data.picked.toUpperCase()}: "${data.chosen_text}". Response time: ${((data.response_time_ms || 0) / 1000).toFixed(1)}s. NOTE: Type scores have already been updated deterministically. Your job is to update behavioral signals, threat/move/cost patterns, and decide the next routing target only.`;

      const result = await generateNextQuestion(state, lastAnswer, null);

      // Save state
      await db.updateSessionState(data.session_id, JSON.stringify(state));

      if (result.done) {
        const r = result.result;
        await db.updateSessionComplete(
          data.session_id,
          state.question_number,
          r.type, r.wing, r.wing_name || '', r.summary || '',
          JSON.stringify(sanitizeState(state))
        );
        json(res, 200, { done: true, result: r, state: sanitizeState(state) });
      } else {
        await db.insertQuestion(
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
  if (method === 'GET' && url.startsWith('/api/state/')) {
    const id = url.split('/api/state/')[1];
    const state = await db.getSessionState(id);
    if (!state) { json(res, 404, { error: 'Session not found' }); return; }
    json(res, 200, sanitizeState(state));
    return;
  }

  // ── Report question ──
  if (method === 'POST' && url === '/api/questions/report') {
    try {
      const data = await readBody(req);
      await db.insertReport(
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
  if (method === 'POST' && url === '/api/sessions/actual') {
    try {
      const data = await readBody(req);
      const session = await db.getSession(data.session_id);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }
      const correctType = session.guessed_type === data.actual_type ? 1 : 0;
      const correctWing = session.guessed_wing === data.actual_wing ? 1 : 0;
      await db.updateSessionActual(
        data.session_id,
        data.actual_type, data.actual_wing || null,
        correctType, correctWing,
        data.notes || ''
      );
      json(res, 200, { ok: true, correct_type: correctType, correct_wing: correctWing });
    } catch (err) {
      json(res, 400, { error: err.message });
    }
    return;
  }

  // ── Get session detail ──
  const sessionMatch = url.match(/^\/api\/sessions\/([a-f0-9-]+)$/);
  if (method === 'GET' && sessionMatch) {
    const session = await db.getSession(sessionMatch[1]);
    if (!session) { json(res, 404, { error: 'Not found' }); return; }
    const answers = await db.getQuestions(sessionMatch[1]);
    const parsed = { ...session };
    parsed.final_scores = parsed.final_scores ? JSON.parse(parsed.final_scores) : null;
    json(res, 200, { session: parsed, answers });
    return;
  }

  // ── List sessions (calibration dashboard) ──
  if (method === 'GET' && url === '/api/sessions') {
    const allSessions = await db.getAllSessions();
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

  // ── Individual report ──
  if (method === 'POST' && url === '/api/report/individual') {
    try {
      const data = await readBody(req);
      const regenerate = data.regenerate === true;
      const session = await db.getSession(data.session_id);
      if (!session) { json(res, 404, { error: 'Session not found' }); return; }

      // Check cache
      if (!regenerate) {
        const cached = await db.getMotionReport('individual', data.session_id, null);
        if (cached) { json(res, 200, { report: cached.report, cached: true, created_at: cached.created_at }); return; }
      }

      const questions = await db.getQuestions(data.session_id);
      const personCtx = buildPersonContext(session, questions);

      const systemPrompt = "You are a Living Motions Enneagram analyst. Write a rich, personalized individual report for this person. Use their actual answer data and behavioral patterns. Write in second person ('you'). Be specific and insightful, not generic. Use markdown formatting with headers, bold, and paragraphs. Write 4+ paragraphs per section.";

      const userPrompt = `Here is the full profile data for this person:\n\n${personCtx}\n\nPlease write a comprehensive individual report with the following sections:\n\n1. **Core Pattern** — Who they are at their center\n2. **How They Move Through the World** — Behavioral analysis based on their signals\n3. **Under Pressure** — Threat and stress patterns\n4. **The Cost They Pay** — Repeated cost analysis\n5. **Contradictions** — Where they defy their type\n6. **Growth Edge** — Where their development work lives`;

      const report = await callLLMText(systemPrompt, userPrompt, 4096);
      await db.saveMotionReport('individual', data.session_id, null, report);
      json(res, 200, { report, cached: false });
    } catch (err) {
      console.error('Individual report error:', err);
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── Relationship report ──
  if (method === 'POST' && url === '/api/report/relationship') {
    try {
      const data = await readBody(req);
      const regenerate = data.regenerate === true;
      const sessionA = await db.getSession(data.session_id_a);
      const sessionB = await db.getSession(data.session_id_b);
      if (!sessionA || !sessionB) { json(res, 404, { error: 'One or both sessions not found' }); return; }

      // Check cache (check both orderings)
      if (!regenerate) {
        const cached = await db.getMotionReport('relationship', data.session_id_a, data.session_id_b)
          || await db.getMotionReport('relationship', data.session_id_b, data.session_id_a);
        if (cached) { json(res, 200, { report: cached.report, cached: true, created_at: cached.created_at }); return; }
      }

      const questionsA = await db.getQuestions(data.session_id_a);
      const questionsB = await db.getQuestions(data.session_id_b);
      const ctxA = buildPersonContext(sessionA, questionsA);
      const ctxB = buildPersonContext(sessionB, questionsB);

      const systemPrompt = "You are a Living Motions relationship analyst. Write a rich relationship dynamics report between two people based on their Enneagram data. Be specific to their actual patterns, not generic type descriptions. Address the report to both people. Use markdown formatting. Write 4+ paragraphs per section.";

      const structuralRef = `### Structural Reference Data
- Triads: gut [8,9,1], heart [2,3,4], head [5,6,7]
- Hornevian: assertive [3,7,8], compliant [1,2,6], withdrawn [4,5,9]
- Harmonic: positive_outlook [2,7,9], competency [1,3,5], reactive [4,6,8]
- Stress lines: 1→4, 2→8, 3→9, 4→2, 5→7, 6→3, 7→1, 8→5, 9→6
- Growth lines: 1→7, 2→4, 3→6, 4→1, 5→8, 6→9, 7→5, 8→2, 9→3`;

      const userPrompt = `Here is the full profile data for both people:\n\n${ctxA}\n\n---\n\n${ctxB}\n\n---\n\n${structuralRef}\n\nPlease write a comprehensive relationship report with the following sections:\n\n1. **The Architecture Between You** — How their types interact structurally (triads, hornevian, harmonic, stress/growth lines)\n2. **The Contradiction Map** — Where their wiring creates friction\n3. **Five Key Dynamics** — Specific behavioral interactions based on their data\n4. **What Each Person Gives the Other**\n5. **The Work Ahead**`;

      const report = await callLLMText(systemPrompt, userPrompt, 4096);
      await db.saveMotionReport('relationship', data.session_id_a, data.session_id_b, report);
      json(res, 200, { report, cached: false });
    } catch (err) {
      console.error('Relationship report error:', err);
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── Get saved reports for a session ──
  if (method === 'GET' && url.match(/^\/api\/reports\/([a-f0-9-]+)$/)) {
    try {
      const sessionId = url.match(/^\/api\/reports\/([a-f0-9-]+)$/)[1];
      const reports = await db.getMotionReports(sessionId);
      json(res, 200, { reports });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── Relationship chat ──
  if (method === 'POST' && url === '/api/chat') {
    try {
      const data = await readBody(req);
      const sessionA = await db.getSession(data.session_id_a);
      const sessionB = await db.getSession(data.session_id_b);
      if (!sessionA || !sessionB) { json(res, 404, { error: 'One or both sessions not found' }); return; }
      const questionsA = await db.getQuestions(data.session_id_a);
      const questionsB = await db.getQuestions(data.session_id_b);
      const ctxA = buildPersonContext(sessionA, questionsA);
      const ctxB = buildPersonContext(sessionB, questionsB);

      const systemPrompt = `You are the Living Motions Mirror — an Enneagram relationship advisor. You have deep knowledge of both ${sessionA.name} and ${sessionB.name}'s Enneagram profiles. Answer questions about their dynamic, individual patterns, and relationship. Be specific to their data, cite their actual behavioral patterns and answers when relevant. Be warm but honest. Don't use emojis.\n\nHere is the full data for both people:\n\n${ctxA}\n\n---\n\n${ctxB}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2048,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          messages: data.messages
        })
      });
      const result = await response.json();
      if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
      const reply = result.content?.[0]?.text || '';
      json(res, 200, { reply });
    } catch (err) {
      console.error('Chat error:', err);
      json(res, 500, { error: err.message });
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

module.exports = handler;
