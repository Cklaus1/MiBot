# MiBot — Opportunities (deferred-work sink)

> The curated input to the *next* build loop. Per `build-loop.md §10`, during a build run:
> - A newly-found **optimization** → one line here, **not acted on** (no failing test →
>   acting would violate the verification bar).
> - A newly-found **bug** → captured here as a candidate task with proposed severity,
>   **never** silently fixed outside the DAG.
> - Exception: a fix impossible without a minimal refactor may include that refactor (as an
>   `Rn`/`Fn` anticipates) — note it here rather than expanding scope silently.
>
> Format: `- [OPT|BUG] <where> — <what> · <proposed severity/effort or "opt">`

## Optimizations (deferred — do not act during build)
_(none yet — appended during the build loop)_

## Candidate bugs found during build (triage into a future DAG)
- [OPT] test isolation — db.test.ts / recording-status.test.ts / migrations(real-DB paths)
  all share the on-disk `~/.config/mibot/mibot.db`; observed one transient
  "1 failed | 4 skipped" run under full-suite concurrency that vanished on re-run
  (5× clean after). No production impact — purely a test-harness data-sharing race.
  Fix: point getDb() at a `MIBOT_DB_PATH` env override and give each suite a temp DB.
  · proposed P3/S (test-infra)

## Carried architecture items (out of current scope, tracked)
- [ARCH] control channel — no auth; local-only `0600` socket for now (hardening OQ7 /
  arch AQ4). Becomes mandatory if an `eval`/arbitrary-JS command is ever added (C16 removes
  it from the usage string). Revisit before exposing any code-execution command.
- [ARCH] AR1 (BrowserBackend unification) — largest structural change; its target bugs
  (M15, C5) are fixed tactically in waves 2–3, so AR1 is optional-within-scope and
  scheduled last. If deferred past this run, it lands here as the top item for the next.
- [ARCH] N1 transcription-provider interface, N2 platform-plugin registry, N3 signal event
  bus, N4 DI framework, N5 DB repository/ORM — explicitly rejected as YAGNI
  (architecture-spec NEGATIVES). Listed so they are not "re-discovered" as new ideas.
