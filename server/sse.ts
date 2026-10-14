import type { Broadcast } from './store.ts';

export type SseClient = (chunk: string) => void;

export class SseHub {
  private clients = new Set<SseClient>();
  add(c: SseClient) {
    this.clients.add(c);
    return () => this.clients.delete(c);
  }
  get size() {
    return this.clients.size;
  }
  publish(b: Broadcast) {
    const data = `event: kanban\ndata: ${JSON.stringify(b)}\n\n`;
    for (const c of this.clients) {
      try {
        c(data);
      } catch {
        this.clients.delete(c);
      }
    }
  }
}
