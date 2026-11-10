import {
  Ban as BanIcon, Briefcase, Gavel, HeartPulse, LogOut, MessageSquare, PackagePlus, ShieldOff, Trash2, Users, Wallet,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Ban, type Group, type InventoryItem, type Player, type Shared } from '../api';
import {
  Button, Drawer, Empty, formatMoney, Modal, Notice, Segmented, Spinner, useAction, useConfirm, usePoll,
} from '../ui';

const BAN_LENGTHS = [
  { label: '1 hour', hours: 1 }, { label: '1 day', hours: 24 }, { label: '1 week', hours: 168 },
  { label: '30 days', hours: 720 }, { label: 'Permanent', hours: 0 },
];

function GroupEditor({ title, icon, groups, current, grade, busy, onApply }: {
  title: string; icon: React.ReactNode; groups: Group[]; current?: string; grade?: number; busy: boolean;
  onApply: (name: string, grade: number) => void;
}) {
  const [name, setName] = useState(current || '');
  const [level, setLevel] = useState(grade ?? 0);
  useEffect(() => { setName(current || ''); setLevel(grade ?? 0); }, [current, grade]);
  const grades = groups.find((g) => g.name === name)?.grades || [];
  const changed = name !== current || level !== grade;
  return (
    <section className="card">
      <h3 className="card-title">{icon}{title}</h3>
      <div className="input-row wrap">
        <select className="input" aria-label={title} value={name} onChange={(e) => { setName(e.target.value); setLevel(0); }}>
          {groups.map((g) => <option key={g.name} value={g.name}>{g.label}</option>)}
        </select>
        <select className="input" aria-label={`${title} grade`} value={level} onChange={(e) => setLevel(Number(e.target.value))}>
          {grades.map((g) => <option key={g.level} value={g.level}>{g.name}</option>)}
        </select>
        <Button busy={busy} disabled={!changed} onClick={() => onApply(name, level)}>Apply</Button>
      </div>
    </section>
  );
}

function PlayerDetail({ player, shared, onClose, reload }: { player: Player; shared: Shared | null; onClose: () => void; reload: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [inventory, setInventory] = useState<InventoryItem[] | null>(null);
  const [inventoryError, setInventoryError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [item, setItem] = useState('');
  const [amount, setAmount] = useState('1');
  const [note, setNote] = useState('');
  const [banOpen, setBanOpen] = useState(false);
  const [banHours, setBanHours] = useState(24);
  const [banReason, setBanReason] = useState('');
  const hasCharacter = Boolean(player.citizenid);

  const loadInventory = async () => {
    if (!hasCharacter) return;
    try {
      setInventory(await api.inventory(player.id));
      setInventoryError(null);
    } catch (err) {
      setInventoryError((err as Error).message);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadInventory(); }, [player.id, hasCharacter]);

  const action = async (key: string, name: string, extra: Record<string, unknown> = {}) => {
    const result = await run(key, () => api.playerAction(player.id, name, extra), (r) => r.message);
    reload();
    return result;
  };

  const itemName = useMemo(() => {
    const raw = item.trim().toLowerCase();
    const match = shared?.items.find((i) => i.name.toLowerCase() === raw || i.label.toLowerCase() === raw);
    return match?.name || raw;
  }, [item, shared]);

  const give = async () => {
    const r = await action('give', 'giveItem', { item: itemName, amount: Number(amount) });
    if (r) { setItem(''); setAmount('1'); loadInventory(); }
  };
  const removeOne = async (inv: InventoryItem) => {
    const r = await action(`rm:${inv.slot}`, 'removeItem', { item: inv.name, amount: 1 });
    if (r) loadInventory();
  };
  const kick = async () => {
    const ok = await confirm({ title: `Kick ${player.name}?`, body: <p>They can rejoin right away.</p>, confirm: 'Kick', danger: true });
    if (ok && await action('kick', 'kick', { reason: 'Removed by an admin' })) onClose();
  };
  const ban = async () => {
    const r = await action('ban', 'ban', { reason: banReason.trim() || 'Banned by an admin', hours: banHours || undefined });
    if (r) { setBanOpen(false); onClose(); }
  };

  return (
    <Drawer onClose={onClose} label={player.name}>
      <header className="drawer-head">
        <div>
          <h2>{player.character?.trim() || player.name}</h2>
          <p className="muted-note">{player.name} · Server ID {player.id} · {player.ping} ms{player.citizenid && ` · ${player.citizenid}`}</p>
        </div>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </header>

      {!hasCharacter && <Notice kind="info">{player.name} has not chosen a character yet, so money, job and items are not available.</Notice>}

      {hasCharacter && (
        <>
          <section className="card">
            <h3 className="card-title"><Wallet size={16} />Money</h3>
            <div className="money-grid">
              {Object.entries(player.money || {}).map(([type, value]) => {
                const draft = drafts[type];
                const changed = draft !== undefined && draft !== '' && Number(draft) !== value;
                return (
                  <div key={type} className="money-row">
                    <div>
                      <div className="money-type">{type}</div>
                      <div className="money-value">{formatMoney(value)}</div>
                    </div>
                    <input
                      className="input input-number"
                      type="number"
                      min={0}
                      inputMode="numeric"
                      aria-label={`New ${type} amount`}
                      placeholder="New amount"
                      value={draft ?? ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [type]: e.target.value }))}
                    />
                    <Button
                      busy={busy === `money:${type}`}
                      disabled={!changed}
                      onClick={async () => {
                        const r = await action(`money:${type}`, 'setMoney', { type, amount: Number(draft) });
                        if (r) setDrafts((d) => { const c = { ...d }; delete c[type]; return c; });
                      }}
                    >
                      Set
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          {shared && (
            <>
              <GroupEditor
                title="Job"
                icon={<Briefcase size={16} />}
                groups={shared.jobs}
                current={player.job?.name}
                grade={player.job?.grade}
                busy={busy === 'job'}
                onApply={(job, grade) => action('job', 'setJob', { job, grade })}
              />
              <GroupEditor
                title="Gang"
                icon={<Users size={16} />}
                groups={shared.gangs}
                current={player.gang?.name}
                grade={player.gang?.grade}
                busy={busy === 'gang'}
                onApply={(gang, grade) => action('gang', 'setGang', { gang, grade })}
              />
            </>
          )}

          <section className="card">
            <h3 className="card-title"><PackagePlus size={16} />Items</h3>
            <div className="input-row wrap">
              <input className="input" list="qb-items" placeholder="Search for an item" aria-label="Item" value={item} onChange={(e) => setItem(e.target.value)} />
              <datalist id="qb-items">
                {(shared?.items || []).map((i) => <option key={i.name} value={i.label}>{i.name}</option>)}
              </datalist>
              <input className="input input-number small" type="number" min={1} inputMode="numeric" aria-label="Amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Button busy={busy === 'give'} disabled={!item.trim() || Number(amount) < 1} onClick={give}>Give</Button>
            </div>
            {inventoryError && <Notice kind="error">{inventoryError}</Notice>}
            {!inventory && !inventoryError && <Spinner label="Reading inventory" />}
            {inventory && inventory.length === 0 && <p className="muted-note">Their inventory is empty.</p>}
            {inventory && inventory.length > 0 && (
              <ul className="inventory-list">
                {inventory.map((inv) => (
                  <li key={`${inv.slot}-${inv.name}`}>
                    <span>{inv.label}</span>
                    <span className="muted-note">x{inv.amount}</span>
                    <Button variant="ghost" title={`Remove one ${inv.label}`} aria-label={`Remove one ${inv.label}`} icon={<Trash2 size={15} />} busy={busy === `rm:${inv.slot}`} onClick={() => removeOne(inv)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <section className="card">
        <h3 className="card-title"><MessageSquare size={16} />Send a message</h3>
        <div className="input-row">
          <input className="input" placeholder="Shown only to this player" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          <Button
            busy={busy === 'notify'}
            disabled={!note.trim()}
            onClick={async () => { if (await action('notify', 'notify', { message: note.trim() })) setNote(''); }}
          >
            Send
          </Button>
        </div>
      </section>

      <footer className="drawer-foot button-row">
        {hasCharacter && <Button icon={<HeartPulse size={15} />} busy={busy === 'revive'} onClick={() => action('revive', 'revive')}>Revive</Button>}
        <Button icon={<LogOut size={15} />} busy={busy === 'kick'} onClick={kick}>Kick</Button>
        <Button variant="danger" icon={<Gavel size={15} />} onClick={() => setBanOpen(true)}>Ban</Button>
      </footer>

      {banOpen && (
        <Modal
          title={`Ban ${player.name}?`}
          onClose={() => setBanOpen(false)}
          footer={<><Button onClick={() => setBanOpen(false)}>Cancel</Button><Button variant="danger" busy={busy === 'ban'} onClick={ban}>Ban player</Button></>}
        >
          <label className="input-label" htmlFor="ban-length">How long</label>
          <select id="ban-length" className="input" value={banHours} onChange={(e) => setBanHours(Number(e.target.value))}>
            {BAN_LENGTHS.map((b) => <option key={b.label} value={b.hours}>{b.label}</option>)}
          </select>
          <label className="input-label" htmlFor="ban-reason">Reason (the player sees this)</label>
          <input id="ban-reason" className="input" maxLength={200} value={banReason} onChange={(e) => setBanReason(e.target.value)} />
        </Modal>
      )}
    </Drawer>
  );
}

function BansList() {
  const { data, error, refresh } = usePoll(api.bans, 0);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const remove = async (ban: Ban) => {
    const ok = await confirm({ title: `Unban ${ban.name}?`, body: <p>They will be able to join again.</p>, confirm: 'Unban' });
    if (ok && await run(String(ban.id), () => api.unban(ban.id), `${ban.name} unbanned`)) refresh();
  };
  if (error) return <Notice kind="info">{error}</Notice>;
  if (!data) return <Spinner label="Reading bans" />;
  if (!data.length) return <Empty icon={<BanIcon size={30} />} title="No one is banned" />;
  return (
    <ul className="version-list card">
      {data.map((ban) => (
        <li key={ban.id}>
          <div>
            <div>{ban.name || 'Unknown player'}</div>
            <div className="muted-note">
              {ban.reason || 'No reason given'} · {ban.expire >= 2147483647 ? 'Permanent' : `Until ${new Date(ban.expire * 1000).toLocaleString()}`}
            </div>
          </div>
          <Button icon={<ShieldOff size={15} />} busy={busy === String(ban.id)} onClick={() => remove(ban)}>Unban</Button>
        </li>
      ))}
    </ul>
  );
}

export function Players({ gamePort }: { gamePort: number }) {
  const { data, error, refresh } = usePoll(api.players, 4000);
  const shared = usePoll(api.shared, 0);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState<'online' | 'bans'>('online');
  const player = data?.find((p) => p.id === selected) || null;

  useEffect(() => {
    if (selected !== null && data && !player) setSelected(null);
  }, [data, player, selected]);

  useEffect(() => {
    if (data?.length && !shared.data) shared.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.length]);

  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>Players</h1>
          <p className="muted-note">{data ? `${data.length} online` : 'Server is not answering'}</p>
        </div>
        <Segmented label="View" value={tab} onChange={setTab} options={[{ value: 'online', label: 'Online' }, { value: 'bans', label: 'Bans' }]} />
      </header>

      {tab === 'bans' && <BansList />}

      {tab === 'online' && (
        <>
          {error && !data && <Notice kind="info">{error}</Notice>}
          {data && data.length === 0 && (
            <Empty icon={<Users size={30} />} title="Nobody is online">
              Join from FiveM by pressing F8 and typing <code>connect localhost:{gamePort}</code>
            </Empty>
          )}
          {data && data.length > 0 && (
            <ul className="player-list">
              {data.map((p) => (
                <li key={p.id}>
                  <button className="player-card" onClick={() => setSelected(p.id)}>
                    <span className="player-id">{p.id}</span>
                    <span className="player-main">
                      <span className="player-name">{p.character?.trim() || p.name}</span>
                      <span className="muted-note">{p.character ? p.name : 'Choosing a character'}</span>
                    </span>
                    <span className="player-meta">
                      <span>{p.job ? `${p.job.label}${p.job.gradeName ? ` · ${p.job.gradeName}` : ''}` : '-'}</span>
                      <span className="muted-note">{p.money ? `${formatMoney(p.money.cash)} cash · ${formatMoney(p.money.bank)} bank` : ''}</span>
                    </span>
                    <span className="player-ping">{p.ping} ms</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {player && <PlayerDetail key={player.id} player={player} shared={shared.data} onClose={() => setSelected(null)} reload={refresh} />}
    </div>
  );
}
