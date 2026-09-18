-- ============================================================
-- Your Soul Animal Personality — D1 schema
-- Anonymous sessions. No personal information is collected.
-- Apply with:  wrangler d1 execute soul-animal --remote --file=schema.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,              -- random UUID (anonymous session key)
  created_at     INTEGER NOT NULL,              -- unix ms
  expires_at     INTEGER NOT NULL,              -- unix ms (session auto-expiry)
  answers        TEXT NOT NULL DEFAULT '[]',    -- JSON array of 16 option indices (0-3)
  scores         TEXT,                          -- JSON map { animal: rawScore }
  big_pts        TEXT,                          -- JSON map { animal: countOf2ptContributions } tie-break data
  result_type    TEXT,                          -- winning animal ("fox", ...)
  payment_status TEXT NOT NULL DEFAULT 'none',  -- none | dev_pending | awaiting_payment | awaiting_manual_verification | paid
  payment_id     TEXT,                          -- PayPal capture id (Orders API) or manual txn reference
  payment_method TEXT,                          -- paypal_orders_api | paypalme | paypalme_manual | dev_sim
  order_id       TEXT,                          -- PayPal order id (Orders API) for capture lookup
  unlocked_at    INTEGER,                       -- unix ms when verified paid
  verify_count   INTEGER NOT NULL DEFAULT 0,    -- duplicate/abuse guard
  last_verify_at INTEGER,                       -- unix ms
  question_order TEXT NOT NULL DEFAULT '[]'     -- JSON array: shuffled question indices per session
);

CREATE INDEX IF NOT EXISTS idx_sessions_order_id   ON sessions(order_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status     ON sessions(payment_status);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);