// ─── LLM Prompt Builders ────────────────────────────────────────────
// Router decides WHAT to test. Writer generates HOW to test it.

const { PAIR_AXES, PROBE_GUIDE, WING_GUIDE, TRIADS, HORNEVIAN, HARMONIC } = require('./engine');

// ─── Router Prompt ──────────────────────────────────────────────────

function buildRouterPrompt(stateSummary, lastAnswer, calibrationData) {
  const isFirstAdaptive = !!calibrationData;

  let context = `You are the routing engine for an Enneagram typing system. You decide WHAT to test next. You do NOT write questions.

## Your job

Given the current state, output a JSON routing decision. Identify the single highest-value unresolved distinction.

## Core frame

Type is inferred from: threat → move → repeated cost
- What feels threatened first?
- What move follows?
- What repeated cost keeps showing up?

## Priority order

1. If repair_mode is true: target the cost-pattern conflict
2. If untested_types >= 4 and question < 10: force a broad triad/stance cut
3. If rephrase is due: pick the best rephrase target
4. If a clear pair ambiguity exists (top_two_gap < 20): target that pair with its best splitter
5. If wing needs work (wing_confidence < 60 and type_confidence > 50): target wing split
6. Otherwise: target the highest remaining ambiguity

## Tunnel prevention

Never target the same type family (same pair direction) more than 2 questions in a row.
If same_type_family_streak >= 2, you MUST switch to a different pair or a broad cut.

## Broad discrimination tools

For broad cuts, use these groupings:
- Triads: gut [8,9,1] vs heart [2,3,4] vs head [5,6,7]
- Hornevian: assertive [3,7,8] vs compliant [1,2,6] vs withdrawn [4,5,9]
- Harmonic: positive_outlook [2,7,9] vs competency [1,3,5] vs reactive [4,6,8]

A single broad question can move 6+ types at once.`;

  if (isFirstAdaptive) {
    context += `

## Calibration data

The person just answered 5 calibration questions. Here are their answers:

${JSON.stringify(calibrationData, null, 2)}

IMPORTANT: Calibration sets behavioral signal readings ONLY. The type posterior is flat (all types at ~11%). Do NOT eliminate any types based on calibration. Analyze the behavioral signals and decide what broad discrimination question to ask first.`;
  } else {
    context += `

## Last answer

${lastAnswer}`;
  }

  context += `

## Current state

${JSON.stringify(stateSummary, null, 2)}

## Available pair axes

${Object.entries(PAIR_AXES).map(([key, ax]) =>
    `${key}: ${ax.splitter} (domains: ${ax.domains.join(', ')})`
  ).join('\n')}

## Response format

You MUST respond with valid JSON only. No markdown, no explanation.

{
  "target_pair": "<e.g. 5v9 or null for broad cut>",
  "target_splitter": "<e.g. absorption_vs_settling or null>",
  "target_domain": "<relationship|work|self|stress|conflict|authority|leisure|social>",
  "question_purpose": "<broad_discrimination|pair_discrimination|wing_split|rephrase|repair|approval>",
  "must_avoid_domains": ["<domains used recently>"],
  "rephrase_of": null,
  "reasoning": "<1-2 sentences: what distinction matters most right now and why>",
  "types_raised": [{"type": <number>, "amount": <1-15>}],
  "types_lowered": [{"type": <number>, "amount": <1-15>}],
  "behavioral_updates": {
    "<dimension>": {"value": "<value>", "confidence": <number>}
  },
  "threat_pattern": "<enum value or null if unchanged>",
  "move_pattern": "<enum value or null if unchanged>",
  "repeated_cost_pattern": "<enum value or null if unchanged>",
  "likely_wing": <number or null>,
  "wing_confidence": <number or null>
}

For the first question after calibration, types_raised and types_lowered should be empty (posterior stays flat). Only set behavioral_updates from calibration signals.
For subsequent questions, update types_raised/lowered based on the answer you just received.`;

  return context;
}

// ─── Writer Prompt ──────────────────────────────────────────────────

function buildWriterPrompt(routerOutput, state) {
  const pair = routerOutput.target_pair;
  const splitter = routerOutput.target_splitter;
  const domain = routerOutput.target_domain;
  const purpose = routerOutput.question_purpose;

  // Get relevant probe context
  let probeContext = '';
  if (pair) {
    const types = pair.split('v').map(Number);
    const probeA = PROBE_GUIDE[types[0]];
    const probeB = PROBE_GUIDE[types[1]];
    const axis = PAIR_AXES[pair];

    probeContext = `
## Target pair: ${pair}
Splitter: ${splitter}
${axis ? `Pole A (type ${types[0]}): ${axis.probe_a}` : ''}
${axis ? `Pole B (type ${types[1]}): ${axis.probe_b}` : ''}

## Type ${types[0]} probe context
Target: ${probeA?.target || 'unknown'}
Latent probes: ${(probeA?.latent_probes || []).join(' | ')}
Killer probe: ${probeA?.killer_probe || 'none'}

## Type ${types[1]} probe context
Target: ${probeB?.target || 'unknown'}
Latent probes: ${(probeB?.latent_probes || []).join(' | ')}
Killer probe: ${probeB?.killer_probe || 'none'}`;
  }

  // Wing context if needed
  let wingContext = '';
  if (purpose === 'wing_split' && state.top_type) {
    const wg = WING_GUIDE[state.top_type];
    if (wg) {
      wingContext = `
## Wing split for type ${state.top_type}
${wg.low.name}: ${wg.low.desc}
${wg.high.name}: ${wg.high.desc}
How to split: ${wg.split}`;
    }
  }

  // Broad discrimination context
  let broadContext = '';
  if (purpose === 'broad_discrimination') {
    broadContext = `
## Broad discrimination
Use these groupings to write items that cut across multiple types:
- Gut [8,9,1]: body-based, anger relationship
- Heart [2,3,4]: image/identity, shame relationship
- Head [5,6,7]: thinking/planning, fear relationship
- Assertive [3,7,8]: move against, take initiative
- Compliant [1,2,6]: move toward, follow standards/others
- Withdrawn [4,5,9]: move away, retreat inward
- Positive outlook [2,7,9]: reframe/minimize negative
- Competency [1,3,5]: manage emotion, focus on task
- Reactive [4,6,8]: amplify emotion, push back

The router wants a ${domain} domain question.
${routerOutput.reasoning || ''}`;
  }

  // Recent questions to avoid repetition
  const recentItems = state.question_history.slice(-3).map(q =>
    `A: "${q.option_a}" / B: "${q.option_b}"`
  ).join('\n');

  const prompt = `You are a forced-choice item writer for an Enneagram typing system. You generate candidate questions. You do NOT decide what to test — that was already decided.

## Your job

Write 3 candidate forced-choice items for the target below. Each item must separate the specified distinction.

## Target
Pair: ${pair || 'broad cut'}
Splitter: ${splitter || 'broad discrimination'}
Domain: ${domain}
Purpose: ${purpose}
${routerOutput.reasoning ? `Router reasoning: ${routerOutput.reasoning}` : ''}
${probeContext}
${wingContext}
${broadContext}

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
- If you can tell which option a "nice person" would pick the item is bad

## Probe-to-item conversion

The latent probes above are NOT literal questions. Convert them:
- "What do you quietly resent having to fix?" becomes something like:
  A: "I get irritated when I keep fixing what others should handle"
  B: "I get irritated when others push me before I am ready"

## Recent questions (avoid repetition)
${recentItems || 'None yet'}

## Response format

Valid JSON only. No markdown.

{
  "candidates": [
    {
      "a": "<option A text>",
      "b": "<option B text>",
      "predicted_signal_a": [<type numbers option A favors>],
      "predicted_signal_b": [<type numbers option B favors>],
      "domain": "${domain}",
      "target_pair": "${pair || 'broad'}",
      "target_splitter": "${splitter || 'broad'}"
    },
    { ... },
    { ... }
  ]
}`;

  return prompt;
}

// ─── Rephrase Writer Prompt ─────────────────────────────────────────

function buildRephraseWriterPrompt(rephraseTarget, state) {
  const originalQ = state.question_history.find(q => q.question_number === rephraseTarget.original_question);

  // Pick a different domain than the original
  const pairKey = rephraseTarget.pair;
  const axis = PAIR_AXES[pairKey];
  const availableDomains = (axis?.domains || ['relationship', 'work', 'self', 'stress'])
    .filter(d => d !== rephraseTarget.domain);
  const newDomain = availableDomains[0] || 'relationship';

  return `You are a forced-choice item writer. Write a REPHRASE of a previous structural fork.

## Original item (question ${rephraseTarget.original_question})
A: "${originalQ?.option_a || 'unknown'}"
B: "${originalQ?.option_b || 'unknown'}"
Pair: ${rephraseTarget.pair}
Splitter: ${rephraseTarget.splitter}
Original domain: ${rephraseTarget.domain}

## Your job

Write 1 forced-choice item that tests the SAME structural distinction (${rephraseTarget.splitter}) but in the ${newDomain} domain with different wording.

If the person gives the same answer, confidence increases.
If they flip, it flags an inconsistency.

## Item writing rules
- First person, present tense
- 8-16 words per option
- Parallel syntax, matched emotional weight
- No commas or dashes
- No moral contrast
- Concrete behavioral language

## Response format

Valid JSON only.

{
  "candidates": [
    {
      "a": "<option A — should correspond to same pole as original A>",
      "b": "<option B — should correspond to same pole as original B>",
      "predicted_signal_a": [<types>],
      "predicted_signal_b": [<types>],
      "domain": "${newDomain}",
      "target_pair": "${rephraseTarget.pair}",
      "target_splitter": "${rephraseTarget.splitter}",
      "rephrase_of": ${rephraseTarget.original_question}
    }
  ]
}`;
}

// ─── Approval Prompt ────────────────────────────────────────────────

function buildApprovalPrompt(state, stateSummary) {
  const topType = state.top_type;
  const wing = state.likely_wing;
  const wg = WING_GUIDE[topType];
  const wingName = wing ? (
    wg && wg.low.wing === wing ? wg.low.name :
    wg && wg.high.wing === wing ? wg.high.name :
    `${topType}w${wing}`
  ) : `${topType}w?`;

  return `You are finalizing an Enneagram typing result. Based on all accumulated evidence, write a personalized summary.

## Final typing
Type: ${topType}
Wing: ${wingName}

## State summary
${JSON.stringify(stateSummary, null, 2)}

## Behavioral signals
${Object.entries(state.behavioral).map(([k, v]) => `${k}: ${v.value} (${v.confidence}%)`).join('\n')}

## Patterns detected
Threat: ${state.threat_pattern || 'not identified'}
Move: ${state.move_pattern || 'not identified'}
Repeated cost: ${state.repeated_cost_pattern || 'not identified'}

## Response format

Valid JSON only.

{
  "type": ${topType},
  "wing": ${wing || 0},
  "wing_name": "${wingName}",
  "summary": "<2-3 sentences: personalized summary describing how this person lives their type. Reference specific behavioral patterns observed. Do not use Enneagram jargon — describe the person, not the type.>",
  "confidence_note": "<1 sentence: what was most clear and what remained ambiguous>"
}`;
}

module.exports = {
  buildRouterPrompt,
  buildWriterPrompt,
  buildRephraseWriterPrompt,
  buildApprovalPrompt
};
