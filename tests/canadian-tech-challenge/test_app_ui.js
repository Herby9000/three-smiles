"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const APP_ROOT = path.join(__dirname, "../../public-projects/canadian-tech-challenge");
const html = fs.readFileSync(path.join(APP_ROOT, "index.html"), "utf8");
const questions = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "data/questions.json"), "utf8"));
const coreSource = fs.readFileSync(path.join(APP_ROOT, "assets/core.js"), "utf8");
const appSource = fs.readFileSync(path.join(APP_ROOT, "assets/app.js"), "utf8");

function click(window, element) {
  assert.ok(element, "expected an element to click");
  element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

async function main() {
  const dom = new JSDOM(html, {
    url: "https://herbyprojects.com/projects/canadian-tech-challenge/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.scrollTo = () => {};
  window.requestAnimationFrame = (callback) => callback();
  window.fetch = async (url) => {
    assert.equal(url, "data/questions.json");
    return { ok: true, json: async () => questions };
  };
  window.eval(coreSource);
  window.eval(appSource);
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.equal(window.document.documentElement.dataset.ready, "true");

  click(window, window.document.querySelector('[data-action="quick"]'));
  assert.equal(window.document.querySelector("#question-screen").classList.contains("hidden"), false);
  assert.equal(window.document.querySelectorAll("#answers .answer").length, 4);
  assert.ok(window.localStorage.getItem("north-star-tech-game-v1"));
  click(window, window.document.querySelector("#answers .answer"));
  click(window, window.document.querySelector("#submit-answer"));
  assert.equal(window.document.querySelectorAll("#answers .correct").length, 1);
  assert.equal(window.document.querySelector("#result").classList.contains("hidden"), false);

  click(window, window.document.querySelector('[data-action="quit"]'));
  click(window, window.document.querySelector('[data-action="setup-team"]'));
  window.document.querySelector("#timer-setting").value = "0";
  window.document.querySelector("#team-form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  const frontierButton = Array.from(window.document.querySelectorAll("#category-grid .category-button"))
    .find((button) => button.textContent.includes("Frontier & Defence"));
  assert.ok(frontierButton);
  assert.ok(frontierButton.classList.contains("cat-frontier"));
  click(window, frontierButton);
  assert.equal(window.document.querySelector("#question-category").textContent, "Frontier & Defence");
  assert.ok(window.document.querySelector("#question-category").classList.contains("cat-frontier"));
  assert.equal(window.document.querySelector("#timer").textContent, "No timer");
  const persisted = JSON.parse(window.localStorage.getItem("north-star-tech-game-v1"));
  assert.equal(persisted.category, "Frontier & Defence");
  assert.equal(persisted.timer, 0);

  click(window, window.document.querySelector('[data-action="quit"]'));
  click(window, window.document.querySelector('[data-action="study"]'));
  const frontierFilter = Array.from(window.document.querySelectorAll("#study-filters .filter"))
    .find((button) => button.textContent === "Frontier & Defence");
  assert.ok(frontierFilter);
  click(window, frontierFilter);
  assert.equal(window.document.querySelector("#study-count").textContent, "46 sourced questions");
  assert.equal(window.document.querySelectorAll("#study-list .study-card").length, 46);
  const reveal = window.document.querySelector("#study-list .study-reveal");
  click(window, reveal);
  assert.equal(reveal.getAttribute("aria-expanded"), "true");
  assert.equal(window.document.querySelector("#study-list .study-answer").classList.contains("hidden"), false);
  dom.window.close();
}

main().then(() => console.log("North Star browser UI tests: 1 passed"));
