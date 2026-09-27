# Setup

This guide deploys the whole system from scratch. It takes about an hour, and most of that is clicking through the Meta developer dashboard. Everything used here is free and needs no credit card.

**You'll need:**
- Node.js 22+ and git
- A **GitHub** account. The repo should be public for unlimited free Actions minutes; private works too, with 2,000 minutes a month.
- A **Cloudflare** account (free plan)
- **Telegram** on your phone
- The **Instagram** account to post to. It must be a Professional account (Business or Creator). No Facebook Page is needed.
- A **Meta** account for developers.facebook.com

---

## 1. Get the code

```bash
git clone https://github.com/edwardjones7/statmanposterbot.git
cd statmanposterbot
npm install
npm run preview -- https://x.com/EdTheStatMan/status/2102175703781224462
```

The last command renders a tweet into `out/`. If you get a PNG there, rendering works on your machine.

## 2. Create the Telegram bot

1. In Telegram, message **@BotFather**, send `/newbot`, and follow the prompts. Copy the token it gives you.
2. Message your new bot once (anything, e.g. "hi").
3. Find your numeric user ID. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and look for `"from":{"id":…`. The bot will only respond to IDs you list.

## 3. Create `.dev.vars`

This file holds all the secrets on your machine. It's git-ignored, so **never commit it, and never paste its contents into chats or issues.**

```ini
TELEGRAM_BOT_TOKEN=<from BotFather>
TELEGRAM_ALLOWED_USER_IDS=<your numeric id; comma-separate several>
TELEGRAM_WEBHOOK_SECRET=<random string, see below>
JOB_CALLBACK_SECRET=<another random string>
GITHUB_TOKEN=<added in step 5>
IG_ACCESS_TOKEN=<added in step 7>
```

Generate the two random strings with:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

## 4. Cloudflare: storage, database and the Worker

```bash
npx wrangler login
npx wrangler kv namespace create STORE          # prints an id
npx wrangler d1 create statmanposterbot         # prints a database_id
```

Then edit `wrangler.jsonc`:
- Put the KV `id` and the D1 `database_id` in their bindings.
- Set `GITHUB_REPO` to your `owner/repo`.
- Set `WATCH_HANDLE` to the X account to watch. Leave it empty to disable watching.

Create the tables and deploy:

```bash
npx wrangler d1 migrations apply statmanposterbot --remote
npx wrangler deploy
```

The deploy prints the Worker's URL, e.g. `https://statmanposterbot.<your-subdomain>.workers.dev`. Put that URL in two places:
- `WORKER_URL` in `wrangler.jsonc`, then run `npx wrangler deploy` again
- the `WORKER_URL` default in `.github/workflows/render.yml`

Upload the secrets you have so far. `IG_ACCESS_TOKEN` and `GITHUB_TOKEN` come later.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put TELEGRAM_ALLOWED_USER_IDS
npx wrangler secret put JOB_CALLBACK_SECRET
```

Each command asks you to paste the value. Check it's up with `curl <WORKER_URL>/`, which should reply `statmanposterbot ok`.

## 5. GitHub: the render job

1. Push the repo to GitHub.
2. **Create a token for the Worker** so it can start render jobs. Go to GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:
   - Repository access: **only this repo**
   - Permissions → Repository → **Actions: Read and write**. Nothing else.

   Save it as `GITHUB_TOKEN` in `.dev.vars`, then run `npx wrangler secret put GITHUB_TOKEN`.
3. **Give the render job its secrets.** Go to Repo → Settings → Secrets and variables → **Actions** → **Repository secrets** (not Environment secrets) → New repository secret:
   - `TELEGRAM_BOT_TOKEN`
   - `JOB_CALLBACK_SECRET` (the same value as the Worker's)

> ⚠️ **Environment secrets don't work here.** They're invisible to this workflow, which then fails with `Missing env var TELEGRAM_BOT_TOKEN`.

## 6. Point Telegram at the Worker

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<WORKER_URL>/telegram","secret_token":"<TELEGRAM_WEBHOOK_SECRET>","allowed_updates":["message","callback_query"],"drop_pending_updates":true}'
```

Send the bot a tweet link. You should get "⏳ On it…", then the slides about a minute later, then a caption preview with buttons. At this stage **✅ Post** hands you the files to post manually, because Instagram isn't connected yet.

## 7. Connect Instagram

This uses the **Instagram API with Instagram Login**, which needs no Facebook Page. Meta renames things often, so treat the labels below as approximate.

1. **Account type.** In Instagram, go to Profile → ☰ → Account type and tools. The account must be **Professional**; switching is free.
2. **Create the app.** At developers.facebook.com, go to **My Apps → Create app** and choose the use case **"Manage messaging & content on Instagram"**. Skip connecting a business portfolio.
3. **Permissions.** Go to Use cases → **Customize** → **Permissions and features**, and click **Add** on exactly:
   - `instagram_business_basic`
   - `instagram_business_content_publish`

   The "Add all required permissions" button on the setup page adds *messaging* permissions, which you don't need.
4. **Tester role.** Go to App roles → **Roles** → Add people → **Instagram Tester** and enter the account's username. Then, logged in as that account, accept the invite at **instagram.com/accounts/manage_access → Tester invites**.
5. **Token.** Go to Customize → **API setup with Instagram login** → **2. Generate access tokens** → **Add account**, log in, then click **Generate token**. The section starts collapsed, so click "See more" if it's hidden.
6. Save the token as `IG_ACCESS_TOKEN` in `.dev.vars` and run `npx wrangler secret put IG_ACCESS_TOKEN`.
7. Send the bot `/instagram`. It should reply "connected as @yourhandle".

The app stays in **development mode**, and no Meta app review is needed, because it only posts to accounts with a role on the app. The token is valid for 60 days, and the Worker refreshes it weekly (see [operations](operations.md#instagram-token)).

## 8. Smoke test

1. Send a tweet link, check the preview, and tap **✅ Post**. You should get "🎉 Posted to Instagram!" with the link.
2. Send `/watch`. It should say it's watching. The next post from `WATCH_HANDLE` arrives within about 3–8 minutes.

---

## Local development

The whole bot can run on your machine and be used from your phone with no deploy. The dev bridge polls Telegram, which stands in for the webhook, and runs render jobs locally, which stands in for GitHub Actions.

1. Add to `.dev.vars`:
   ```ini
   DEV_DISPATCH_URL=http://localhost:8788
   ```
   Never set this on the deployed Worker.
2. Telegram only delivers updates one way at a time, so **remove the webhook while you develop**:
   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
   ```
3. Run each of these in its own terminal:
   ```bash
   npm run worker:dev     # the Worker, with local D1/KV (Workers AI still runs remotely)
   npm run dev:bridge     # Telegram ↔ local Worker, render jobs on this PC
   ```
4. When you're done, set the webhook again (step 6). **Until you do, the deployed bot won't receive any messages.**

The local D1 database starts empty. Apply the migrations to it once with `npx wrangler d1 migrations apply statmanposterbot --local`.

## Secrets and config reference

| Name | Where | What it's for |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Worker secret + GitHub secret | Talking to Telegram |
| `TELEGRAM_WEBHOOK_SECRET` | Worker secret | Proves webhook calls come from Telegram |
| `TELEGRAM_ALLOWED_USER_IDS` | Worker secret | Who the bot answers |
| `JOB_CALLBACK_SECRET` | Worker secret + GitHub secret | Lets only the render job upload slides and report back |
| `GITHUB_TOKEN` | Worker secret | Starting render jobs (fine-grained, Actions read/write only) |
| `IG_ACCESS_TOKEN` | Worker secret | Seeds the Instagram token, which the Worker then refreshes and stores in D1 |
| `GITHUB_REPO` | `wrangler.jsonc` var | Which repo's workflow to dispatch |
| `WATCH_HANDLE` | `wrangler.jsonc` var | X account to watch (empty = off) |
| `WORKER_URL` | `wrangler.jsonc` var + workflow default | The Worker's public URL (Instagram fetches slides from it) |
| `CAPTION_MODEL` | `wrangler.jsonc` var | Workers AI model for captions |
| `DEV_DISPATCH_URL` | `.dev.vars` only | Local development only |
