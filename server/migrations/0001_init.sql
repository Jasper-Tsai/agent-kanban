CREATE TABLE projects (
  id          TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) BETWEEN 2 AND 40),
  name        TEXT NOT NULL,
  color       TEXT NOT NULL CHECK (color GLOB '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  description TEXT NOT NULL DEFAULT '',
  repo_path   TEXT,
  url         TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  handoff     TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE "cards" (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('backlog','todo','in_progress','review','done')),
  agent             TEXT NOT NULL DEFAULT 'none' CHECK (agent IN ('codex','claude','owner','none')),
  priority          TEXT NOT NULL DEFAULT 'p2' CHECK (priority IN ('p0','p1','p2','p3')),
  blocked           INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0,1)),
  blocked_reason    TEXT NOT NULL DEFAULT '',
  needs_owner       INTEGER NOT NULL DEFAULT 0 CHECK (needs_owner IN (0,1)),
  branch            TEXT,
  session_ref       TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  due_date          TEXT,
  position          REAL NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  status_changed_at TEXT NOT NULL
);

CREATE TABLE "events" (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    INTEGER,
  project_id TEXT NOT NULL,
  actor      TEXT NOT NULL CHECK (actor IN ('codex','claude','owner','webmcp','system')),
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE "notes" (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id    INTEGER NOT NULL REFERENCES cards(id),
  actor      TEXT NOT NULL CHECK (actor IN ('codex','claude','owner','webmcp','system')),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE "comments" (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id          INTEGER NOT NULL REFERENCES cards(id),
  parent_id        INTEGER REFERENCES comments(id),
  author           TEXT NOT NULL CHECK (author IN ('codex','claude','owner','webmcp','system')),
  body             TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  target           TEXT CHECK (target IS NULL OR target IN ('codex','claude')),
  target_requested TEXT CHECK (target_requested IS NULL OR target_requested IN ('codex','claude','any')),
  status           TEXT CHECK (status IS NULL OR status IN ('open','answered','resolved')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  resolved_at      TEXT,
  CHECK ((parent_id IS NULL AND target IS NOT NULL AND status IS NOT NULL) OR (parent_id IS NOT NULL AND target IS NULL AND status IS NULL))
);

CREATE INDEX idx_cards_project ON cards(project_id);

CREATE INDEX idx_cards_status_position ON cards(status, position);

CREATE INDEX idx_cards_updated ON cards(updated_at);

CREATE INDEX idx_events_project ON events(project_id, id);

CREATE INDEX idx_events_card ON events(card_id, id);

CREATE INDEX idx_events_actor ON events(actor, id);

CREATE INDEX idx_notes_card ON notes(card_id, id);

CREATE INDEX idx_comments_card ON comments(card_id, id);

CREATE INDEX idx_comments_parent ON comments(parent_id, id);

CREATE INDEX idx_comments_inbox ON comments(status, target, id);
