import type { Card } from '../../shared/constants.ts';
import { store } from '../store/store.ts';
import { ui } from '../store/ui.ts';
import { returnTarget } from './dormant.ts';
import { currentRoute, navigate } from './router.ts';
import { buildUrl } from './url-state.ts';


export async function approveCard(card: Pick<Card, 'id'>): Promise<boolean> {
  try {
    await store.setStatus(card.id, 'done');
    return true;
  } catch (e) {
    store.error(e);
    return false;
  }
}


export async function rejectCard(card: Pick<Card, 'id' | 'agent'>): Promise<boolean> {
  try {
    await store.setStatus(card.id, 'in_progress');
  } catch (e) {
    store.error(e);
    return false;
  }
  ui.requestCommentFocus(card.id, returnTarget(card.agent));
  navigate(buildUrl({ ...currentRoute(), card: card.id }));
  return true;
}
