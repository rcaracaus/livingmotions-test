// ─── Enneagram State Engine ─────────────────────────────────────────
// Deterministic state management. The LLM never owns this.

const TYPES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// ─── Reference Data ─────────────────────────────────────────────────

const TYPE_PROFILES = {
  1: { anger_awareness: 'immediate', pressure_stance: 'engage', good_day_anchor: 'performance', hurt_response: 'containment', no_demand_pattern: 'inquiry' },
  2: { anger_awareness: 'delayed', pressure_stance: 'engage', good_day_anchor: 'relational', hurt_response: 'contact_seeking', no_demand_pattern: 'settling' },
  3: { anger_awareness: 'delayed', pressure_stance: 'engage', good_day_anchor: 'performance', hurt_response: 'containment', no_demand_pattern: 'inquiry' },
  4: { anger_awareness: 'delayed', pressure_stance: 'ease_back', good_day_anchor: 'performance', hurt_response: 'contact_seeking', no_demand_pattern: 'inquiry' },
  5: { anger_awareness: 'delayed', pressure_stance: 'ease_back', good_day_anchor: 'performance', hurt_response: 'containment', no_demand_pattern: 'inquiry' },
  6: { anger_awareness: 'immediate', pressure_stance: 'engage', good_day_anchor: 'relational', hurt_response: 'contact_seeking', no_demand_pattern: 'inquiry' },
  7: { anger_awareness: 'delayed', pressure_stance: 'engage', good_day_anchor: 'performance', hurt_response: 'containment', no_demand_pattern: 'inquiry' },
  8: { anger_awareness: 'immediate', pressure_stance: 'engage', good_day_anchor: 'performance', hurt_response: 'containment', no_demand_pattern: 'inquiry' },
  9: { anger_awareness: 'delayed', pressure_stance: 'ease_back', good_day_anchor: 'relational', hurt_response: 'containment', no_demand_pattern: 'settling' }
};

const COST_MAP = {
  1: 'tension_for_rightness',
  2: 'overgiving_for_connection',
  3: 'self_loss_for_image',
  4: 'pain_for_depth',
  5: 'distance_for_resources',
  6: 'worry_for_preparedness',
  7: 'scatter_for_freedom',
  8: 'conflict_for_autonomy',
  9: 'self_erasure_for_peace'
};

const COST_TO_TYPE = {};
for (const [type, cost] of Object.entries(COST_MAP)) {
  COST_TO_TYPE[cost] = parseInt(type);
}

const THREAT_MAP = {
  1: 'rightness',
  2: 'connection_value',
  3: 'image_traction',
  4: 'meaning_identity',
  5: 'resource_depletion',
  6: 'uncertainty_footing',
  7: 'constraint_pain',
  8: 'control_vulnerability',
  9: 'peace_disruption'
};

const MOVE_MAP = {
  1: 'correct',
  2: 'move_toward',
  3: 'perform',
  4: 'deepen',
  5: 'withdraw_to_understand',
  6: 'scan_prepare',
  7: 'open_options',
  8: 'push_back',
  9: 'settle_numb'
};

// ─── Pair Axes (Template Bank) ──────────────────────────────────────

const PAIR_AXES = {
  '1v3': { splitter: 'rightness_vs_landing', probe_a: 'accuracy and internal standard', probe_b: 'traction and visible result', domains: ['work', 'conflict', 'self'] },
  '1v6': { splitter: 'conviction_vs_doubt', probe_a: 'internal certainty about standards', probe_b: 'checking and questioning before committing', domains: ['authority', 'conflict', 'stress'] },
  '1v8': { splitter: 'principle_vs_instinct', probe_a: 'anger channeled into correction by standard', probe_b: 'anger as immediate instinctive force', domains: ['conflict', 'authority', 'relationship'] },
  '1v9': { splitter: 'reform_vs_peace', probe_a: 'tension held to fix what is wrong', probe_b: 'tension released to restore comfort', domains: ['conflict', 'self', 'relationship'] },
  '2v3': { splitter: 'needed_vs_impressive', probe_a: 'value through being needed by others', probe_b: 'value through achievement and admiration', domains: ['relationship', 'work', 'social'] },
  '2v4': { splitter: 'other_focused_vs_self_focused', probe_a: 'attention flows toward others needs', probe_b: 'attention flows toward own inner experience', domains: ['relationship', 'self', 'stress'] },
  '2v6': { splitter: 'give_to_bond_vs_give_to_secure', probe_a: 'helping to create connection', probe_b: 'helping to build reliable alliance', domains: ['relationship', 'stress', 'work'] },
  '2v8': { splitter: 'care_protection_vs_force_protection', probe_a: 'protecting through warmth and involvement', probe_b: 'protecting through strength and directness', domains: ['relationship', 'conflict', 'stress'] },
  '2v9': { splitter: 'merge_to_connect_vs_merge_to_avoid', probe_a: 'losing self boundary to feel needed', probe_b: 'losing self boundary to avoid friction', domains: ['relationship', 'conflict', 'self'] },
  '3v4': { splitter: 'performance_identity_vs_inner_identity', probe_a: 'identity built from achievement and how others see you', probe_b: 'identity built from inner emotional truth', domains: ['work', 'self', 'relationship'] },
  '3v6': { splitter: 'project_confidence_vs_test_confidence', probe_a: 'presenting certainty to land well', probe_b: 'testing certainty before trusting it', domains: ['work', 'social', 'stress'] },
  '3v7': { splitter: 'results_vs_stimulation', probe_a: 'driven by outcomes and recognition', probe_b: 'driven by novelty and possibility', domains: ['work', 'leisure', 'stress'] },
  '3v8': { splitter: 'polish_vs_rawness', probe_a: 'becoming more polished under pressure', probe_b: 'becoming more raw and direct under pressure', domains: ['stress', 'conflict', 'work'] },
  '4v5': { splitter: 'feeling_depth_vs_analysis_depth', probe_a: 'going deeper into emotion to understand', probe_b: 'going deeper into analysis to understand', domains: ['self', 'relationship', 'stress'] },
  '4v6': { splitter: 'identity_pain_vs_uncertainty', probe_a: 'pain rooted in who I am and being unseen', probe_b: 'pain rooted in what might go wrong and being unsupported', domains: ['self', 'relationship', 'stress'] },
  '4v7': { splitter: 'stay_with_pain_vs_move_from_pain', probe_a: 'moving into pain to find meaning', probe_b: 'moving away from pain toward possibility', domains: ['self', 'stress', 'relationship'] },
  '5v6': { splitter: 'conserve_vs_prepare', probe_a: 'withdrawing to protect energy and resources', probe_b: 'withdrawing to research and prepare for threats', domains: ['stress', 'work', 'relationship'] },
  '5v7': { splitter: 'depth_vs_breadth', probe_a: 'going deep into one thing for mastery', probe_b: 'going wide across many things for freedom', domains: ['self', 'work', 'leisure'] },
  '5v9': { splitter: 'absorption_vs_settling', probe_a: 'withdrawing into rich internal world of thought', probe_b: 'withdrawing into comfort and low-demand space', domains: ['self', 'leisure', 'stress'] },
  '6v7': { splitter: 'brace_vs_reframe', probe_a: 'preparing for what could go wrong', probe_b: 'reframing what went wrong into something better', domains: ['stress', 'self', 'relationship'] },
  '6v8': { splitter: 'test_vs_override', probe_a: 'testing authority and checking before trusting', probe_b: 'overriding authority and trusting gut', domains: ['conflict', 'authority', 'stress'] },
  '6v9': { splitter: 'question_vs_merge', probe_a: 'actively worrying about what could go wrong', probe_b: 'avoiding thinking about what could go wrong', domains: ['conflict', 'relationship', 'stress'] },
  '7v8': { splitter: 'escape_vs_confront', probe_a: 'moving away from pain toward new options', probe_b: 'moving into confrontation to assert control', domains: ['conflict', 'stress', 'self'] },
  '7v9': { splitter: 'options_vs_comfort', probe_a: 'seeking stimulation and new experiences', probe_b: 'seeking comfort and familiar routines', domains: ['leisure', 'stress', 'self'] },
  '8v9': { splitter: 'force_vs_settle', probe_a: 'pushing harder when resistance appears', probe_b: 'easing off when resistance appears', domains: ['conflict', 'stress', 'relationship'] }
};

// ─── Wing Definitions ───────────────────────────────────────────────

const WING_GUIDE = {
  1: { low: { wing: 9, name: '1w9', desc: 'reserved and principled, anger is cold and controlled' }, high: { wing: 2, name: '1w2', desc: 'warmer and people-focused, anger comes with disappointment' }, split: 'frustration leads to withdrawal into standards vs reaching out to correct' },
  2: { low: { wing: 1, name: '2w1', desc: 'principled helper, gives with conditions' }, high: { wing: 3, name: '2w3', desc: 'charming helper, gives to be seen' }, split: 'helping driven by duty vs desire for recognition' },
  3: { low: { wing: 2, name: '3w2', desc: 'warm, success means being admired by people' }, high: { wing: 4, name: '3w4', desc: 'introspective, success means being unique' }, split: 'performing for audience vs inner standard of distinction' },
  4: { low: { wing: 3, name: '4w3', desc: 'expressive and ambitious, stand out through achievement' }, high: { wing: 5, name: '4w5', desc: 'private and cerebral, depth over recognition' }, split: 'intensity pushes outward vs inward into analysis' },
  5: { low: { wing: 4, name: '5w4', desc: 'imaginative, drawn to meaning and feeling' }, high: { wing: 6, name: '5w6', desc: 'systematic, drawn to frameworks and trusted groups' }, split: 'solitude feeds creativity vs structure and preparation' },
  6: { low: { wing: 5, name: '6w5', desc: 'withdrawn and cerebral, manages anxiety through analysis' }, high: { wing: 7, name: '6w7', desc: 'outgoing, manages anxiety through activity and humor' }, split: 'cope with doubt by researching vs staying busy and social' },
  7: { low: { wing: 6, name: '7w6', desc: 'social, fun masks worry underneath' }, high: { wing: 8, name: '7w8', desc: 'assertive, fun pursued with force' }, split: 'nervous energy under enthusiasm vs aggressive energy' },
  8: { low: { wing: 7, name: '8w7', desc: 'expansive, wants more of everything' }, high: { wing: 9, name: '8w9', desc: 'grounded, power is quiet and immovable' }, split: 'force pushes into new territory vs holding ground' },
  9: { low: { wing: 8, name: '9w8', desc: 'stubborn, quiet force when pushed' }, high: { wing: 1, name: '9w1', desc: 'principled, quiet opinions about right and wrong' }, split: 'passive resistance has edge vs moral tone' }
};

// ─── Probe Guide (per-type) ─────────────────────────────────────────

const PROBE_GUIDE = {
  1: {
    target: 'inner pressure, correction, resentment at what is off',
    latent_probes: [
      'what feels wrong rather than merely inconvenient',
      'whether irritation becomes correction or suppression',
      'what standard they quietly enforce'
    ],
    listen_for: [
      { signal: 'anger converted into correction', threat: 'rightness', move: 'correct', cost: 'tension_for_rightness' },
      { signal: 'tightening over exploding', threat: 'rightness', move: 'correct', cost: 'tension_for_rightness' },
      { signal: 'resentment at carrying standard alone', threat: 'rightness', move: 'correct', cost: 'tension_for_rightness' }
    ],
    splitters: ['1v8', '1v6', '1v3'],
    killer_probe: 'what they quietly resent having to fix over and over',
    stress_arrow: 'under stress becomes moody and irrational like unhealthy 4',
    core_avoidance: 'being wrong or corrupt'
  },
  2: {
    target: 'moving toward people, needing to matter, resentment after overgiving',
    latent_probes: [
      'whether value comes from being useful',
      'whether unmet need becomes indirect',
      'whether helping hides a need to matter'
    ],
    listen_for: [
      { signal: 'self-worth through usefulness', threat: 'connection_value', move: 'move_toward', cost: 'overgiving_for_connection' },
      { signal: 'indirect need expression', threat: 'connection_value', move: 'move_toward', cost: 'overgiving_for_connection' },
      { signal: 'connection-seeking under emotion', threat: 'connection_value', move: 'move_toward', cost: 'overgiving_for_connection' }
    ],
    splitters: ['2v3', '2v9', '2v8'],
    killer_probe: 'what hurts more: not being loved back or not being needed',
    stress_arrow: 'under stress becomes aggressive and controlling like unhealthy 8',
    core_avoidance: 'being unwanted or unneeded'
  },
  3: {
    target: 'identity through performance, adaptation, traction',
    latent_probes: [
      'whether setback hits image or recovery momentum',
      'whether value depends on movement and visible competence',
      'whether presentation shifts quickly to land well'
    ],
    listen_for: [
      { signal: 'fast presentation adjustment', threat: 'image_traction', move: 'perform', cost: 'self_loss_for_image' },
      { signal: 'outcome and traction focus', threat: 'image_traction', move: 'perform', cost: 'self_loss_for_image' },
      { signal: 'discomfort with stagnation', threat: 'image_traction', move: 'perform', cost: 'self_loss_for_image' }
    ],
    splitters: ['2v3', '3v4', '3v7'],
    killer_probe: 'who they are when there is nothing to achieve',
    stress_arrow: 'under stress becomes disengaged and apathetic like unhealthy 9',
    core_avoidance: 'being worthless or without value apart from achievements'
  },
  4: {
    target: 'meaning-rich pain, identity through feeling, depth over escape',
    latent_probes: [
      'whether pain becomes significant',
      'whether misunderstanding feels identity-relevant',
      'whether they move into emotion to understand it'
    ],
    listen_for: [
      { signal: 'pain made meaningful', threat: 'meaning_identity', move: 'deepen', cost: 'pain_for_depth' },
      { signal: 'depth as orientation', threat: 'meaning_identity', move: 'deepen', cost: 'pain_for_depth' },
      { signal: 'precise unseen-ness', threat: 'meaning_identity', move: 'deepen', cost: 'pain_for_depth' }
    ],
    splitters: ['4v6', '4v5', '4v7'],
    killer_probe: 'what kind of misunderstanding feels personal not just annoying',
    stress_arrow: 'under stress becomes clingy and over-involved like unhealthy 2',
    core_avoidance: 'being ordinary or without personal significance'
  },
  5: {
    target: 'depletion, intrusion, need to understand before engaging',
    latent_probes: [
      'what demand depletes fastest',
      'whether distance protects resources',
      'whether understanding creates safety'
    ],
    listen_for: [
      { signal: 'guarding time and energy', threat: 'resource_depletion', move: 'withdraw_to_understand', cost: 'distance_for_resources' },
      { signal: 'withdrawing into thought', threat: 'resource_depletion', move: 'withdraw_to_understand', cost: 'distance_for_resources' },
      { signal: 'confidence through understanding', threat: 'resource_depletion', move: 'withdraw_to_understand', cost: 'distance_for_resources' }
    ],
    splitters: ['5v9', '5v6', '5v7'],
    killer_probe: 'what kind of demand makes them disappear fastest',
    stress_arrow: 'under stress becomes scattered and hyperactive like unhealthy 7',
    core_avoidance: 'being overwhelmed or depleted by demands'
  },
  6: {
    target: 'uncertainty, checking, testing, need for reliable footing',
    latent_probes: [
      'what becomes uncertain first',
      'whether certainty from others calms or provokes checking',
      'how they restore footing'
    ],
    listen_for: [
      { signal: 'future-oriented scanning', threat: 'uncertainty_footing', move: 'scan_prepare', cost: 'worry_for_preparedness' },
      { signal: 'testing before trust', threat: 'uncertainty_footing', move: 'scan_prepare', cost: 'worry_for_preparedness' },
      { signal: 'worry mixed with loyalty', threat: 'uncertainty_footing', move: 'scan_prepare', cost: 'worry_for_preparedness' }
    ],
    splitters: ['1v6', '6v9', '6v7'],
    killer_probe: 'what they check for even when things look fine',
    stress_arrow: 'under stress becomes rigid and controlling like unhealthy 3',
    core_avoidance: 'being without support or guidance'
  },
  7: {
    target: 'escape from pain through options, movement, reframing',
    latent_probes: [
      'what kind of heaviness they flee fastest',
      'whether possibility is used as pain relief',
      'what commitment starts to feel enclosing'
    ],
    listen_for: [
      { signal: 'movement away from pain', threat: 'constraint_pain', move: 'open_options', cost: 'scatter_for_freedom' },
      { signal: 'reframing as defense', threat: 'constraint_pain', move: 'open_options', cost: 'scatter_for_freedom' },
      { signal: 'option-opening under strain', threat: 'constraint_pain', move: 'open_options', cost: 'scatter_for_freedom' }
    ],
    splitters: ['7v9', '5v7', '3v7'],
    killer_probe: 'what kind of pain they move away from fastest',
    stress_arrow: 'under stress becomes critical and perfectionistic like unhealthy 1',
    core_avoidance: 'being trapped in pain or deprivation'
  },
  8: {
    target: 'immediate force, resistance to control, hardness over softer hurt',
    latent_probes: [
      'what happens in the body when a line is crossed',
      'whether hurt becomes force',
      'what they refuse to be under'
    ],
    listen_for: [
      { signal: 'fast anger access', threat: 'control_vulnerability', move: 'push_back', cost: 'conflict_for_autonomy' },
      { signal: 'instinct before reflection', threat: 'control_vulnerability', move: 'push_back', cost: 'conflict_for_autonomy' },
      { signal: 'hardness over exposure', threat: 'control_vulnerability', move: 'push_back', cost: 'conflict_for_autonomy' }
    ],
    splitters: ['1v8', '6v8', '2v8'],
    killer_probe: 'what they refuse to let anyone have over them',
    stress_arrow: 'under stress becomes secretive and withdrawn like unhealthy 5',
    core_avoidance: 'being controlled or vulnerable'
  },
  9: {
    target: 'self-forgetting, comfort as anesthesia, loss of own position',
    latent_probes: [
      'what disappears under tension',
      'whether life loudness produces haze or clarity',
      'what they settle into to reduce pressure'
    ],
    listen_for: [
      { signal: 'softening rather than sharpening', threat: 'peace_disruption', move: 'settle_numb', cost: 'self_erasure_for_peace' },
      { signal: 'merging and drifting', threat: 'peace_disruption', move: 'settle_numb', cost: 'self_erasure_for_peace' },
      { signal: 'loss of own priority', threat: 'peace_disruption', move: 'settle_numb', cost: 'self_erasure_for_peace' }
    ],
    splitters: ['5v9', '7v9', '2v9'],
    killer_probe: 'what they lose track of in themselves when things get tense',
    stress_arrow: 'under stress becomes anxious and suspicious like unhealthy 6',
    core_avoidance: 'conflict and disconnection from others'
  }
};

// ─── Triad / Center Data ────────────────────────────────────────────

const TRIADS = {
  gut: [8, 9, 1],
  heart: [2, 3, 4],
  head: [5, 6, 7]
};

const HORNEVIAN = {
  assertive: [3, 7, 8],
  compliant: [1, 2, 6],
  withdrawn: [4, 5, 9]
};

const HARMONIC = {
  positive_outlook: [2, 7, 9],
  competency: [1, 3, 5],
  reactive: [4, 6, 8]
};

// ─── State Creation ─────────────────────────────────────────────────

function createState(sessionId, name) {
  const posterior = {};
  TYPES.forEach(t => { posterior[t] = 11.1; }); // flat start

  return {
    session_id: sessionId,
    name: name,
    question_number: 0,
    phase: 'broad_discrimination',
    budget_total: 25,
    budget_remaining: 25,

    // Type posterior (percentages, sum to ~100)
    posterior,

    // Pattern inference
    threat_pattern: null,
    move_pattern: null,
    repeated_cost_pattern: null,
    repeated_cost_candidates: [],

    // Pair tracking
    target_pair: null,
    target_splitter: null,
    target_pair_questions: 0,
    pair_resolved: false,

    // Wing
    likely_wing: null,
    wing_confidence: 0,

    // Guards
    late_confirmation_failed: false,
    repair_mode: false,

    // Coverage tracking
    types_tested: [],
    type_signal_counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 },
    pairs_tested: [],
    pair_question_counts: {},
    domains_used: [],
    same_type_family_streak: 0,
    last_type_family: null,

    // Question history
    question_history: [],

    // Rephrase tracking
    rephrase_due_at: null,
    rephrase_targets: [],
    next_rephrase_question: 15, // first rephrase around Q15

    // Derived (recomputed each turn)
    top_type: null,
    top_type_confidence: 0,
    second_type: null,
    top_two_gap: 0,
    untested_types_count: 9
  };
}

// ─── Phase Logic ────────────────────────────────────────────────────

function updatePhase(state) {
  const q = state.question_number;

  if (q <= 12) {
    // Broad discrimination until untested types are low enough, then pair work
    if (state.untested_types_count <= 3 && q >= 8) {
      state.phase = 'pair_work';
    } else {
      state.phase = 'broad_discrimination';
    }
  } else if (q <= 19) {
    state.phase = 'pair_work';
  } else if (q <= 23) {
    state.phase = 'repair';
  } else {
    state.phase = 'approval';
  }

  // Override: repair mode takes priority
  if (state.repair_mode && q > 10) {
    state.phase = 'repair';
  }

  return state.phase;
}

// ─── Derived Stats ──────────────────────────────────────────────────

function recomputeDerived(state) {
  const sorted = TYPES
    .map(t => ({ type: t, prob: state.posterior[t] }))
    .sort((a, b) => b.prob - a.prob);

  state.top_type = sorted[0].type;
  state.top_type_confidence = sorted[0].prob;
  state.second_type = sorted[1].type;
  state.top_two_gap = sorted[0].prob - sorted[1].prob;

  // Untested = types at or below initial flat value that haven't been directly targeted
  state.untested_types_count = TYPES.filter(t =>
    !state.types_tested.includes(t) && state.posterior[t] <= 15
  ).length;

  return state;
}

// ─── Calibration ────────────────────────────────────────────────────

function applyCalibration(state, calibrationAnswers) {
  // Calibration is no longer used for behavioral signals (dropped).
  // Just advance the question number past static questions.
  state.question_number = 5;
  state.budget_remaining = 20;
  recomputeDerived(state);
  return state;
}

// ─── Deterministic Score Update (from answer) ──────────────────────

const BOOST_AMOUNT = 6;  // how much to raise favored types per answer
const LOWER_AMOUNT = 3;  // how much to lower unfavored types per answer

function applyAnswerToScores(state, pick) {
  const lastQ = state.question_history[state.question_history.length - 1];
  if (!lastQ) return;

  const favored = pick === 'a' ? lastQ.predicted_signal_a : lastQ.predicted_signal_b;
  const unfavored = pick === 'a' ? lastQ.predicted_signal_b : lastQ.predicted_signal_a;

  // Handle both array [1,6] and weighted object {1: 1.0, 6: 0.4} formats
  // Cap total weight per option to prevent broad cuts from overwhelming pair questions
  const MAX_TOTAL_WEIGHT = 2.0;

  function applySignals(signals, baseAmount) {
    if (!signals) return;
    if (Array.isArray(signals)) {
      // Legacy array format: weight 1.0 for each type, apply cap
      const count = signals.length;
      const totalWeight = count; // each is 1.0
      const scale = totalWeight > MAX_TOTAL_WEIGHT ? MAX_TOTAL_WEIGHT / totalWeight : 1;
      for (const type of signals) {
        const t = parseInt(type);
        const adj = baseAmount * scale;
        state.posterior[t] = adj > 0
          ? Math.min(99, state.posterior[t] + adj)
          : Math.max(0, state.posterior[t] + adj);
        if (!state.types_tested.includes(t)) state.types_tested.push(t);
      }
    } else if (typeof signals === 'object') {
      // Weighted object format: {type: weight}
      const entries = Object.entries(signals);
      const totalWeight = entries.reduce((s, [, w]) => s + w, 0);
      const scale = totalWeight > MAX_TOTAL_WEIGHT ? MAX_TOTAL_WEIGHT / totalWeight : 1;
      for (const [type, weight] of entries) {
        const t = parseInt(type);
        const adj = baseAmount * weight * scale;
        state.posterior[t] = adj > 0
          ? Math.min(99, state.posterior[t] + adj)
          : Math.max(0, state.posterior[t] + adj);
        if (!state.types_tested.includes(t)) state.types_tested.push(t);
      }
    }
  }

  applySignals(favored, BOOST_AMOUNT);
  applySignals(unfavored, -LOWER_AMOUNT);

  // Track how many times each type has been touched by any signal
  function countSignalTouches(signals) {
    if (!signals) return;
    const entries = Array.isArray(signals) ? signals.map(t => [t, 1]) : Object.entries(signals);
    for (const [type] of entries) {
      const t = parseInt(type);
      if (state.type_signal_counts[t] !== undefined) {
        state.type_signal_counts[t]++;
      }
    }
  }
  countSignalTouches(favored);
  countSignalTouches(unfavored);

  // Normalize, enforce floor, recompute
  normalizePosterior(state);
  enforceFloor(state);
  recomputeDerived(state);
}

// ─── Router Update (patterns only, NOT type scores) ─────────────────

function applyRouterUpdate(state, update) {
  // Router is NO LONGER allowed to move type probabilities.
  // Type scores are moved deterministically by applyAnswerToScores.

  // Apply pattern inference
  if (update.threat_pattern) state.threat_pattern = update.threat_pattern;
  if (update.move_pattern) state.move_pattern = update.move_pattern;
  if (update.repeated_cost_pattern) {
    state.repeated_cost_pattern = update.repeated_cost_pattern;
    if (!state.repeated_cost_candidates.includes(update.repeated_cost_pattern)) {
      state.repeated_cost_candidates.push(update.repeated_cost_pattern);
    }
  }

  // Wing updates — validate wing is adjacent to top type
  if (update.likely_wing !== undefined && update.likely_wing !== null) {
    const topType = state.top_type;
    if (topType) {
      const wg = WING_GUIDE[topType];
      const validWings = wg ? [wg.low.wing, wg.high.wing] : [];
      if (validWings.includes(update.likely_wing)) {
        state.likely_wing = update.likely_wing;
      }
      // else: ignore invalid wing from LLM
    }
  }
  if (update.wing_confidence !== undefined) state.wing_confidence = update.wing_confidence;

  // Normalize posterior to sum to 100
  normalizePosterior(state);

  // Enforce floor rule
  enforceFloor(state);

  // Check cost-pattern conflict
  checkCostConflict(state);

  // Recompute derived
  recomputeDerived(state);

  return state;
}

function normalizePosterior(state) {
  const sum = TYPES.reduce((s, t) => s + state.posterior[t], 0);
  if (sum <= 0) return;
  const scale = 100 / sum;
  TYPES.forEach(t => {
    state.posterior[t] = Math.round(state.posterior[t] * scale * 10) / 10;
  });
}

function enforceFloor(state) {
  if (state.question_number >= 15) return; // floor active through mid-game

  const FLOOR = 2;
  let deficit = 0;
  let aboveFloor = [];

  TYPES.forEach(t => {
    if (state.posterior[t] < FLOOR) {
      deficit += FLOOR - state.posterior[t];
      state.posterior[t] = FLOOR;
    } else {
      aboveFloor.push(t);
    }
  });

  if (deficit > 0 && aboveFloor.length > 0) {
    // Proportionally reduce types above floor
    const totalAbove = aboveFloor.reduce((s, t) => s + state.posterior[t] - FLOOR, 0);
    if (totalAbove > 0) {
      aboveFloor.forEach(t => {
        const share = (state.posterior[t] - FLOOR) / totalAbove;
        state.posterior[t] -= deficit * share;
        state.posterior[t] = Math.max(FLOOR, Math.round(state.posterior[t] * 10) / 10);
      });
    }
  }
}

// ─── Contradiction Checking ─────────────────────────────────────────

function updateContradictions(state) {
  // No-op: behavioral signal contradiction detection has been removed.
  // Behavioral signals were dropped because calibration was removed
  // and they created false contradictions.
}

// ─── Cost-Pattern Conflict ──────────────────────────────────────────

function checkCostConflict(state) {
  if (!state.repeated_cost_pattern) return;

  const costType = COST_TO_TYPE[state.repeated_cost_pattern];
  if (!costType) return;

  const topType = state.top_type;
  if (topType && costType !== topType) {
    // Cost pattern conflicts with posterior — trigger repair
    state.repair_mode = true;
    // Raise the cost-consistent type
    if (state.posterior[costType] < state.posterior[topType]) {
      const boost = Math.min(10, state.posterior[topType] - state.posterior[costType]);
      state.posterior[costType] += boost / 2;
      // Find the best splitter for costType vs topType
      const pairKey = [Math.min(costType, topType), Math.max(costType, topType)].join('v');
      if (PAIR_AXES[pairKey]) {
        state.target_pair = `${costType}v${topType}`;
        state.target_splitter = PAIR_AXES[pairKey].splitter;
        state.target_pair_questions = 0;
        state.pair_resolved = false;
      }
    }
  }
}

// ─── Done Gates ─────────────────────────────────────────────────────

function checkDoneGates(state) {
  const failures = [];

  // Gate 1: type confidence (top type probability)
  if (state.top_type_confidence < 55)
    failures.push({ gate: 'type_confidence', msg: `top type at ${state.top_type_confidence}%, needs >= 55` });

  // Gate 2: gap between top 2
  if (state.top_two_gap < 25)
    failures.push({ gate: 'top_two_gap', msg: `gap is ${state.top_two_gap}%, needs >= 25` });

  // Gate 3: wing confidence
  if (state.wing_confidence < 60)
    failures.push({ gate: 'wing_confidence', msg: `wing confidence at ${state.wing_confidence}%, needs >= 60` });

  // Gate 4: (removed — no calibration phase)

  // Gate 5: (removed — behavioral contradiction detection dropped)

  // Gate 6: if lookalike pair was active, must be resolved
  if (state.target_pair && !state.pair_resolved && state.target_pair_questions < 2)
    failures.push({ gate: 'pair_unresolved', msg: `pair ${state.target_pair} not resolved (${state.target_pair_questions} questions)` });

  // Gate 7: minimum questions
  if (state.question_number < 15)
    failures.push({ gate: 'min_questions', msg: `only ${state.question_number} questions, minimum 15` });

  // Gate 9: same-triad pairs must be tested
  const requiredTriadPairs = getRequiredTriadPairs(state);
  if (requiredTriadPairs.length > 0)
    failures.push({ gate: 'triad_pairs', msg: `untested same-triad pairs: ${requiredTriadPairs.map(p => p.pair).join(', ')}` });

  // Gate 8: cost pattern conflict
  if (state.repair_mode && state.repeated_cost_pattern) {
    const costType = COST_TO_TYPE[state.repeated_cost_pattern];
    if (costType && costType !== state.top_type) {
      failures.push({ gate: 'cost_conflict', msg: `cost pattern ${state.repeated_cost_pattern} suggests type ${costType}, not ${state.top_type}` });
    }
  }

  return failures;
}

// ─── Routing Helpers ────────────────────────────────────────────────

const PAIR_CAP = 3; // max questions per pair

function getRoutingConstraints(state) {
  const constraints = {
    phase: state.phase,
    question_number: state.question_number,
    budget_remaining: state.budget_remaining,
    must_avoid_domains: [],
    rephrase_required: false,
    tunnel_blocked: false,
    capped_pairs: [],
    inconsistent_pairs: []
  };

  // Avoid domain repetition (last 2 questions)
  const recentDomains = state.question_history.slice(-2).map(q => q.domain).filter(Boolean);
  constraints.must_avoid_domains = recentDomains;

  // Tunnel prevention: can't ask same type family twice in a row
  if (state.same_type_family_streak >= 2) {
    constraints.tunnel_blocked = true;
  }

  // Rephrase scheduling
  if (state.question_number >= state.next_rephrase_question && state.rephrase_targets.length > 0) {
    constraints.rephrase_required = true;
  }

  // Anti-tunnel trigger
  if (state.untested_types_count >= 4 && state.question_number >= 6) {
    constraints.force_broad = true;
  }

  // PAIR CAP: max 3 questions per pair
  for (const [pair, count] of Object.entries(state.pair_question_counts)) {
    if (count >= PAIR_CAP) {
      constraints.capped_pairs.push(pair);
    }
  }

  // INCONSISTENCY DETECTION: if 3 questions on a pair with mixed results, flag it
  for (const [pair, count] of Object.entries(state.pair_question_counts)) {
    if (count >= PAIR_CAP) {
      const pairQs = state.question_history.filter(q => {
        if (!q.pair || !q.picked) return false;
        return getPairKey(...q.pair.split('v').map(Number)) === pair;
      });
      const pickedA = pairQs.filter(q => q.picked === 'a').length;
      const pickedB = pairQs.filter(q => q.picked === 'b').length;
      if (Math.min(pickedA, pickedB) >= 1) {
        constraints.inconsistent_pairs.push({ pair, split: `${pickedA}-${pickedB}` });
      }
    }
  }

  // Triad pair forcing — after Q6, if same-triad types haven't been pair-tested, force them
  if (state.question_number >= 6 && !constraints.force_broad) {
    const requiredTriadPairs = getRequiredTriadPairs(state);
    if (requiredTriadPairs.length > 0) {
      // Pick the most urgent: highest posterior peer first
      const sorted = requiredTriadPairs.sort((a, b) => state.posterior[b.peer] - state.posterior[a.peer]);
      constraints.force_triad_pair = sorted[0];
    }
  }

  return constraints;
}

function getUntestedTypes(state) {
  return TYPES.filter(t => !state.types_tested.includes(t));
}

function getTopPair(state) {
  const sorted = TYPES
    .map(t => ({ type: t, prob: state.posterior[t] }))
    .sort((a, b) => b.prob - a.prob);
  return [sorted[0].type, sorted[1].type];
}

function getPairKey(a, b) {
  return `${Math.min(a, b)}v${Math.max(a, b)}`;
}

function isLookalikePair(a, b) {
  const key = getPairKey(a, b);
  return !!PAIR_AXES[key];
}

// ─── Triad-Aware Routing ─────────────────────────────────────────────
// Types in the same triad often share identical behavioral profiles.
// The engine must force pair-test same-triad competitors.

function getTriadFor(type) {
  for (const [name, members] of Object.entries(TRIADS)) {
    if (members.includes(type)) return { name, members };
  }
  return null;
}

function getTriadPeers(type) {
  const triad = getTriadFor(type);
  if (!triad) return [];
  return triad.members.filter(t => t !== type);
}

// Returns pairs that MUST be tested before the engine can close.
// Same-triad types with posterior > 2% that haven't been pair-tested.
function getRequiredTriadPairs(state) {
  const topType = state.top_type;
  if (!topType) return [];

  const peers = getTriadPeers(topType);
  const required = [];

  for (const peer of peers) {
    // Skip if already eliminated
    if (state.posterior[peer] < 2) continue;

    const pairKey = getPairKey(topType, peer);
    // Check if this pair has been tested at least twice
    const pairQuestions = state.question_history.filter(q => {
      if (!q.pair) return false;
      const normalizedPair = getPairKey(...q.pair.split('v').map(Number));
      return normalizedPair === pairKey;
    }).length;

    if (pairQuestions < 2) {
      required.push({
        pair: pairKey,
        peer,
        questions_asked: pairQuestions,
        splitter: PAIR_AXES[pairKey]?.splitter || null
      });
    }
  }

  return required;
}

// ─── Pair Signal Override ────────────────────────────────────────────
// Never trust the LLM's predicted_signal_a/b for pair questions.
// For pair "XvY", option A always signals [X], option B always signals [Y].

function derivePairSignals(pair) {
  if (!pair) return null;
  const match = pair.match(/^(\d)v(\d)$/);
  if (!match) return null;
  const typeA = parseInt(match[1]);
  const typeB = parseInt(match[2]);
  if (!PAIR_AXES[pair]) return null;
  return { signal_a: { [typeA]: 1.0 }, signal_b: { [typeB]: 1.0 } };
}

// ─── Record Question ────────────────────────────────────────────────

function recordQuestion(state, questionData) {
  state.question_number++;
  state.budget_remaining--;

  // For pair questions, ensure primary pair types are at weight 1.0
  // but merge in writer's secondary type signals
  const pairSignals = derivePairSignals(questionData.pair);
  let signal_a, signal_b;

  if (pairSignals) {
    // Start with pair primary signals
    signal_a = { ...pairSignals.signal_a };
    signal_b = { ...pairSignals.signal_b };

    // Merge writer's secondary signals (don't override primary pair types)
    const writerA = questionData.predicted_signal_a || {};
    const writerB = questionData.predicted_signal_b || {};

    if (typeof writerA === 'object' && !Array.isArray(writerA)) {
      for (const [type, weight] of Object.entries(writerA)) {
        if (!(type in signal_a)) signal_a[type] = weight;
      }
    }
    if (typeof writerB === 'object' && !Array.isArray(writerB)) {
      for (const [type, weight] of Object.entries(writerB)) {
        if (!(type in signal_b)) signal_b[type] = weight;
      }
    }
  } else {
    // Non-pair question (broad cut) — use writer's signals directly
    signal_a = questionData.predicted_signal_a || {};
    signal_b = questionData.predicted_signal_b || {};
  }

  state.question_history.push({
    question_number: state.question_number,
    pair: questionData.pair || null,
    splitter: questionData.splitter || null,
    domain: questionData.domain || null,
    option_a: questionData.option_a,
    option_b: questionData.option_b,
    predicted_signal_a: signal_a,
    predicted_signal_b: signal_b,
    picked: null,
    answer_text: null
  });

  // Track pair coverage
  if (questionData.pair) {
    if (!state.pairs_tested.includes(questionData.pair)) {
      state.pairs_tested.push(questionData.pair);
    }
    // Track per-pair question counts
    const normalizedPair = getPairKey(...questionData.pair.split('v').map(Number));
    state.pair_question_counts[normalizedPair] = (state.pair_question_counts[normalizedPair] || 0) + 1;
  }

  // Track domain usage
  if (questionData.domain) {
    state.domains_used.push(questionData.domain);
  }

  // Track target pair questions
  if (state.target_pair && questionData.pair === state.target_pair) {
    state.target_pair_questions++;
    if (state.target_pair_questions >= 2) {
      state.pair_resolved = true;
    }
  }

  // Tunnel tracking
  if (questionData.type_family) {
    if (questionData.type_family === state.last_type_family) {
      state.same_type_family_streak++;
    } else {
      state.same_type_family_streak = 1;
    }
    state.last_type_family = questionData.type_family;
  }

  updatePhase(state);
  return state;
}

function recordAnswer(state, pick) {
  const lastQ = state.question_history[state.question_history.length - 1];
  if (lastQ) {
    lastQ.picked = pick;
    lastQ.answer_text = pick === 'a' ? lastQ.option_a : lastQ.option_b;

    // Schedule rephrase if this was a structural fork
    if (lastQ.pair && state.rephrase_targets.length < 4) {
      state.rephrase_targets.push({
        original_question: state.question_number,
        pair: lastQ.pair,
        splitter: lastQ.splitter,
        domain: lastQ.domain,
        original_pick: pick
      });
      // Schedule next rephrase
      if (!state.rephrase_due_at || state.question_number + 6 < state.rephrase_due_at) {
        state.next_rephrase_question = Math.min(state.next_rephrase_question, state.question_number + 6);
      }
    }
  }
  return state;
}

// ─── Item Checker (Rules-Based) ─────────────────────────────────────

const WARMTH_WORDS = ['care', 'caring', 'love', 'loving', 'kind', 'gentle', 'warm', 'compassion', 'generous', 'giving', 'nurture', 'support'];
const COLD_WORDS = ['cold', 'harsh', 'detached', 'distant', 'withdrawn', 'selfish', 'alone', 'isolated'];

function checkCandidate(candidate, state) {
  const issues = [];
  const a = candidate.a || '';
  const b = candidate.b || '';

  // Word count check (8-16 words per option)
  const aWords = a.split(/\s+/).length;
  const bWords = b.split(/\s+/).length;
  if (aWords < 5 || aWords > 20) issues.push(`option_a has ${aWords} words`);
  if (bWords < 5 || bWords > 20) issues.push(`option_b has ${bWords} words`);

  // Length balance (difference < 50%)
  const diff = Math.abs(aWords - bWords);
  const avg = (aWords + bWords) / 2;
  if (diff / avg > 0.5) issues.push('word count imbalance');

  // Warmth/cold loading
  const aWarm = WARMTH_WORDS.filter(w => a.toLowerCase().includes(w)).length;
  const bWarm = WARMTH_WORDS.filter(w => b.toLowerCase().includes(w)).length;
  const aCold = COLD_WORDS.filter(w => a.toLowerCase().includes(w)).length;
  const bCold = COLD_WORDS.filter(w => b.toLowerCase().includes(w)).length;
  if (Math.abs(aWarm - bWarm) >= 2) issues.push('warmth loading imbalance');
  if (Math.abs(aCold - bCold) >= 2) issues.push('coldness loading imbalance');
  if (aWarm >= 2 && bCold >= 1) issues.push('option_a warm vs option_b cold');
  if (bWarm >= 2 && aCold >= 1) issues.push('option_b warm vs option_a cold');

  // Duplicate structure check (against last 3 questions)
  const recent = state.question_history.slice(-3);
  for (const q of recent) {
    if (q.option_a && (
      similarity(a, q.option_a) > 0.6 ||
      similarity(b, q.option_b) > 0.6 ||
      similarity(a, q.option_b) > 0.6 ||
      similarity(b, q.option_a) > 0.6
    )) {
      issues.push('too similar to recent question');
      break;
    }
  }

  // Commas/dashes check
  if (a.includes(',') || a.includes(' - ') || b.includes(',') || b.includes(' - ')) {
    issues.push('contains commas or dashes');
  }

  return { valid: issues.length === 0, issues, score: 10 - issues.length };
}

function similarity(a, b) {
  // Simple word overlap similarity
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

function selectBestCandidate(candidates, state) {
  const scored = candidates.map((c, i) => {
    const check = checkCandidate(c, state);
    return { index: i, candidate: c, ...check };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return best (or least-bad)
  return scored[0];
}

// ─── Build State Summary for Router ─────────────────────────────────

function buildStateSummary(state) {
  const sorted = TYPES
    .map(t => ({ type: t, prob: state.posterior[t] }))
    .sort((a, b) => b.prob - a.prob);

  return {
    question_number: state.question_number,
    phase: state.phase,
    budget_remaining: state.budget_remaining,
    posterior: sorted.map(t => `${t.type}:${Math.round(t.prob)}%`).join(' '),
    top_type: state.top_type,
    second_type: state.second_type,
    top_two_gap: Math.round(state.top_two_gap),
    untested_types: getUntestedTypes(state),
    neglected_types: TYPES.filter(t => state.type_signal_counts[t] <= 1),
    type_signal_counts: state.type_signal_counts,
    threat_pattern: state.threat_pattern,
    move_pattern: state.move_pattern,
    repeated_cost_pattern: state.repeated_cost_pattern,
    target_pair: state.target_pair,
    target_splitter: state.target_splitter,
    target_pair_questions: state.target_pair_questions,
    pair_resolved: state.pair_resolved,
    likely_wing: state.likely_wing,
    wing_confidence: state.wing_confidence,
    repair_mode: state.repair_mode,
    recent_questions: state.question_history.slice(-3).map(q => ({
      pair: q.pair,
      domain: q.domain,
      picked: q.picked
    })),
    pairs_tested: state.pairs_tested,
    pair_question_counts: state.pair_question_counts,
    capped_pairs: Object.entries(state.pair_question_counts).filter(([,c]) => c >= PAIR_CAP).map(([p]) => p),
    domains_used_recently: state.domains_used.slice(-3),
    same_type_family_streak: state.same_type_family_streak,
    required_triad_pairs: getRequiredTriadPairs(state),
    done_gates: checkDoneGates(state)
  };
}

// ─── EIG (Expected Information Gain) Question Selector ──────────────

function entropy(posterior) {
  let h = 0;
  for (const t of TYPES) {
    const p = posterior[t] / 100;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function simulatePick(posterior, signals, boost, lower) {
  // Clone posterior
  const sim = {};
  for (const t of TYPES) sim[t] = posterior[t];

  // Apply favored signals
  const favoredEntries = typeof signals.favored === 'object' && !Array.isArray(signals.favored)
    ? Object.entries(signals.favored) : [];
  const unfavoredEntries = typeof signals.unfavored === 'object' && !Array.isArray(signals.unfavored)
    ? Object.entries(signals.unfavored) : [];

  // Cap total weight
  const MAX_W = 2.0;
  const totalFavored = favoredEntries.reduce((s, [, w]) => s + w, 0);
  const scaleFavored = totalFavored > MAX_W ? MAX_W / totalFavored : 1;
  const totalUnfavored = unfavoredEntries.reduce((s, [, w]) => s + w, 0);
  const scaleUnfavored = totalUnfavored > MAX_W ? MAX_W / totalUnfavored : 1;

  for (const [type, weight] of favoredEntries) {
    const t = parseInt(type);
    sim[t] = Math.min(99, sim[t] + boost * weight * scaleFavored);
  }
  for (const [type, weight] of unfavoredEntries) {
    const t = parseInt(type);
    sim[t] = Math.max(0, sim[t] - lower * weight * scaleUnfavored);
  }

  // Normalize
  const total = TYPES.reduce((s, t) => s + sim[t], 0);
  if (total > 0) {
    for (const t of TYPES) sim[t] = (sim[t] / total) * 100;
  }

  return sim;
}

function calcEIG(candidate, posterior) {
  const currentEntropy = entropy(posterior);

  // Simulate picking A
  const postA = simulatePick(posterior, {
    favored: candidate.predicted_signal_a,
    unfavored: candidate.predicted_signal_b
  }, BOOST_AMOUNT, LOWER_AMOUNT);

  // Simulate picking B
  const postB = simulatePick(posterior, {
    favored: candidate.predicted_signal_b,
    unfavored: candidate.predicted_signal_a
  }, BOOST_AMOUNT, LOWER_AMOUNT);

  // Estimate probability of picking A vs B based on current posterior
  // Weight by how much the current posterior favors each option's types
  const signalA = candidate.predicted_signal_a || {};
  const signalB = candidate.predicted_signal_b || {};
  let weightA = 0, weightB = 0;
  for (const [type, w] of Object.entries(signalA)) {
    weightA += (posterior[parseInt(type)] / 100) * w;
  }
  for (const [type, w] of Object.entries(signalB)) {
    weightB += (posterior[parseInt(type)] / 100) * w;
  }
  const totalW = weightA + weightB;
  const pA = totalW > 0 ? weightA / totalW : 0.5;
  const pB = 1 - pA;

  const expectedEntropy = pA * entropy(postA) + pB * entropy(postB);
  return currentEntropy - expectedEntropy;
}

function selectByEIG(questionBank, state) {
  const asked = new Set(
    state.question_history.map(q => `${q.option_a}|||${q.option_b}`)
  );

  // Get capped pairs
  const cappedPairs = new Set(
    Object.entries(state.pair_question_counts)
      .filter(([, c]) => c >= PAIR_CAP)
      .map(([p]) => p)
  );

  // Get recently used domains
  const recentDomains = state.domains_used.slice(-2);

  // Score all candidates
  const scored = [];
  for (const entry of questionBank) {
    const combo = entry.combo;

    // Skip capped pairs
    if (combo.pair && cappedPairs.has(combo.pair)) continue;

    for (const candidate of entry.candidates) {
      // Skip already asked
      const key = `${candidate.a}|||${candidate.b}`;
      if (asked.has(key)) continue;

      // Calculate EIG
      let eig = calcEIG(candidate, state.posterior);

      // Domain diversity bonus: penalize recently used domains
      if (recentDomains.includes(combo.domain)) {
        eig *= 0.8;
      }

      // Neglected type bonus: boost questions that touch neglected types
      const neglected = TYPES.filter(t => state.type_signal_counts[t] <= 1);
      if (neglected.length > 0) {
        const allSignals = { ...candidate.predicted_signal_a, ...candidate.predicted_signal_b };
        const touchesNeglected = neglected.some(t => allSignals[t] !== undefined);
        if (touchesNeglected) eig *= 1.3;
      }

      // Wing question bonus: if we have a clear leader but no wing
      if (state.top_two_gap > 20 && state.wing_confidence < 60 && combo.type === 'wing') {
        eig *= 1.5;
      }

      scored.push({
        candidate,
        combo,
        eig
      });
    }
  }

  // Sort by EIG descending
  scored.sort((a, b) => b.eig - a.eig);

  return scored[0] || null;
}

module.exports = {
  TYPES,
  TYPE_PROFILES,
  COST_MAP,
  COST_TO_TYPE,
  THREAT_MAP,
  MOVE_MAP,
  PAIR_AXES,
  WING_GUIDE,
  PROBE_GUIDE,
  TRIADS,
  HORNEVIAN,
  HARMONIC,
  createState,
  updatePhase,
  recomputeDerived,
  applyCalibration,
  applyAnswerToScores,
  applyRouterUpdate,
  normalizePosterior,
  enforceFloor,
  updateContradictions,
  checkCostConflict,
  checkDoneGates,
  getRoutingConstraints,
  getUntestedTypes,
  getTopPair,
  getPairKey,
  isLookalikePair,
  derivePairSignals,
  getTriadFor,
  getTriadPeers,
  getRequiredTriadPairs,
  recordQuestion,
  recordAnswer,
  checkCandidate,
  selectBestCandidate,
  buildStateSummary,
  calcEIG,
  selectByEIG
};
