# Running JevMon

How to install, configure, run and deploy the bot. For what it does and why, see the [README](../README.md);
for how the state, payload and guards work, see [DESIGN.md](DESIGN.md).

Node.js 22.20+ is required. The bot has two direct runtime dependencies: `@pkmn/dex` for Showdown
move/species/type data and `@smogon/calc` for damage. TypeScript and Node types are development dependencies.
The lookahead search needs Rust to build (see [Lookahead search](#lookahead-search-experimental)).

## Install and verify

```sh
npm install
cp -n .env.example .env
npm test
npm run smoke
```

`smoke` connects as a guest and exits after the handshake. It never authenticates,
accepts challenges or enters battles, even when those settings are configured.

Put an existing registered bot account in `.env`:

```dotenv
SHOWDOWN_USERNAME=YourBotName
SHOWDOWN_PASSWORD="your password"
```

Use quotes for passwords containing spaces or `#`. Both fields are required for
login. Credentials, login assertions and arbitrary exception text are never logged.
Account connections require a trusted `wss://` server; login credentials go only to
the official HTTPS authentication endpoint, with redirects rejected.

```sh
npm run smoke:login
```

Success prints `login smoke passed`. This authenticates and disconnects without
entering a battle. Authentication failures stop with exit code 1. Both smoke
commands have a 30-second overall deadline.

## Play one controlled battle

Configure the bot account above, then add:

```dotenv
BATTLE_MODE=random
DRY_RUN=false
ACCEPT_CHALLENGES_FROM=YourHumanAccount   # or * for whoever challenges first
SHOWDOWN_BATTLE_ROOM=
```

```sh
npm run build
npm start
```

From the configured human account, challenge the bot to **[Gen 9] Random Battle**.
The bot accepts only that opponent and exact format, and accepts at most **one
challenge per process run**, including across reconnects. Current structured challenge
PMs and legacy challenge updates are supported; ordinary PM text is not acted on. It selects uniformly
among request-supported actions (including Tera variants), not by strategic merit.
It never searches the ladder. Restart for another challenge after the battle ends.

Expected console events include authentication, challenge acceptance, battle entry,
then `choice sent: ...` with a request ID. Turn states, decisions, safe error/status
events and the final win/tie state go into `logs/<battle ID>-<session UUID>.jsonl`.
Each decision includes the offered actions, selected action, whether it was sent,
fallback use and decision latency. A sent choice is not proof it was accepted:
server rejections are separate status events. `node scripts/ladder-report.mjs` and the live view's
performance page summarise results across battles.

Stop with Ctrl+C. This disconnects without sending a forfeit; an ongoing battle can
still expire on its timer.

`ACCEPT_CHALLENGES_FROM` accepts one named account, or `*` for whoever challenges first.
Either way the gate opens once: one battle per run, in Gen 9 Random Battle only, and never
a challenge from our own account. To join an existing battle instead, for example to resume after a restart, clear
`ACCEPT_CHALLENGES_FROM` and set `SHOWDOWN_BATTLE_ROOM` to that battle's actual room
ID. Within the same process, a known room is rejoined after reauthentication.

## Dry-run and observation

Defaults are `BATTLE_MODE=observe` and `DRY_RUN=true`.

To observe, use Watch a battle in Showdown and copy an existing Gen 9 Random Battle
room ID from its URL, or paste the complete official battle URL:

```dotenv
BATTLE_MODE=observe
SHOWDOWN_BATTLE_ROOM=battle-gen9randombattle-1234567890
ACCEPT_CHALLENGES_FROM=
```

Replace that example with a real room. Run `npm run build` and `npm start`. Public
observation works without credentials and never sends battle choices.

For a decision dry-run, set `BATTLE_MODE=random`, `DRY_RUN=true`, account credentials,
and a room where **that account is already a player**. It will log its selection
without sending it; you must make the actual choice manually. A spectator does not
receive private requests and therefore cannot test decision generation. Dry-run
also prevents challenge acceptance; it reports a matching challenge once.

`LIVE_VIEW_PORT` is covered under Watching the decisions below. `DEBUG=true` logs protocol message types only. Clear `SHOWDOWN_BATTLE_ROOM` and
`ACCEPT_CHALLENGES_FROM` for connection-only mode.

## Staying up for challenges

To leave the bot running and challengeable by anyone:

```dotenv
BATTLE_MODE=jev
DRY_RUN=false
ACCEPT_CHALLENGES_FROM=*
SHOWDOWN_BATTLE_ROOM=
MAX_BATTLES=0
```

When a battle is decided the bot leaves the room and takes the next challenge, for
as long as the process runs. It still plays one battle at a time, so a challenge
that arrives mid-battle is ignored rather than queued. `MAX_BATTLES` stops it after
that many games; `0` means no limit. Each battle gets a fresh `JEV_MAX_CALLS_PER_BATTLE`
budget, so a bot left up overnight can spend real money — set `MAX_BATTLES` if that
matters.

The count is kept in `logs/battles-played` and survives restarts, so a crash or a
failed login that restarts the process does not hand it a fresh allowance. A battle
counts as soon as it starts, because that is when the calls begin. Delete the file to
start a new allowance; if it exists but cannot be read, no challenges are accepted.

Only one copy runs from a folder at a time. Two copies logged in as the same account
would both receive every battle, so a second start is refused while `logs/bot.pid`
names a live process; a stale file from a crash is taken over. Stop the bot with
Ctrl-C, not Ctrl-Z: Ctrl-Z only pauses it, leaving it logged in and holding the lock.

Nothing here restarts the process. To survive a crash or a reboot, run it under
whatever supervisor you already use (`launchd` on this Mac, `systemd`, `pm2`, a
container restart policy); the bot reconnects on its own if the Showdown connection
drops, but it cannot restart itself.

## Playing the ladder

To have the bot find its own opponents on the Gen 9 Random Battle ladder:

```dotenv
BATTLE_MODE=jev
DRY_RUN=false
PLAY_MODE=ladder
LADDER_BATTLES=10
```

`PLAY_MODE` chooses where battles come from:

| Mode | Behaviour |
|---|---|
| `challenges` | Accepts challenges from `ACCEPT_CHALLENGES_FROM` only. |
| `ladder` | Searches the ladder, and takes challenges only once the run is complete. |
| `both` | Ladders, and takes a challenge between ladder games, never during one. |

In `both`, a challenge that arrives during a ladder game waits until that game ends,
and is accepted before the next search. One that arrives while the bot is only
searching withdraws the search first, and is accepted once the server confirms no
game was matched. If a game was already matched, it is played and the challenge
follows it. A challenge withdrawn in the meantime is dropped, and one accepted that
never becomes a battle is given up after 20 seconds. So the bot never has to stop,
or leave a ladder game, to take a challenge. Left blank, `PLAY_MODE` is `ladder`
when `LADDER_BATTLES` is set and `challenges` otherwise.

Once logged in it searches for one battle, plays it, and searches again five seconds
after it ends, until that many ladder battles have finished. With `LADDER_BATTLES=0`
in a ladder mode there is no run length, and `MAX_BATTLES` must be set to end it. A battle that is abandoned,
never joined or cut short does not use up the run; `MAX_BATTLES`, the spending cap,
still counts every battle as it starts. It never searches while a
battle is on, and while `LADDER_BATTLES` is set it takes no challenges, so two games
never overlap. The run is counted in `logs/ladder-battles-played` and carries on
across restarts; delete the file to start another run. Once it is complete the bot
takes challenges again, from whoever `ACCEPT_CHALLENGES_FROM` names. `MAX_BATTLES` still applies on
top, so raise it if it would cut the run short. If the process restarts mid-game, the
server's list of our games brings it back into the battle rather than letting the
timer lose it. A search the server refuses, for instance while throttled, is retried
each minute, five times at most. In dry-run the bot only logs that it would search.

In every battle it plays, ladder or challenge, the bot turns the battle timer on with its
first move and asks again if the timer is ever turned off, so an opponent cannot stall
it indefinitely. Its own decisions take a few seconds, well inside the timer. It never
does this in dry-run, where it sends no moves and the timer would only lose it the game.

`node scripts/ladder-report.mjs` summarises the run: result, ratings, knockouts, guard
skips, search overrides and provider failures per battle (`--all` adds challenge games).

## Running it on a server

The bot lives and dies with the machine it runs on: it is a single Node process
holding a WebSocket, with no cloud component. A laptop that sleeps loses the battle
in progress to Showdown's timer, and a laptop that shuts down stops the bot entirely.
To stay challengeable, run it somewhere that is always on.

`Dockerfile` and `docker-compose.yml` cover that. From this machine, with SSH access to a
server that has Docker and the compose plugin:

```sh
scripts/deploy-vps.sh user@your-server
```

It copies the sources and your `.env` (owner-only) to `~/jevmon`, builds the image on the
server, starts it, and checks that the container can write its logs. Rerun it to redeploy;
the server's logs are kept. Then:

```sh
ssh user@your-server 'cd jevmon && docker compose logs -f'
```

`restart: unless-stopped` brings it back after a crash and after the host reboots.
The image runs as a non-root user, carries only production dependencies, and is about
76 MB. Battle logs are written to `./logs` on the host, so they survive a rebuild.

That user is uid 1000, and on Linux a `./logs` that Docker creates for the bind mount is
owned by root, so the bot cannot write to it. It keeps playing, reports one `battle logging
failed` line and records nothing. The deploy script creates `logs` with the right owner
first. If you run compose by hand, do the same: `mkdir -p logs && sudo chown 1000:1000 logs`.

### Reaching the live view safely

The live view has no authentication of its own, so compose publishes it on the
server's loopback interface only. Reach it from your own machine with a tunnel:

```sh
ssh -N -L 8733:127.0.0.1:8733 user@your-server
```

Then open <http://127.0.0.1:8733>, or point the browser extension at port 8733 as
usual. The view shows your team and every choice, so it sends no CORS header and
answers only requests addressed to a loopback name: other sites open in the same
browser cannot read it, even by rebinding their own name to 127.0.0.1. Keep Docker
at 28 or later on the server, because older versions let other machines on the same
network reach ports published on 127.0.0.1. Do not map the port to a public interface: `LIVE_VIEW_HOST=0.0.0.0` inside the
container is what makes it reachable from the published port at all, and publishing
that straight to the internet would expose it to anyone.

### Before you leave it running

`.env` holds your Showdown password and `TYPESAFE_API_KEY`, so putting the bot on a
server puts both there too. They travel over SSH, land owner-only, and are never
built into the image or written to a log; anyone who can run `docker` on the server
can still read them with `docker inspect`, which is the same as having root there.
So use a Showdown account made for the bot, with a long password used nowhere else,
log in with an SSH key rather than a password, and rotate both if the server is ever
compromised.

The container runs as a non-root user with a read-only filesystem, no Linux
capabilities, no privilege escalation, and a 512 MB memory cap. Its only writable
place is `./logs`.

With password login, the deploy script asks for the password once in the terminal
you run it from; every step after that shares the connection. Check `docker compose
logs` before walking away.

## Self-play bench

Twenty ladder games cannot tell a 50-Elo change from luck. `scripts/selfplay.mjs` plays two search configurations
against each other on a local simulator: no Jev calls, no ladder. Every seed is played twice with the teams swapped, so
team luck cancels, and it reports B's win rate against A with a 95% interval.

```sh
npm install --prefix ~/.cache/jevmon-sim --ignore-scripts --no-audit --no-fund @pkmn/sim@0.10.11 @pkmn/randoms@0.10.11
SIMULATOR_DIR=~/.cache/jevmon-sim npm run bench -- --pairs 100 --name budget \
  --a '{"worlds":16,"msPerWorld":200}' --b '{"worlds":32,"msPerWorld":300,"extraWorlds":16}'
```

A config takes `worlds`, `msPerWorld`, `extraWorlds`, `closeRatio`, `endgamePokemon`, `endgameWorlds`,
`endgameMsPerWorld`, and `guards: false` to play without the strategy guards. Results go to `logs/bench/<name>.jsonl`,
and rerunning the same name resumes. Searches are CPU-bound and time-limited, so the bench refuses to start while the
ladder bot runs (`--force` overrides this).

**Sample sizes.** 200 games resolve about 70 Elo (a 60% win rate); 35 Elo needs about 800 games.

**What it measures.** The bench measures search against search, without Jev. A change that wins here should help the
live blend, which is 70% search, but that is an inference, not a measurement.

## Lookahead search (experimental)

Jev judges one turn at a time from the numbers in its payload. The strongest random-battle bots also look ahead:
Jaxcalibur, which reached #1 on the Gen 9 Random Battle ladder, credits its search with 100–150 Elo, and Foul Play
is built on search alone. This bot can add the same kind of lookahead with
[poke-engine](https://github.com/pmariglia/poke-engine), the MIT-licensed Rust engine behind Foul Play, vendored in
`vendor/poke-engine` at a pinned commit.

Each decision samples a number of "worlds": every revealed opposing Pokémon takes one candidate set from our
inference, drawn by probability, and each unrevealed slot takes a random species from the random-battle pool with a
sampled set. The engine runs Monte Carlo tree search on each world with both sides choosing at once, and the visit
shares and win estimates are averaged per legal action. Our moves are restricted to what the request offers, so a
Choice lock, Encore or a spent Tera reaches the engine.

```sh
npm run build:engine   # needs Rust: brew install rust
```

Settings (all off by default):
- `SEARCH_EXTRA_WORLDS`: a second pass of this many worlds when the first leaves its top two actions close
  (`SEARCH_CLOSE_RATIO`, default 0.6, meaning the second drew at least 60% of the first's visits).
- `SEARCH_ENDGAME_POKEMON`: with this many Pokémon or fewer left on both sides together, each world is solved by
  depth-limited expectiminimax, deepened while it fits `SEARCH_ENDGAME_MS`, over `SEARCH_ENDGAME_WORLDS` worlds. Its
  root is solved as a simultaneous-move game, not the engine's worst-case choice.

```dotenv
SEARCH_MODE=blend      # off, advise (its verdict goes into Jev's payload) or blend (mixed into the choice afterwards)
SEARCH_WEIGHT=0.7      # in blend, the search's share of the choice against Jev's probabilities
SEARCH_WORLDS=16
SEARCH_MS_PER_WORLD=200
SEARCH_IN_PAYLOAD=     # unset: Jev sees the search only in advise mode; true shows it in blend too, to compare
JEV_SKIP_AT_SEARCH_SHARE=0.7  # in blend, Jev is not asked when the search puts this share of its visits on one action; 0 always asks
```

Jev is also not asked when there is only one legal action. With 70% of the search's visits on one action the blend
follows the search whatever Jev says: across 7,555 logged blend decisions those turns played the search's choice 96%
of the time, the rest through a guard's fallback. Together the two skips save about a fifth of the calls. Each such
decision records `providerSkipped`, and the live view shows "Jev: not asked".

In blend, Jev's payload leaves the search out by default. The search is mixed into the choice afterwards, so also
showing it to Jev counted it twice and made Jev's opinion a copy of it. Each decision records `search.inPayload`,
so games with and without it can be compared. A world's score is pooled by visits. Sixteen worlds of 200 ms run in
parallel in under a second on this Mac, before the Jev call. If Jev's call
fails, the search's ranking replaces the random fallback. The Docker image builds the engine for Linux in its own
stage. Limitations: the engine simplifies some mechanics, unrevealed Pokémon are drawn uniformly from the pool, and
100 ms per world is a short search.

## Watching the decisions

The bot serves a read-only live view of the battle and of what it is choosing and
why. Start it as usual and open <http://127.0.0.1:8733>. It shows:

- **The arena.** Each side's active Pokémon with its sprite, HP, status, Tera type,
  stat stages (such as SpA +2 or Atk −1) and effects like Substitute or Leech Seed. A
  "setting up" badge appears while it boosts. It also shows each side's hazards and
  screens, the whole team (with unseen slots) and the weather, terrain and Trick Room.
  A ticker names the latest action, and the sprites shake when hit, glow when healed
  and bounce on boosts.
- **Play-by-play.** Every turn in words, newest first: moves, damage and healing as
  "−45% → 55%", stat changes with the running stage, status, switches, Tera, faints,
  and an **End of turn** section for Leftovers, poison, weather and the like.
- **The result.** A Victory or Defeat banner with the knockouts each way, turns and
  the ladder rating change, plus a record of completed battles from the local logs.
  The record and rating survive bot restarts.
- **Watch on Showdown.** Opens the real battle in its own tab as a spectator.
  Showdown does not allow its client inside another page, so it cannot be embedded.
- **Jev's side.** The selected action, the probability the model gave every legal
  action beside the damage, KO and turn-order numbers, and any decision a runtime
  guard overruled, with the guard's reason. Click any entry in the decision list to
  go back to that turn.

- **Jev beside the search.** Each option shows Jev's probability and the search's share of its visits as two bars,
  with the blended score the move was chosen on. The decision says who settled it: Jev and the search agreeing, a
  near tie handed to Jev, a Tera held back, or a guard.
- **Performance.** Record, current and peak rating, streak and the last 20 results. A rating chart shades the build
  that played each battle, and a per-build table gives each build's record and performance rating.
- **Replays.** Any recorded battle, played back through the same view: the arena moves event by event, each decision
  appears with its numbers, and it can be paused, stepped (← →), sped up or scrubbed by turn. **🎬 Present** (P) opens
  a full-screen presentation for screen recording: the battlefield, a caption for each event, the bot's call with
  Jev's and the search's bars, and a victory or defeat splash. `?replay=<room>` links straight to one. The first
  opening builds the replay from its log (about ten seconds), and it is cached in `logs/replays/` after that.

`npm run view` serves all of this from the logs without the bot, for when it is stopped or busy (a bench run, say):
<http://127.0.0.1:8733>, or `-- --port 8736`.

`LIVE_VIEW_PORT` sets the port and `LIVE_VIEW_PORT=0` turns it off. The server binds
to the loopback interface and serves only `GET`. The play-by-play reads only public
battle lines, never our private request or the room's chat, and from a ladder
rating line it takes only the numbers. Sprites load from Showdown's image server;
nothing about our team is sent to it. A port already in use is reported and the
battle continues without it.

If the bot is already running an older UI build, `npm run build` followed by
`node --env-file-if-exists=.env scripts/live-view-sidecar.mjs` serves the updated
view at <http://127.0.0.1:8734> while the bot keeps playing. The sidecar reads the
existing local view and log files; it does not control battles.

### The browser extension

`extension/` holds an unpacked Chrome extension that puts the same view in the
browser side panel, beside the Showdown battle. Load it once:

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Choose **Load unpacked** and select the `extension/` folder.
3. Open the Showdown tab and click the extension's toolbar button.

The panel frames the local view, so the bot must be running. It reads nothing from
the Showdown page and sends nothing anywhere; if the port is not the default, change
it in the panel's own field.

## TypeSafe Jev

See [Jev setup and API contract](JEV.md) for complete details. Get a key from
[TypeSafe's console](https://console.typesafe.ai), and add it to `.env` locally.
Do not paste keys into chat.

```dotenv
BATTLE_MODE=jev
TYPESAFE_API_KEY=your-key
JEV_MODEL=jev-latest
JEV_MAX_CALLS_PER_BATTLE=60
JEV_TIMEOUT_MS=6000
```

Test the API separately with `npm run smoke:jev`. That command makes **one paid API
request** on a synthetic battle state; it does not log into Showdown or play a battle.
To play, use `DRY_RUN=false` and the same challenge/room settings as random mode.
Jev dry-runs make no API calls unless `JEV_CALLS_IN_DRY_RUN=true` is also set.

Each API attempt counts against the per-battle limit, including failed/cancelled
attempts. Failures use a local random legal action. The provider validates the
chosen action, confidence, probability distribution and reported token usage.
Timeouts and stale decisions abort the HTTP request; redirects are rejected.
401/403 disables further Jev calls for the battle; 429/529 triggers a 30-second
cooldown. There are no automatic paid retries. Per-battle limits survive reconnects
in the same process but reset after a process restart.

Decision records include confidence, per-action probabilities and usage. Safe
provider events record attempts, errors, cancellations and cumulative usage even
when a decision becomes stale. Cost estimates are `null` unless both account rates
are configured. Failed requests may have unreported charges (`usageIncomplete`).
Confidence is **not** an estimated Pokémon battle win probability.

## Local full-battle integration test

The optional harness uses `@pkmn/sim` and `@pkmn/randoms`, extracted from Pokémon
Showdown, in a separate temporary installation. It adds no packages to the bot.

```sh
SIM_DIR=$(mktemp -d)
npm install --prefix "$SIM_DIR" --ignore-scripts --no-audit --no-fund @pkmn/sim@0.10.11 @pkmn/randoms@0.10.11
SIMULATOR_DIR="$SIM_DIR" npm run test:sim
```

The harness runs three seeded Gen 9 Random Battles through the real battle manager
and injected seeded decision providers. The third run uses the actual Jev provider
with mocked HTTP responses, testing its request/response path without paid calls. It emulates the server's request IDs,
checks choices use the current ID, and requires normal completion, decisions and
forced switches. Battle and team seeds are fixed; `SIMULATOR_RUNS=15` runs a broader
suite. Hidden-information rejections are recorded and recovered; other rejection
types fail the harness. The simulator provides actual mechanics and request generation.
This is not a public-server authentication/challenge test; that needs your account.
