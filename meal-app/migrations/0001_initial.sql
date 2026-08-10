PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  management_token_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  restaurant TEXT NOT NULL CHECK (restaurant IN ('namsan', 'seongju')),
  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul' CHECK (timezone = 'Asia/Seoul'),
  breakfast_enabled INTEGER NOT NULL DEFAULT 1 CHECK (breakfast_enabled IN (0, 1)),
  breakfast_time TEXT NOT NULL DEFAULT '07:30',
  lunch_enabled INTEGER NOT NULL DEFAULT 1 CHECK (lunch_enabled IN (0, 1)),
  lunch_time TEXT NOT NULL DEFAULT '11:30',
  dinner_enabled INTEGER NOT NULL DEFAULT 1 CHECK (dinner_enabled IN (0, 1)),
  dinner_time TEXT NOT NULL DEFAULT '17:30',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_success_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_breakfast_due
  ON subscriptions (breakfast_enabled, breakfast_time);
CREATE INDEX IF NOT EXISTS idx_subscriptions_lunch_due
  ON subscriptions (lunch_enabled, lunch_time);
CREATE INDEX IF NOT EXISTS idx_subscriptions_dinner_due
  ON subscriptions (dinner_enabled, dinner_time);

CREATE TABLE IF NOT EXISTS deliveries (
  subscription_id TEXT NOT NULL,
  meal_date TEXT NOT NULL,
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'lunch', 'dinner')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'sent')),
  queued_at TEXT NOT NULL,
  sent_at TEXT,
  PRIMARY KEY (subscription_id, meal_date, meal_type),
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_deliveries_date ON deliveries (meal_date);
