DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'customer',
  details TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'customer',
  account_id INTEGER,
  may_see TEXT NOT NULL DEFAULT '',
  must_not_see TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft TEXT NOT NULL,
  persona_id INTEGER,
  persona_name TEXT NOT NULL DEFAULT '',
  verdict TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'rules+llm',
  summary TEXT NOT NULL DEFAULT '',
  findings TEXT NOT NULL DEFAULT '[]',
  checklist TEXT NOT NULL DEFAULT '[]',
  rewrite TEXT,
  created_at INTEGER NOT NULL
);
