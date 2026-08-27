# Stackfall

A turn-based, AI-narrated survival game for 1–6 players, built from your SRS —
**running entirely on free tiers, no credit card required anywhere.**

## The free stack, and why

| Piece | What it needs to do | Free service used | Cost |
|---|---|---|---|
| Hosting the site | Serve the HTML/CSS/JS | **GitHub Pages** | Free, no limit for a project this size |
| Login + cloud save | Store users, sessions, health, story state, synced live | **Supabase** (Postgres + Auth + Realtime) | Free tier: 500MB DB, 50K monthly active users |
| AI story engine | Write the narrative each turn, without exposing a secret key in the browser | **Supabase Edge Functions** calling **DeepSeek's API** | Requires a DeepSeek API key; usage stays server-side |
| Source control | What you asked to publish through git | **GitHub** | Free |

Nothing here requires entering a credit card. Supabase's free "Edge Functions" are what
make this possible without Firebase's paid Blaze plan — they're genuinely free up to a
generous monthly quota, not a trial.

The trade-off: DeepSeek usage has **rate limits**, so this is
great for personal use / playing with friends, but isn't meant for heavy simultaneous
traffic. If you ever outgrow it, swapping the two `fetch` calls in
`supabase/functions/_shared/storyteller.ts` for another model is the only change needed later.

---

## 0. What you need before starting

- [Node.js](https://nodejs.org) 20+ (`node -v` to check) — only used to run the Supabase CLI
- Git installed (`git --version`)
- A free [GitHub](https://github.com) account
- A free [Supabase](https://supabase.com) account (sign in with GitHub is easiest)
- A [DeepSeek API key](https://platform.deepseek.com/api_keys)

Everything below runs in **VS Code's integrated terminal** (`` Ctrl+` `` / `` Cmd+` ``).

---

## 1. Open the project in VS Code

```bash
cd path/to/dnd-game
code .
```

---

## 2. Create the Supabase project

1. Go to https://supabase.com/dashboard → **New project**.
2. Pick an organization, name it (e.g. `last-ember`), set a database password (save it
   somewhere — you likely won't need it again), pick a region, **Free** plan → **Create**.
3. Once it's ready, go to **Authentication → Providers** and confirm **Email** is enabled
   (it is by default). Go to **Authentication → Settings** and turn **off** "Confirm
   email" if you want people to be able to sign up and play immediately without checking
   their inbox (fine for a game with friends; leave it on for a more locked-down setup).
4. Go to **SQL Editor → New query**, paste in the entire contents of
   `supabase/migrations/0001_init.sql` from this project, and click **Run**. This creates
   the `profiles`, `sessions`, and `players` tables with the correct security rules and
   turns on realtime sync for them.
5. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public**
   key. Paste them into `public/js/supabase-config.js` in VS Code, replacing the
   `REPLACE_WITH_...` placeholders.

---

## 3. Install the Supabase CLI and log in

```bash
npm install -g supabase
supabase login
```

This opens a browser to authenticate the CLI.

Link this folder to your project (find your **project ref** in the Supabase dashboard
URL, `https://supabase.com/dashboard/project/<this-part>`):

```bash
supabase link --project-ref YOUR_PROJECT_REF
```

---

## 4. Set your DeepSeek secret

These live only on Supabase's servers — never in your code, never in git:

```bash
supabase secrets set DEEPSEEK_API_KEY=your-deepseek-api-key-here
```

Rotate it later by re-running the same command and redeploying the functions.

---

## 5. Deploy the Edge Functions

```bash
supabase functions deploy generate-story
supabase functions deploy reset-session
supabase functions deploy assign-class
```

That's the entire "backend" — three small serverless functions, deployed straight from
your terminal, no server to manage.

---

## 6. Publish the site through Git → GitHub Pages

```bash
git init
git add .
git commit -m "Initial commit: Last Ember turn-based survival game"
```

Create an empty repo on GitHub:
1. https://github.com/new → name it (e.g. `last-ember`) → leave it empty → **Create repository**
2. Copy the URL it gives you, e.g. `https://github.com/yourname/last-ember.git`

Back in the terminal:

```bash
git branch -M main
git remote add origin https://github.com/yourname/last-ember.git
git push -u origin main
```

Now turn on GitHub Pages, pointed at the `public` folder:
1. On GitHub, open your new repo → **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Branch: `main`, folder: you'll need `public/` as the site root, but GitHub Pages'
   branch deploy only offers `/ (root)` or `/docs` — so run this once locally to rename it:

```bash
git mv public docs
git commit -m "Rename public/ to docs/ for GitHub Pages"
git push
```

4. Back in **Settings → Pages**, set folder to **`/docs`** → **Save**.
5. GitHub gives you a live URL like `https://yourname.github.io/last-ember/` within a
   minute or two. That's your free, cloud-hosted game.

From now on, whenever you make changes:

```bash
git add .
git commit -m "describe what changed"
git push
```

GitHub Pages redeploys automatically on every push to `main` — no separate deploy step,
unlike the Edge Functions (below).

If you change anything inside `supabase/functions/`, redeploy just that function:

```bash
supabase functions deploy generate-story
```

---

## How the pieces map to your requirements

| Your requirement | Where it lives |
|---|---|
| Login / accounts | Supabase Auth + `profiles` table (auto-created by a DB trigger on sign-up) |
| Cloud-persisted settings & game state | `profiles` and `sessions`/`players` tables in Postgres — same data from any device you sign into |
| Up to 6 players, turn order, health | `sessions`/`players` tables, enforced in `app.js` (join) and the Edge Functions (turn advance, health) |
| AI-generated branching story | `supabase/functions/generate-story`, calling DeepSeek server-side |
| Simple vs. animated UI, per-user, persisted | `preferred_ui_mode` column on `profiles`; theme applied via a body class in `style.css` |
| Last player standing wins, then resets | `generate-story` detects one player left, marks the session `completed`; the client shows the recap, then automatically calls `reset-session` a few seconds later |
| Master reset | `btn-master-reset-open` → modal → `master-reset` Edge Function, which wipes the session after verifying the user |

---

## Local testing before you deploy (optional)

```bash
supabase start
supabase functions serve
```

This spins up Postgres, Auth, and the functions locally with Docker. Open
`public/index.html` with any static server (e.g. the VS Code "Live Server" extension, or
`npx serve public`) and point `supabase-config.js` at the local URL/keys `supabase start`
prints out while testing.

---

## Notes / known limitations

- The DeepSeek API key lives only in Supabase's server-side secret
  store — never sent to the browser.
- Row Level Security policies restrict writes so a player can't directly edit their own
  health or someone else's; all health changes go through the Edge Functions.
- Joining a session does a read-then-write on the turn order rather than a database
  transaction (Supabase's REST layer doesn't expose client-side transactions) — with two
  people joining the exact same session in the same instant, one could theoretically be
  dropped from the turn order. Fine for casual play; if it matters to you, move the join
  logic into a Postgres function (`security definer`) for atomicity.
- This is a solid, working implementation of the SRS's core loop, not a pixel-perfect
  final product — FE-1 through FE-4 (inventory, co-op mode, avatars, sound) aren't built.
- DeepSeek is rate-limited — if multiple tables play at
  once and you hit the limit, story calls will briefly fail; the UI shows a retry message
  when that happens.
