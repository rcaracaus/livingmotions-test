// Simulate Polly's session through the new engine
// Uses real LLM calls for routing/writing, LLM simulator for answering as 6w5

const fs = require('fs');
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(l => {
    const [k, ...v] = l.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
} catch (_) {}

const engine = require('./engine');
const prompts = require('./prompts');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

async function callLLM(systemPrompt, userPrompt) {
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
      system: [{ type: 'text', text: systemPrompt }],
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty LLM response');

  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i);
  let jsonText = fenceMatch ? fenceMatch[1] : text.trim();
  jsonText = jsonText.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(jsonText);
}

async function simulateAnswer(questionA, questionB, questionNumber, pair) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system: [{ type: 'text', text: `You are simulating a person named Polly for an Enneagram quiz. Polly is actually a 6w5 (The Defender) but she doesn't present obviously as one. Here is her profile:

- She is a 6w5: head type, anxiety-driven, seeks security and understanding
- She eases back under pressure (not assertive)
- She seeks reassurance when hurt (contact-seeking)
- She anchors good days on performance/achievement
- She values feeling settled over exploring
- She checks things from multiple angles before committing
- She worries about what might go wrong
- She analyzes situations to troubleshoot rather than diving into feelings
- She cares about professional credibility
- She needs to figure out where communication broke down
- She processes stress by stepping back to analyze factors
- When she has nothing to do, she feels lost without purpose/structure
- She sometimes LOOKS like a 4 because she values emotional depth and authenticity
- She sometimes LOOKS like a 3 because she cares about performance and credibility

Answer as Polly would genuinely answer — pick the option that resonates more with her 6w5 nature. If both options seem equally plausible, lean toward the one a 6w5 would naturally gravitate to.

Respond with ONLY a JSON object: {"pick": "a"} or {"pick": "b"} and a brief reason.` }],
      messages: [{ role: 'user', content: `Question ${questionNumber}${pair ? ` (testing ${pair})` : ''}:\nA: "${questionA}"\nB: "${questionB}"\n\nWhich does Polly pick?` }]
    })
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.[0]?.text || '';
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i);
  let jsonText = fenceMatch ? fenceMatch[1] : text.trim();
  jsonText = jsonText.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(jsonText);
  } catch (_) {
    // Fallback: look for "a" or "b" in the text
    if (text.toLowerCase().includes('"pick": "a"') || text.toLowerCase().includes('"a"')) return { pick: 'a' };
    return { pick: 'b' };
  }
}

function printScores(state, label) {
  const sorted = engine.TYPES
    .map(t => ({ type: t, prob: state.posterior[t] }))
    .sort((a, b) => b.prob - a.prob);

  const bar = (prob) => {
    const len = Math.max(0, Math.min(25, Math.round(prob / 2)));
    return '█'.repeat(len) + '░'.repeat(25 - len);
  };

  console.log(`\n${label}`);
  console.log('─'.repeat(50));
  for (const { type, prob } of sorted) {
    const marker = type === state.top_type ? ' ◄' : '';
    console.log(`  ${type}: ${bar(prob)} ${prob.toFixed(1)}%${marker}`);
  }
  console.log(`  Gap: ${state.top_two_gap.toFixed(1)}% | Phase: ${state.phase} | Budget: ${state.budget_remaining}`);
  if (Object.keys(state.pair_question_counts).length > 0) {
    console.log(`  Pairs: ${Object.entries(state.pair_question_counts).map(([p,c]) => `${p}(${c})`).join(' ')}`);
  }
}

async function run() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  POLLY SIMULATION — New Engine (6w5 actual)     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const state = engine.createState('sim-polly', 'Polly');
  printScores(state, 'Initial state (flat)');

  for (let q = 1; q <= 25; q++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Generating Q${q}...`);

    // Build last answer context (for Q2+)
    let lastAnswer = null;
    if (q > 1) {
      const lastQ = state.question_history[state.question_history.length - 1];
      if (lastQ) {
        const sigA = lastQ.predicted_signal_a ? `Signals A: ${JSON.stringify(lastQ.predicted_signal_a)}` : '';
        const sigB = lastQ.predicted_signal_b ? `Signals B: ${JSON.stringify(lastQ.predicted_signal_b)}` : '';
        const pairInfo = lastQ.pair ? `Target pair: ${lastQ.pair}.` : '';
        lastAnswer = `${pairInfo} ${sigA}. ${sigB}. Picked ${lastQ.picked.toUpperCase()}: "${lastQ.answer_text}". NOTE: Type scores have already been updated deterministically.`;
      }
    }

    // Router
    const stateSummary = engine.buildStateSummary(state);
    const routerPrompt = prompts.buildRouterPrompt(stateSummary, lastAnswer);
    const routerOutput = await callLLM(
      'You are an Enneagram typing router. Output valid JSON only.',
      routerPrompt
    );
    engine.applyRouterUpdate(state, routerOutput);

    // Check done gates
    const doneGates = engine.checkDoneGates(state);
    if (doneGates.length === 0 && state.question_number >= 15) {
      console.log('\n✅ DONE — All gates passing!');
      printScores(state, `Final scores at Q${state.question_number}`);
      console.log(`\nResult: Type ${state.top_type}w${state.likely_wing || '?'}`);
      console.log(`Correct type: ${state.top_type === 6 ? 'YES ✅' : 'NO ❌ (should be 6)'}`);
      return;
    }

    if (state.budget_remaining <= 0) {
      console.log('\n⏱ Budget exhausted');
      printScores(state, `Final scores at Q${state.question_number}`);
      console.log(`\nResult: Type ${state.top_type}w${state.likely_wing || '?'}`);
      console.log(`Correct type: ${state.top_type === 6 ? 'YES ✅' : 'NO ❌ (should be 6)'}`);
      return;
    }

    // Writer
    const constraints = engine.getRoutingConstraints(state);
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
      writerPrompt
    );

    const candidates = writerOutput.candidates || [writerOutput];
    const best = engine.selectBestCandidate(candidates, state);
    const item = best.candidate;

    engine.recordQuestion(state, {
      pair: routerOutput.target_pair || null,
      splitter: routerOutput.target_splitter || null,
      domain: routerOutput.target_domain || null,
      option_a: item.a,
      option_b: item.b,
      predicted_signal_a: item.predicted_signal_a || {},
      predicted_signal_b: item.predicted_signal_b || {},
      type_family: routerOutput.target_pair || null
    });

    const pair = routerOutput.target_pair || 'broad';
    console.log(`  Pair: ${pair} | Domain: ${routerOutput.target_domain}`);
    console.log(`  A: "${item.a}"`);
    console.log(`  B: "${item.b}"`);

    const lastQEntry = state.question_history[state.question_history.length - 1];
    console.log(`  Signals A: ${JSON.stringify(lastQEntry.predicted_signal_a)}`);
    console.log(`  Signals B: ${JSON.stringify(lastQEntry.predicted_signal_b)}`);

    // Simulate Polly's answer
    const simResult = await simulateAnswer(item.a, item.b, q, pair);
    const pick = simResult.pick;
    const chosenText = pick === 'a' ? item.a : item.b;

    engine.recordAnswer(state, pick);
    engine.applyAnswerToScores(state, pick);

    console.log(`  → Polly picks ${pick.toUpperCase()}: "${chosenText}"`);
    if (simResult.reason) console.log(`    (${simResult.reason})`);

    printScores(state, `After Q${q}`);
  }

  // Final result
  console.log('\n' + '═'.repeat(50));
  console.log('FINAL RESULT');
  console.log('═'.repeat(50));
  printScores(state, 'Final scores');
  console.log(`\nGuessed: Type ${state.top_type}w${state.likely_wing || '?'}`);
  console.log(`Actual: 6w5`);
  console.log(`Correct type: ${state.top_type === 6 ? 'YES ✅' : 'NO ❌'}`);
  console.log(`\nPair question counts:`);
  for (const [pair, count] of Object.entries(state.pair_question_counts)) {
    console.log(`  ${pair}: ${count} questions`);
  }
}

run().catch(err => {
  console.error('Simulation error:', err);
  process.exit(1);
});
