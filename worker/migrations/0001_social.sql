CREATE TABLE social_posts (
 id TEXT PRIMARY KEY,
 property_id TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('instagram','facebook','marketplace')),
 template TEXT NOT NULL CHECK(template IN ('square','portrait')),
 caption TEXT NOT NULL,
 photos TEXT NOT NULL,
 snapshot TEXT NOT NULL,
 fingerprint TEXT NOT NULL,
 assets TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN
 ('draft','pending','approved','scheduled','publishing','published','blocked','needs_review','cancelled')),
 revision INTEGER NOT NULL DEFAULT 1,
 created_by TEXT NOT NULL,
 approved_by TEXT,
 scheduled_at TEXT,
 remote_id TEXT,
 error TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX social_due ON social_posts(status, scheduled_at);
CREATE INDEX social_property ON social_posts(property_id);
CREATE TABLE social_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 post_id TEXT NOT NULL REFERENCES social_posts(id),
 revision INTEGER NOT NULL,
 kind TEXT NOT NULL,
 actor TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX social_event_post ON social_events(post_id, id);
-- Audit events are inserted in the same SQLite transaction as each mutation.
CREATE TRIGGER social_created AFTER INSERT ON social_posts BEGIN
 INSERT INTO social_events(post_id,revision,kind,actor,created_at)
 VALUES(NEW.id,NEW.revision,'draft',NEW.created_by,NEW.created_at);
END;
CREATE TABLE social_property_state (
 property_id TEXT PRIMARY KEY,
 fingerprint TEXT NOT NULL,
 available INTEGER NOT NULL,
 observed_at TEXT NOT NULL
);
