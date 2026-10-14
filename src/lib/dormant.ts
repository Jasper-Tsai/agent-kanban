import type { Agent, CommentTarget, Project, SearchResult, Card, SearchMatch } from '../../shared/constants.ts';


export function splitProjects<P extends { status: string; dormant: boolean }>(projects: P[]): { active: P[]; dormant: P[] } {
  const live = projects.filter((p) => p.status !== 'archived');
  return { active: live.filter((p) => !p.dormant), dormant: live.filter((p) => p.dormant) };
}


export function returnTarget(agent: Agent): CommentTarget {
  return agent === 'claude' || agent === 'codex' ? agent : 'codex';
}

export interface SearchGroup {
  project_id: string;
  name: string;
  color: string;
  dormant: boolean;
  cards: (Card & { match: SearchMatch })[];
}


export function groupSearch(result: Pick<SearchResult, 'cards'>, projects: Project[]): SearchGroup[] {
  const byProject = new Map<string, SearchGroup['cards']>();
  for (const c of result.cards) {
    const list = byProject.get(c.project_id) ?? [];
    list.push(c);
    byProject.set(c.project_id, list);
  }
  const groups: SearchGroup[] = [];
  for (const p of projects) {
    const cards = byProject.get(p.id);
    if (!cards) continue;
    groups.push({ project_id: p.id, name: p.name, color: p.color, dormant: p.dormant, cards });
    byProject.delete(p.id);
  }
  for (const [id, cards] of byProject) groups.push({ project_id: id, name: id, color: '#97A1AF', dormant: false, cards });
  return groups;
}


export function moveSelection(index: number, delta: number, len: number): number {
  if (len <= 0) return -1;
  return Math.min(len - 1, Math.max(0, index + delta));
}
