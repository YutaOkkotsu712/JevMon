# JevMon

Increment 5: a strict TypeScript Showdown client with login, state tracking,
request-derived legal actions and a random decision loop for **Gen 9 Random Battle**.
Optional TypeSafe Jev decisions and a conservative deterministic feature layer are
implemented. Strategic objectives, opponent prediction and a dashboard are not.

Node.js 22.20+ is required. The bot uses **one direct runtime dependency**, `@pkmn/dex`, for Showdown
move/species/type data. TypeScript and Node types are development dependencies.

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
server rejections are separate status events. Aggregate analytics are not built yet.

Stop with Ctrl+C. This disconnects without sending a forfeit; an ongoing battle can
still expire on its timer. To resume after a process restart, clear
`ACCEPT_CHALLENGES_FROM` accepts one named account, or `*` for whoever challenges first.
Either way the gate opens once: one battle per run, in Gen 9 Random Battle only, and never
a challenge from our own account. To join an existing battle instead, clear
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
```

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

## Reliability and scope

- Legal actions come exclusively from validated private requests, independent of
  the observational tracker. Commands use numeric move/roster slots and `rqid`.
- Disabled and exhausted moves, active/fainted switch targets, known trapping,
  forced switches, Tera, Struggle/recharge, Revival Blessing and full preview
  permutations are handled. Only the selected singles format is enabled.
- Hidden trapping or move restrictions can still cause server rejection. Those
  actions are marked uncertain. Unavailable choices wait for a revised request;
  invalid choices try another request-supported action. Three rejections per
  request ID stop retries and report the problem.
- Duplicate/stale requests are suppressed. Disconnects, wait requests, battle end
  and the server's `sentchoice` reconnect marker cancel pending decisions. Decisions
  are validated again immediately before sending. Invalid/failed/timed-out providers
  fall back to a legal action; random mode makes no Jev/API calls.
- Reconnect delay grows from 1 to 30 seconds. Initial handshakes time out after 15
  seconds. Half-open sockets still depend on underlying transport failure detection.
  If connection drops before a newly accepted battle's room ID arrives, manual room
  configuration may be needed. There is no cross-process session recovery yet.
- Jev is optional; observe/random modes make no API calls.
- A disk write error reports once and disables that logger. State snapshots may
  contain player names/private team information, but no credentials or chat.

The state tracks visible HP/status, switches/faints, boosts, revealed moves,
items/abilities, Tera, weather/terrain, Trick Room, hazards and turns. Private
requests supply the full own roster and exact HP. Unknown values use `null`, and
public HP is approximate. Duplicate private roster slots remain separate.

Tracker improvements include stable Pokémon IDs independent of roster slots,
private stats/moves, Transform with separate copied moves, boost copying/swapping,
volatile start/end events, ability suppression, side conditions, Court Change and
observed field start turns. Illusion marks remaining-team counts unknown instead
of guessing. This is still incomplete: indistinguishable public identities,
Baton Pass/Shed Tail volatile transfer, exact duration bounds, some ability/form
restoration and interactions need further work. Decision legality remains driven
by server requests, independently of strategic state.

The deterministic feature layer supplies move data, base STAB/type-chart factors,
conditional weather/terrain factors and hazard exposure. It distinguishes these
from action-specific damage envelopes computed with `@smogon/calc`. The inference
layer filters official Gen 9 role pools by revealed moves/Tera and uses reproducible
sampled sets for original items, abilities and base-speed ranges. Damage uses private
own stats/HP, known current items/abilities, boosts, weather, terrain and screens.
Envelopes combine rolls across compatible samples. Conditional KO labels describe
raw damage only, before accuracy, Sash/Sturdy, healing or an opponent action, and
are evaluated against the target's whole possible current-HP interval.

Every offered action carries a comparable evaluation, not only attacking moves:

- **Turn order.** Effective speed (modifiers and Trick Room included) against the
  sampled opposing spreads, plus the priority brackets those samples allow. A move is
  reported as moving first only when no sampled opposing move outranks it and it wins
  any equal-priority race; otherwise the opposing moves that would resolve first are
  named with their generation frequencies.
- **Incoming damage.** What the opposing active Pokémon could do to the current active
  Pokémon and to each switch target, over its revealed moves plus the most frequently
  generated moves of its compatible roles. Non-damaging possibilities (Will-O-Wisp,
  Taunt, recovery) are named rather than dropped.
- **Switch matchups.** For each switch target: types, HP, hazard exposure, incoming
  worst case, our own best damage from that Pokémon and its speed relation.
- **Move effects.** Recovery amounts, setup boosts, inflicted status, hazards, weather
  and terrain, forced and self switches, listed accuracy and secondary chances, so
  recovery and setup are comparable with attacking. Amounts the dex leaves out because
  they depend on the weather (Synthesis, Moonlight, Morning Sun, Shore Up) are computed
  from the current weather, and the ones that depend on the target (Strength Sap, Pain
  Split, Wish) say what they depend on.
- **Stalling.** `residualsPerTurn` is the end-of-turn HP change as a percentage of max HP —
  Leftovers, Black Sludge, burn, poison, Leech Seed, Salt Cure, Sandstorm, Grassy Terrain,
  with Magic Guard and the type immunities applied — which is what decides whether a Pokémon
  climbs out of a damage range. The opponent's item is often unknown, so theirs is a range.
  `survivalIfWeStayIn` counts how many more turns our Pokémon lasts against the worst incoming
  damage once that healing is counted, using the pessimistic end of ours.
- **PP.** Our own remaining PP comes from the private request. The opponent's is counted from
  observed uses against full PP Ups, which is how random battles generate — an upper bound on
  what remains, since turns we did not see are not counted, and moves called by another move
  spend no PP. Our own Pressure doubles what they spend, which is what makes stalling a move
  out realistic.
- **Protect.** A protecting move reports `successChance`, which falls to a third of itself for
  each consecutive protect, and `endOfTurnSwingPercentOfMaxHP`, the worst-case net gain from
  spending a turn taking nothing. The opponent still spends the PP of whatever it was blocked
  doing.
- **What a move's stat change buys.** `afterItsStatChange` projects one step: our best damage
  and speed relation once the stages land. A Dragon Dance that wins the matchup and a Draco
  Meteor that weakens the next hit both show up here.
- **What a status is worth.** `ifTheStatusLands` reports how much less we take once it applies,
  because a burn halves physical damage and paralysis halves speed — neither visible from the
  status name. Sleep Clause is enforced, so a second sleep move is not offered as if it worked.
- **Tera as defence.** `defensiveTera` reports what our own Tera changes about the damage we
  take, which is the half of Tera easiest to miss.
- **Hazards as investment.** A hazard move is priced by how many opposing Pokémon are still to
  come in and what each revealed one takes on entry, since it is paid for once and collected on
  every switch. Removal reports what it clears from each side.
- **The endgame.** `endgame` reads past the active pair: which of our Pokémon beat which of
  theirs, and which of theirs we have no answer to. Coarse on purpose — best move each way from
  full health, turns to knock out, faster side winning the race — and only for Pokémon revealed.
- **Choice lock.** `opponentChoiceLock` names the move a Choice item would have locked them
  into, with the probability from the candidate items still compatible. It is the most
  exploitable read available from public information alone.
- **Abilities.** The calculator models absorption, Unaware, the pinch abilities, the weather speed
  abilities (Swift Swim, Chlorophyll, Sand Rush, Slush Rush), Sand Force, Sheer Force and both Auras —
  including an Aura on the *defender*, which boosts our own move of that type. Protosynthesis and Quark
  Drive it does not model, so their Booster Energy stat is applied directly from the volatile that names
  it. Sheer Force trades a move's secondary effect for damage, so the secondary is no longer advertised
  on a move that will not have one. but a zero
  in an envelope is indistinguishable from a low roll. `takesNothingFromIt` names the ability and the
  probability mass of sets it holds for; `takesNothingBecauseOfOurAbility` does the same for incoming,
  where our own ability makes it certain. Both are taken from the calculator's own verdict rather than
  re-deriving the rule, so an attacker with Mold Breaker — which reads straight through Storm Drain,
  Levitate and Unaware alike — cannot turn either into a false promise. `pinchAbilities` name an ability
  that changes damage once its holder is low, with the threshold, and `ignoredByUnawareWithProbability`
  marks setup that the opponent would read straight through.
- **Form changes.** A move that changes the user's form changes its typing and stats while looking like
  an ordinary attack. `changesOurForme` gives what it becomes, the base-stat shifts, the damage and
  incoming figures afterwards, and whether it reaches the new typing without spending the one Tera
  available — Relic Song turning Meloetta into its Pirouette form is the case that occurs in random
  battles. Driven by the dex's own `requiredMove`, so it covers any such move rather than one by name.
- **Terastallising into a form.** Terapagos is the one Pokémon whose Tera changes its form rather than
  only its type, and the change costs it Tera Shell — the ability that halves every hit while it is at
  full health. `teraChangesOurForme` prices that: against Iron Boulder it reports incoming going from
  36.3% to 89.1% for 7.6% more damage of our own. Treating Tera as a type change hides it entirely.
- **Delayed recovery, and passing it.** A Wish heals whoever holds the slot when it lands, so switching
  after casting it passes the healing to the Pokémon coming in; a Healing Wish or Lunar Dance fully
  restores whatever comes in after its caster faints. Both are tracked from the moment they are set
  (`recoveryWaitingOnOurSide`) and described at the point of choosing them (`delayedRecovery`).
- **Effects the dex keeps in code.** Belly Drum, Tidy Up, Take Heart, Haze, Heal Bell and Trick carry
  their effects in behaviour rather than in data, so a move that maximises Attack looked identical to one
  that does nothing. These are described explicitly, and Belly Drum's projection spends the health it
  costs — reporting what is left and whether that still survives the reply.
- **Transforming by leaving.** Zero to Hero transforms Palafin when it switches *out*, and it returns
  with base Attack of 160 instead of 70. That makes switching a gain rather than the cost every other
  field here treats it as, and neither the move list nor the ability name says so.
  `switchingOutTransformsOurActive` reports what it becomes and what that is worth.
- **A knockout that moves first.** When two moves both knock the target out, the extra damage on the
  slower one buys nothing while the faster one wins the exchange untouched. That is the one dominance
  relation the damage comparison has to exclude, since it rests on differing priority, so it is checked
  separately: both knockouts must hold across every modelled set, the faster move may not be less
  accurate, and anything worth its own turn — draining back, pivoting out — is left alone.
- **Substitute and Shed Tail.** A Substitute is priced by whether the shell survives their best sampled
  hit: one that breaks at once has bought a single blocked hit, one that holds blocks status and stat
  changes for as long as it stands. Shed Tail is the same trade at twice the price and hands the shell to
  the Pokémon coming in, which is what makes it a setup move rather than a pivot.
- **Setup that never happens.** Stat changes are lost when their holder faints, and a stat move deals
  no damage to prevent that — so a projection that shows a sweep is misleading when the Pokémon is
  knocked out that turn. `afterItsStatChange` now carries
  `wastedBecauseWeAreKnockedOutFirst` in that case, evaluated *after* the boost so one that saves us is
  not wrongly flagged. It applies only to a move that buys a gain and deals nothing: a self-penalty on
  an attacking move is not a loss worth reporting. A status instead survives its user, so it is only
  marked as never going off when we would also move second.
- **Weather as setup.** Setting weather is setup for whatever our own moves do in it. `afterThisWeather`
  reports the damage after it lands and which move becomes our best, since nothing about a weather move
  says that Hydro Steam is what the sun is for.
- **What Tera buys here.** Tera can be spent once in a battle, so `teraBuysUs` states the difference it
  makes to this particular move — the damage with and without, the points gained, and whether it turns a
  non-knockout into one — rather than leaving that to be found by comparing two separate actions.
- **Whether a move would accomplish anything.** A status the target's type cannot take, a
  target that is already statused, a heal at full HP, boosts already at the cap, a hazard
  or weather already in place, Substitute below a quarter HP, Safeguard or Misty Terrain —
  reported as established facts. Hidden abilities and items that would block it instead
  (Magic Bounce, Good as Gold, Purifying Salt, Insomnia, Overcoat, Safety Goggles) are
  reported as possibilities with their generation frequency. Neither list is exhaustive.
- **Substitute.** A move aimed at a Pokémon behind a Substitute reports whether the
  Substitute absorbs it entirely (a status move accomplishes nothing), breaks first
  (damage never reaches the holder this turn), or is bypassed by a sound move or
  Infiltrator. The tracker starts Substitute HP at floor(max HP / 4), keeps a range
  after observed hits, handles explicit transfers, and clears it on break/switch.
  `damageRange.substituteDamage` reports shield damage and whether it breaks; a
  break is never called a KO and excess single-hit damage does not spill through.
  Critical, multihit or otherwise unmodeled hits leave a conservative HP interval.
- **Why an estimate is missing.** A null damage range, threat or matchup never means
  safety. `estimatesUnavailable` gives the state-wide cause and `damageUnavailable` any
  move-specific one, because a silently empty evaluation reads as an absence of danger
  and leaves whatever is still populated looking like the only option.
- **What a switch costs.** Switching forfeits the turn, so `incomingThreatIfWeStayIn` is
  the comparison and a switch target's damage is `ourBestDamageFromNextTurn`, not something
  comparable with a move's `damageRange`. `turnsOurActiveHasBeenIn`, `ourActiveJustSwitchedIn`
  and a target's `wasActiveTurnsAgo` say whether switching would undo the last one. A forced switch is framed explicitly:
  after a faint the active slot still holds the fainted Pokémon, so a speed relation or
  incoming threat computed from it would be meaningless — both are null, and
  `stayingInIsNotAnOption` states why beside them rather than leaving nulls that read as
  safety. The per-switch matchups still carry real numbers, which is what the choice
  should turn on.

One decision is not left to the model. A Pokémon that only just arrived, still facing the
opponent it was sent in to answer, switching again spends a second turn on a matchup already
chosen and gives up another free hit; repeated, it is a loop that never attacks. Describing
that cost in the payload did not stop it, so `cyclicSwitch` recognises the shape directly and
the decision loop skips it — taking the provider's **next-ranked action** rather than
substituting a choice of its own, so the model's judgement still decides. The skip is recorded
as `skippedCyclicSwitch` on the decision and reported in the status log.

Switching into a Pokémon that every sampled set knocks out on entry is *not* guarded, even when
another switch target would survive. An earlier guard skipped it, but a deliberate sacrifice can
buy a free replacement after the opposing attack, so entry death is a cost the model weighs
rather than proof the switch is dominated. The payload marks it as `knockedOutOnEntry` and the
loop sends it unchanged.

The cycle guard is deliberately narrow, because double switching is ordinary play. It never applies to a
forced switch, nor once a Pokémon has settled in, nor when the opposing Pokémon has changed
since we arrived — re-pivoting against a new opponent is a real decision — nor when staying in
is a certain knockout, which is worth a turn to escape. Actions are never removed from the
payload: the model still sees and ranks every legal option, and `wouldUndoLastSwitch` marks the
ones the guard would skip.

Hidden-set inference also learns from the battle itself. Observed turn order
eliminates sampled spreads that could not have produced it, and observed damage
eliminates sampled sets outside the roll envelope; a fainting target censors overkill,
so damage only ever yields a lower bound. Critical hits, extra hits, interrupting
effects, residual `[from]` damage, Illusion and Transform discard the observation
instead of attributing it. Every deduction is recorded with the candidate counts before
and after.

Ruling out *every* remaining set is treated as a contradiction rather than a deduction:
it means the model is wrong or the true set was never sampled, so nothing is eliminated,
the contradiction is counted in `evidenceContradictions`, and later estimates keep
working. The damage test also allows one HP of slack, because the damage formula rounds
at several steps and a single-point disagreement is model error, not evidence. Turn order
stays observable behind a Substitute, which changes no speeds; Slow Start's halving is
applied from its volatile, so it is modelled while it lasts and dropped when it expires.

This is **not complete hidden-state recovery**. Samples are not exhaustive or
probability estimates, and generation frequencies are marginal, not a posterior or a
model of what the opponent will choose. Unknown team members, team-generation
constraints, server updates and changed moves/identities remain unresolved.
Transform, unmodeled active volatiles, multihit and some
history-dependent moves return null damage. Switch matchups exclude the switch turn
itself: no entry abilities such as Intimidate, and the opponent may switch too.
Unsupported states and no compatible samples never silently fall back to an
invented set.

Data comes from [pkmn/randbats](https://github.com/pkmn/randbats), the public feed behind
Showdex and the Randbats Tooltip, plus the official Showdown role pools. All three
snapshots are dated 2026-09-22 and refresh with a script that validates the shape before
writing:

- `gen9-joint-sets.json` — the candidate pool: every complete (item, ability, moves, Tera)
  combination the dataset recorded, with the share of 600,000 generation draws that
  produced it. Because these are joint sets rather than marginals, each candidate carries
  a real `probability`, and a KO can be reported as probability mass rather than only as
  "some sampled rolls". `data/full` records no EVs or IVs, so each set is attributed to
  the roles whose pool could have produced it and takes their spread — random battles use
  85 EVs and 31 IVs except where a role overrides them. Where attributed roles disagree on
  the spread, every distinct spread is emitted and the probability is split by role weight
  rather than guessing. Refresh with `node scripts/fetch-randbats-sets.mjs`.
- `gen9-randbats-stats.json` — per-role move, item, ability and Tera frequencies, used for
  role compatibility and for the coarser `setPriors`. Roles that generate no item report
  the missing mass as `noItemProbability` rather than implying it away. Refresh with
  `node scripts/fetch-randbats-stats.mjs`.
- `gen9-sets.json` — the official
  [Showdown source](https://github.com/smogon/pokemon-showdown/blob/master/data/random-battles/gen9/sets.json)
  role pools, for compatible movepools, abilities and Tera types.

This replaced an earlier approach that resampled the generator locally with
`@pkmn/randoms`, 128 draws per species. That sampling missed 732 of the 5,802 recorded
joint sets across 97 species — as much as 108 of Mew's 177 — so the candidate pool could
omit the opponent's actual set, and the evidence layer could eliminate on a set that was
never sampled. The simulator is no longer needed to build the set data.

Production requests start at **reduced** detail within a 24,000-byte budget. Full
features remain available for local diagnostics only. The emergency minimal payload
retains all legal actions, damage, switch threats, turn order, setup warnings and
endgame context; it drops detailed set summaries and secondary projections and
names those omissions. The versioned instructions explicitly explain survival,
execution risk, endgame, Substitute, effects and guards. Successful decisions log
`instructionsVersion`, `payloadDetail` and `payloadBytes`.

A third runtime guard skips narrowly dominated simple attacks using Jev's next
ranked non-guarded legal action. It compares every modeled set and requires equal
accuracy, priority, relevant effects and Tera cost, with no PP disadvantage. It
never invents an action and logs `skippedDominatedMove`. Different useful effects
remain a choice: Flamethrower's burn prevents treating Hydro Steam's extra damage
as strict dominance against a healthy, unstatused target. A separate
`strongerImmediateDamageAvailable` comparison makes that tradeoff explicit.

Before restarting on new code, run `npm run preflight` (or `npm run preflight -- 60` for more games). It rebuilds
the recent logged decisions with the current build and the live `.env`. It reports the payload tier split against
what was played, payload sizes, build errors, whether our own active Pokémon can be modelled, missing estimates, and
which guards would now change a logged choice. It warns, and exits non-zero, when more decisions fall to the minimal
tier or anything fails to build.

`npm run build && node scripts/audit-decisions.mjs` replays every retained decision
state in `logs/` through current features without API calls, and rewrites `docs/DECISION-AUDIT.json`. See `docs/DECISION-AUDIT.json`
for budget counts and historical choice flags. Reconstructed requests can lack PP;
this audit does not rerun Jev or measure the prompt's effect on winning.

Snapshots mark turn starts, private requests and battle end. Rejoins can append
replayed snapshots; observation logs are not deduplicated analytics.

The feature layer is deterministic, so `node scripts/inspect-battle.mjs logs/<file>.jsonl`
rebuilds exactly what was sent for every decision in a recorded battle and prints the
deductions, the choices, and the model's confidence against uniform; add `turn <n>` for
one turn's full payload. Exclusions already recorded in a log carry over, so a replay
shows the evidence as it stood at the time rather than as the current code would derive
it. Because the calculator matches items and abilities by display name while private
requests supply IDs, both are resolved through the dex before any calculation, and an
unrecognised name declines the estimate rather than being silently dropped.

## TypeSafe Jev

See [Jev setup and API contract](docs/JEV.md) for complete details. Get a key from
[TypeSafe's console](https://console.typesafe.ai), and add it to `.env` locally.
Do not paste keys into chat.

```dotenv
BATTLE_MODE=jev
TYPESAFE_API_KEY=your-key
JEV_MODEL=jev-latest
JEV_MAX_CALLS_PER_BATTLE=60
JEV_TIMEOUT_MS=3000
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

## Modules

- `src/showdown/`: connection, authentication, challenge gate, protocol/HP parsing.
- `src/battle/`: observable state, tracker, manager, legal actions and decision loop.
- `src/decisions/`: provider interface, random provider and TypeSafe Jev provider.
- `src/pokemon/` and `src/strategy/`: data-backed mechanics and concise model features.
- `src/logging/`: local JSONL snapshots, decisions and safe status events.
- `src/config/`: validated environment settings.
- `test/`: fixtures and tests for critical request, state and lifecycle logic.
- `scripts/test-simulator.mjs`: optional complete-battle simulator harness.

Next: validate real account/API access, improve mechanics coverage, then evaluate
decision quality before adding hierarchical strategy or opponent modeling.

## Protocol sources

- [Official Showdown protocol](https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md)
- [Battle protocol and choices](https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md)
- [Authoritative choice implementation](https://github.com/smogon/pokemon-showdown/blob/master/sim/side.ts)
- [Request generation](https://github.com/smogon/pokemon-showdown/blob/master/sim/pokemon.ts)
- [Current challenge messages](https://github.com/smogon/pokemon-showdown/blob/master/server/ladders-challenges.ts)
- [Server request/reconnect handling](https://github.com/smogon/pokemon-showdown/blob/master/server/room-battle.ts)
