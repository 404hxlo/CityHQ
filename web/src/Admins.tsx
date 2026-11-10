import { Crown, ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import {
  api, type AdminEntry, type AdminRole, type KnownPlayer,
} from './api';
import {
  Button, Notice, Spinner, useAction, useConfirm, usePoll,
} from './ui';
import { Avatar, PlayerPicker } from './Visuals';

const ROLE_ORDER: AdminRole[] = ['god', 'admin', 'mod'];
const roleName = (a: AdminEntry, labels: Record<string, string>) => (a.role === 'full' ? 'Full access' : labels[a.role] || a.role);

/** Make people admins by picking them from everyone who has played. */
export function AdminsCard() {
  const { data, error, refresh } = usePoll(api.admins, 0);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<KnownPlayer | null>(null);
  const [role, setRole] = useState<AdminRole>('admin');

  if (error && !data) return <Notice kind="error">{error}</Notice>;
  if (!data) return <Spinner label="Reading admins" />;
  const labels = Object.fromEntries(Object.entries(data.roles).map(([k, v]) => [k, v.label]));

  const add = async () => {
    if (!chosen) return;
    const result = await run('add', () => api.addAdmin(chosen.license, role, chosen.name), (r) => (r.live
      ? `${chosen.name} is now ${labels[role].toLowerCase() === 'owner' ? 'an owner' : `a ${labels[role].toLowerCase()}`}. It works right away.`
      : `${chosen.name} is saved as ${labels[role]}. It takes effect when the server next starts.`));
    if (result) { setChosen(null); setAdding(false); refresh(); }
  };
  const remove = async (a: AdminEntry) => {
    const who = a.name || a.label || 'this player';
    const ok = await confirm({
      title: `Remove ${who}'s admin role?`,
      body: <p>They lose their admin commands right away. {a.line ? `This removes line ${a.line} of server.cfg.` : ''}</p>,
      confirm: 'Remove role',
      danger: true,
    });
    if (ok && await run(`rm:${a.identifier}`, () => api.removeAdmin(a.identifier), (r) => (r.live ? `${who} is no longer an admin` : `Removed. It takes effect when the server next starts.`))) refresh();
  };

  return (
    <div className="admins">
      <div className="card-row">
        <h4 className="admins-title"><ShieldCheck size={15} />Admins</h4>
        {!adding && <Button icon={<UserPlus size={15} />} onClick={() => setAdding(true)}>Make someone an admin</Button>}
      </div>
      {data.admins.length === 0 ? <p className="muted-note">Nobody has an admin role yet.</p> : (
        <ul className="people-list">
          {data.admins.map((a) => (
            <li key={`${a.identifier}-${a.principal}`}>
              <Avatar name={a.name || a.label || '?'} size={32} />
              <span className="people-main">
                <strong>{a.name || a.label || 'Unknown player'}</strong>
                <span className="muted-note">{a.identifier.split(':')[0] === 'license' ? 'FiveM license' : a.identifier.split(':')[0]} · line {a.line} of server.cfg</span>
              </span>
              <span className={`pill pill-role-${a.role}`}>{a.role === 'god' && <Crown size={12} />}{roleName(a, labels)}</span>
              <Button variant="ghost" busy={busy === `rm:${a.identifier}`} onClick={() => remove(a)}>Remove</Button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="admin-add">
          {!chosen ? (
            <>
              <p className="muted-note">Pick someone who has joined your server before.</p>
              {data.playersError ? <Notice kind="error">{data.playersError}</Notice> : (
                <PlayerPicker players={data.players} exclude={data.admins.map((a) => a.identifier)} onPick={setChosen} />
              )}
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
            </>
          ) : (
            <>
              <div className="chosen">
                <Avatar name={chosen.name} size={34} />
                <span className="people-main">
                  <strong>{chosen.name}</strong>
                  <span className="muted-note">{chosen.characters.map((c) => c.name).join(', ') || 'No character yet'}</span>
                </span>
                <Button variant="ghost" onClick={() => setChosen(null)}>Change</Button>
              </div>
              <div className="role-choices" role="radiogroup" aria-label="Role">
                {ROLE_ORDER.map((r) => (
                  <button key={r} role="radio" aria-checked={role === r} className={`role-choice${role === r ? ' active' : ''}`} onClick={() => setRole(r)}>
                    <strong>{r === 'god' && <Crown size={13} />}{data.roles[r].label}</strong>
                    <span>{data.roles[r].help}</span>
                  </button>
                ))}
              </div>
              <div className="button-row">
                <Button variant="primary" icon={<ShieldCheck size={15} />} busy={busy === 'add'} onClick={add}>Make {labels[role]}</Button>
                <Button variant="ghost" onClick={() => { setChosen(null); setAdding(false); }}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
