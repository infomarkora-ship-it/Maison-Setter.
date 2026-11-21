-- Multi-tenant schema. Every table that holds client data carries client_id.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS clients (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  status                text NOT NULL DEFAULT 'pilot' CHECK (status IN ('pilot','active','paused')),
  timezone              text NOT NULL DEFAULT 'America/Toronto',
  webhook_secret        text NOT NULL,
  platform_api_key      text NOT NULL,
  instagram_account_id  text NOT NULL,
  settings              jsonb NOT NULL,
  knowledge             text NOT NULL DEFAULT '',
  commission_rate       numeric(5,4) NOT NULL DEFAULT 0.20,
  attribution_days      int NOT NULL DEFAULT 45,
  opener_daily_max      int NOT NULL DEFAULT 50,
  opener_window_start   int NOT NULL DEFAULT 9,    -- local hour, inclusive
  opener_window_end     int NOT NULL DEFAULT 20,   -- local hour, exclusive
  hourly_send_cap       int NOT NULL DEFAULT 600,
  min_intent_score      int NOT NULL DEFAULT 60,
  notify_webhook_url    text,
  calendar_provider     text NOT NULL DEFAULT 'link' CHECK (calendar_provider IN ('link','cal_com','mock')),
  calendar_config       jsonb NOT NULL DEFAULT '{}'::jsonb,
  launched_at           timestamptz NOT NULL DEFAULT now(),
  next_opener_at        timestamptz NOT NULL DEFAULT now(),
  prompt_version        text NOT NULL DEFAULT 'v1',
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform_user_id text NOT NULL,
  username         text,
  do_not_contact   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, platform_user_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('inbound_dm','story_reply','comment_opener','ad_comment')),
  state            text NOT NULL DEFAULT 'new',
  human_takeover   boolean NOT NULL DEFAULT false,
  triaged          boolean NOT NULL DEFAULT false,
  followups_sent   int NOT NULL DEFAULT 0,
  lead_notes       text,
  last_inbound_at  timestamptz,
  last_outbound_at timestamptz,
  first_touch_at   timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, contact_id)
);
CREATE INDEX IF NOT EXISTS conversations_client_state ON conversations (client_id, state);

CREATE TABLE IF NOT EXISTS messages (
  id                  bigserial PRIMARY KEY,
  client_id           uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction           text NOT NULL CHECK (direction IN ('in','out')),
  body                text NOT NULL,
  platform_message_id text,
  prompt_version      text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS messages_platform_id ON messages (client_id, platform_message_id) WHERE platform_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS raw_events (
  id          bigserial PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  dedupe_key  text NOT NULL,
  payload     jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error       text,
  UNIQUE (client_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS comments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  platform_comment_id text NOT NULL,
  post_id             text,
  post_caption        text,
  is_ad               boolean NOT NULL DEFAULT false,
  author_id           text NOT NULL,
  author_username     text,
  text                text NOT NULL,
  like_count          int NOT NULL DEFAULT 0,
  commented_at        timestamptz NOT NULL DEFAULT now(),
  decision            text,            -- engage | ignore | flag
  intent_score        int,
  fit_score           int,
  reason              text,
  priority_score      numeric(6,2),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','queued','sent','skipped','expired','flagged')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, platform_comment_id)
);
CREATE INDEX IF NOT EXISTS comments_client_status ON comments (client_id, status);

-- Everything that goes out to Instagram passes through this queue (pacing lives here).
CREATE TABLE IF NOT EXISTS send_queue (
  id              bigserial PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('reply','followup','reminder','opener')),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  comment_id      uuid REFERENCES comments(id) ON DELETE CASCADE,
  body            text,                 -- null for openers: generated at send time
  priority        numeric(6,2) NOT NULL DEFAULT 0,
  scheduled_for   timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled','expired')),
  attempts        int NOT NULL DEFAULT 0,
  error           text,
  sent_at         timestamptz,
  last_attempt_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS send_queue_due ON send_queue (client_id, status, scheduled_for);

CREATE TABLE IF NOT EXISTS jobs (
  id           bigserial PRIMARY KEY,
  type         text NOT NULL,
  client_id    uuid,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at       timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','dead')),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error   text,
  dedupe_key   text,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs (status, run_at);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe ON jobs (dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  starts_at       timestamptz NOT NULL,
  attendee_name   text,
  attendee_email  text,
  external_id     text,
  status          text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','confirmed','showed','no_show','cancelled')),
  reminder24_sent boolean NOT NULL DEFAULT false,
  reminder2_sent  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sales (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  commission_cents bigint NOT NULL,
  status           text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','verified','disputed')),
  reported_at      timestamptz NOT NULL DEFAULT now(),
  note             text
);

CREATE TABLE IF NOT EXISTS brakes (
  id         bigserial PRIMARY KEY,
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  reason     text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  until      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS brakes_active ON brakes (client_id, until);

CREATE TABLE IF NOT EXISTS usage_log (
  id            bigserial PRIMARY KEY,
  client_id     uuid REFERENCES clients(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_read    int NOT NULL DEFAULT 0,
  cache_write   int NOT NULL DEFAULT 0,
  cost_usd      numeric(10,6) NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_client_time ON usage_log (client_id, created_at);

-- Block / report / hostile opt-out signals feed the automatic brakes.
CREATE TABLE IF NOT EXISTS signals (
  id         bigserial PRIMARY KEY,
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  contact_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_client_time ON signals (client_id, created_at);

-- =====================================================================================
-- v2 upgrade (idempotent: safe to re-run with `npm run migrate`)
-- Modes, call monitor, planned follow-ups, comment-to-DM controls, milestones.
-- =====================================================================================
ALTER TABLE clients ADD COLUMN IF NOT EXISTS default_mode               text NOT NULL DEFAULT 'qualify_and_book';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS min_comment_dm_score       int  NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS max_comment_dms_per_day    int;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS comment_dm_min_gap_minutes int  NOT NULL DEFAULT 2;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS low_score_action           text NOT NULL DEFAULT 'review';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS human_pause_hours          int  NOT NULL DEFAULT 24;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS instantdm_webhook_secret   text;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS mode                    text;           -- null = client default_mode
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS call_status             text NOT NULL DEFAULT 'no_booking_link_sent';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS paused_until            timestamptz;    -- human takeover cooldown; null + human_takeover = indefinite
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS lead_score              int;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS conversation_goal       text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS next_follow_up_at       timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_up_rationale     text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS follow_up_angle         text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS booking_link_sent_at    timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS comment_dm_sent_at      timestamptz;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS comment_dm_comment_id   text;           -- platform comment id that triggered the DM
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS comment_dm_post_id      text;
CREATE INDEX IF NOT EXISTS conversations_comment_dm ON conversations (client_id, comment_dm_sent_at) WHERE comment_dm_sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_next_followup ON conversations (next_follow_up_at) WHERE next_follow_up_at IS NOT NULL;

ALTER TABLE comments ADD COLUMN IF NOT EXISTS lead_score int;
ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_status_check;
ALTER TABLE comments ADD CONSTRAINT comments_status_check
  CHECK (status IN ('pending','queued','sent','skipped','expired','flagged','review','public_replied'));

ALTER TABLE send_queue ADD COLUMN IF NOT EXISTS goal text;
ALTER TABLE send_queue DROP CONSTRAINT IF EXISTS send_queue_kind_check;
ALTER TABLE send_queue ADD CONSTRAINT send_queue_kind_check
  CHECK (kind IN ('reply','followup','reminder','opener','public_reply'));

-- Timeline of everything notable on a thread: the dashboard's milestone markers and the Context Bot read this.
CREATE TABLE IF NOT EXISTS thread_events (
  id              bigserial PRIMARY KEY,
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  kind            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS thread_events_conv ON thread_events (conversation_id, at);
