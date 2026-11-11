import {
  useEffect, useId, useRef, useState, type ReactNode,
} from 'react';
import { GLOSSARY } from './glossary';

/**
 * A word with a plain-English explanation: dotted underline, explanation on hover, focus or tap.
 * Esc or tapping elsewhere closes it.
 */
export function Term({ id, children }: { id: keyof typeof GLOSSARY | string; children?: ReactNode }) {
  const entry = GLOSSARY[id];
  const [open, setOpen] = useState(false);
  const tip = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  if (!entry) return <>{children}</>;
  return (
    <span className="term" ref={wrap} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="term-word"
        aria-describedby={open ? tip : undefined}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {children ?? entry.term}
      </button>
      {open && (
        <span role="tooltip" id={tip} className="term-tip">
          <strong>{entry.term}</strong>
          {entry.short}
        </span>
      )}
    </span>
  );
}
