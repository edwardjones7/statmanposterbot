# statmanposterbot

Tweet → Instagram pipeline for EdTheStatMan.

Paste a tweet link into Telegram, or tap Build on a new post the bot spotted → get a branded 1080×1350 image + AI caption → approve → it posts to Instagram.

Bot commands: `/watch on|off` (offer new @EdTheStatMan posts automatically), `/single <link>`, `/instagram`.

## Status

| Step | | |
|---|---|---|
| 1 | Card renderer (Satori + resvg WASM) | ✅ |
| 2 | Tweet fetching + thread → carousel | ✅ |
| 3 | Telegram bot + approval flow | ✅ |
| 4 | AI captions (Cloudflare Workers AI) | ✅ |
| 5 | Instagram publishing (Instagram Login API) + manual fallback | ✅ first post 2026-09-27 |
| 6 | Token refresh cron, alerts, duplicate protection | 🟡 token refresh, render watchdog, no double-posting done |
| 7 | Watch for new posts (FxTwitter timeline, every 5 min) | ✅ |

## Architecture ($0)

```
Telegram ──link──► Cloudflare Worker (free) ──workflow_dispatch──► GitHub Actions
                   · Telegram webhook                               · fetch tweet
                   · approval buttons                               · render PNG(s) (~1.5s CPU each)
                   · AI caption (Workers AI)                        · send slides to Telegram
                   · KV: slide images                               · upload slides to Worker
                   · Instagram publish + manual fallback
                   · D1: job state, IG token; cron: token refresh + watchdog
```

Rendering can't run on the Worker: the free plan allows 10ms CPU per request, and a
slide takes ~1.5s. Everything else is network-bound, which doesn't count toward that limit.

Tweet data comes from X's embed endpoint; long-form (Premium) tweets fall back to
FxTwitter (`api.fxtwitter.com`) for the full text. Both are unofficial and free.

## Preview the card design locally

```bash
npm install
npm run preview -- https://x.com/jack/status/20      # real tweet
npm run preview -- --thread <last tweet url>          # thread → carousel
npm run preview -- --samples                          # offline edge cases
npm run preview -- --samples --twemoji                # compare emoji sets
```

PNGs are written to `out/`.

## Branding — `brand.json`

Values come from the EdTheStatMan design system (`.claude/context/brand-kit.md`).

| Field | Meaning |
|---|---|
| `colors.*` | Canvas, card, border, divider, heading, body text, secondary text, accent (links/@/#) |
| `texture` | Tiled background texture (the candlestick motif). Empty hides it |
| `footer.text` | Text under the card, e.g. `@edthestatman`. Empty hides it |
| `footer.logo` | Path to a logo file (PNG/SVG), relative to the project root |
| `emoji` | `apple` or `twemoji` artwork baked into the image |
| `monoNumbers` | Set stat-like numbers (records, %, odds, lines) in JetBrains Mono |
| `showDate` / `timeZone` | Show the tweet timestamp, in this IANA time zone |

## Layout

- `src/tweet/fetch.ts` — fetches tweets (X embed endpoint, FxTwitter for long-form)
- `src/tweet/thread.ts` — rebuilds a thread from its last tweet
- `src/render/card.ts` — the card design
- `src/render/render.ts` — card → SVG → PNG (runtime-agnostic, runs in Node and Workers)
- `src/platform/node.ts` — loads fonts/WASM/brand from disk for local scripts
