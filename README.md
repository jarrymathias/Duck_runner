# Duck Runner — UX & Design Edition

An educational board game about wireframes, UX principles, user research and methodologies.
Each player has their own account and plays from their own device: one player creates a game and shares its code, and the others join with that code.

```
index.html        page structure, game rules (game-logic script) and UI
style.css         all the styles (colors, board, modals…)
icons/            SVG drawings of the special squares
images/           board picture, and the Duck Runner logo (animated GIF, plus a still one for reduced motion)
server.js         web server + JSON API (accounts, rooms)
server/           accounts.js (passwords, sessions), rooms.js (codes, room actions, timer, chat),
                  stats.js (adaptive questions, end-of-game report),
                  db.js (PostgreSQL), logic.js (loads the rules from index.html)
docs/             rules of the board game version: rules.html and the printable duck-runner-rules.pdf
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

## Put it online (Render)

`render.yaml` describes the service, so Render sets it up for you:

1. On https://render.com, sign in with GitHub.
2. **New → Blueprint**, pick this repository, then **Apply**.
3. When Render asks for `DATABASE_URL`, paste the Neon connection string (the same one as in `.env`).
4. Wait for the deploy to finish, then open the `https://duck-runner-xxxx.onrender.com` address Render gives you.

Every push to `main` deploys again. On the free plan the server sleeps after 15 minutes without visitors: the first visit after that takes about a minute to load.

## Play

1. **Create an account** (username and password) or log in. Passwords are stored hashed (scrypt), and sessions last 30 days.
2. **Create a game.** You get a 6-character code with letters and digits, such as `K7P2XM`. Codes never use 0, O, 1, I or L, so they are easy to read aloud. Give yours to your friends.
3. The others click **Join a game** and type the code. A game holds up to 6 players.
4. The host (whoever created the game) clicks **Start the game**.
5. On your turn, click **Roll the die**. Your pawn moves square by square, and every player sees it move.
   - **Question square:** answer the question shown in the pop-up within **30 seconds**. If you're right you stay on the square; if you're wrong, or time runs out, you move back one square (the special effect of that square does not apply). The other players see the question, the countdown and your answer, and can react while they wait.
   - **Special square:** its effect applies automatically. The table below lists them.
   - You must land exactly on **FINISH**. If your roll is too high, the pawn bounces back by the extra squares.
6. The first player on FINISH wins. Players are ranked by their square, then by how many questions they answered correctly. The host can start a new game with the same players.

### What the online version adds

- **Questions that adapt to you.** The server remembers every answer of every player. When you land on a question square, it picks the theme with odds based on your mistakes: a theme you always get wrong comes about 3 times more often than one you always get right. A new player gets an even mix. A question still never comes back before the others in the deck have been used.
- **A 30-second countdown** on each question. The server sets the deadline and has the last word: an answer that arrives too late counts as "time's up", and if nobody answers, the turn moves on by itself.
- **Chat and reactions.** Send short messages (200 characters max) from the waiting room or during the game. The reaction buttons (👍 😂 😮 😬 🎉 🦆) also float above your pawn on the other players' boards, and the players waiting during someone else's question can react from the question pop-up.
- **A personal report at the end of each game.** Your score by theme for this game and for all your games, your strong point, the theme to review, the theme your next games will focus on, and every question you missed, with your answer, the right answer and the explanation.

The server rolls the die, checks the answers and enforces the turns, so nobody can play out of turn. If you reload or close the page, you return to your game when you log in again. If a player leaves during a game, their turns are skipped. If the host leaves, another player becomes the host.

The game works with the keyboard alone: Tab, Enter and Space work everywhere, and in the question pop-up you can press **A / B / C / D** to answer.

| Square | Effect |
|---|---|
| 8, 21 | **Shortcut:** 8 jumps to 13, 21 jumps to 25 |
| 24 | **Bridge:** go straight to 28 |
| 12 | **Shark:** skip your next turn |
| 26 | **Whirlpool:** skip your next 2 turns |
| 29 | **Boat:** go back to square 5 |
| 5, 16, 27 | **Rest:** safe square, nothing happens |

The board goes from START (0) to FINISH (32). When a special square moves your pawn, your turn ends without a question. If the pawn lands on another special square, that square's effect applies too: for example 29 → 5, which is a Rest square.

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
12: { type:'shark', icon:'icons/shark.svg', name:'Shark', tag:'skip 1',
      action:{ kind:'skip', turns:1 },
      message:'A shark! {name} hides and will skip the next turn.' },
```

- `action.kind` can be:
  - `move` with `by` (a positive or negative number of squares);
  - `goto` with `to` (a square number);
  - `skip` with `turns`;
  - `rest`.
- `type` sets the legend color. The colors are the `--sq-*` variables at the top of `style.css`: bonus, bridge, shark, typhoon, boat and rest.
- `icon` is the picture shown in the legend. The drawings are SVG files in `icons/`.
- `message` can use `{name}`, `{to}` and `{turns}`.
- Chains of special squares are protected against infinite loops: a square can't trigger twice in the same chain, and a chain has at most `MAX_CHAIN` effects.

The legend under the board is built from `SPECIAL_CELLS`, so it always matches. If you change which squares are special, also update the "How to play" text in `index.html` (it appears on the account, lobby and waiting-room screens), and make sure the board picture shows the same thing.

## Change the board picture

The board is the picture `images/board.jpg` (1400 × 1400 pixels). Pawns are drawn on invisible spots, one per square, placed with `BOARD_SPOTS` in `index.html`: `BOARD_SPOTS[n]` is the center of square `n`, as a percentage of the picture's width and height (`[x, y]`). If you use a new picture, keep it square and update these positions. If the number of squares changes, also change `FINISH` in the game-logic script.

## Code layout

The styles are in `style.css`. `index.html` contains two scripts:

1. **`game-logic`:** the data and the pure rule functions: `computeMove`, `resolveLanding`, `drawCard`, `playRoll`, `answerQuestion`, `advanceTurn` and `ranking`. This script never touches the page; each function takes a state and returns a new one. The server runs this script to decide what happens.
2. **UI:** the account, lobby and waiting-room screens, plus the board, animations, modals, toasts and history. It sends actions (roll, answer, start, leave) to the server and polls the room every second. The server answers with numbered events, which the UI replays as animations.

On the server, `server/rooms.js` holds every room action as a pure function, which makes them easy to test. `server/db.js` runs each action inside a transaction that locks the room's row, so when two players click at the same time, the server handles one click and then the other. Rooms that nobody has touched for 7 days are deleted.

The board is a picture (`images/board.jpg`) with the pawns drawn on top of it; see "Change the board picture" above.
