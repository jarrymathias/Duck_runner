# Duck Runner — UX & Design Edition

An educational board game about wireframes, UX principles, user research and methodologies.
Each player has their own account and plays from their own device: one player creates a game and shares its code, and the others join with that code.

```
index.html        page structure, game rules (game-logic script) and UI
style.css         all the styles (colors, board, modals…)
icons/            SVG drawings of the special squares
images/           Duck Runner logo (animated GIF, plus a still one for reduced motion)
server.js         web server + JSON API (accounts, rooms)
server/           accounts.js (passwords, sessions), rooms.js (codes, room actions),
                  db.js (PostgreSQL), logic.js (loads the rules from index.html)
tests.js          game rule tests
tests-server.js   account, room and API tests (in-memory database)
.env              database settings: secret, never commit or share it
```

## Install and start

You need Node.js 20.12 or newer and a PostgreSQL database (the project uses Neon).

1. In `.env`, paste your Neon connection string (Neon dashboard → **Connect**) as `DATABASE_URL=postgresql://...`. You can instead fill only `PGHOST`, the host part of that string (for example `ep-xxxx-123456.eu-central-1.aws.neon.tech`). See `.env.example`.
2. `npm install`
3. `npm start`, then open http://localhost:3000. The tables are created on the first start.

Opening `index.html` directly by double-clicking no longer works: the game needs the server.

## Play

1. **Create an account** (username and password) or log in. Passwords are stored hashed (scrypt), and sessions last 30 days.
2. **Create a game.** You get a 6-character code with letters and digits, such as `K7P2XM`. Codes never use 0, O, 1, I or L, so they are easy to read aloud. Give yours to your friends.
3. The others click **Join a game** and type the code. A game holds up to 6 players.
4. The host (whoever created the game) clicks **Start the game**.
5. On your turn, click **Roll the die**. Your pawn moves square by square, and every player sees it move.
   - **Question square:** answer the question shown in the pop-up. If you're right you stay on the square; if you're wrong you go back to where your turn started. The other players see the question and your answer.
   - **Special square:** its effect applies automatically. The table below lists them.
   - You must land exactly on **FINISH**. If your roll is too high, the pawn bounces back by the extra squares.
6. The first player on FINISH wins. Players are ranked by their square, then by how many questions they answered correctly. The host can start a new game with the same players.

The server rolls the die, checks the answers and enforces the turns, so nobody can play out of turn. If you reload or close the page, you return to your game when you log in again. If a player leaves during a game, their turns are skipped. If the host leaves, another player becomes the host.

The game works with the keyboard alone: Tab, Enter and Space work everywhere, and in the question pop-up you can press **A / B / C / D** to answer.

| Square | Effect |
|---|---|
| 8, 21 | **Bonus** (star): move ahead 3 squares |
| 24 | **Bridge:** go straight to 28 |
| 12 | **Shark:** move back 3 squares |
| 26 | **Typhoon:** skip the next 2 turns |
| 29 | **Boat:** go back to square 5 |
| 16, 27 | **Rest** (moon): safe square, nothing happens |

When a special square moves your pawn, your turn ends without a question. If the pawn lands on another special square, that square's effect applies too: for example 21 → 24 → 28.

## Run the tests

```
npm test
```

This runs `tests.js` (game rules) and `tests-server.js` (accounts, room codes, room actions, and the real HTTP API against an in-memory PostgreSQL, so no Neon access is needed). The server and `tests.js` both read the `<script id="game-logic">` block straight from `index.html`, so the browser, the server and the tests always run the same rules.

## Edit the questions

In `index.html`, find `const QUESTIONS = [` at the top of the `game-logic` script. Each question looks like this:

```js
{t:'W', q:"Question?", o:["Option A","Option B","Option C","Option D"], a:1, e:"Explanation."}
```

- `t`: the theme. Use `W` (Wireframes), `U` (UX principles), `R` (User research) or `M` (Methodologies). Theme names and colors are set in `THEMES`.
- `o`: the 4 answer options. The game shuffles their order on screen.
- `a`: the index of the correct option, counting from 0.
- `e`: the explanation shown after the player answers.

You can add or remove questions. The draw pile adjusts to however many there are, and no question comes back until all the others have been used. Run `node tests.js` afterwards: the first test expects exactly 50 questions, so update it if you change the count.

## Edit the special squares

Special squares are set in `SPECIAL_CELLS`, just below the questions:

```js
12: { type:'shark', icon:'icons/shark.svg', name:'Shark', tag:'−3',
      action:{ kind:'move', by:-3 },
      message:'A shark! {name} swims back 3 squares to square {to}.' },
```

- `action.kind` can be:
  - `move` with `by` (a positive or negative number of squares);
  - `goto` with `to` (a square number);
  - `skip` with `turns`;
  - `rest`.
- `type` sets the square's color. The colors are the `--sq-*` variables at the top of `style.css`: bonus, bridge, shark, typhoon, boat and rest.
- `icon` is the path to the square's picture. The drawings are SVG files in `icons/` (`bonus.svg`, `bridge.svg`, `shark.svg`, `typhoon.svg`, `boat.svg`, `rest.svg`). To change one, edit the SVG or replace it with your own picture (SVG, PNG, JPG…) and update the path. Square pictures work best.
- `message` can use `{name}`, `{to}` and `{turns}`.
- Chains of special squares are protected against infinite loops: a square can't trigger twice in the same chain, and a chain has at most `MAX_CHAIN` effects.

If you change which squares are special, also update the legend in `renderLegend()` and the "How to play" text in `index.html` (it appears on the account, lobby and waiting-room screens).

## Code layout

The styles are in `style.css`. `index.html` contains two scripts:

1. **`game-logic`:** the data and the pure rule functions: `computeMove`, `resolveLanding`, `drawCard`, `playRoll`, `answerQuestion`, `advanceTurn` and `ranking`. This script never touches the page; each function takes a state and returns a new one. The server runs this script to decide what happens.
2. **UI:** the account, lobby and waiting-room screens, plus the board, animations, modals, toasts and history. It sends actions (roll, answer, start, leave) to the server and polls the room every second. The server answers with numbered events, which the UI replays as animations.

On the server, `server/rooms.js` holds every room action as a pure function, which makes them easy to test. `server/db.js` runs each action inside a transaction that locks the room's row, so when two players click at the same time, the server handles one click and then the other. Rooms that nobody has touched for 7 days are deleted.

The board has 4 lanes of 8 squares joined by single turn squares, like a snake. This layout puts square 24 right above square 28, so the bridge crosses the gap between them.
