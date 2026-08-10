ALTER TABLE subscriptions
ADD COLUMN weekend_enabled INTEGER NOT NULL DEFAULT 1
CHECK (weekend_enabled IN (0, 1));
