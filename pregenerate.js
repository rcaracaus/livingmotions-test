// Pre-generate all question candidates for EIG-based quiz
// Run once, outputs to questions-bank.json

const fs = require('fs');
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(l => {
    const [k, ...v] = l.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
} catch (_) {}

const { PAIR_AXES, PROBE_GUIDE, WING_GUIDE, TRIADS, HORNEVIAN, HARMONIC } = require('./engine');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 5;
const OUTPUT_FILE = './questions-bank.json';

// ─── All combos to generate ─────────────────────────────────────────

function buildCombos() {
  const combos = [];

  // Pair questions: each pair × each domain
  for (const [pair, axis] of Object.entries(PAIR_AXES)) {
    for (const domain of axis.domains) {
      combos.push({
        type: 'pair',
        pair,
        splitter: axis.splitter,
        domain,
        probe_a: axis.probe_a,
        probe_b: axis.probe_b
      });
    }
  }

  // Broad cuts: each grouping × domains
  const broadGroupings = [
    { name: 'triad', desc: 'gut [8,9,1] vs heart [2,3,4] vs head [5,6,7]', domains: ['self', 'stress', 'relationship', 'work'] },
    { name: 'hornevian', desc: 'assertive [3,7,8] vs compliant [1,2,6] vs withdrawn [4,5,9]', domains: ['conflict', 'work', 'stress', 'social'] },
    { name: 'harmonic', desc: 'positive_outlook [2,7,9] vs competency [1,3,5] vs reactive [4,6,8]', domains: ['stress', 'relationship', 'self', 'work'] }
  ];

  for (const group of broadGroupings) {
    for (const domain of group.domains) {
      combos.push({
        type: 'broad',
        pair: null,
        splitter: group.name,
        domain,
        grouping: group.desc
      });
    }
  }

  // Wing splits: each type's wing split × domains
  for (const [type, wg] of Object.entries(WING_GUIDE)) {
    const domains = ['relationship', 'stress', 'work'];
    for (const domain of domains) {
      combos.push({
        type: 'wing',
        pair: `${wg.low.wing}v${wg.high.wing}`,
        splitter: `wing_${type}`,
        domain,
        wingType: parseInt(type),
        wingGuide: wg
      });
    }
  }

  return combos;
}

// ─── Build prompt for a single combo ────────────────────────────────

function buildPrompt(combo) {
  let context = '';

  if (combo.type === 'pair') {
    const types = combo.pair.split('v').map(Number);
    const probeA = PROBE_GUIDE[types[0]];
    const probeB = PROBE_GUIDE[types[1]];

    context = `## Target pair: ${combo.pair}
Splitter: ${combo.splitter}
Pole A (type ${types[0]}): ${combo.probe_a}
Pole B (type ${types[1]}): ${combo.probe_b}

## Type ${types[0]} probe context
Target: ${probeA?.target || 'unknown'}
Latent probes: ${(probeA?.latent_probes || []).join(' | ')}
Killer probe: ${probeA?.killer_probe || 'none'}
Under stress: ${probeA?.stress_arrow || 'unknown'}
Core avoidance: ${probeA?.core_avoidance || 'unknown'}

## Type ${types[1]} probe context
Target: ${probeB?.target || 'unknown'}
Latent probes: ${(probeB?.latent_probes || []).join(' | ')}
Killer probe: ${probeB?.killer_probe || 'none'}
Under stress: ${probeB?.stress_arrow || 'unknown'}
Core avoidance: ${probeB?.core_avoidance || 'unknown'}`;
  } else if (combo.type === 'broad') {
    context = `## Broad discrimination
Grouping: ${combo.grouping}
Use this grouping to write items that cut across multiple types:
- Gut [8,9,1]: body-based, anger relationship
- Heart [2,3,4]: image/identity, shame relationship
- Head [5,6,7]: thinking/planning, fear relationship
- Assertive [3,7,8]: move against, take initiative
- Compliant [1,2,6]: move toward, follow standards/others
- Withdrawn [4,5,9]: move away, retreat inward
- Positive outlook [2,7,9]: reframe/minimize negative
- Competency [1,3,5]: manage emotion, focus on task
- Reactive [4,6,8]: amplify emotion, push back`;
  } else if (combo.type === 'wing') {
    const wg = combo.wingGuide;
    context = `## Wing split for type ${combo.wingType}
${wg.low.name}: ${wg.low.desc}
${wg.high.name}: ${wg.high.desc}
How to split: ${wg.split}`;
  }

  return `You are a forced-choice item writer for an Enneagram typing system.

## Your job

Write 3 candidate forced-choice items for the target below. Each item must separate the specified distinction.

## Target
Type: ${combo.type}
${combo.pair ? `Pair: ${combo.pair}` : 'Broad cut'}
Splitter: ${combo.splitter}
Domain: ${combo.domain}

${context}

## Item writing rules — follow ALL of these exactly

- First person, present tense
- 8-16 words per option
- Parallel syntax between A and B
- Matched emotional weight — neither option sounds healthier
- Both options slightly costly or confessional
- Never frame one option as caring and the other as not caring
- Both options assume the person cares — test HOW or WHY
- No moral contrast (generous vs selfish, warm vs cold)
- One domain only per item
- No Enneagram jargon (type numbers, wing, tritype, etc.)
- No commas or dashes in option text
- Each option is one clean sentence or phrase
- Concrete behavioral differences over abstract identity language
- Use situational scenarios but do NOT reference specific people (no "my partner" or "my colleague" or "my friend") — these trigger role-based answering instead of core patterns. Instead use universal framings like "when someone criticizes my work" or "when plans fall apart"
- If you can tell which option a "nice person" would pick the item is bad

## WEIGHTED MULTI-TYPE SIGNALS (CRITICAL)

For each option, list ALL Enneagram types it could signal (3-5 types). Use weights 0.0 to 1.0:
- 1.0 = primary signal for target type
- 0.5-0.7 = moderate signal
- 0.2-0.4 = weak signal
- 0.1 = faint but real signal

## Response format

Valid JSON only. No markdown.

{
  "candidates": [
    {
      "a": "<option A text>",
      "b": "<option B text>",
      "predicted_signal_a": {"<type>": <weight>, "<type>": <weight>},
      "predicted_signal_b": {"<type>": <weight>, "<type>": <weight>},
      "domain": "${combo.domain}",
      "target_pair": "${combo.pair || 'broad'}",
      "target_splitter": "${combo.splitter}"
    },
    { ... },
    { ... }
  ]
}`;
}

// ─── LLM call ───────────────────────────────────────────────────────

async function callLLM(prompt) {
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
      messages: [{ role: 'user', content: prompt }]
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

// ─── Process with concurrency ───────────────────────────────────────

async function processWithConcurrency(items, fn, concurrency) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.error(`  ✗ Failed combo ${i}: ${err.message}`);
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ─── Main ───────────────────────────────────────────────────────────

async function run() {
  const combos = buildCombos();
  console.log(`\nPre-generating questions for ${combos.length} combos...`);
  console.log(`  Pair combos: ${combos.filter(c => c.type === 'pair').length}`);
  console.log(`  Broad combos: ${combos.filter(c => c.type === 'broad').length}`);
  console.log(`  Wing combos: ${combos.filter(c => c.type === 'wing').length}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log(`  Model: ${MODEL}\n`);

  const startTime = Date.now();
  let completed = 0;

  const results = await processWithConcurrency(combos, async (combo, i) => {
    const prompt = buildPrompt(combo);
    const output = await callLLM(prompt);
    const candidates = output.candidates || [output];
    completed++;

    if (completed % 10 === 0 || completed === combos.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  ${completed}/${combos.length} done (${elapsed}s)`);
    }

    return {
      combo: {
        type: combo.type,
        pair: combo.pair,
        splitter: combo.splitter,
        domain: combo.domain
      },
      candidates: candidates.map(c => ({
        a: c.a,
        b: c.b,
        predicted_signal_a: c.predicted_signal_a || {},
        predicted_signal_b: c.predicted_signal_b || {},
        domain: combo.domain,
        target_pair: combo.pair || 'broad',
        target_splitter: combo.splitter
      }))
    };
  }, CONCURRENCY);

  // Filter out failures
  const valid = results.filter(r => r !== null);
  const failed = results.length - valid.length;

  // Build the bank
  const bank = {
    generated_at: new Date().toISOString(),
    model: MODEL,
    total_combos: valid.length,
    total_candidates: valid.reduce((s, r) => s + r.candidates.length, 0),
    questions: valid
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(bank, null, 2));

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s`);
  console.log(`  ${valid.length} combos generated (${failed} failed)`);
  console.log(`  ${bank.total_candidates} total candidates`);
  console.log(`  Saved to ${OUTPUT_FILE}`);
}

run().catch(err => {
  console.error('Pre-generation error:', err);
  process.exit(1);
});
