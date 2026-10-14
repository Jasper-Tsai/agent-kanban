import { useSyncExternalStore } from 'react';
import type { CommentTarget, Status } from '../../shared/constants.ts';

export interface NewCardOpts {
  status?: Status;
  project?: string;
}
interface UiState {
  newCard: NewCardOpts | null;
  menuOpen: boolean;
  newProject: boolean;
  editProject: string | null;
  
  search: boolean;
  
  commentFocus: { cardId: number; target: CommentTarget; n: number } | null;
}
let state: UiState = { newCard: null, menuOpen: false, newProject: false, editProject: null, search: false, commentFocus: null };
let focusSeq = 0;
const listeners = new Set<() => void>();
const set = (p: Partial<UiState>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};
export const ui = {
  openNewCard: (o: NewCardOpts = {}) => set({ newCard: o }),
  closeNewCard: () => set({ newCard: null }),
  openNewProject: () => set({ newProject: true, menuOpen: false }),
  closeNewProject: () => set({ newProject: false }),
  openEditProject: (id: string) => set({ editProject: id }),
  closeEditProject: () => set({ editProject: null }),
  openSearch: () => set({ search: true, menuOpen: false }),
  closeSearch: () => set({ search: false }),
  requestCommentFocus: (cardId: number, target: CommentTarget) => set({ commentFocus: { cardId, target, n: ++focusSeq } }),
  clearCommentFocus: () => set({ commentFocus: null }),
  toggleMenu: (v?: boolean) => set({ menuOpen: v ?? !state.menuOpen }),
  get: () => state,
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
export const useUi = () => useSyncExternalStore(ui.subscribe, ui.get, ui.get);
