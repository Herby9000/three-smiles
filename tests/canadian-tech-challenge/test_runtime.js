"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const APP_ROOT = path.join(__dirname, "../../public-projects/canadian-tech-challenge");
const Core = require(path.join(APP_ROOT, "assets/core.js"));
const questions = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "data/questions.json"), "utf8"));

function testDeterministicShuffleAndExhaustion() {
  assert.deepEqual(Core.shuffle([1, 2, 3, 4], "north"), Core.shuffle([1, 2, 3, 4], "north"));
  const state = Core.createState(questions, { mode: "quick", seed: "fixed" });
  const seen = new Set();
  for (let i = 0; i < questions.length; i += 1) seen.add(Core.nextQuestion(state, questions, "Random"));
  assert.equal(seen.size, questions.length, "mixed deck repeats before exhaustion");
  assert.ok(Core.nextQuestion(state, questions, "Random"), "deck starts a new deterministic cycle");
}

function testTeamSetupAnswerScoringAndRotation() {
  const state = Core.createState(questions, { mode: "team", teams: ["Aurora", "Maple"], target: 2, timer: 45, seed: "teams" });
  Core.nextQuestion(state, questions, "AI & Data");
  const question = questions.find((item) => item.id === state.questionId);
  Core.selectAnswer(state, (question.answer + 1) % 4);
  assert.equal(state.revealed, false, "selection must not reveal correctness");
  assert.equal(Core.submitAnswer(state, questions, false), false);
  assert.equal(state.teams[0].score, 0);
  Core.advanceTurn(state);
  assert.equal(state.turn, 1);
  Core.nextQuestion(state, questions, "Fintech & Crypto");
  const next = questions.find((item) => item.id === state.questionId);
  Core.selectAnswer(state, next.answer);
  assert.equal(Core.submitAnswer(state, questions, false), true);
  assert.equal(state.teams[1].score, 1);
  Core.advanceTurn(state);
  assert.equal(state.turn, 0);
  assert.equal(state.round, 2);
}

function testTimerDisabledAndExpiration() {
  const disabled = Core.createState(questions, { mode: "team", teams: ["A", "B"], timer: 0, seed: "off" });
  assert.equal(disabled.timer, 0);
  Core.nextQuestion(disabled, questions, "Random");
  const q = questions.find((item) => item.id === disabled.questionId);
  Core.selectAnswer(disabled, q.answer);
  assert.equal(Core.submitAnswer(disabled, questions, true), false);
  assert.equal(disabled.expired, true);
  assert.equal(disabled.teams[0].score, 0);
}

function testWinnerAndRestoration() {
  const state = Core.createState(questions, { mode: "team", teams: ["A", "B"], target: 1, seed: "win" });
  Core.nextQuestion(state, questions, "SaaS & Enterprise");
  const q = questions.find((item) => item.id === state.questionId);
  Core.selectAnswer(state, q.answer);
  Core.submitAnswer(state, questions, false);
  assert.equal(state.winner, 0);
  const restored = Core.restore(JSON.stringify(state), questions);
  assert.deepEqual(restored.teams, state.teams);
  assert.equal(restored.questionId, state.questionId);
  assert.equal(Core.restore("bad json", questions), null);
}

function testStudyAndRuntimeContracts() {
  for (const category of Core.CATEGORIES) assert.equal(questions.filter((q) => q.category === category).length, 12);
  const appSource = fs.readFileSync(path.join(APP_ROOT, "assets/app.js"), "utf8");
  new vm.Script(appSource, { filename: "app.js" });
  assert.match(appSource, /studyFilter === "All" \|\| question\.category === studyFilter/);
  assert.match(appSource, /localStorage\.getItem\(STORAGE_GAME\)/);
  assert.match(appSource, /rel=\\"noopener noreferrer\\"/);
}

[
  testDeterministicShuffleAndExhaustion,
  testTeamSetupAnswerScoringAndRotation,
  testTimerDisabledAndExpiration,
  testWinnerAndRestoration,
  testStudyAndRuntimeContracts,
].forEach((test) => test());
console.log("North Star runtime tests: 5 passed");
