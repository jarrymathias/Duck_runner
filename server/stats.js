'use strict';
/*
 * Learning stats, as pure functions (db.js fetches the rows).
 *  - themeWeights: how much to favor each theme when drawing a question for a
 *    player, from their answers over all their games (adaptive questions).
 *  - buildReport: the personal report shown at the end of a game.
 */
const L = require('./logic');

const THEMES = Object.keys(L.THEMES);
const MIN_ANSWERS_FOR_VERDICT = 2; // per theme, before calling it strong or weak

/** rows: [{ theme, answered, correct }] → { W: {answered, correct}, … } for every theme. */
function byTheme(rows) {
  const out = {};
  for (const t of THEMES) out[t] = { answered: 0, correct: 0 };
  for (const r of rows || []) {
    if (!out[r.theme]) continue;
    out[r.theme].answered += Number(r.answered) || 0;
    out[r.theme].correct += Number(r.correct) || 0;
  }
  return out;
}

/**
 * Weight = 1 + 3 × estimated error rate. The estimate starts at 50 % for a
 * theme never seen (prior of one right + one wrong), so a new player gets an
 * even mix, and a theme always answered wrong comes about 3× more often than
 * one always answered right.
 */
function themeWeights(rows) {
  const stats = byTheme(rows);
  const weights = {};
  for (const t of THEMES) {
    const { answered, correct } = stats[t];
    const errorRate = (answered - correct + 1) / (answered + 2);
    weights[t] = Math.round((1 + 3 * errorRate) * 1000) / 1000;
  }
  return weights;
}

const rate = (s) => (s.answered ? s.correct / s.answered : null);

/**
 * gameRows: this player's answers in this game, in order
 *   [{ question_id, theme, correct, timed_out, choice }]
 * overallRows: [{ theme, answered, correct }] over all their games.
 */
function buildReport(gameRows, overallRows) {
  const game = byTheme(gameRows.map((r) => ({ theme: r.theme, answered: 1, correct: r.correct ? 1 : 0 })));
  const overall = byTheme(overallRows);
  const themes = THEMES.map((t) => ({
    theme: t,
    name: L.THEMES[t].name,
    game: game[t],
    overall: Object.assign({ rate: rate(overall[t]) }, overall[t])
  }));

  // Strong / weak themes over all games, once there is enough data.
  const rated = themes.filter((t) => t.overall.answered >= MIN_ANSWERS_FOR_VERDICT);
  const sorted = rated.slice().sort((a, b) => a.overall.rate - b.overall.rate || b.overall.answered - a.overall.answered);
  const weakest = sorted.length && sorted[0].overall.rate < 1 ? sorted[0].theme : null;
  const best = sorted.length ? sorted[sorted.length - 1] : null;
  const strongest = best && best.theme !== weakest && best.overall.rate >= 0.5 ? best.theme : null;

  const weights = themeWeights(overallRows);
  const focus = THEMES.slice().sort((a, b) => weights[b] - weights[a])[0];

  return {
    answered: gameRows.length,
    correct: gameRows.filter((r) => r.correct).length,
    timedOut: gameRows.filter((r) => r.timed_out).length,
    themes,
    weakest,
    strongest,
    focus, // the theme the next games will ask most
    missed: gameRows
      .filter((r) => !r.correct)
      .map((r) => ({ questionId: r.question_id, choice: r.choice === null || r.choice === undefined ? null : r.choice, timedOut: !!r.timed_out }))
  };
}

module.exports = { themeWeights, buildReport, byTheme };
