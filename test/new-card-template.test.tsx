// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_BRIEF_TEMPLATE } from '../shared/constants.ts';
import { NewCardDialog } from '../src/components/Dialogs.tsx';
import { store } from '../src/store/store.ts';
import { ui } from '../src/store/ui.ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  store.state = { ...store.state, auth: 'in', loaded: true, projects: [{ id: 'demo', name: 'Demo', status: 'active' } as any], cards: [] };
});
afterEach(async () => {
  ui.closeNewCard();
  await act(async () => root.unmount());
  host.remove();
});

describe("New card task brief template", () => {
  it("Show the brief in an empty description placeholder without submitting it", async () => {
    await act(async () => { ui.openNewCard({}); root.render(<NewCardDialog />); });
    const ta = host.querySelector<HTMLTextAreaElement>('#nc-d')!;
    expect(ta).not.toBeNull();
    expect(ta.value).toBe('');
    for (const h of ["## Goal", "## Scope", "## Acceptance", "## Related files and documents", "## Key decisions"]) expect(ta.placeholder).toContain(h);
    expect(ta.placeholder).toContain(CARD_BRIEF_TEMPLATE.trim());
  });
});
