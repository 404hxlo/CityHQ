import {
  Bug, Check, Copy, ExternalLink, Eye, Pencil,
} from 'lucide-react';
import { useState } from 'react';
import { api } from './api';
import {
  Button, Modal, Notice, useAction, useToast,
} from './ui';

type Report = Awaited<ReturnType<typeof api.report>>;

/** Copies text, falling back to a selected text box where the clipboard isn't allowed (a phone on plain http). */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    return ok;
  }
}

function ReportDialog({ onClose }: { onClose: () => void }) {
  const [what, setWhat] = useState('');
  const [doing, setDoing] = useState('');
  const [includeDetails, setIncludeDetails] = useState(true);
  const [report, setReport] = useState<Report | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, run } = useAction();
  const toast = useToast();

  const preview = async () => {
    const result = await run('preview', () => api.report(what, doing, includeDetails));
    if (result) { setReport(result); setCopied(false); }
  };

  const copy = async () => {
    if (!report) return;
    const ok = await copyText(report.body);
    setCopied(ok);
    toast(ok ? 'Report copied' : 'Couldn\'t copy. Select the text above and copy it.', ok ? 'ok' : 'error');
  };

  const openGithub = async () => {
    if (!report) return;
    // A long report doesn't fit in the link: copy all of it to paste on GitHub.
    if (!report.complete) await copy();
    window.open(report.url, '_blank', 'noreferrer');
  };

  if (report) {
    return (
      <Modal
        title="Check your report"
        onClose={onClose}
        wide
        footer={(
          <>
            <Button icon={<Pencil size={15} />} onClick={() => setReport(null)}>Edit</Button>
            <Button icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button variant="primary" icon={<ExternalLink size={15} />} onClick={openGithub}>Open on GitHub</Button>
          </>
        )}
      >
        <p className="muted-note">
          This is everything that goes in the report. License keys, passwords, player IDs, IP addresses and your Windows user name were taken out.
          Reports on GitHub are public, so read it through once.
        </p>
        <textarea className="input report-preview" readOnly value={report.body} aria-label="The report" />
        <Notice kind="info">
          {report.complete
            ? <>Open on GitHub fills in a new report there; press <strong>Create</strong> on that page to send it. You need a free GitHub account.</>
            : <>The report is too long to fill in by itself, so it's copied when you press Open on GitHub. Paste it into the report there, then press <strong>Create</strong>.</>}
          {' '}No GitHub account? Making one is free, or copy the report and share it wherever you ask for help.
        </Notice>
      </Modal>
    );
  }

  return (
    <Modal
      title="Report a problem with CityHQ"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Eye size={15} />} busy={busy === 'preview'} disabled={!what.trim()} onClick={preview}>See the report</Button>
        </>
      )}
    >
      <p className="muted-note">
        For problems with CityHQ itself. For a script or the server, Things to fix on Home and the Health page usually explain what to do.
        Nothing is sent until you look over the report and choose to.
      </p>
      <label className="input-label" htmlFor="report-what">What went wrong?</label>
      <textarea id="report-what" className="input report-input" rows={4} maxLength={4000} autoFocus value={what} onChange={(e) => setWhat(e.target.value)} placeholder="For example: the Backups page says 'Something went wrong' when I press Back up now." />
      <label className="input-label" htmlFor="report-doing">What were you doing just before? (optional)</label>
      <textarea id="report-doing" className="input report-input" rows={3} maxLength={2000} value={doing} onChange={(e) => setDoing(e.target.value)} />
      <label className="check-row">
        <input type="checkbox" checked={includeDetails} onChange={(e) => setIncludeDetails(e.target.checked)} />
        <span>Include technical details: CityHQ and Windows versions, the kind of setup, the problems CityHQ shows and the last lines of its log, with private details taken out.</span>
      </label>
    </Modal>
  );
}

/** The button that opens Report a problem. */
export function ReportButton({ label = 'Report a problem' }: { label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={<Bug size={15} />} onClick={() => setOpen(true)}>{label}</Button>
      {open && <ReportDialog onClose={() => setOpen(false)} />}
    </>
  );
}
