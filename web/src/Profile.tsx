import { Copy, ExternalLink, IdCard, Save } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import {
  Button, Spinner, useAction, usePoll, useToast,
} from './ui';

// FiveM's colour codes in server names: ^0 to ^9.
const COLOURS: Record<string, string> = {
  0: '#ffffff', 1: '#f44336', 2: '#4caf50', 3: '#ffeb3b', 4: '#42a5f5', 5: '#03a9f4', 6: '#9c27b0', 7: '#ffffff', 8: '#ff5722', 9: '#9e9e9e',
};

/** How a name with ^ colour codes looks in the server list. */
export function colourParts(name: string): { text: string; colour: string }[] {
  const out: { text: string; colour: string }[] = [];
  let colour = COLOURS[0];
  for (const piece of name.split(/(\^\d)/)) {
    const code = piece.match(/^\^(\d)$/);
    if (code) { colour = COLOURS[code[1]]; continue; }
    if (piece) out.push({ text: piece, colour });
  }
  return out;
}

function NameMaker() {
  const toast = useToast();
  const [name, setName] = useState('^3My City ^7| ^5QBCore roleplay');
  const parts = colourParts(name);
  const copy = async () => {
    try { await navigator.clipboard.writeText(name); toast('Copied. Paste it as the server name on the Cfx.re Portal.'); } catch { toast('Couldn\'t copy. Select the text and copy it instead.', 'error'); }
  };
  return (
    <div className="name-maker">
      <label className="input-label" htmlFor="name-maker">Try a server name</label>
      <div className="name-maker-row">
        <input id="name-maker" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        <button type="button" className="icon-btn" aria-label="Copy the name" title="Copy" onClick={copy}><Copy size={16} /></button>
      </div>
      <div className="name-preview" aria-label="How it looks in the server list">
        {parts.length ? parts.map((p, i) => <span key={i} style={{ color: p.colour }}>{p.text}</span>) : <span className="muted-note">Type a name above</span>}
      </div>
      <p className="muted-note">
        Colours: {Object.entries(COLOURS).filter(([k]) => k !== '7').map(([k, c]) => <code key={k} style={{ color: c }}>^{k} </code>)}
        put one before the words to colour.
      </p>
    </div>
  );
}

function Row({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <div className="switch-row">
      <div>
        <div className="field-label">{title}</div>
        <div className="field-help">{help}</div>
      </div>
      <div className="profile-control">{children}</div>
    </div>
  );
}

/** Server profile: the listing (on the Cfx.re Portal), player slots and the game version. */
export function ProfileCard() {
  const { data, setData } = usePoll(api.profile, 0);
  const { busy, run } = useAction();
  const [slots, setSlots] = useState('');
  useEffect(() => { if (data?.maxClients) setSlots(String(data.maxClients)); }, [data?.maxClients]);
  if (!data) return <section className="card"><Spinner /></section>;
  const changed = Number(slots) !== data.maxClients;
  const save = async () => {
    const updated = await run('slots', () => api.setSlots(Number(slots)), 'Saved. It applies the next time the server restarts.');
    if (updated) setData(updated);
  };
  return (
    <section className="card">
      <h3 className="card-title"><IdCard size={16} />Server profile</h3>
      <div className="profile-portal">
        <div>
          <div className="field-label">Name, description, tags, language, icon and banners</div>
          <div className="field-help">FiveM now keeps these on the Cfx.re Portal, so server.cfg can't change them any more. Sign in there with the account that owns your server's license key, choose your server, then Server Listing.</div>
        </div>
        <a className="btn btn-default" href={data.portalUrl} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span>Open the Cfx.re Portal</span></a>
      </div>
      <NameMaker />
      <Row title="Player slots" help="How many people can be on at once. It applies at the next restart.">
        <input className="input input-number" type="number" min={1} max={2048} value={slots} onChange={(e) => setSlots(e.target.value)} aria-label="Player slots" />
        <Button variant="primary" icon={<Save size={15} />} disabled={!changed || !slots} busy={busy === 'slots'} onClick={save}>Save</Button>
      </Row>
      <Row title="Game version" help="The GTA V update your server uses, which decides which cars, clothes and places exist. Changing it makes every player download it again and can break some scripts, so it's shown here but not changed here.">
        <span className="profile-value">{data.gameBuild ? `${data.gameBuild}${data.gameBuildName ? `: ${data.gameBuildName}` : ''}` : 'The default'}</span>
      </Row>
    </section>
  );
}
