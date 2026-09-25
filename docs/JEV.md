# TypeSafe Jev integration

The implementation follows the official [HTTP API reference](https://docs.typesafe.ai/api)
and [Choice primitive](https://docs.typesafe.ai/primitives/choice), inspected on
2026-09-22. It uses TypeSafe directly, not community proxy services.

## Contract

- POST `https://api.typesafe.ai/v1/systemone`, bearer authentication.
- Request: `model`, structured `state`, and `questions.battle_action` with
  `type: "choice"`, `instructions` and a `criteria` map of legal action IDs.
- Response: `answers.battle_action` with `type`, `choice`, `confidence`, and
  `probabilities`; `usage.input_tokens` and `usage.output_tokens` report usage.
- Choice supports at most 255 options. Larger action sets use local fallback.
- Model defaults to the documented `jev-latest` alias.

Validation rejects unknown actions, missing/extra distribution entries, non-finite
or out-of-range probabilities/confidence, a distribution not approximately summing
to one, or a selected action that is not maximal. The engine validates the choice
again against the latest Showdown request before sending it.

## Configure and test

Get your key from [TypeSafe's console](https://console.typesafe.ai). Put it in `.env`:

```dotenv
TYPESAFE_API_KEY=your-key
JEV_MODEL=jev-latest
JEV_MAX_CALLS_PER_BATTLE=60
JEV_TIMEOUT_MS=6000
```

The timeout guards the tail, not the median. Across three live battles the median decision
took 455 ms and the 90th percentile 1.5 s, but the slowest reached 3.1 s and was cut off by
the previous 3 s setting, falling back to a random choice. Input tokens per call grew from
about 4,800 to 9,200 as the payload gained evaluations, so the tail grew with it.

Run `npm run smoke:jev` for one paid request using a synthetic two-action battle.
It requires no Showdown credentials. The command uses its own one-call limit and
five-second deadline; it is an explicit API test even if `DRY_RUN=true`.
Successful output contains `jev smoke passed`, a validated decision and usage.
A failure exits with code 1 and safe error text.

For a live challenge, also configure Showdown credentials and:

```dotenv
BATTLE_MODE=jev
DRY_RUN=false
ACCEPT_CHALLENGES_FROM=YourHumanAccount   # or * for whoever challenges first
SHOWDOWN_BATTLE_ROOM=
```

Run `npm run build` and `npm start`, then challenge the bot to Gen 9 Random Battle.
For an existing battle where the bot account is a player, clear the opponent setting
and set the battle room instead. A spectator receives no private choice requests.

To inspect choices without sending them, set `DRY_RUN=true`. Jev calls are also
disabled by default in this mode. Set `JEV_CALLS_IN_DRY_RUN=true` to explicitly
allow paid model calls while leaving battle choices unsent.

## Context and cost

Only compact battle facts and currently offered actions are sent. Account names,
credentials, chat and full protocol history are excluded. Hidden information stays
unknown; conditional type/STAB/field/hazard features are labeled. Each action also
carries deduced turn order, a damage envelope with a conditional KO label, listed
non-damage effects, whether a target's Substitute absorbs it, and — for switches —
incoming worst case, our best damage and the switch-in's speed relation. Where an
estimate could not be computed, its cause is stated rather than left blank. A shared `glossary` block states what each of those
is and is not, once per request rather than per action. This is an experimental
single-layer chooser, not a claim of competitive strength or a complete mechanics
engine.

One provider instance serves one battle. Every attempted HTTP request consumes
one call from `JEV_MAX_CALLS_PER_BATTLE`, including failures and cancellations.
A single legal action bypasses the API. There are no automatic retries; limits,
errors, oversized local payloads and unsupported option counts use random fallback.
The local JSON request budget is 24,000 bytes, not a documented TypeSafe API limit.
Production now starts with reduced detail; full detail is for local diagnostics.
The emergency minimal form drops detailed set summaries and secondary projections
but retains legal actions, damage, switch matchups, move order, setup warnings and
endgame context. Only an oversized minimal request falls back locally. Decisions
record the instruction version, actual detail tier and exact payload bytes.
Instructions live in `src/decisions/instructions.ts`; the offline 225-decision audit
is `scripts/audit-decisions.mjs` and never sends paid requests.

`JEV_INPUT_USD_PER_MILLION` and `JEV_OUTPUT_USD_PER_MILLION` may be set using your
actual account rates. Without both, estimated cost is unknown (`null`). Estimates
cover reported tokens only. Failed/cancelled calls can still incur charges without
returning usage; those mark `usageIncomplete=true`. Request cancellation does not
guarantee billing cancellation.

A schema-invalid response names the field that failed — `lastInvalidResponseReason` in
the provider counters, and a `jev_invalid_response` status distinct from a transport
`jev_failed` — with the offending value bounded to 120 characters and stripped of control
characters. Without that a bad reply is undiagnosable, since response bodies are not
retained.

Logs separate the selected action, sent command, response confidence/probabilities,
reported usage and provider counters. Model confidence is not battle win probability.
Tests use mock responses; a real-key smoke test is still required to verify access.
