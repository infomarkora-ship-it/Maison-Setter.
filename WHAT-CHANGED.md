# Maison Setter server 3.6 — what changed

One thing: a **"New in this build" tour on the Overview page** — because the fastest way to see every
new feature is to be handed a button that opens it. The Overview now opens with a card listing each
new capability (Sender test, Day diary, "Everything right now", the lead brief, auto-book, the more
human warm-up, the extension popup) with an **Open** button that jumps straight to that page. It is
dismissed with one click and remembered per browser, so it never becomes noise.

Also: **you can now tell at a glance which build you are actually running** —
- The login screen and the sidebar keep showing the live server build ("Server build: v3.6.0"), read
  from the running server, so a stale deployment can never disguise itself.
- The extension popup header now shows the extension's own version (v6.6.0) next to the brand.
- This README's deploy checklist says exactly what each screen must show after a deploy.

Nothing else changed in this release. If you are coming from 3.3.1, the 3.5 section below covers the
big pieces (the Sender test page, narrated diaries, the lead brief, auto-book, more human warm-up).

---

# Maison Setter server 3.5 — what changed

One thing: a **test bench for your sender accounts**. Before this, the only way to know an account
could actually act on Instagram was to wait for the scheduler to hand it real work — hours later, at
a human pace, inside the sending window. Now there is a **Sender test** page in the dashboard that
makes one account prove itself on demand: follow a profile, like a post, or send a real message —
immediately, whatever the clock, the caps or the warm-up plan say.

## 1. The Sender test page (Operations menu)
- Pick a sender account, then choose one of three tests:
  - **Follow a profile** — type a username; the account opens that profile and presses Follow like a
    person would, then verifies the button flipped to "Following".
  - **Like a post** — paste a post or reel link (it is cleaned to `instagram.com/p/…` /
    `/reel/…`) or type a username and the account likes that profile's latest post. The Like is
    verified on the page (the button must really flip to "Unlike"), and "already liked" counts as a
    pass.
  - **Send a message** — type a username and the exact text; the account opens the conversation and
    really sends it, right away — no warm-touch, no pacing, no caps, and it sends even if a thread
    already exists (the point is to watch it land). The dashboard asks you to confirm first.
- **Immediately** means immediately. Queuing a test wakes the account's browser through the live
  long-poll (within a second); the test skips the sending window, the daily/hourly caps, the warm-up
  gating and the human-gap hold (`type = 'test'` tasks are served first by the scheduler and the
  extension runs them the moment it fetches them). One test at a time per account.
- **It still refuses to be stupid.** Quarantined, restricted, cooled-down or switched-off accounts
  decline every test with the reason on the page. A **paused** account still tests — pausing stops
  the campaign, not your hand. Tests run even outside sending hours and while a local safety pause
  is on.
- **Identity is checked first.** If the browser hasn't verified who is logged in within the last 10
  minutes, the test does it before acting, so a test can never act as the wrong Instagram account.
- **Results are pass/fail, once.** The extension reports what happened on the page (`followed`,
  `liked`, `already following`, `no_follow_button`, `like_unconfirmed`, `login_required`,
  `invalid_profile`, …); the server translates it into a plain-English verdict in the Day diary
  ("Test on Acme sender 1: tried to follow @joes_roofing — followed them, confirmed on the page.").
  Nothing is retried, no lead state changes, and a failed test does not count toward the
  three-failure automation lock. A rate-limit warning **during** a test still quarantines the
  account — that is the kill switch proving it works.
- **Recent tests** table keeps the last 25 per account (newest first) with the verdict; a waiting
  test can be cancelled with one click before the browser picks it up.
- Endpoints: `POST /api/test/run`, `GET /api/test/tasks`, `POST /api/test/cancel/:id`. The
  extension accepts the tests through `GET /ext/tasks/next?test=1`, so the same door also works for
  paused and out-of-hours check-ins.

---

# Maison Setter server 3.4 — what changed

Four things: the extension is narrated step by step, you can describe the leads you want in your own
words, sender accounts behave more like real accounts (they follow people and like more), and booking
became fully automatic — the AI reads the DMs, puts the appointment on the calendar and moves the
pipeline when a time is actually agreed on. The extension (6.4) and the server are built for each
other; both stay compatible with your existing database and pairing codes.

## 1. You can literally watch what every sender is doing
- The extension (6.4) narrates every micro-step in plain English: "opened @joes_roofing's profile",
  "watching their story", "typing the message... 66%", "pressing send", "message is out and visible
  in the thread". Narrated lines go to `/ext/status` in small batches and are stored twice: in memory
  for the live pages and in the activity table so they survive a restart (`kind = narration`).
- **Senders live** cards were rebuilt: the headline is now "First message — @handle (step 2/4): typing
  the message", plus two new lines: **why it is waiting** ("Hourly cap reached (3 this hour)", "Local
  daily cap reached (12/12)", "Resting between messages: the next one goes out about 6 min from now",
  "Holding it like a person would...") and **what comes next**. The step log on each card grew from 4
  to 8 lines server-side.
- New **"Everything right now"** toggle on Senders live: one plain-English line per sender, all
  senders on one screen.
- New **Day diary** page (Operations menu): a scrollable, plain-English diary per sender — today's
  narrated micro-steps on top, the durable activity history underneath (14 days), with a sender
  filter. Updates itself.
- The extension popup gained a "Doing right now" card with the same narration and the last six steps.

## 2. The lead brief: describe the leads you want, the AI obeys
- Every campaign has a **Lead brief** field (campaign editor, its own section): write in plain words
  who a perfect lead is and who must never be messaged — niches, locations, sizes, must-have signals,
  dealbreakers. It rides into the AI bouncer's message on EVERY lead, marked as deciding ("when the
  brief and the target line disagree, the brief wins"). The static system prompt is untouched, so
  prompt caching keeps working.
- **"Sync rules with AI"** button next to the brief: the AI reads your brief and proposes concrete
  pre-filter settings (follower bounds, activity window, contact requirement, creator switch, exclude
  words) with a sentence of why for each. It fills the form fields as a recommendation; nothing saves
  until "Save changes" (`POST /api/ai/brief-rules`).

## 3. Sender accounts act like real accounts: they follow and like
- **Follows finally work for extension-driven accounts** (before, only runner/VPS accounts followed).
  Warm-up sessions now end with up to three real profile visits and Follows. Targets come from the
  campaign's follow pool **plus a discovered pool**: while browsing the feed and explore, the
  extension harvests profile handles it sees, sends them to the server, which filters them (valid
  username, not a lead, not a sender account, not already followed, not a system path) and stores up
  to 300 per campaign (`clients.follow_discovered`). Discovered accounts are tried first, so the
  following list keeps growing with fresh accounts.
- Caps unchanged: default 3 follows/day (`follow_cap` setting), max 2-3 per session, 1-2/day while
  the warm-up program is still running, hard 10/day. Never the same account twice, never itself.
- **Follow the lead before the first message** (campaign switch, off by default): the pre-DM
  warm-touch also follows the lead, then watches the story / likes posts as before.
- **Likes at real-person levels**: per warm session 1-2 (careful), 2-4 (gentle), 3-8 (steady),
  5-12 (settled) — was 0-6 max — on the feed and now also on explore (posts are opened and liked in
  their dialog). The warm-touch likes up to two of the lead's recent posts instead of at most one.
  Every like, pause and follow is narrated (see 1).

## 4. Booking is fully automatic
- The reply drafter's output now includes an optional `appointment` object: when a specific time is
  actually agreed on in the DMs (the lead named a slot and it was confirmed, or the booking link did
  its job), the AI returns their exact words plus an ISO best guess in the campaign's time zone. The
  prompt forbids inventing times.
- With the campaign's **"Book appointments automatically"** switch on (default on, `auto_book`):
  the appointment is created as **Booked** with the parsed date and time — or an existing
  booking-pending appointment is upgraded — the lead's pipeline moves to Booked with it
  (`createAppointment` already did the pipeline/notification work), and the Inbox notification fires.
  No human click. With the switch off, booking intent keeps creating a booking-pending appointment
  like before.
- Time parsing is conservative: ISO wall times in the campaign tz (DST-safe), plain dates (assumed
  mid-morning), "today/tomorrow 3pm" phrases; anything unparsable stays booking-pending for a human.
- New **subscribable calendar feed**: the Appointments page has an "Add to calendar" link
  (`/api/calendar.ics?token=...`, token-gated, no login needed — calendar apps cannot log in). Add it
  to Google Calendar / Apple Calendar / Outlook and every booked appointment with a date shows up in
  your real calendar.

## Untouched
- The quarantine kill-switch, warning detection, human pacing math, hard caps (40 DMs / 10 follows a
  day), the supervisor, scoring, CRM stages, the runner API. Existing databases upgrade in place
  (four new columns on `clients`); existing pairing codes and the runner keep working.

---

# Maison Setter server 3.3 — what changed

The AI part in every section. Each section of the operation now has a "describe what you want" AI
path next to its form, the whole thing runs on one company brain built by an 8-question interview,
the setter is trained on a real appointment-setting playbook, and the supervisor was rethought from
"how dangerous is this" to "is sending this a good idea". The extension is unchanged: it only ever
executes what the server decides.

## v3.3.1 — the agency filter is now a plain switch
- Each campaign card carries a real switch, "Filter out marketing agencies", with a badge
  ("Filtering agencies" / "Agencies kept") in the card head. Flip it and it saves instantly:
  off means agencies pass the checks and get the separate agency script; on means they are
  rejected before the AI ever runs (the old default).
- The same switch now also sits in the campaign editor under Lead rules, so the filter can be
  changed from both places. Nothing else moved; the underlying rule (`allow_agencies`) is the same
  one the pre-filter and the AI bouncer have always respected.

## 1. The AI builder: describe it, the AI fills the real fields
- New module `src/builder.js` + endpoints: `POST /api/ai/build` (fills form fields),
  `POST /api/ai/chat` (the chat panel), `POST /api/ai/interview` (onboarding), `POST /api/ai/brain` (approval).
- **Campaign editor**: a "Build with AI" card describes the basics (offer, target, tone), the opener
  scripts or the whole follow-up sequence from a plain-words paragraph. It fills the real form fields
  with a written explanation of why; nothing saves until "Save changes", so the AI recommends and you pick.
- **Warm-up plans**: the plan drawer has "Build a plan with AI". Describe the niche, the account age and
  how aggressive you want it, and the AI writes the full day-by-day plan (phases, sessions, DMs/day,
  follows/day). AI plans must pass the existing guardrails (`validatePlan`), with one automatic repair
  retry that feeds the validation error back to the model. Aggressive plans still require the explicit override.
- **AI builder page** (new, Workspace menu): a chat with the strategist brain. It reads the campaign,
  the company brain and the knowledge layers, proposes a concrete patch (basics, scripts, follow-ups,
  warm-up plan, onboarding sections), shows it as JSON, and one "Apply to campaign" button runs it
  through the same validated endpoints the forms use. Nothing is applied without your click.
- Every AI-built string goes through `noEmDash()`: em and en dashes are killed at the source, and
  `cleanText` strips any that slip through on every outgoing message. The rule is absolute.

## 2. The personalization layer: the 8-question interview and the company brain
- Onboarding gained an AI interview slide (still the first stop; the manual slides stay for people who
  would rather type). A fixed set of 8 questions, one at a time, phrased with the context of the answers
  so far: company, offer and price, differentiators, proof, ideal customer (paste yours or let the AI
  draft one), tone and never-say words, pricing policy, booking process.
- After the 8th answer the AI synthesizes the **company brain** (structured profile: company, market,
  offer, pricing approach, differentiators, proof, tone, do-not-say, booking process), a **draft ICP**
  (all ten fields the manual slide has) and a setter-style briefing. You edit the ICP on the approve
  screen and click "Approve and use": the brain + ICP are saved, and the campaign row's offer, target
  and tone sync from them.
- The brain rides in every prompt from then on: openers, replies, the supervisor's review, the builders
  and the chat panel. Onboarding state is stored in the existing `onboarding` row (`interview`, `brain`
  and `icp` sections), and Business profile shows the brain as its own section.

## 3. Outreach personalization: AI-drafted openers are now the default path
- Previously the opener was a base template with one hook dropped in. Now every passed lead also gets an
  AI opener queued automatically (`makeOpener`), written per lead from the company brain, the knowledge
  layers and the profile (bio, category, recent captions), with the new `OPENER_RULES`: one specific true
  thing, varied message skeletons, no invented facts. The template stays as the instant fallback and
  your edits are never overwritten (`opener_edited` still wins).

## 4. The appointment setter is trained (the built-in playbook)
- New `src/playbook.js`: a full setter playbook injected verbatim into every reply prompt. It covers
  acting human (a casual, confident "no" when asked if this is a bot, then straight back to the
  conversation), pro-setter message discipline (one question per message, mirroring, no corporate
  lines), the close (two-option time close, booking link fallback, confirm the slot), the objection
  ladders (too expensive, need to think about it, send me info, not right now, talk to my partner,
  already have someone, no time, legitimacy, ghosting re-engagement), when to walk away, and the facts
  rule (never invent prices, promises or results; pivot to the call).
- The setter now receives the whole knowledge stack on every decision: playbook + company brain +
  global knowledge + campaign knowledge (including the new script field on the knowledge slide).
  Before this change the knowledge collected in onboarding never reached the reply drafter at all.
- New intent `disengage`: time-wasters and one-word loops get walked away from politely
  (stage cold, no follow-ups, nothing wasted) instead of sitting in a human's queue.
- Handoffs shrink to the genuine cases: anger or legal, explicit "get me a human", phone number
  requests, stop requests, and factual questions the knowledge base cannot answer. Price questions,
  bot questions and negotiation are answered from the knowledge base, not escalated.

## 5. The supervisor was rethought: "is sending this a good idea?"
- The system prompt is rewritten from "conservative gatekeeper, everything money/bot/phone gets held"
  to a context judge: does this fit the conversation, does it read like a person, does it invent
  anything? Bot-question answers and price talk backed by the knowledge are explicitly correct now.
- Holds only for unverifiable facts and the genuine handoffs; blocks only for stop signals, anger,
  legal, deception and abuse. The knowledge layers ride along in the review prompt, so the reviewer
  checks claims against what the business actually wrote.
- Autonomy thresholds loosened: supervised holds at risk 75+ (was 60), autopilot at risk 90+ (was 85).
  Watch mode is unchanged. The AI Lab drill labels and the campaign editor mode text match.
- The bouncer / Apify pre-filter is untouched: marginal profiles are still auto-rejected before any
  meaningful cost, and leads only wait for a person when the pre-filter or the bouncer genuinely
  cannot decide.

## 6. Knowledge & script page (new, Workspace menu)
- The global company knowledge: overview, FAQs, pricing guidance, objection notes, policies, proof,
  script, extra notes (`GET/PUT /api/kb`, stored in settings). The page explains the three layers:
  built-in playbook (always on) → global knowledge (this page) → per-campaign knowledge and script
  (onboarding). Overlaps resolve in favor of the campaign layer.

## 7. Version you can see (added after release)
- The login screen and the sidebar now show the actual server build ("Server build: v3.3.0"), read live from the server's `/api/session` - so you always know which version is really deployed, before signing in.
- Static script tags carry a `?v=3.3.0` cache-buster on top of the existing `no-cache` header, so no proxy between you and Railway can ever serve an old dashboard.
- The Campaigns page carries a one-line tip pointing at the "Build with AI" card inside the campaign form.

## Files
- New: `src/playbook.js`, `src/brain.js`, `src/builder.js`, `public/views4.js`.
- Changed: `src/leads.js` (prompts, disengage, opener queue, noEmDash), `src/supervisor.js` (prompt,
  thresholds, knowledge in review), `src/api.js` (6 new endpoints, warmup clientId), `src/server.js`
  (brain + builder wiring), `src/growth.js` (interview/brain onboarding sections), `src/util.js`
  (noEmDash), `public/app.js`, `public/views2.js`, `public/views3.js`, `public/index.html`,
  `public/style.css`, `package.json`.
- Untouched: everything the extension talks to (`/ext/*`), the runner, warm-up presets, scoring, CRM.

---

# Maison Setter server 3.2 — what changed

## 1. PostgreSQL (the database move)
- Set `DATABASE_URL` (a `postgres://` address) and the server uses PostgreSQL. No variable, no change — it keeps using the SQLite file like before, so local dev and the test suite still work with zero setup.
- The whole schema was rebuilt for PostgreSQL: 64-bit columns for all timestamps (SQLite integers were 64-bit, PostgreSQL's 32-bit integers would overflow on epoch milliseconds), the same tables, columns and indexes as before.
- The app's queries keep their SQLite dialect; a small translator on the way to PostgreSQL rewrites the few dialect differences (`?` placeholders, `IFNULL`, `INSERT OR IGNORE`, `IS ?`). A worker thread owns the connections so the app keeps its simple synchronous style.
- **One-time data migration** so your leads, accounts, tasks and history survive the switch:
      node scripts/migrate-sqlite-to-postgres.js data/magnetengine.db "$DATABASE_URL"
  Run it once while the server is stopped, then point Railway at the Postgres database and redeploy.
- The full test suite (214 checks) passes on both PostgreSQL and SQLite.

## 2. AI Lab — test the bot without touching anything real
- New "AI Lab" page in the dashboard. Two testers:
  - **Draft tester** — the exact prompts production uses for openers and replies, pointed at a made-up or pasted profile and conversation. Shows the draft, the intent, whether it handed off to a human, and how long it took.
  - **Supervisor drill** — the same hard rules, the same model prompt and the same watch/supervised/autopilot thresholds as a real send. Shows verdict (allow/edit/hold/block), risk, reason and the final text.
- Nothing is ever sent, saved as a task or written to a lead. Every drill is recorded in the AI supervisor log with a `lab` kind so you can audit what you tested.
- Endpoints: `POST /api/lab/draft`, `POST /api/lab/verdict`, `GET /api/lab/history`.

## 3. Senders Live — see what every browser is doing right now
- New "Senders live" page: one card per sender with a traffic light (moving / connected but quiet / offline), the current action in plain words ("Step 3/5 — typing — writing to @joes_roofing (thread)"), today's sent/limit, warm-up day, the last error, and the last few log lines from that browser.
- The extension (6.3+) posts a small status blob whenever something changes and at least every ~20s (`POST /ext/status`); the server keeps the latest per account in memory and pushes it to open dashboards over the existing event stream. Nothing new is stored in the database; a restart just resets the cards.
- Runner-driven accounts keep their own reporting: their cards show the runner's heartbeat data (last action, last check-in) — the runner itself is unchanged.

## 4. Warm-up: fully customizable, presets kept
- The three presets (Strict 21 / Standard 14 / Fast 7) are unchanged and remain the default per account age. An account can also be pinned to any preset explicitly.
- "Plan…" button on every account card opens a plan drawer: assign a preset, edit an existing custom plan or build a new one — phases table (each phase runs until the day you set, with sessions / DMs / follows per day), counting rules (require the browser to have run, warning holds the day), and the post-program sending ramp.
- A live preview colors the first 30 days of the plan. Guardrails refuse configs the presets would never do (DMs in the first 3 days, phase caps above 10 DMs or 4 follows, programs shorter than 7 days); the explicit "allow an aggressive plan" switch lifts them — the hard cap of 40 DMs/day can never be lifted.
- Storage: custom plans live in server settings (`warmup_plans`), each account stores its assignment in the new `accounts.warm_plan` column. Delete a plan and its accounts fall back to the preset for their age.

## 5. Two AI providers: Claude Haiku AND Gemini Flash Lite
- Settings → "AI model": pick Automatic (Haiku if its key exists, else Gemini), Claude Haiku, or Gemini Flash Lite. Both stay available; the choice applies to the bouncer, the supervisor, drafts, openers and vision.
- Gemini: set `GEMINI_API_KEY` on the server **or** paste the key in Settings (stored in the database, never echoed back). `GEMINI_MODEL` overrides the model id (default `gemini-3.5-flash-lite`).
- "Test Haiku" / "Test Gemini" buttons ping each provider and report latency or the exact error.
- Safety unchanged: the AI can only make things safer, and if the active model fails, messages hold for a human instead of going out unchecked.

## Env vars added
| Variable | Meaning | Default |
| --- | --- | --- |
| `DATABASE_URL` | postgres:// address — wins over DB_PATH | (none = SQLite) |
| `GEMINI_API_KEY` | Google API key (or set it in Settings) | (none) |
| `GEMINI_MODEL` | Gemini model id | `gemini-3.5-flash-lite` |
| `AI_PROVIDER` | force `haiku` or `gemini` | automatic |

## Tests
- `npm run test:server` — 146 checks (pass on SQLite and on PostgreSQL via `TEST_DB_PATH=postgres://...`)
- `npm run test:ui` — 68 browser checks (both backends)
- The pre-existing `e2e-runner` failures exist in the untouched original code as well (the runner was only ever tested against simulators) and are unrelated to these changes.
