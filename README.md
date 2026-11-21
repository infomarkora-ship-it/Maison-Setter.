# DM Setter: the bot logic (v2)

An AI appointment setter for Instagram. Two engines, one conversation system:

- **Inbound DM engine:** every DM (and story reply) is triaged, answered by the model with tools (knowledge, booking, status, handoff, do-not-contact), and sent after a human-feeling delay.
- **Comment engine:** every comment is pre-filtered, classified (`engage / ignore / flag` + intent and fit scores), ranked, and turned into a unique opener DM, paced through a shared send queue.

Multi-tenant from day one: a client is a database row (settings, knowledge base, caps, calendar, commission). Adding client #2 means `npm run create-client`, not new code.

## What changed in v2

| Area | Behaviour | Where |
|---|---|---|
| InstantDM API | `POST https://api.instantdm.com/api-webhook`, Bearer key, `{action:"send_message", type:"dm", recipient_id, message}`. 429 honours `Retry-After`; a 2xx carrying an error body throws (never a silent drop). | `src/platform/instantdm.ts` |
| Inbound webhooks | `dm_received`, `comment`, `postback`, `question_answered`, `flow_completed`, echo/outbound. `X-Webhook-Signature` = HMAC-SHA256 of the raw body (`timingSafeEqual`), required once `INSTANTDM_WEBHOOK_SECRET` (or the client's own secret) is set. Raw event stored (deduped), job queued, `200` returned. | `src/server.ts`, `src/platform/signature.ts` |
| Chunking | 1-3 short bubbles with typing-style pauses; stops mid-message if a human or opt-out lands. | `src/pacing.ts`, `src/sender.ts` |
| Debounce | Each message pushes one pending `converse` job back 4-6 s (max 20 s); a queued reply made stale by a newer message is cancelled and regenerated. | `src/jobs.ts`, `src/handlers/events.ts`, `src/handlers/converse.ts` |
| 24h guard | Automated sends blocked once the window is closed (minus `DM_WINDOW_SAFETY_MINUTES`); follow-ups are scheduled inside it or dropped. | `src/guard.ts`, `src/sender.ts` |
| Attachments | Voice notes, images, shares stored as `[voice note]` etc.; the AI reacts naturally and falls back to a canned natural reply instead of failing or handing off. | `src/ai/converse.ts` |
| Human takeover | A message we did not send sets `paused_until` (client `humanPauseHours`, default 24h; each human message extends it). Manual takeover is indefinite. | `src/handlers/events.ts`, `src/guard.ts`, `pauseExpiryScan` |
| Call monitor | `no_booking_link_sent`, `booking_link_sent`, `call_booked`, `call_rescheduled`, `call_canceled`, `call_completed`, `call_no_show` driven by the booking tool, a calendar/CRM webhook (`POST /webhooks/calendar/:clientId?token=`), the dashboard, and link detection in sent messages. Confirmed calls cancel stale "please book" nudges; cancel/no-show switch the thread to `noshow_recovery` and replan. | `src/booking.ts`, `src/state.ts` |
| Follow-up planner | After each outbound message the model chooses whether, when, why (goal) and what angle; `guardFollowUp()` then enforces opt-outs, pauses, caps, outreach hours and the 24h window. If the model is down, the mode's default cadence is used. | `src/ai/converse.ts`, `src/handlers/schedulers.ts`, `src/guard.ts` |
| Modes | Per client default plus per-thread override, switchable in the dashboard. | `src/modes.ts` |
| Comment-to-DM | `minCommentDmScore` (lead score = 60% intent + 40% fit), `lowScoreAction` (`review` / `public_reply_only` / `skip`), `maxCommentDmsPerDay`, `commentDmMinGapMinutes`. `comment_dm_sent_at` plus comment/post ids recorded on the thread and in the timeline. | `src/handlers/comments.ts`, `src/scoring.ts`, `src/sender.ts` |
| Dashboard | `GET /dashboard` (static page; data calls need `ADMIN_TOKEN`). | `src/dashboard/page.ts` |
| Context Bot | `POST /api/conversations/:id/ask {question}`. Quotes, timestamps, style metrics and milestones are computed from the thread; the model only phrases the answer and any quote it invents is rejected. | `src/contextbot.ts` |

## What is verified and what is not

**Verified in the build sandbox:** `tsc --noEmit` is clean and 63 unit tests pass (pacing, chunking, debounce math, follow-up guards, call-status rules, calendar payload mapping, signature verification, InstantDM adapter against a fake `fetch`, comment gate and cap, attachment fallback, Context Bot, dashboard markup).

**NOT run here (you must run them):**
1. The Postgres integration tests (`tests/integration.test.ts`, including the new ones for the planner, call monitor, debounce, takeover cooldown, score gate and daily cap). The sandbox had no Postgres. Run `DATABASE_URL=... npm test`.
2. The Fastify server and dashboard in a browser. The sandbox had no `fastify` package, so routes were type-checked against a stub only. Run `npm run start:web` and open `/dashboard`.
3. Anything against live InstantDM, Meta, Cal.com or the real Haiku model.
4. **InstantDM payload shapes** beyond what the brief states (see the comment block at the top of `src/platform/instantdm.ts`): event field names, attachments, echo events, the comment reply body (`reply_comment`) and the comment-linked DM body. Capture real events in `raw_events` and adjust `mapPayload()`; `tests/upgrade.test.ts` and `tests/instantdm.test.ts` hold the assumed shapes.
5. Cal.com endpoints in `src/booking.ts` are still from memory; keep `calendarProvider: "link"` until verified.

## Setup

```bash
cp .env.example .env        # fill DATABASE_URL, ANTHROPIC_API_KEY, ADMIN_TOKEN
npm install
npm run migrate             # idempotent: also upgrades a v1 database in place
npm run evals               # read the replies before you trust it
npm test                    # set DATABASE_URL to include the Postgres integration tests
npm run start:web           # then open http://localhost:3000/dashboard and paste ADMIN_TOKEN
npm run start:worker        # exactly one instance
```

Create a client: copy `clients/example.json`, fill it in, then `npm run create-client -- clients/acme.json`. It prints the webhook URL (with a per-client secret) to paste into InstantDM.

**Railway:** one project, three pieces: Postgres, a `web` service (`npm run start:web`), a `worker` service (`npm run start:worker`). Same env vars on both. **Run exactly one worker instance** (the sender assumes it).

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

Admin API (Bearer `ADMIN_TOKEN`): `POST /api/sales`, `POST /api/conversations/:id/takeover|handback`, `POST /api/appointments/:id/outcome`, `GET /api/clients/:id/funnel|usage`.

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
