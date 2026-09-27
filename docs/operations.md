# Operations

Day-to-day use, what the bot's messages mean, and what to do when something breaks.

## Daily use

### When a new post appears (watching)

About 3–8 minutes after @EdTheStatMan posts, the bot sends:

> 🆕 New post from @EdTheStatMan · Sep 21, 7:18 PM EDT
> *(the post's text)*

| Button | Does |
|---|---|
| 🎨 **Build it** / **Build thread** | Starts the pipeline. A thread becomes a carousel |
| 1️⃣ **First tweet only** | Builds just the first tweet of a thread. Use it for posts followed only by a promo reply |
| ⏭ **Skip** | Does nothing. The post is never offered again |

The delay is deliberate. The watcher waits until a post is 3 minutes old so a thread isn't offered half-posted. Replies to other people and reposts are ignored.

### Building from a link

Send a tweet link, or `/single <link>` for just that tweet. Threads are built from their **last** tweet's link.

### The preview

About a minute after Build, you get the slides and then a caption preview:

| Button | Does |
|---|---|
| ✅ **Post** | Publishes to Instagram and replies with the post link |
| ✏️ **Edit caption** | Sends the current caption for you to copy. Your **next message** becomes the new caption (within an hour) |
| 🔄 **New caption** | Asks the AI for a different version |
| ❌ **Reject** | Nothing is posted |

A line starting **"ℹ️ Template caption used"** means the AI caption failed a check. Usually it contained a number that isn't in the tweet, or banned wording such as "lock". The reason is shown, and you can tap 🔄 to try again.

### If Instagram refuses a post

You get the reason, the full-quality image files, the caption as its own message, and:

| Button | Does |
|---|---|
| 🔁 **Try again** | Retries publishing |
| ✔️ **I posted it manually** | Marks it done after you've posted the files yourself |
| ❌ **Reject** | Drops it |

### Commands

| Command | Does |
|---|---|
| `/watch on` · `/watch off` · `/watch` | Turns new-post notifications on or off, or shows their status |
| `/instagram` | Shows whether Instagram is connected and roughly how many days the token has left |
| `/single <link>` | Builds just this tweet |

---

## Alerts the bot can send

| Alert | Meaning | What to do |
|---|---|---|
| ❌ *The render job for this link didn't finish* | A GitHub Actions render didn't report back within 5 minutes | Open the run log (the link is in the message). See [troubleshooting](#troubleshooting) |
| ❌ *Couldn't start the render job (HTTP 401)* | The Worker's `GITHUB_TOKEN` expired or was revoked | [Replace the GitHub token](#github-token) |
| ❌ *Couldn't make that post* | The render job hit an error, such as a deleted tweet or a private account | Read the error. Deleted or protected tweets can't be built |
| ⚠️ *Couldn't refresh the Instagram access token* | The weekly refresh failed. The bot retries daily | If it repeats for days, [replace the token](#instagram-token) |
| ⚠️ *Can't check @… for new posts* | The timeline source (FxTwitter) has failed for about 30 minutes | Nothing, usually. It retries automatically, and pasting links still works |

---

## Credentials and their lifetimes

### Instagram token

- Valid 60 days from its last refresh. The Worker's cron refreshes it **weekly** and stores the current token in D1.
- `/instagram` shows about how many days it has left.
- **To replace it** (after a failed-refresh alert, or if Instagram disconnects the app):
  1. developers.facebook.com → your app → Use cases → Customize → **API setup with Instagram login** → Generate token.
  2. Save it in `.dev.vars` as `IG_ACCESS_TOKEN`, then run `npx wrangler secret put IG_ACCESS_TOKEN`.
  3. The Worker notices the new secret on its next use and replaces the stored token. Check with `/instagram`.

### GitHub token

Fine-grained tokens expire on the date you chose when creating them. When one does, render jobs fail to start with HTTP 401. To replace it, generate a new one with **Actions: Read and write** on this repo only, then run `npx wrangler secret put GITHUB_TOKEN`.

### Telegram bot token

Rotate it if it ever leaks, for example if it's pasted somewhere public:

1. @BotFather → `/revoke` → pick the bot → copy the new token.
2. Update it in three places:
   - `.dev.vars`
   - `npx wrangler secret put TELEGRAM_BOT_TOKEN`
   - GitHub → Settings → Secrets and variables → Actions → `TELEGRAM_BOT_TOKEN`
3. Re-register the webhook with the new token ([setup step 6](setup.md#6-point-telegram-at-the-worker)).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| "⏳ On it…" then nothing | Render job failed before it could report | GitHub → Actions → **render** → the latest run's log |
| Run log shows `Missing env var TELEGRAM_BOT_TOKEN` | Secrets saved as **Environment** secrets, or under Codespaces/Dependabot | Re-add them as **Actions → Repository secrets** |
| Slides arrive but no caption/buttons | The job couldn't reach the Worker | Check `WORKER_URL` in the workflow, and that `JOB_CALLBACK_SECRET` matches on both sides |
| A button replies "Already posted/rejected/…" | That job was already handled | Nothing to do. This is the double-post protection |
| A button replies "That post has expired" | The job isn't in the database | Build it again from the link |
| No new-post notifications | Watching is off, or the timeline source is down | Send `/watch`. If it's on, check the logs for `timeline poll failed` |
| The bot doesn't respond at all | Webhook not set, or you're not in `TELEGRAM_ALLOWED_USER_IDS` | `https://api.telegram.org/bot<TOKEN>/getWebhookInfo` should show the Worker URL. Also check you haven't left it deleted after local development |
| Instagram error `(code 190)` | The Instagram token expired or was revoked | [Replace the Instagram token](#instagram-token) |
| Instagram error about the image URL | Instagram couldn't fetch the slide | Open `<WORKER_URL>/media/<job id>/1.jpg` in a browser. Slides are kept for 30 days |

### Looking inside

```bash
npx wrangler tail                                   # live Worker logs
npx wrangler d1 execute statmanposterbot --remote --command \
  "SELECT id, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 10"
npx wrangler d1 execute statmanposterbot --remote --command \
  "SELECT key, datetime(updated_at/1000,'unixepoch') FROM settings"
```

Render job logs live on GitHub under **Actions → render**. Each run is named after its job id.

---

## Deploying changes

| You changed | Deploy with |
|---|---|
| `worker/`, `src/caption.ts`, `src/voice.ts`, `src/instagram.ts`, `wrangler.jsonc` | `npx wrangler deploy` |
| `src/render/`, `src/tweet/`, `scripts/render-job.ts`, the workflow | `git push` (render jobs run from `main`) |
| `brand.json` | **both**: the render job uses it for the images, the Worker for captions and time zone |
| `migrations/` | `npx wrangler d1 migrations apply statmanposterbot --remote`, then deploy |

Run `npm run typecheck` before deploying. It checks both the Node side and the Worker.

## Limits to keep in mind

- **Instagram:** 100 API posts per 24 hours.
- **Workers AI:** about 100 captions a day on the free tier. After that, captions fall back to the template.
- **KV:** 1,000 writes a day, one per slide. That's roughly 100–1,000 posts a day depending on carousel size.
- **Slide images** expire after 30 days, so a post has to be published within 30 days of being built. Job records stay in D1.
