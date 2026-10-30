CREATE TABLE splits (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  distributor_id TEXT NOT NULL,
  total_sale INTEGER NOT NULL CHECK (total_sale > 0),
  sale_fee_percent INTEGER NOT NULL CHECK (sale_fee_percent IN (3, 5)),
  net_sale INTEGER NOT NULL,
  distributor_percent_hundredths INTEGER CHECK (distributor_percent_hundredths BETWEEN 0 AND 10000),
  distributor_final INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'canceled')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  canceled_at TEXT
);

CREATE TABLE split_members (
  split_id TEXT NOT NULL REFERENCES splits(id),
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  percent_hundredths INTEGER CHECK (percent_hundredths BETWEEN 0 AND 10000),
  listing_amount INTEGER NOT NULL CHECK (listing_amount >= 0),
  expected_receipt INTEGER NOT NULL CHECK (expected_receipt >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploaded', 'purchased', 'excluded')),
  uploaded_at TEXT,
  purchased_at TEXT,
  PRIMARY KEY (split_id, user_id)
);

CREATE INDEX splits_distributor_active ON splits(guild_id, distributor_id, status, created_at DESC);
CREATE INDEX splits_guild_history ON splits(guild_id, created_at DESC);
CREATE INDEX members_user_status ON split_members(user_id, status, split_id);
CREATE INDEX members_split_status ON split_members(split_id, status);
