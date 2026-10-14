import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { renderMarkdown } from '../src/lib/markdown.ts';

const purifier = createDOMPurify(new JSDOM('').window as any) as any;
const md = (s: string) => renderMarkdown(s, purifier);
const dom = (s: string) => new JSDOM(`<body>${md(s)}</body>`).window.document;

describe("Markdown rendering", () => {
  it("Bold, lists, inline code, blocks, quotes, and newlines", () => {
    const d = dom("**Conclusion**: possible\nSecond line\n\n1. One\n2. Two\n\n- a\n- b\n\n`x = 1`\n\n```\nline1\nline2\n```\n\n> Quote");
    expect(d.querySelector('strong')?.textContent).toBe("Conclusion");
    expect(d.querySelectorAll('ol > li')).toHaveLength(2);
    expect(d.querySelectorAll('ul > li')).toHaveLength(2);
    expect(d.querySelector('p code')?.textContent).toBe('x = 1');
    expect(d.querySelector('pre code')?.textContent).toContain('line1\nline2');
    expect(d.querySelector('blockquote')).toBeTruthy();
    expect(d.querySelector('p br')).toBeTruthy();
  });

  it("HTTP links use a new tab and noopener noreferrer", () => {
    const a = dom('[docs](https://example.com/x?a=1)').querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/x?a=1');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it("Sanitize XSS scripts, event attributes, unsafe URLs, data URLs, and styles", () => {
    const payloads = [
      '<img src=x onerror="alert(1)">',
      '<script>alert(1)</script>',
      '[x](javascript:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '<a href="javascript:alert(1)" onclick="alert(2)">y</a>',
      '<div style="background:url(javascript:alert(1))" onmouseover="alert(3)">z</div>',
      '<iframe src="https://evil.test"></iframe>',
      '<svg onload=alert(1)><circle/></svg>',
      '![alt](https://evil.test/track.png)',
      '<details open ontoggle=alert(1)>',
    ];
    for (const p of payloads) {
      const html = md(p);
      const d = new JSDOM(`<body>${html}</body>`).window.document;
      expect(d.querySelector('script, iframe, svg, img, object, embed, style'), p).toBeNull();
      for (const el of Array.from(d.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          expect(attr.name.startsWith('on'), `${p} → ${attr.name}`).toBe(false);
          expect(['href', 'title', 'start', 'target', 'rel'], `${p} → ${attr.name}`).toContain(attr.name);
        }
        const href = el.getAttribute('href');
        if (href) expect(href, p).toMatch(/^(https?:|mailto:)/i);
      }
      expect(html.toLowerCase()).not.toMatch(/<script|<img /);
    }
  });

  it("Raw HTML stays literal; images show alternative text", () => {
    const d = dom("Before <b>bold</b> <script>alert(1)</script> After");
    expect(d.body.textContent).toContain("<b>bold</b>");
    expect(d.querySelector('b, script')).toBeNull();
    expect(dom("![Alternative text](https://evil.test/a.png)").body.textContent).toContain("Alternative text");
  });

  it("Empty and undefined input are safe", () => {
    expect(md('')).toBe('');
    expect(md(undefined as unknown as string)).toBe('');
  });
});
