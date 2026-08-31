(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NorthStarCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CATEGORIES = ["AI & Data", "Fintech & Crypto", "SaaS & Enterprise", "Consumer & Commerce", "Deep Tech & Climate", "Builders & Breakthroughs"];

  function hashSeed(value) {
    let h = 2166136261;
    for (const char of String(value)) {
      h ^= char.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0 || 1;
  }

  function randomFrom(seed) {
    let state = hashSeed(seed);
    return function () {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4294967296;
    };
  }

  function shuffle(items, seed) {
    const result = items.slice();
    const random = randomFrom(seed);
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  function buildDecks(questions, seed) {
    const decks = { Mixed: shuffle(questions.map((q) => q.id), seed + ":Mixed") };
    CATEGORIES.forEach((category) => {
      decks[category] = shuffle(questions.filter((q) => q.category === category).map((q) => q.id), seed + ":" + category);
    });
    return decks;
  }

  function createState(questions, config) {
    const seed = String(config.seed || Date.now());
    return {
      version: 1,
      mode: config.mode || "quick",
      seed,
      teams: (config.teams || ["Solo"]).map((name) => ({ name: String(name).trim(), score: 0 })),
      target: Number(config.target || 5),
      timer: Number(config.timer || 0),
      turn: 0,
      round: 1,
      questionId: null,
      category: null,
      selected: null,
      revealed: false,
      expired: false,
      winner: null,
      decks: buildDecks(questions, seed),
      positions: Object.fromEntries(["Mixed"].concat(CATEGORIES).map((key) => [key, 0]))
    };
  }

  function nextQuestion(state, questions, requestedCategory) {
    const category = requestedCategory && requestedCategory !== "Random" ? requestedCategory : "Mixed";
    const deck = state.decks[category];
    if (!deck || !deck.length) throw new Error("Unknown or empty category: " + category);
    let position = state.positions[category] || 0;
    if (position >= deck.length) {
      const cycle = Math.floor(position / deck.length);
      state.decks[category] = shuffle(deck, state.seed + ":" + category + ":" + cycle);
      position = 0;
    }
    state.questionId = state.decks[category][position];
    state.positions[category] = position + 1;
    state.category = questions.find((q) => q.id === state.questionId).category;
    state.selected = null;
    state.revealed = false;
    state.expired = false;
    return state.questionId;
  }

  function selectAnswer(state, index) {
    if (state.revealed) return false;
    state.selected = Number(index);
    return true;
  }

  function submitAnswer(state, questions, expired) {
    if (state.revealed) return null;
    const question = questions.find((q) => q.id === state.questionId);
    if (!question) throw new Error("Question not found");
    state.expired = Boolean(expired);
    state.revealed = true;
    const correct = !state.expired && state.selected === question.answer;
    if (correct && state.mode === "team") {
      state.teams[state.turn].score += 1;
      if (state.teams[state.turn].score >= state.target) state.winner = state.turn;
    }
    return correct;
  }

  function advanceTurn(state) {
    if (state.winner !== null) return false;
    if (state.mode === "team") {
      state.turn = (state.turn + 1) % state.teams.length;
      if (state.turn === 0) state.round += 1;
    } else {
      state.round += 1;
    }
    state.questionId = null;
    state.selected = null;
    state.revealed = false;
    return true;
  }

  function restore(raw, questions) {
    try {
      const state = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!state || state.version !== 1 || !Array.isArray(state.teams) || !state.decks) return null;
      if (state.questionId && !questions.some((q) => q.id === state.questionId)) return null;
      return state;
    } catch (_) {
      return null;
    }
  }

  return { CATEGORIES, hashSeed, shuffle, createState, nextQuestion, selectAnswer, submitAnswer, advanceTurn, restore };
});
