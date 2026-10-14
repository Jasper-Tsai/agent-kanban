import { useLanguage } from '../i18n/index.ts';
import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.ts';


export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  useLanguage();
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className={`md ${className}`.trim()} dangerouslySetInnerHTML={{ __html: html }} />;
}
