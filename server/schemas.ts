import { z } from 'zod';
import { AGENTS, COMMENT_STATUSES, COMMENT_TARGETS, COMMENT_TARGETS_REQUESTED, PRIORITIES, PROJECT_ID_RE, PROJECT_STATUSES, STATUSES } from '../shared/constants.ts';

export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Date does not exist');
export const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(30);
export const cardFields = {
  description: z.string().max(50000),
  status: z.enum(STATUSES),
  agent: z.enum(AGENTS),
  priority: z.enum(PRIORITIES),
  blocked: z.boolean(),
  blocked_reason: z.string().max(1000),
  needs_owner: z.boolean(),
  branch: z.string().max(200).nullable(),
  session_ref: z.string().max(500).nullable(),
  tags: tagsSchema,
  due_date: dateOnly.nullable(),
};
export const titleSchema = z.string().trim().min(1, 'Title is required').max(200, 'Title must not exceed 200 characters');
export const createCardSchema = z.object({ project_id: z.string(), title: titleSchema }).extend(
  Object.fromEntries(Object.entries(cardFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof cardFields]: z.ZodOptional<(typeof cardFields)[K]> },
);
export const patchCardSchema = z.object({ title: titleSchema.optional() }).extend(
  Object.fromEntries(Object.entries(cardFields).map(([k, v]) => [k, v.optional()])) as { [K in keyof typeof cardFields]: z.ZodOptional<(typeof cardFields)[K]> },
);
export const moveSchema = z.object({
  status: z.enum(STATUSES),
  before_id: z.number().int().positive().optional(),
  after_id: z.number().int().positive().optional(),
});
export const handoffSchema = z.string().max(50000);
export const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'Color must use #RRGGBB format');
export const createProjectSchema = z.object({
  id: z.string().regex(PROJECT_ID_RE, 'id must be a 2-40 character lowercase alphanumeric slug with hyphens'),
  name: z.string().trim().min(1).max(100),
  color: colorSchema.optional(),
  description: z.string().max(1000).optional(),
  repo_path: z.string().max(500).nullable().optional(),
  url: z.string().max(500).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  handoff: handoffSchema.optional(),
  sort_order: z.number().int().optional(),
});
export const patchProjectSchema = createProjectSchema.omit({ id: true }).partial();
export const noteSchema = z.object({ body: z.string().trim().min(1, 'Body is required').max(20000) });
export const commentBody = z.string().trim().min(1, 'Body is required').max(20000, 'Comment must not exceed 20000 characters');
export const createCommentSchema = z.object({ body: commentBody, target: z.enum(COMMENT_TARGETS_REQUESTED).default('codex') });
export const replyCommentSchema = z.object({ body: commentBody });
export const resolveCommentSchema = z.object({ resolved: z.boolean() });
export const inboxFilterSchema = z.object({
  status: z.enum([...COMMENT_STATUSES, 'all']).optional(),
  target: z.enum(COMMENT_TARGETS).optional(),
  project: z.string().optional(),
  card_id: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(200).optional(),
});
export const archiveSchema = z.object({ archived: z.boolean().optional() });

export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
}
