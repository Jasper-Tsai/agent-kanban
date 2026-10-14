import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';



const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'];
const ALLOWED_ATTR = ['href', 'title', 'start'];
const SAFE_URI = /^(?:https?:|mailto:)/i;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const renderer = new Renderer();
renderer.html = ({ text }) => escapeHtml(text); 
renderer.image = ({ text }) => escapeHtml(text); 

type Purifier = { sanitize: (dirty: string, cfg: Record<string, unknown>) => string; addHook: (name: string, fn: (node: any) => void) => void };
const hooked = new WeakSet<object>();


export function renderMarkdown(src: string, purifier?: Purifier): string {
  const p = (purifier ?? (DOMPurify as unknown as Purifier));
  if (!hooked.has(p)) {
    hooked.add(p);
    p.addHook('afterSanitizeAttributes', (node: any) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  const dirty = marked.parse(src ?? '', { gfm: true, breaks: true, async: false, renderer }) as string;
  return p.sanitize(dirty, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP: SAFE_URI, ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false });
}
