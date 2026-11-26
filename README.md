# Maison Setter server

The server behind the Maison Setter Chrome extension and growth command center. You bring leads (from Apify, or Meta Ad Library records). The server filters them, has an AI bouncer act as a strict gatekeeper, lets you approve what is left, hands each sender account its work at a slow, human pace, and turns the whole operation into a measurable pipeline: leads → conversations → appointments → revenue.

> **New in v3.5** — a **Sender test** page: make one sender account prove itself on demand — follow a profile, like a specific post (or the latest one of a handle), or send a real DM — with no sending window, no caps and no waiting. The test jumps the whole queue and runs the moment that browser checks in (the live link wakes it within a second), the page verifies the action on Instagram's side and narrates the verdict in plain English. Quarantined or switched-off accounts refuse to test; a paused account still tests, because you are driving it by hand. Details in `WHAT-CHANGED.md`.

> **New in v3.4** — every sender narrates what it is doing step by step (Senders live + the Day diary page), a per-campaign **lead brief** lets you describe the leads you want in plain words (the AI bouncer obeys it, and "Sync rules with AI" proposes matching pre-filter rules), sender accounts **follow people and like more** (pool + discovered accounts, follow-leads-before-DM optional), and booking is **fully automatic**: the AI reads the DMs, books the appointment with its time on the calendar and moves the pipeline. Details in `WHAT-CHANGED.md`.

> Previously branded MagnetEngine. The database, pairing codes and APIs are fully compatible; an existing deployment keeps working after the upgrade.

## How a lead travels

1. **Import** (dashboard, `POST /api/leads/import`, `POST /api/leads/import-ads`, or `POST /hooks/import`). Duplicates are dropped by username within a campaign.
2. **Free pre-filter** (`src/rules.js`). No API calls. Rejects private accounts, creator/guru categories, odd follower counts, dead profiles, course-platform links and marketer wording; rewards commercial categories, booking links, websites and contact details.
3. **AI bouncer** (`src/haiku.js`). Strict JSON at temperature 0 with prompt caching on the static instructions. Returns PASS or REJECT, a confidence score, the entity type, niche, location and a one-line **personalization hook**.
4. **Scoring** (`src/scoring.js`). An explainable 0–100 score with a stored factor breakdown (business fit, ideal-customer fit, profile quality, engagement, conversation signals). Every score in the dashboard can answer "why".
5. **Review.** Real businesses, agencies (if the campaign wants them) and "needs a look". The opener is the campaign template with the hook dropped in: no second API call.
6. **Warm-touch, then opener.** The sender views the lead's story or likes one recent post, then the opener goes out 10 to 30 minutes later.
7. **Replies, booking, CRM.** Replies are classified (interested / question / not-interested / stop / booked), drafted by the AI and wait for approval unless auto-reply is on. Booking intent creates a pending appointment. The **pipeline** (20 CRM stages, `src/crm.js`) stays deliberately distinct from the operational conversation status.

## The growth command center (dashboard)

- **Overview** — KPIs with previous-period deltas, growth activity timeline, the lead-to-revenue journey, data-grounded performance insights, today's priorities and the live activity feed.
- **Inbox** — a three-panel unified inbox (conversations, full thread, lead context) with views for Needs you / AI drafts / Interested / High intent / Questions / Booked / Do not contact.
- **Leads** — searchable CRM table with pipeline, score, niche, source and value; a full lead profile drawer with the score breakdown, conversation, appointments, tasks, activity and outcome fields.
- **Pipeline** — kanban across the CRM stages.
- **Appointments** — list + month view, statuses from Booking Pending to Converted, outcome recording ("Deal won" closes the opportunity loop).
- **Campaigns** — offer, scripts, rules, AI supervision modes, monthly client investment (drives ROI).
- **Opportunities** — the recovery center. Missed-opportunity alerts are recomputed continuously (`src/growth.js`): interested prospects waiting too long, unanswered DMs, booking abandonment, overdue follow-ups, no-show recovery, stalled opportunities, campaign underperformance. Alerts can be started, resolved or snoozed; resolution time is reported.
- **Analytics & ROI** — funnel conversion between every stage, revenue/pipeline/booked-value with honest labels, revenue over time, per-campaign attribution, cost per lead/appointment and ROI (only when the client investment is set).
- **Reports** — weekly/monthly narrative report plus the numbers, copyable for clients.
- **Onboarding** — a 13-slide wizard (business, offer, ICP, qualification, goals, outreach preferences, conversation guidelines, appointment process, campaign preferences, knowledge) that saves per section and can be resumed anytime; completed data stays inspectable in **Business profile**.
- **Notifications** — a bell with unread state for interested prospects, high-intent replies, booking signals, appointments and critical alerts.
- **Sender accounts** — add senders, pair them, pause/quarantine/release, health and warm-up stage, driver (extension or runner).
- **Senders live** — what every sender's browser is doing right now, narrated step by step.
- **Sender test** — the test bench: one account follows / likes / DMs a target you type in, immediately, with a pass/fail log of the last 25 tests.
- **Day diary** — a plain-English diary per sender: today's narrated micro-steps plus 14 days of history.
- **Warm-up** — the per-sender warm-up programs and their calendar grid.

## What makes the dashboard and extension actually connect

- **Live dashboard.** `GET /api/stream` (server-sent events) pushes every change.
- **Live extension.** `GET /ext/pulse` is a long poll; dashboard actions reach the sender's browser within a second.
- **The extension reports back.** Its activity log lands in the dashboard's Live activity; its connection state is shown in plain words in its popup.
- **One safety switch.** Instagram warnings quarantine the account for 48 hours and reassign its unsent first messages to healthy senders.

## Runner, Dolphin Anty and the AI supervisor (v3)

An account is driven by **either** the Chrome extension **or** the runner on your Windows VPS (see `magnetengine-runner`). Every outgoing message passes the AI supervisor first: hard rules in code, then the model (allow / edit / hold / block with a risk score). Per campaign: **Watch**, **Supervised** or **Autopilot**.

## Deploy on Railway

1. Push this folder to GitHub and create a Railway project from it.
2. Add a **volume** mounted at `/data`.
3. Set variables: `ADMIN_PASSWORD` (required), `ANTHROPIC_API_KEY`, `DB_PATH=/data/magnetengine.db`. Optional: `HAIKU_MODEL`, `HAIKU_DAILY_TOKEN_CAP`, `DEFAULT_TZ`, `PUBLIC_URL`.
4. Open your Railway URL and sign in. Existing databases upgrade in place on first start.

## Tests

```
npm run test:server       # the API: pipeline, rules, bouncer, locks, quarantine, live endpoints, runner API, supervisor, CRM, growth
npm run test:ui           # real Chromium (needs Playwright; SHOTS=/dir saves screenshots)
EXT_DIR=../magnetengine-extension/ npm run test:extension
RUNNER_DIR=../magnetengine-runner/ npm run test:runner
```

## Honest limits

- Automated messaging on Instagram goes against Instagram's rules. Quarantine and pacing lower the risk; they do not remove it.
- The warm-touch and warning detection use Instagram's page text and layout, tested against simulated pages.
- Lead scores, insights and ROI are computed only from data actually present. Estimates (pipeline value, booked value) are always labelled as estimates.
