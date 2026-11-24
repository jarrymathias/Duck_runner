'use strict';
/*
 * Loads the game rules from the <script id="game-logic"> block of index.html,
 * exactly like tests.js does. The server and the browser run the same code.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const match = html.match(/<script id="game-logic">([\s\S]*?)<\/script>/);
if (!match) throw new Error('Could not find <script id="game-logic"> in index.html');
const sandbox = { module: { exports: {} } };
vm.runInNewContext(match[1], sandbox, { filename: 'index.html#game-logic' });

module.exports = sandbox.module.exports;
