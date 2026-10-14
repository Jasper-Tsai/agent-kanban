import fs from 'node:fs';
import { z } from 'zod';
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { AGENTS, PRIORITIES, PROJECT_ID_RE, PROJECT_PALETTE, STATUSES } from '../shared/constants.ts';
import { POSITION_STEP } from '../shared/position.ts';

const seedSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string().regex(PROJECT_ID_RE),
      name: z.string().min(1),
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
      description: z.string().optional(),
      repo_path: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      handoff: z.string().optional(),
      cards: z
        .array(
          z.object({
            title: z.string().min(1).max(200),
            description: z.string().optional(),
            status: z.enum(STATUSES),
            agent: z.enum(AGENTS).optional(),
            priority: z.enum(PRIORITIES).optional(),
            blocked: z.boolean().optional(),
            blocked_reason: z.string().optional(),
            needs_owner: z.boolean().optional(),
            branch: z.string().nullable().optional(),
            session_ref: z.string().nullable().optional(),
            tags: z.array(z.string()).optional(),
            due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
          }),
        )
        .default([]),
    }),
  ),
});

export function importSeedIfEmpty(db: DB, seedFile: string, now: Date = new Date()): { projects: number; cards: number } | null {
  const n = (db.prepare('SELECT COUNT(*) c FROM projects').get() as { c: number }).c;
  if (n > 0 || !fs.existsSync(seedFile)) return null;
  const seed = seedSchema.parse(JSON.parse(fs.readFileSync(seedFile, 'utf8')));
  const ts = now.toISOString();
  let cardCount = 0;
  tx(db, () => {
    const insProject = db.prepare(
      `INSERT INTO projects (id,name,color,description,repo_path,url,status,handoff,sort_order,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',?,?,?,?)`,
    );
    const insCard = db.prepare(
      `INSERT INTO cards (project_id,title,description,status,agent,priority,blocked,blocked_reason,needs_owner,branch,session_ref,tags,due_date,position,archived,created_at,updated_at,status_changed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`,
    );
    const insEvent = db.prepare('INSERT INTO events (card_id, project_id, actor, type, payload, created_at) VALUES (?,?,?,?,?,?)');
    const posCounter: Record<string, number> = {};
    seed.projects.forEach((p, i) => {
      insProject.run(p.id, p.name, p.color ?? PROJECT_PALETTE[i % PROJECT_PALETTE.length], p.description ?? '', p.repo_path ?? null, p.url ?? null, p.handoff ?? '', i, ts, ts);
      insEvent.run(null, p.id, 'system', 'project.created', JSON.stringify({ name: p.name, seed: true }), ts);
      for (const c of p.cards) {
        posCounter[c.status] = (posCounter[c.status] ?? 0) + 1;
        const res = insCard.run(
          p.id,
          c.title,
          c.description ?? '',
          c.status,
          c.agent ?? 'none',
          c.priority ?? 'p2',
          c.blocked ? 1 : 0,
          c.blocked_reason ?? '',
          c.needs_owner ? 1 : 0,
          c.branch ?? null,
          c.session_ref ?? null,
          JSON.stringify(c.tags ?? []),
          c.due_date ?? null,
          posCounter[c.status] * POSITION_STEP,
          ts,
          ts,
          ts,
        );
        insEvent.run(Number(res.lastInsertRowid), p.id, 'system', 'card.created', JSON.stringify({ title: c.title, status: c.status, seed: true }), ts);
        cardCount++;
      }
    });
  });
  return { projects: seed.projects.length, cards: cardCount };
}
