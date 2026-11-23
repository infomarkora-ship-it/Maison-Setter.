# DM Setter

An AI appointment setter for Instagram. Two engines, one conversation system:

- **Inbound DM engine:** every DM (and story reply) is triaged, answered by the model with tools (knowledge, booking, status, handoff, do-not-contact), and sent after a human-feeling delay.
- **Comment engine:** every comment is pre-filtered, classified (`engage / ignore / flag` + intent and fit scores), ranked, and turned into a unique opener DM, paced through a shared send queue.

Multi-tenant from day one: a client is a database row (settings, knowledge base, caps, calendar, commission). Adding client #2 means `npm run create-client`, not new code.

## The dashboard (v3)

`GET /dashboard` serves an 8-page single-file app (no build step, Plus Jakarta Sans, light/dark, keyboard- and phone-friendly). Everything is in plain words; every setting has help text next to it. The AI itself — prompts, tools, guard rails — is untouched by any of this.

| Page | What it does |
|---|---|
| Home | Today's numbers, a "needs you" list (handoffs, held/flagged comments, no-shows), an "Ask your AI" box. |
| Pipeline | Leads as cards in columns (New / Talking / Qualified / Booked / Lost); click a card to read the whole chat. |
| Conversations | Chat-app style inbox, lead details on the side, pause-the-AI / take-over-myself buttons. |
| Comments | Held-for-review queue (approve / skip), the comment-to-DM rules in plain words, and results. |
| Clients | Add/edit a business with a form; prints the webhook links to copy when done. |
| AI Studio | Edit tone, offer, rules and facts; the sandboxed test chat (old `/test` redirects here). |
| Ask AI | Full-page chat over your real data only; shows which conversations it used. |
| Health & help | Worker status, recent errors, free-limit warning, and an explanation of every setting. |

Two AI features, both read-only until you press a button:

- **Ask AI** (`POST /api/clients/:id/ask`) answers only from live data, cites the threads it used, and never changes anything. If it thinks something should happen it returns a proposal; you press Confirm (`POST /api/ask-ai/confirm`) or Dismiss.
- **Describe-it box** (`POST /api/clients/:id/describe` → `.../describe/apply`) drafts setting changes from a plain-English request, shows before/after for each field, and applies nothing until you press Apply. It can only touch settings the AI reads (tone, offer, rules, facts) — never its core logic.

Free-tier care: every dashboard AI call is one request, usage is counted per day (`GET /api/health`), and when Gemini says "slow down" (429 / RESOURCE_EXHAUSTED) the UI shows a friendly message instead of an error dump (`src/api/friendly.ts`).

## What changed in v3.1 (hotfix: real events + Gemini 3.x)

| Fix | What was wrong | What happens now | Where |
|---|---|---|---|
| Gemini 3.x support | `thinkingConfig: {thinkingBudget: 0}` was sent to every `*flash*` model. Gemini 3.x models reject that setting outright with `400 INVALID_ARGUMENT "Request contains an invalid argument."` — several lite models cannot disable thinking at all. | Model-aware requests: 2.5 Flash keeps `thinkingBudget: 0`; 3.x+ gets no thinkingConfig and a larger output budget (thinking tokens count against it). Replayed tool calls on 3.x carry Google's documented `skip_thought_signature_validator` signature. | `src/ai/llm.ts` |
| Inbound webhook mapping | The mapper assumed flat bodies (`sender_id`, `text`, `event` in the body). Real InstantDM events are the documented Meta envelope (`{object, entry:[{messaging|changes}]}`) with the event name only in the `X-Event-Type` header — so every real DM landed as `unmatched_event_shape` and nothing appeared anywhere. | `mapPayload()` now understands the documented shapes for `dm_received`, `comment`, `postback` (JSON-string payload parsed for the username), `question_answered`, `flow_completed`; handles attachments/story mentions, ms-vs-s timestamps, read receipts (ignored, not flagged), and dedupes on `mid` / comment `id` per the docs. Pinned by tests built from the docs' own example payloads. | `src/platform/instantdm.ts` |
| Send endpoint | Config pointed at `https://openapi.instantdm.com/action`, which is not in the current docs. | Default is the documented `https://api.instantdm.com/api-webhook`; a deployment still configured with the old route gets one automatic retry against the documented URL when it answers 404/405. | `src/config.ts`, `src/platform/instantdm.ts` |
| Diagnostics | The Health page showed only the error string for incoming events, so an unknown payload meant SQL. | Incoming-event errors now carry the raw payload (clipped) in a collapsible block on the Health page — copy it straight into a chat for help. | `src/api/health.ts`, `src/dashboard/page.ts` |

## What changed in v2

| Area | Behaviour | Where |
|---|---|---|
| InstantDM API | `POST https://api.instantdm.com/api-webhook` (was wrongly `openapi.instantdm.com/action` before v3.1), `Authorization: Bearer <key>`. Three documented actions, exact formats: DM `{action:"send_message", type:"dm", recipient_id, message:{text}}`; public reply `{action:"post_comment", comment_id, comment_text}`; private reply `{action:"send_message", type:"comment_reply", comment_id, message:{text}}`. 429 honours `Retry-After`; a 2xx carrying an error body throws (never a silent drop). | `src/platform/instantdm.ts` |
| Inbound webhooks | New comment, comment reply, live comment, new DM (`dm_received`), story reply, postback, question_answered, flow_completed, message sent (echo/outbound). `X-Webhook-Signature` = HMAC-SHA256 of the raw body (`timingSafeEqual`), required once `INSTANTDM_WEBHOOK_SECRET` (or the client's own secret) is set; URL token fallback. Raw event stored (deduped by platform event id), job queued, `200` returned. | `src/server.ts`, `src/platform/signature.ts` |
| Chunking | 1-3 short bubbles with typing-style pauses; stops mid-message if a human or opt-out lands. | `src/pacing.ts`, `src/sender.ts` |
| Debounce | Each message pushes one pending `converse` job back 4-6 s (max 20 s); a queued reply made stale by a newer message is cancelled and regenerated. | `src/jobs.ts`, `src/handlers/events.ts`, `src/handlers/converse.ts` |
| 24h guard | Automated sends blocked once the window is closed (minus `DM_WINDOW_SAFETY_MINUTES`); follow-ups are scheduled inside it or dropped. | `src/guard.ts`, `src/sender.ts` |
| Attachments | Voice notes, images, shares stored as `[voice note]` etc.; the AI reacts naturally and falls back to a canned natural reply instead of failing or handing off. | `src/ai/converse.ts` |
| Human takeover | A message we did not send sets `paused_until` (client `humanPauseHours`, default 24h; each human message extends it). Manual takeover is indefinite. | `src/handlers/events.ts`, `src/guard.ts`, `pauseExpiryScan` |
| Call monitor | `no_booking_link_sent`, `booking_link_sent`, `call_booked`, `call_rescheduled`, `call_canceled`, `call_completed`, `call_no_show` driven by the booking tool, a calendar/CRM webhook (`POST /webhooks/calendar/:clientId?token=`), the dashboard, and link detection in sent messages. Confirmed calls cancel stale "please book" nudges; cancel/no-show switch the thread to `noshow_recovery` and replan. | `src/booking.ts`, `src/state.ts` |
| Follow-up planner | After each outbound message the model chooses whether, when, why (goal) and what angle; `guardFollowUp()` then enforces opt-outs, pauses, caps, outreach hours and the 24h window. If the model is down, the mode's default cadence is used. | `src/ai/converse.ts`, `src/handlers/schedulers.ts`, `src/guard.ts` |
| Modes | Per client default plus per-thread override, switchable in the dashboard. | `src/modes.ts` |
| Comment-to-DM | `minCommentDmScore` (lead score = 60% intent + 40% fit), `lowScoreAction` (`review` / `public_reply_only` / `skip`), `maxCommentDmsPerDay`, `commentDmMinGapMinutes`. `comment_dm_sent_at` plus comment/post ids recorded on the thread and in the timeline. | `src/handlers/comments.ts`, `src/scoring.ts`, `src/sender.ts` |
| Dashboard | The 8-page dashboard (see "The dashboard (v3)" above). Static HTML + a Bearer-token API; `/test` redirects to the AI Studio test chat. | `src/dashboard/page.ts`, `src/server.ts`, `src/api/*` |
| Context Bot | `POST /api/conversations/:id/ask {question}`. Quotes, timestamps, style metrics and milestones are computed from the thread; the model only phrases the answer and any quote it invents is rejected. | `src/contextbot.ts` |

## What is verified and what is not

**Verified in the build sandbox:** `tsc --noEmit` is clean and 69 unit tests pass, 20 Postgres integration tests skipped (no database here) — pacing, chunking, debounce math, follow-up guards, call-status rules, calendar payload mapping, signature verification, the exact InstantDM request URL/headers/bodies (all three actions) against a fake `fetch`, every documented webhook event name, event-id dedup, comment gate and cap, attachment fallback, Context Bot, Test Chat sandbox isolation (no send path reachable), Ask AI + describe-it + client admin endpoints, dashboard markup. The dashboard itself was also screenshot-reviewed page by page (all 8 pages, light and dark, phone width) in a headless browser against mocked API data.

**NOT run here (you must run them):**
1. The Postgres integration tests (`tests/integration.test.ts`, including the ones for the planner, call monitor, debounce, takeover cooldown, score gate and daily cap). Run `DATABASE_URL=... npm test`.
2. The server against a real Gemini key: run `npm run start:web`, open `/dashboard`, and try Ask AI, the test chat and the describe-it box.
3. Anything against live InstantDM, Meta, Cal.com or the production Anthropic model.
4. **InstantDM inbound events against your LIVE account** — as of v3.1 the mapping follows the official docs (`instantdm.com/instagram-api-docs`) and is pinned by tests built from the docs' own example payloads (`tests/webhooks.test.ts`). What is still only proven in production: that your plan actually delivers the events you expect (webhooks need an eligible plan) and that no plan-specific fields are missing. If anything still shows up as `unmatched_event_shape`, its raw payload now appears on the Health page — paste it into the chat and the mapper gets extended.
5. Cal.com endpoints in `src/booking.ts` are still from memory; keep `calendarProvider: "link"` until verified.

## Setup

```bash
cp .env.example .env        # fill DATABASE_URL, GEMINI_API_KEY, ADMIN_TOKEN
npm install
npm run migrate             # idempotent: also upgrades a v1 database in place
npm run evals               # read the replies before you trust it
npm test                    # set DATABASE_URL to include the Postgres integration tests
npm run start:web           # then open http://localhost:3000/dashboard and paste ADMIN_TOKEN
npm run start:worker        # exactly one instance
```

Create a client: copy `clients/example.json`, fill it in, then `npm run create-client -- clients/acme.json`. It prints the webhook URL (with a per-client secret) to paste into InstantDM.

**Railway:** one project with Postgres + one web service. The default start command (`npm start`) runs the job worker **inside** the web process, so a single service handles webhooks, the dashboard and the AI work. To split them instead, set `WORKER_INLINE=0` on the web service and add a second service running `npm run start:worker` with the same env vars — **run exactly one worker instance** (the sender assumes it).

## Map from the plan to the code

| Plan | File |
|---|---|
| Webhook receiver, ack fast | `src/server.ts` |
| Queue + worker | `src/jobs.ts`, `src/worker.ts` |
| Inbound DM triage + conversation | `src/handlers/converse.ts`, `src/ai/converse.ts` |
| Comment classifier, scoring | `src/handlers/comments.ts`, `src/ai/classify.ts`, `src/scoring.ts` |
| Pacing, caps, ramp, brakes | `src/pacing.ts`, `src/sender.ts`, `src/handlers/schedulers.ts` |
| Guard rails | `src/guard.ts` |
| Prompts (versioned) | `src/ai/prompts.ts` |
| Booking, reminders | `src/booking.ts`, `src/handlers/schedulers.ts` |
| Takeover detection | echo handling in `src/handlers/events.ts` |
| Attribution, sales, funnel | `src/repo.ts`, `/api/sales`, `/api/clients/:id/funnel` |
| Platform seam (swap providers here) | `src/platform/types.ts` |

Admin API (all under `/api/*`, Bearer `ADMIN_TOKEN` — the dashboard's single shared password):

- Businesses: `GET/POST /api/clients`, `GET/PATCH /api/clients/:id` (settings, controls), `GET /api/clients/:id/overview|pipeline|conversations|review-comments|settings|funnel|usage`
- Threads: `GET /api/conversations/:id`, `POST /api/conversations/:id/mode|call-status|takeover|handback|ask`
- Comments: `POST /api/comments/:id/approve|dismiss`
- AI features: `POST /api/clients/:id/ask` (Ask AI), `POST /api/ask-ai/confirm`, `POST /api/clients/:id/describe` + `.../describe/apply` (describe-it box), `POST /api/clients/:id/test-chat` (sandbox)
- Ops: `GET /api/health`, `GET /api/modes`, `POST /api/sales`, `POST /api/appointments/:id/outcome`

## Known gaps (not built)

- Nightly reconciliation job: the adapter hook (`listRecentEvents`) exists, no implementation.
- Voice notes and images are never transcribed or viewed; the AI only knows that one was sent.
- Conversations longer than 30 messages are truncated, not summarized.
- `platform_api_key` and calendar keys are stored in plaintext. Encrypt them (or use a secrets manager) before you hold other businesses' keys.
- Reddit is not implemented.
- The 24h/2h reminders only send inside Meta's DM window; keep the calendar's own email reminders on.
- Prompts are tuned for nothing yet. Expect to iterate per niche using the eval set.
- Follow-up cap is per silent streak: `followups_sent` resets when the lead replies.
- Dashboard is read/control only; it cannot send messages as a human. Reply from Instagram and the AI will pause by itself.
