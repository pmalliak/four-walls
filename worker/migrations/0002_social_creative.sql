-- Preserve the exact design of existing drafts/history; new drafts choose a
-- preset explicitly. Every design edit still clears approval and rendered assets.
ALTER TABLE social_posts ADD COLUMN creative TEXT NOT NULL DEFAULT '{"preset":"classic","version":1,"includeFacts":false,"includeCta":false}';
ALTER TABLE social_posts ADD COLUMN photos_confirmed_clean INTEGER NOT NULL DEFAULT 0 CHECK(photos_confirmed_clean IN (0,1));
