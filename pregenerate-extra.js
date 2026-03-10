// Generate extra questions for underrepresented types (7 and 2)
// Adds 2 extra domains per pair to close the coverage gap

const fs = require('fs');
try {
  fs.readFileSync('.env', 'utf8').split('\n').forEach(l => {
    const [k, ...v] = l.split('=');
    if (k && v.length) process.env[k.trim()] = v.join('=').trim();
  });
} catch (_) {}

const { PAIR_AXES, PROBE_GUIDE } = require('./engine');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-haiku-4-5-20251001';
const CONCURRENCY = 5;
const BANK_FILE = './questions-bank.json';

// Pick 2 best missing domains per pair
const EXTRA_DOMAINS = {
  '2v3': ['self', 'stress'],
  '2v4': ['work', 'conflict'],
  '2v6': ['self', 'conflict'],
  '2v8': ['work', 'self'],
  '2v9': ['work', 'stress'],
  '3v7': ['relationship', 'conflict'],
  '4v7': ['work', 'conflict'],
  '5v7': ['relationship', 'stress'],
  '6v7': ['work', 'conflict'],
  '7v8': ['relationship', 'work'],
  '7v9': ['relationship', 'conflict']
};

function buildPrompt(pair, domain) {
  const axis = PAIR_AXES[pair];
  const types = pair.split('v').map(Number);
  const probeA = PROBE_GUIDE[types[0]];
  const probeB = PROBE_GUIDE[types[1]];

  return `You are a forced-choice item writer for an Enneagram typing system.

## Your job
Write 3 candidate forced-choice items for the target below.

## Target pair: ${pair}
Splitter: ${axis.splitter}
Pole A (type ${types[0]}): ${axis.probe_a}
Pole B (type ${types[1]}): ${axis.probe_b}
Domain: ${domain}

## Type ${types[0]} probe context
Target: ${probeA?.target || 'unknown'}
Latent probes: ${(probeA?.latent_probes || []).join(' | ')}
Under stress: ${probeA?.stress_arrow || 'unknown'}
Core avoidance: ${probeA?.core_avoidance || 'unknown'}

## Type ${types[1]} probe context
Target: ${probeB?.target || 'unknown'}
Latent probes: ${(probeB?.latent_probes || []).join(' | ')}
Under stress: ${probeB?.stress_arrow || 'unknown'}
Core avoidance: ${probeB?.core_avoidance || 'unknown'}

## Item writing rules
- First person, present tense
- 8-16 words per option
- Parallel syntax between A and B
- Matched emotional weight — neither option sounds healthier
- Both options slightly costly or confessional
- No moral contrast
- No Enneagram jargon
- No commas or dashes in option text
- Each option is one clean sentence or phrase
- Use situational scenarios but do NOT reference specific people (no "my partner" or "my colleague" or "my friend")
- If you can tell which option a "nice person" would pick the item is bad

## WEIGHTED MULTI-TYPE SIGNALS
For each option, list ALL Enneagram types it could signal (3-5 types). Weights 0.0 to 1.0.
Target pair types = 1.0. Include secondary/tertiary signals.

## Response format
Valid JSON only. No markdown.
{
  "candidates": [
    {
      "a": "<option A>",
      "b": "<option B>",
      "predicted_signal_a": {"<type>": <weight>},
      "predicted_signal_b": {"<type>": <weight>},
      "domain": "${domain}",
      "target_pair": "${pair}",
      "target_splitter": "${axis.splitter}"
    },
    { ... },
    { ... }
  ]
}`;
}

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
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.[0]?.text;
  if (!text) throw new Error('Empty response');
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i);
  let jsonText = fenceMatch ? fenceMatch[1] : text.trim();
  jsonText = jsonText.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(jsonText);
}

async function run() {
  const combos = [];
  for (const [pair, domains] of Object.entries(EXTRA_DOMAINS)) {
    for (const domain of domains) {
      combos.push({ pair, domain });
    }
  }

  console.log(`Generating ${combos.length} extra combos for types 2 and 7...\n`);
  const startTime = Date.now();
  let completed = 0;

  const results = [];
  let index = 0;

  async function worker() {
    while (index < combos.length) {
      const i = index++;
      const combo = combos[i];
      try {
        const prompt = buildPrompt(combo.pair, combo.domain);
        const output = await callLLM(prompt);
        const candidates = (output.candidates || [output]).map(c => ({
          a: c.a, b: c.b,
          predicted_signal_a: c.predicted_signal_a || {},
          predicted_signal_b: c.predicted_signal_b || {},
          domain: combo.domain,
          target_pair: combo.pair,
          target_splitter: PAIR_AXES[combo.pair].splitter
        }));
        results[i] = {
          combo: { type: 'pair', pair: combo.pair, splitter: PAIR_AXES[combo.pair].splitter, domain: combo.domain },
          candidates
        };
        completed++;
        if (completed % 5 === 0) console.log(`  ${completed}/${combos.length} done`);
      } catch (err) {
        console.error(`  ✗ Failed ${combo.pair}/${combo.domain}: ${err.message}`);
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Merge into existing bank
  const bank = JSON.parse(fs.readFileSync(BANK_FILE, 'utf8'));
  const valid = results.filter(r => r !== null);
  let added = 0;
  for (const entry of valid) {
    bank.questions.push(entry);
    added += entry.candidates.length;
  }
  bank.total_combos += valid.length;
  bank.total_candidates += added;

  fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 2));
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${elapsed}s — added ${valid.length} combos (${added} candidates)`);
  console.log(`  Bank now: ${bank.total_combos} combos, ${bank.total_candidates} candidates`);
}

run().catch(err => { console.error(err); process.exit(1); });
