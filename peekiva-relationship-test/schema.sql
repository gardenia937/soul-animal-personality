-- ============================================================
-- Peekiva "What Are We, Really?" — D1 schema
-- 中文说明: 用 wrangler d1 execute 命令初始化 (见 README)。
-- Apply with: wrangler d1 execute <db> --remote --file=schema.sql
-- 价格只有 $0.38 一档, 由 Worker 环境变量 PRICE_USD 控制。
-- ============================================================

-- 私人测试会话 (需付费解锁才能读完整结果)
CREATE TABLE IF NOT EXISTS test_sessions (
  session_id         TEXT PRIMARY KEY,  -- 不可预测的会话 ID (UUID v4)
  session_token_hash TEXT NOT NULL,     -- 会话令牌 SHA-256 (绝不存明文)
  answers            TEXT NOT NULL,     -- JSON: 24 个 0-3 选项下标
  dimension_scores   TEXT NOT NULL,     -- JSON: {emo,effort,clarity,spark} 0-100 (一位小数)
  result_type        TEXT NOT NULL,     -- 六种结果 key
  payment_status     TEXT NOT NULL DEFAULT 'unpaid', -- unpaid | awaiting | paid
  payment_order_id   TEXT,              -- PayPal order id
  payment_capture_id TEXT,              -- PayPal capture id (记账去重)
  created_at         INTEGER NOT NULL,  -- unix ms
  updated_at         INTEGER NOT NULL   -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_sessions_order ON test_sessions(payment_order_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON test_sessions(payment_status);

-- 付款记录 (幂等: 同一 PayPal order 只记一笔; 同一 capture 只解锁一次)
CREATE TABLE IF NOT EXISTS payments (
  payment_id        TEXT PRIMARY KEY,  -- peekiva-pay-<orderId> (幂等键)
  session_id        TEXT NOT NULL,     -- 归属会话
  paypal_order_id   TEXT NOT NULL UNIQUE,
  paypal_capture_id TEXT UNIQUE,
  amount            TEXT NOT NULL,     -- "0.38"
  currency          TEXT NOT NULL,     -- "USD"
  status            TEXT NOT NULL DEFAULT 'created', -- created | completed | failed
  created_at        INTEGER NOT NULL,  -- unix ms
  verified_at       INTEGER            -- unix ms
);

CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id);

-- 永久公开分享卡片 (与私人报告分离, 无过期时间, 只存可公开字段)
CREATE TABLE IF NOT EXISTS share_cards (
  share_id            TEXT PRIMARY KEY, -- 不可预测的公开分享 ID (url-safe, >=128bit)
  session_id          TEXT NOT NULL,    -- 来源会话 (仅内部关联, 不对外暴露)
  public_result_type  TEXT NOT NULL,    -- 公开的结果类型 key
  public_scores       TEXT NOT NULL,    -- JSON: 四维度分数 (可公开, 无答题/付款信息)
  public_description  TEXT NOT NULL,    -- 公开的一句话描述 (服务端生成)
  created_at          INTEGER NOT NULL, -- unix ms
  revoked_at          INTEGER           -- NULL=有效, 时间戳=已撤销
);

CREATE INDEX IF NOT EXISTS idx_share_session ON share_cards(session_id);
