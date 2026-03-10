// ─── LLM Prompt Builders ────────────────────────────────────────────
// Router decides WHAT to test. Writer generates HOW to test it.

const { PAIR_AXES, PROBE_GUIDE, WING_GUIDE, TRIADS, HORNEVIAN, HARMONIC } = require('./engine');

// ─── Router Prompt ──────────────────────────────────────────────────

function buildRouterPrompt(stateSummary, lastAnswer) {
  let context = `You are the routing engine for an Enneagram typing system. You decide WHAT to test next. You do NOT write questions.

## Your job

Given the current state, output a JSON routing decision. Identify the single highest-value unresolved distinction.

## Core frame

Type is inferred from: threat → move → repeated cost
- What feels threatened first?
- What move follows?
- What repeated cost keeps showing up?

## Priority order

1. If neglected_types is non-empty and question >= 8: force a broad cut that includes at least one neglected type. A type with ≤1 signal touch after 8+ questions is a blind spot — the system cannot confirm or eliminate it. Pick a triad/stance grouping that covers the neglected type(s).
2. If repair_mode is true: target the cost-pattern conflict
3. If untested_types >= 4 and question < 8: force a broad triad/stance cut
4. **If required_triad_pairs is non-empty: you MUST target one of those pairs.** Same-triad types (gut [8,9,1], heart [2,3,4], head [5,6,7]) share behavioral profiles and CANNOT be distinguished without direct pair testing. This is mandatory — the engine will block completion until these pairs are tested.
5. If rephrase is due: pick the best rephrase target
6. If a clear pair ambiguity exists (top_two_gap < 20): target that pair with its best splitter
7. If wing needs work (wing_confidence < 60 and type_confidence > 50): target wing split
8. Otherwise: target the highest remaining ambiguity

## PAIR CAP RULE (MANDATORY)

Each type pair can be tested a MAXIMUM of 3 times. After 3 questions on the same pair, you MUST move to a different pair or a broad cut. The capped_pairs list shows which pairs have hit this limit.

If a pair has been tested 3 times with inconsistent results (e.g. person picked A twice and B once), this means NEITHER type in that pair may be correct. You should test the leading type against an UNTESTED or UNDERTESTED type instead.

## Tunnel prevention

Never target the same type family (same pair direction) more than 2 questions in a row.
If same_type_family_streak >= 2, you MUST switch to a different pair or a broad cut.

## Broad discrimination tools

For broad cuts, use these groupings:
- Triads: gut [8,9,1] vs heart [2,3,4] vs head [5,6,7]
- Hornevian: assertive [3,7,8] vs compliant [1,2,6] vs withdrawn [4,5,9]
- Harmonic: positive_outlook [2,7,9] vs competency [1,3,5] vs reactive [4,6,8]

A single broad question can move 6+ types at once.`;

  if (lastAnswer) {
    context += `

## Last answer

${lastAnswer}`;
  } else {
    context += `

## First question

This is the first question. The type posterior is flat (all types at ~11%). Start with a broad discrimination question to begin separating types.`;
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
  "threat_pattern": "<enum value or null if unchanged>",
  "move_pattern": "<enum value or null if unchanged>",
  "repeated_cost_pattern": "<enum value or null if unchanged>",
  "likely_wing": <number or null>,
  "wing_confidence": <number or null>
}

For the first question, types_raised and types_lowered should be empty (posterior stays flat).
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
Under stress: ${probeA?.stress_arrow || 'unknown'}
Core avoidance: ${probeA?.core_avoidance || 'unknown'}

## Type ${types[1]} probe context
Target: ${probeB?.target || 'unknown'}
Latent probes: ${(probeB?.latent_probes || []).join(' | ')}
Killer probe: ${probeB?.killer_probe || 'none'}
Under stress: ${probeB?.stress_arrow || 'unknown'}
Core avoidance: ${probeB?.core_avoidance || 'unknown'}`;
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

  // Answer history for context
  const answerHistory = state.question_history
    .filter(q => q.picked)
    .map(q => {
      const chosenText = q.picked === 'a' ? q.option_a : q.option_b;
      return `Q${q.question_number} (${q.pair || 'broad'}): picked ${q.picked.toUpperCase()} — "${chosenText}"`;
    }).join('\n');

  // Current type distribution
  const sorted = [1,2,3,4,5,6,7,8,9]
    .map(t => ({ type: t, prob: state.posterior[t] }))
    .sort((a, b) => b.prob - a.prob);
  const typeDistribution = sorted.map(t => `${t.type}:${Math.round(t.prob)}%`).join(' ');

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

## Person's emerging pattern
Type distribution: ${typeDistribution}
Threat: ${state.threat_pattern || 'unknown'}
Move: ${state.move_pattern || 'unknown'}
Cost: ${state.repeated_cost_pattern || 'unknown'}

## Signal coverage (IMPORTANT)
${Object.entries(state.type_signal_counts || {}).map(([t, c]) => `Type ${t}: ${c} signal touches`).join('\n')}
${(() => {
  const neglected = Object.entries(state.type_signal_counts || {}).filter(([, c]) => c <= 1).map(([t]) => t);
  return neglected.length > 0 ? `\nNEGLECTED TYPES (≤1 signal touch): [${neglected.join(', ')}] — Try to include at least one neglected type as a tertiary signal (0.1-0.3) in your options. Every question should help eliminate OR confirm these types.` : '';
})()}

## Answer history
${answerHistory || 'No answers yet — this is the first question.'}

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

## WEIGHTED MULTI-TYPE SIGNALS (CRITICAL — READ CAREFULLY)

For each option, you MUST list ALL Enneagram types it could signal — not just the target pair. Each option should typically signal 3-5 types. Use weights from 0.0 to 1.0:
- 1.0 = this option is a primary signal for this type (the target pair type)
- 0.5-0.7 = this option moderately signals this type
- 0.2-0.4 = this option weakly signals this type
- 0.1 = faint but real signal for this type

The target pair types should always be 1.0. But EVERY option has multiple secondary and tertiary type signals — find them all.

Think about each option: "What other types would also pick this?" For example:
- "I step back to analyze what went wrong" → 5 (detachment/conservation 1.0), 6 (troubleshooting 0.6), 1 (correcting errors 0.4), 3 (performance review 0.2)
- Duty/responsibility language → also signals 1 (standards) and 6 (loyalty/duty)
- Worry about credibility → also signals 6 (security anxiety) and 3 (image)
- Withdrawing to think → also signals 5 (conservation), 6 (analysis), and 9 (retreating)
- Helping others → also signals 2 (connection), 9 (merging), and 1 (doing the right thing)
- Wanting recognition → also signals 3 (image), 8 (impact), and 7 (excitement)
- Self-criticism → also signals 1 (inner critic), 6 (self-doubt), and 4 (deficiency)
- Seeking comfort → also signals 9 (settling), 2 (contact-seeking), and 7 (pain avoidance)
- Opening new possibilities when stuck → signals 7 (options as escape), 3 (pivoting to win), and 9 (avoiding the hard thing)
- Reframing negatives into positives → signals 7 (pain avoidance), 2 (maintaining harmony), and 9 (smoothing over)
- Feeling trapped by routine/commitment → signals 7 (constraint pain), 4 (longing for something more), and 8 (resisting control)

If an option has fewer than 3 types tagged, you are almost certainly missing signals. This is the most important part of your output — the system uses secondary and tertiary signals to detect types that aren't being directly tested. Every forced-choice answer reveals information about multiple types simultaneously.

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
      "predicted_signal_a": {"<type>": <weight>, "<type>": <weight>},
      "predicted_signal_b": {"<type>": <weight>, "<type>": <weight>},
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
      "predicted_signal_a": {"<type>": <weight>, ...},
      "predicted_signal_b": {"<type>": <weight>, ...},
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
