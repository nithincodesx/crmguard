ALTER TABLE checks ADD COLUMN check_type TEXT NOT NULL DEFAULT 'reply';
--> statement-breakpoint
ALTER TABLE checks ADD COLUMN rewrite_verdict TEXT;
--> statement-breakpoint
CREATE TABLE policy_packs (
  id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0
);
