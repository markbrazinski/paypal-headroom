import { useEffect, useRef, useState, type ReactNode } from 'react';
import { themeQuartz } from 'ag-grid-community';
import type { InvoiceRow } from '@headroom/contracts';

type Tone = 'amber' | 'brand' | 'grey' | 'green' | 'red' | 'slate';
export const Pill = ({ tone, glyph, children }: { tone: Tone; glyph: string; children: ReactNode }) => (
  <span className={`pill p-${tone}`}><span aria-hidden>{glyph}</span>{children}</span>
);
export const Tag = ({ kind }: { kind: 'SEEDED' | 'ACTUAL' | 'PENDING' | 'UNDATED' }) => <span className={`tag ${kind}`}>{kind}</span>;

/** Status pill for an invoice row (glyph + word). Overdue uses the business date from the session. */
export function InvoicePill({ inv, today }: { inv: InvoiceRow; today: string }) {
  if (inv.hold) return <Pill tone="amber" glyph="‖">Hold</Pill>;
  if (inv.state === 'DRAFT') return <Pill tone="grey" glyph="○">Draft</Pill>;
  if (inv.state === 'ISSUING') return <Pill tone="amber" glyph="◐">{inv.waitingReason ? 'Waiting' : 'Issuing'}</Pill>;
  if (inv.state === 'ISSUE_UNKNOWN') return <Pill tone="amber" glyph="?">Checking with PayPal</Pill>;
  if (inv.state === 'FAILED') return <Pill tone="red" glyph="✕">Failed</Pill>;
  if (inv.state === 'PAID') return <Pill tone="green" glyph="✓">Paid</Pill>;
  if (inv.state === 'PARTIALLY_PAID') return <Pill tone="amber" glyph="◐">Part paid</Pill>;
  if (inv.dueOn < today) return <Pill tone="amber" glyph="!">Overdue</Pill>;
  return <Pill tone="grey" glyph="○">Open</Pill>;
}

export function Panel({ kicker, title, onClose, children, status }: { kicker: string; title: ReactNode; onClose: () => void; children: ReactNode; status?: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.focus(); }, [kicker]);
  return (
    <aside className="panel" ref={ref} tabIndex={-1} aria-label={kicker}>
      <button className="close" aria-label="Close panel" onClick={onClose}>×</button>
      <div className="ph">
        <div className="kicker">{kicker}</div>
        <h2>{title}</h2>
        {status}
      </div>
      {children}
    </aside>
  );
}

export function Dialog({ kicker, title, onClose, children, footer }: { kicker: string; title: string; onClose: () => void; children: ReactNode; footer: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('select, input, button.primary, button');
    first?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dh"><div className="kicker">{kicker}</div><div className="serif" style={{ fontSize: 22 }}>{title}</div></div>
        <div className="db">{children}</div>
        <div className="df">{footer}</div>
      </div>
    </div>
  );
}

/** A short status line. With `onOpen` (a confirmed event: receipt, skipped offer, supplier paid) it links to the record and stays longer. */
export function Toast({ text, onClose, onOpen }: { text: string; onClose: () => void; onOpen?: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, onOpen ? 10_000 : 6000); return () => clearTimeout(t); }, [text, onClose, onOpen]);
  return <div className={`toast ${onOpen ? 'toast-event' : ''}`} role="status">{onOpen && <span className="toast-dot" aria-hidden />}{text}{onOpen && <button className="toast-open" onClick={() => { onOpen(); onClose(); }}>View ›</button>}<button aria-label="Dismiss" onClick={onClose}>×</button></div>;
}

/** A styled single-choice menu (the native select's popup can't take the app's styling). Escape or a click outside closes it. */
export function Picker({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string; hint?: string }[]; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('mousedown', away); addEventListener('keydown', esc);
    return () => { removeEventListener('mousedown', away); removeEventListener('keydown', esc); };
  }, [open]);
  const cur = options.find((o) => o.value === value) ?? options[0];
  return (
    <div className="picker" ref={ref}>
      <span className="small muted">{label}</span>
      <button className="picker-btn" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((x) => !x)}>{cur?.label}<span aria-hidden className="picker-caret">▾</span></button>
      {open && (
        <div className="picker-menu" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button key={o.value} role="option" aria-selected={o.value === value} className={`picker-opt ${o.value === value ? 'on' : ''}`} title={o.hint} onClick={() => { onChange(o.value); setOpen(false); }}>
              <span>{o.label}</span>{o.hint && <span className="small muted">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const Loading = () => <div className="muted" style={{ padding: 18 }}>Loading…</div>;
export const Failed = ({ error }: { error: unknown }) => <div className="err-banner">Couldn't load: {(error as Error)?.message ?? String(error)}</div>;

/** Quartz + Identity params: surface bg, #F6F2E9 header, #DAD3C4 borders, row 42, header 36, radius 0. */
export const gridTheme = themeQuartz.withParams({
  backgroundColor: '#FFFDF8', headerBackgroundColor: '#F6F2E9', borderColor: '#DAD3C4', rowBorder: { color: '#DAD3C4' },
  rowHeight: 42, headerHeight: 36, borderRadius: 0, wrapperBorderRadius: 0, fontFamily: "'Public Sans', system-ui, sans-serif",
  fontSize: 13.5, headerFontWeight: 500, foregroundColor: '#1B211E', headerTextColor: '#575C56', accentColor: '#2E5E47',
  rowHoverColor: '#FFFAF0', selectedRowBackgroundColor: '#E3EDE6',
});
