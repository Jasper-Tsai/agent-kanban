export const STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type Status = (typeof STATUSES)[number];
export const AGENTS = ['codex', 'claude', 'owner', 'none'] as const;
export type Agent = (typeof AGENTS)[number];
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const ACTORS = ['codex', 'claude', 'owner', 'webmcp', 'system'] as const;
export type Actor = (typeof ACTORS)[number];

export const AGENT_TOKEN_ACTORS = ['codex', 'claude'] as const;
export type AgentTokenActor = (typeof AGENT_TOKEN_ACTORS)[number];
export const PROJECT_STATUSES = ['active', 'paused', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  backlog: 'Backlog',
  todo: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};
export const AGENT_LABEL: Record<Agent, string> = {
  claude: 'Claude',
  codex: 'Codex',
  owner: 'Owner',
  none: 'Unassigned',
};
export const ACTOR_LABEL: Record<Actor, string> = {
  claude: 'Claude',
  codex: 'Codex',
  owner: 'Owner',
  webmcp: 'Browser agent',
  system: 'System',
};
export const PRIORITY_LABEL: Record<Priority, string> = { p0: 'P0', p1: 'P1', p2: 'P2', p3: 'P3' };

export const PROJECT_PALETTE = [
  '#E8956A',
  '#5CC8E0',
  '#F2C14E',
  '#5FCB8F',
  '#C4A5FF',
  '#FF8FA3',
  '#8AB4FF',
  '#D4C9A8',
] as const;


export const WIP_LIMITS: Partial<Record<Status, number>> = { in_progress: 6, review: 5 };
export const DONE_VISIBLE_DAYS = 14;


export const STALE_HOURS: Partial<Record<Status, number>> = { todo: 48, in_progress: 24, review: 48 };


export const REVIEW_WAIT_WARN_HOURS = 48;

export const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;


export const CARD_BRIEF_TEMPLATE = `## Goal
(One or two sentences: what should be achieved)
## Scope
(What is included and excluded)
## Acceptance
(How completion is verified)
## Related files and documents
(Repository paths, design docs, PRs, branches)
## Key decisions
(Date, decision, reason; add newer decisions below)
`;

export const HANDOFF_NOTE_PREFIX = '[handoff]';

export interface Card {
  id: number;
  project_id: string;
  title: string;
  description: string;
  status: Status;
  agent: Agent;
  priority: Priority;
  blocked: boolean;
  blocked_reason: string;
  needs_owner: boolean;
  branch: string | null;
  session_ref: string | null;
  tags: string[];
  due_date: string | null;
  position: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
  status_changed_at: string;
  stale: boolean;
  age_days: number;
  
  open_comments: number;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  description: string;
  repo_path: string | null;
  url: string | null;
  status: ProjectStatus;
  handoff: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  
  dormant: boolean;
  
  dormant_since: string | null;
}


export type SearchMatch = 'id' | 'title' | 'description' | 'branch' | 'tag' | 'comment';
export interface SearchResult {
  q: string;
  projects: Project[];
  cards: (Card & { match: SearchMatch })[];
  
  truncated: boolean;
}

export interface KanbanEvent {
  id: number;
  card_id: number | null;
  project_id: string;
  actor: Actor;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface Note {
  id: number;
  card_id: number;
  actor: Actor;
  body: string;
  created_at: string;
}

export const COMMENT_TARGETS = ['codex', 'claude'] as const;
export type CommentTarget = (typeof COMMENT_TARGETS)[number];
export const COMMENT_TARGETS_REQUESTED = ['codex', 'claude', 'any'] as const;
export type CommentTargetRequested = (typeof COMMENT_TARGETS_REQUESTED)[number];
export const COMMENT_STATUSES = ['open', 'answered', 'resolved'] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];
export const COMMENT_STATUS_LABEL: Record<CommentStatus, string> = { open: 'Awaiting reply', answered: 'Answered', resolved: 'Resolved' };


export interface Comment {
  id: number;
  card_id: number;
  parent_id: number | null;
  author: Actor;
  body: string;
  target: CommentTarget | null;
  target_requested: CommentTargetRequested | null;
  status: CommentStatus | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

export interface InboxItem extends CommentThread {
  card: { id: number; title: string; status: Status; project_id: string };
  project: { id: string; name: string; repo_path: string | null };
}
