'use strict';
/*
 * The "Answers" page (/answers): every question of the game, its correct
 * answer and the explanation. Built from QUESTIONS in index.html, so it is
 * always in step with the game.
 */
const L = require('./logic');

const LETTERS = ['A', 'B', 'C', 'D'];

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function questionCard(q, n, theme) {
  const options = q.o.map((text, i) => {
    const ok = i === q.a;
    return `<li class="opt${ok ? ' is-correct' : ''}"><span class="opt-letter" aria-hidden="true">${LETTERS[i]}</span>`
      + `<span>${esc(text)}</span>${ok ? '<span class="opt-mark">✓ <span class="visually-hidden">Correct answer</span></span>' : ''}</li>`;
  }).join('');
  return `<article class="card answer-card" data-text="${esc((q.q + ' ' + q.o.join(' ') + ' ' + q.e).toLowerCase())}">
  <div class="answer-head"><span class="answer-num">#${n}</span><span class="theme-pill" style="--theme:${theme.color}">${esc(theme.name)}</span></div>
  <h3 class="answer-q">${esc(q.q)}</h3>
  <ol class="answer-options" aria-label="Options">${options}</ol>
  <div class="feedback ok answer-why"><p><strong>Answer ${LETTERS[q.a]}: ${esc(q.o[q.a])}</strong></p><p>${esc(q.e)}</p></div>
</article>`;
}

function render() {
  const themes = Object.entries(L.THEMES);
  const sections = themes.map(([key, theme]) => {
    const cards = [];
    L.QUESTIONS.forEach((q, i) => { if (q.t === key) cards.push(questionCard(q, i + 1, theme)); });
    return `<section class="answer-section" id="theme-${key}" data-theme="${key}" aria-labelledby="h-${key}">
  <h2 id="h-${key}"><span class="theme-dot" style="background:${theme.color}"></span>${esc(theme.name)} <span class="muted">(${cards.length})</span></h2>
  <div class="answer-grid">${cards.join('\n')}</div>
</section>`;
  }).join('\n');

  const chips = [`<button type="button" class="tab" data-filter="" aria-pressed="true">All (${L.QUESTIONS.length})</button>`]
    .concat(themes.map(([key, t]) => `<button type="button" class="tab" data-filter="${key}" aria-pressed="false">${esc(t.name)}</button>`))
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Answers — Duck Runner</title>
<link rel="icon" href="images/duck-runner.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="style.css">
</head>
<body class="answers-page">
<header class="app-header">
  <a class="brand" href="/" aria-label="Duck Runner: back to the game">
    <img class="logo" src="images/duck-runner.png" width="800" height="695" alt="">
  </a>
  <a class="btn btn--small btn--ghost" href="/">← Back to the game</a>
</header>
<main>
  <div class="answers-intro card">
    <h1>All questions &amp; answers</h1>
    <p class="muted">The ${L.QUESTIONS.length} questions of the game, with the right answer and why. Handy for revising before (or after) a game.</p>
    <div class="answers-tools">
      <div class="tabs" role="group" aria-label="Filter by theme">${chips}</div>
      <label class="visually-hidden" for="answers-search">Search</label>
      <input type="search" id="answers-search" class="answers-search" placeholder="Search a word…" autocomplete="off">
    </div>
    <p class="muted answers-count" id="answers-count" aria-live="polite"></p>
  </div>
${sections}
  <p class="card boot-msg answers-empty" id="answers-empty" hidden>No question matches your search.</p>
</main>
<script>
(function () {
  'use strict';
  var chips = document.querySelectorAll('[data-filter]');
  var search = document.getElementById('answers-search');
  var sections = document.querySelectorAll('.answer-section');
  var theme = '';
  function update() {
    var words = search.value.trim().toLowerCase();
    var shown = 0;
    sections.forEach(function (sec) {
      var inTheme = !theme || sec.dataset.theme === theme;
      var visible = 0;
      sec.querySelectorAll('.answer-card').forEach(function (card) {
        var ok = inTheme && (!words || card.dataset.text.indexOf(words) !== -1);
        card.hidden = !ok;
        if (ok) visible++;
      });
      sec.hidden = visible === 0;
      shown += visible;
    });
    document.getElementById('answers-count').textContent = shown + (shown === 1 ? ' question shown' : ' questions shown');
    document.getElementById('answers-empty').hidden = shown !== 0;
  }
  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      theme = chip.dataset.filter;
      chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c === chip)); });
      update();
    });
  });
  search.addEventListener('input', update);
  update();
})();
</script>
</body>
</html>
`;
}

let cached = null;
module.exports = { render: () => cached || (cached = render()) };
