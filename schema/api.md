# The HTTP contract — `site/api.php` (hosted) and `collector/serve.mjs` (local)

Both serve **the same paths with the same shapes**, so `site/` has exactly one code path. Locally
there is no password: `whoami` says `authed: true, local: true` and `login` / `logout` are no-ops.

All responses are JSON with `Cache-Control: no-store`, except `state?project=` which also sends an
`ETag` and answers `If-None-Match` with `304`.

| Request | Success | Failure |
|---|---|---|
| `GET api.php?action=whoami` | `200 {"authed": bool, "local": bool, "home": bool}` — `home`: the visitor is on a network the collector pushed from in the last 12 h (hosted only; the local view omits it) | — |
| `POST api.php?action=login` body `{"password": "…"}` | `200 {"ok": true}` + session cookie (`HttpOnly; Secure; SameSite=Strict`) | `401 {"error": "wrong", "remaining": n}` · `429 {"error": "locked", "retryAfter": seconds}` after 5 wrong tries, for 15 min |
| `POST api.php?action=logout` | `200 {"ok": true}` | — |
| `GET api.php?action=state` | `200` index — `schema/index.schema.json` | `401 {"error": "auth"}` |
| `GET api.php?action=state&project=<id>` | `200` snapshot — `schema/snapshot.schema.json`, `ETag` · `304` | `401` · `404 {"error": "unknown project"}` |
| `POST api.php?action=push` `Authorization: Bearer <token>`, body = one snapshot | `200 {"ok": true}` — writes `data/projects/<id>.json` atomically, rebuilds `data/index.json`, sets that project's index `at` to the receive time | `401 {"error": "auth"}` · `400 {"error": "invalid", "detail": "…"}` · `413` over 512 KB |

Hosted `api.php` needs **PHP ≥ 8.1**. The `Bearer` scheme word is matched case-insensitively.

The site polls `state?project=<current>` every 5 s and `state` (the index, for tab counts) every
15 s, and stops polling while `document.hidden`.

The pusher sends a snapshot when it changed (ignoring `at`) or 60 s have passed, at most once per 2 s per
project, with exponential backoff on failure (2 s → 60 s cap).

## Freshness, retirement and size (added after the pass-2 collector review)

- **Heartbeat.** The pusher sends each project at least every 60 s even when nothing changed.
  The server sets that project's `projects[].at` in the index to the time it received the push
  (locally: the collector's last successful tick). The site marks a project whose `at` is more than
  180 s old as **feed down** — on its tab and over the floor — rather than letting timers run on.
- **Retirement.** When a project's last session ends, the collector pushes one snapshot with
  `sessions: []`, so the hosted page never keeps ghost workers.
- **Size.** The collector keeps every snapshot under 400 KB (dropping finished agents, then the
  oldest-active agents of the largest crews). `413` is not retried.
- **Unknown numbers.** `tokens` and `costUSD` are `null` when the collector could not see the
  whole story (a transcript first read from its tail). The site shows "—", never a partial sum.

## The demo (`site/lab/sim.mjs`)

A visitor who is neither signed in nor `home` gets the demo: `app.js` answers its own `api()` calls
from a simulation in the browser, with the same shapes as above, and never calls `state` on the
server. `?demo=1` forces it; `?signin=1` shows the sign-in plate instead. Each accepted `push`
records a hash of the sender's network in `data/home.json` (kept 12 h) — that is what `home` checks.
`home` decides which screen is shown, never access: `state` still needs the session.

## Local-only differences (`collector/serve.mjs`)

- `push` needs no bearer, and only stores project ids the collector does not produce itself
  (so a fixture can be loaded for testing); its store is capped.
- Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` get `421` — a DNS-rebinding
  page must not be able to read the local view.
