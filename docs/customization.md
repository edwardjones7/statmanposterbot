# Customisation

Most changes are config. Run `npm run preview -- --samples` or `npm run preview -- <tweet url>` to see the effect before deploying. See [operations → deploying changes](operations.md#deploying-changes) for how each change goes live.

## Branding: `brand.json`

Used by both the render job (images) and the Worker (captions and time zone), so **deploy both** after changing it.

| Field | Meaning |
|---|---|
| `clientName` | Brand name |
| `colors.canvas` | Background behind the card |
| `colors.card` · `border` · `divider` | Card fill, outline, and the line above the date |
| `colors.heading` · `text` · `secondary` | Display name, tweet text, and handle/date. Keep `secondary` readable; it isn't a decorative grey |
| `colors.accent` | @mentions, #hashtags and links |
| `texture` | Tiled background image (the candlestick motif, `assets/candles.svg`). Empty = none |
| `footer.text` · `footer.logo` | Shown under the card (e.g. `@edthestatman` + `assets/logo.png`). Both empty = no footer |
| `emoji` | `"apple"` or `"twemoji"`: the emoji artwork drawn into images |
| `monoNumbers` | Set records, odds, lines and percentages (`27-13`, `+7 (-115)`, `.700`) in JetBrains Mono |
| `showDate` · `timeZone` | Show the tweet time on the card, in this IANA zone (`America/New_York` = US Eastern, EST/EDT by season) |
| `caption.signoff` | Line appended to template captions |
| `caption.hashtags` | Always added. Sport tags (`#NFL`, `#CBB`, …) are added when the tweet mentions the sport |

The values come from the EdTheStatMan design system: navy ground `#071219`, teal `#2DD4BF` as the only accent, Outfit for display, Inter for body, JetBrains Mono for numbers.

> **Emoji licensing:** Apple's emoji artwork is Apple's copyright. Using it in organic posts is common and not enforced in practice, but use `"twemoji"` (CC-BY) for anything run as a paid ad.

### Card layout

The design lives in `src/render/card.ts`: sizes, spacing, corner radius and the footer. The text size is chosen by measuring the laid-out text at each size from 60 px down to 28 px, keeping the largest that fits. In a carousel every slide shares the smallest size needed and the tallest card height, so the card doesn't jump around between swipes.

Card corners are 28 px on the 1080 px canvas. That displays as roughly 10 px on a phone, matching the design system's 10 px cap.

## Caption voice: `src/voice.ts` and `src/caption.ts`

- **`VOICE`** describes the brand and lists the allowed calls to action. The AI ends every caption with exactly one of them.
- **`BANNED_PHRASES`** is a list of regexes. Any AI caption matching one ("lock", "guaranteed", "can't lose", "free money"…) is rejected. Add to it freely.
- **`SYSTEM_PROMPT`** in `caption.ts` holds the writing rules: the hook line, short paragraphs, no invented facts, no hashtags or URLs.

The number check isn't configurable on purpose. Every number in an AI caption must appear in the tweet.

### Changing the AI model

Set `CAPTION_MODEL` in `wrangler.jsonc` to any Workers AI text-generation model, then deploy. To see the available models:

```bash
npx wrangler ai models | grep "Text Generation"
```

Larger models write better but use more of the free daily allowance (10k "neurons"). Llama 3.3 70B uses about 100 per caption.

## Watching a different account

Set `WATCH_HANDLE` in `wrangler.jsonc` and deploy. On its first run the watcher only records the newest post, so it won't replay history. To force a fresh start, delete the stored position:

```bash
npx wrangler d1 execute statmanposterbot --remote --command "DELETE FROM settings WHERE key='watch_since_id'"
```

Leave `WATCH_HANDLE` empty to disable watching entirely. `/watch off` pauses it without a deploy.

## Who can use the bot

`TELEGRAM_ALLOWED_USER_IDS` is a comma-separated list of numeric Telegram user IDs. To add someone, have them message the bot, get their ID (see [setup step 2](setup.md#2-create-the-telegram-bot)), then run `npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS` with the updated list.

New-post notifications and alerts go to the **first** ID in the list.
