import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

const DONE_KEY = 'cityhq-tour-done';
const START_EVENT = 'cityhq-start-tour';

interface Step { target?: string; title: string; text: string }

const STEPS: Step[] = [
  { title: 'Welcome to CityHQ', text: 'A one-minute tour of where everything is. You can replay it any time from Settings or the Learn page.' },
  { target: '#overview', title: 'Overview', text: 'Whether the server is running, who\'s on, and anything that needs attention, with the problem explained and a fix button when there\'s a safe one.' },
  { target: '#health', title: 'Health', text: 'Checks for common setup problems, explains why the server restarted, and walks you through letting friends join.' },
  { target: '#city', title: 'City', text: 'Change the weather and time, show announcements to everyone, and manage who\'s allowed in.' },
  { target: '#players', title: 'Players', text: 'Help the people who are on: heal, teleport, give items or money, change jobs, kick or ban.' },
  { target: '#resources', title: 'Resources', text: 'Your scripts. Add new ones (each gets an install check), start or stop them, and choose which start with the server.' },
  { target: '#files', title: 'Files', text: 'Open and edit any server file. Every save keeps a backup, and mistakes are caught before they reach the server.' },
  { target: '#backups', title: 'Backups', text: 'Back up and restore the server, and see "What changed": every change made through CityHQ, with Undo.' },
  { target: '#console', title: 'Console', text: 'The server\'s live log, and a place to type server commands.' },
  { target: '#settings', title: 'Settings', text: 'Automatic backups, keeping the PC awake, phone access, your server profile and admin roles.' },
  { target: '.header-help', title: 'Help when you need it', text: 'Dotted words explain themselves when you point at or tap them. The Learn page covers the basics and every term.' },
];

const done = () => { try { return localStorage.getItem(DONE_KEY) === '1'; } catch { return true; } };
const markDone = () => { try { localStorage.setItem(DONE_KEY, '1'); } catch { /* only a convenience */ } };

/** Starts the tour from anywhere, such as a "Take the tour" button. */
export const startTour = () => window.dispatchEvent(new Event(START_EVENT));

function targetOf(step: Step): Element | null {
  if (!step.target) return null;
  if (step.target.startsWith('#')) {
    const link = document.querySelector(`.rail a[href="${step.target}"]`);
    if (link && link.getBoundingClientRect().width > 0) return link;
  }
  const el = document.querySelector(step.target);
  return el && el.getBoundingClientRect().width > 0 ? el : null;
}

/** The first-run tour: a spotlight on each part of the app with a short explanation. */
export function Tour({ autoStart = true }: { autoStart?: boolean }) {
  const [index, setIndex] = useState<number | null>(null);
  // The first-run tour waits until there's a dashboard to show (not txAdmin's setup steps).
  useEffect(() => { if (autoStart && !done()) setIndex((i) => (i === null ? 0 : i)); }, [autoStart]);
  const [box, setBox] = useState<DOMRect | null>(null);

  useEffect(() => {
    const start = () => setIndex(0);
    window.addEventListener(START_EVENT, start);
    return () => window.removeEventListener(START_EVENT, start);
  }, []);

  // Skip steps whose target isn't on screen (the help button doesn't exist on phones). Worked out
  // after the page has drawn, so the header is there to be found.
  const [steps, setSteps] = useState<Step[]>(STEPS);
  const running = index !== null;
  useEffect(() => {
    if (!running) return undefined;
    const pick = () => setSteps(STEPS.filter((s) => !s.target || s.target.startsWith('#') || targetOf(s)));
    const frame = requestAnimationFrame(pick);
    window.addEventListener('resize', pick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', pick); };
  }, [running]);
  const step = index === null ? null : steps[Math.min(index, steps.length - 1)];

  const measure = useCallback(() => {
    if (!step) return;
    const el = targetOf(step);
    setBox(el ? el.getBoundingClientRect() : null);
  }, [step]);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const close = useCallback(() => { markDone(); setIndex(null); }, []);
  useEffect(() => {
    if (index === null) return undefined;
    const keys = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setIndex((i) => (i === null ? i : Math.min(steps.length - 1, i + 1)));
      if (e.key === 'ArrowLeft') setIndex((i) => (i === null ? i : Math.max(0, Math.min(i, steps.length - 1) - 1)));
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [index, close, steps.length]);

  if (index === null || !step) return null;
  // The step list can shrink while the tour is open (a resize to phone width), leaving index past the end.
  const pos = Math.min(index, steps.length - 1);
  const last = pos === steps.length - 1;
  const phone = window.innerWidth <= 760;
  // The card sits beside the highlighted item: to the right of the side menu, above the phone's bottom bar.
  let cardStyle: React.CSSProperties = {};
  if (box && !phone) cardStyle = { left: Math.min(box.right + 16, window.innerWidth - 360), top: Math.max(12, Math.min(box.top - 10, window.innerHeight - 230)) };
  if (box && phone) cardStyle = { left: 12, right: 12, bottom: window.innerHeight - box.top + 12 };

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {box
        ? <div className="tour-spot" style={{ left: box.left - 4, top: box.top - 4, width: box.width + 8, height: box.height + 8 }} />
        : <div className="tour-dim" />}
      <div className={`tour-card ${box ? '' : 'tour-card-center'}`} style={cardStyle}>
        <button type="button" className="icon-btn tour-close" aria-label="Close the tour" onClick={close}><X size={16} /></button>
        <p className="tour-count">{pos + 1} of {steps.length}</p>
        <h3 id="tour-title">{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-actions">
          {pos > 0 && <button type="button" className="btn btn-ghost" onClick={() => setIndex(pos - 1)}><ArrowLeft size={15} /><span>Back</span></button>}
          {!last && <button type="button" className="btn btn-ghost" onClick={close}>Skip</button>}
          <button type="button" className="btn btn-primary" onClick={() => (last ? close() : setIndex(pos + 1))}>
            <span>{last ? 'Done' : 'Next'}</span>{!last && <ArrowRight size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
