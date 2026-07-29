# Selector overrides

MiBot scrapes participant names and the active-speaker overlay from each
platform's meeting UI. A subset of those selectors — the **obfuscated, minified
class names** that Google/Zoom generate (e.g. Meet's `.KV1GEc`) — change without
notice and are the biggest source of scraper breakage.

The bundled defaults live in `src/selectors.ts`. You can override them **at
runtime, without rebuilding**, by dropping a JSON file here:

```
~/.config/mibot/selectors/<platform>.json    # meet | teams | zoom
```

Copy an example to get started:

```bash
mkdir -p ~/.config/mibot/selectors
cp selectors/meet.json.example ~/.config/mibot/selectors/meet.json
```

## Format

Each file has two keys, and each is an **ordered fallback list** — MiBot tries
the first selector, then the next. Put stable semantic selectors (`data-*`,
`aria-*`) first and fragile minified classes last, so an obsolete class name
degrades instead of breaking scraping.

| Key | Used for |
|-----|----------|
| `participantNames` | Elements whose text/attributes yield participant names |
| `activeSpeaker` | Name-overlay selectors read via `textContent` (the fragile minified classes) |

```json
{
  "participantNames": ["[data-participant-id]", "[data-self-name]", ".zWfAib"],
  "activeSpeaker": [".KV1GEc", ".cS7aqe.NkoVdd"]
}
```

## Merge behavior

- A key you specify **replaces** that default list wholesale.
- A key you omit keeps its bundled default.
- Malformed JSON is ignored with a warning — MiBot falls back to defaults.

Stable attribute-based checks (e.g. Meet's `[data-self-name][data-is-speaking="true"]`)
are intentionally **not** overridable — they live in code because they rarely
change. Only the fragile overlay classes are exposed here.

## Finding a replacement selector

When a class name breaks, open the meeting in a real browser, use DevTools to
inspect the active-speaker overlay or a participant tile, and copy a stable
selector (prefer `data-*`/`aria-*` attributes over minified classes). Add it to
the front of the relevant list.
