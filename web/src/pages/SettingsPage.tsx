import {
  BookOpen, Compass, ExternalLink, FolderOpen, KeyRound, LogOut, Plus, QrCode, RefreshCw, Server, Smartphone, Timer, X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  api, SERVER_SCOPE, type Automation as AutomationData, type Settings,
} from '../api';
import { AdminsCard } from '../Admins';
import { ProfileCard } from '../Profile';
import { Term } from '../Term';
import { startTour } from '../Tour';
import { SettingsEditor } from '../SettingsEditor';
import {
  Button, Notice, Spinner, Toggle, useAction, useConfirm, usePoll,
} from '../ui';

function PhoneAccess({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [pairing, setPairing] = useState<{ url: string; svg: string } | null>(null);
  const [passcode, setPasscode] = useState<string | null>(settings.passcode);
  const [showCode, setShowCode] = useState(false);
  const [url, setUrl] = useState(settings.urls[0] || '');

  const makeQr = async (target = url) => {
    const result = await run('qr', () => api.pairing(target));
    if (result) setPairing(result);
  };

  useEffect(() => {
    if (settings.lanEnabled && settings.lanListening && !pairing) makeQr(settings.urls[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.lanEnabled, settings.lanListening]);

  const toggle = async (enabled: boolean) => {
    const result = await run('lan', () => api.setLan(enabled));
    if (!enabled) setPairing(null);
    if (result?.errors?.length) await confirm({ title: 'Phone access had a problem', body: <p>{result.errors.join(', ')}</p>, confirm: 'OK' });
    reload();
  };

  const regenerate = async () => {
    const ok = await confirm({
      title: 'Make a new passcode?',
      body: <p>Every phone or browser that is signed in will have to sign in again.</p>,
      confirm: 'Make a new passcode',
      danger: true,
    });
    if (!ok) return;
    const result = await run('passcode', () => api.newPasscode(), 'New passcode created');
    if (result) { setPasscode(result.passcode); setShowCode(true); }
  };

  return (
    <section className="card">
      <div className="card-row">
        <h3 className="card-title"><Smartphone size={16} />Phone access</h3>
        <Toggle checked={settings.lanEnabled} disabled={busy === 'lan'} onChange={toggle} label="Allow phones on your home network" />
      </div>
      <p className="muted-note">
        Use this dashboard from your phone on the same Wi-Fi. It stays on your home network and is not reachable from the internet.
      </p>

      {settings.lanEnabled && (
        <>
          <Notice kind="info">
            If Windows asks about CityHQ, allow it on <strong>Private networks</strong> only. The connection on your Wi-Fi is not encrypted, so use this at home rather than on shared networks.
          </Notice>
          {!settings.lanListening && <Notice kind="error">No home network was found on this PC. Connect to Wi-Fi or Ethernet, then turn this off and on.</Notice>}
          {settings.lanListening && (
            <div className="pair-grid">
              <div className="qr-box" aria-label="QR code to sign in on your phone" role="img">
                {pairing ? <div dangerouslySetInnerHTML={{ __html: pairing.svg }} /> : <Spinner label="Making code" />}
              </div>
              <div className="pair-text">
                <h4><QrCode size={15} /> Scan with your phone's camera</h4>
                <p className="muted-note">The code signs in one phone and expires in 5 minutes.</p>
                <Button icon={<RefreshCw size={15} />} busy={busy === 'qr'} onClick={() => makeQr()}>New code</Button>

                <h4 className="pair-subhead">Or type this address</h4>
                {settings.urls.length > 1 ? (
                  <select className="input" aria-label="Network address" value={url} onChange={(e) => { setUrl(e.target.value); makeQr(e.target.value); }}>
                    {settings.urls.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                ) : <code className="plain-code">{url}</code>}

                <h4 className="pair-subhead"><KeyRound size={15} /> Passcode</h4>
                <div className="input-row">
                  <code className="plain-code passcode">{showCode ? passcode : '••••••••'}</code>
                  <Button variant="ghost" onClick={() => setShowCode((v) => !v)}>{showCode ? 'Hide' : 'Show'}</Button>
                  <Button variant="ghost" busy={busy === 'passcode'} onClick={regenerate}>New</Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SwitchRow({ title, help, checked, disabled, onChange }: { title: string; help: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="switch-row">
      <div>
        <div className="field-label">{title}</div>
        <div className="field-help">{help}</div>
      </div>
      <Toggle checked={checked} disabled={disabled} onChange={onChange} label={title} />
    </div>
  );
}

/** What the keep-awake setting is doing right now, in plain words. */
function awakeNow(k: AutomationData['keepAwake']) {
  if (!k.enabled) return 'Off. Windows may put the PC to sleep and pause the server.';
  if (!k.serverRunning) return 'Waiting: it starts keeping the PC awake when the server runs.';
  if (k.holding === 'display') return 'Keeping the PC and its screen awake now (on battery).';
  if (k.onBattery) return 'Keeping the PC awake now, but it\'s on battery: Windows still sleeps a few minutes after its sleep timer unless the screen stays on. Plug it in, or turn on the screen option above.';
  return 'Keeping the PC awake now. The screen can still turn off.';
}

function KeepAwake({ state, saving, update }: {
  state: AutomationData['keepAwake'];
  saving: boolean;
  update: (patch: Parameters<typeof api.setAutomation>[0]) => Promise<void>;
}) {
  return (
    <>
      <SwitchRow
        title="Keep this PC awake while the server runs"
        help="When the PC sleeps, the server freezes, and txAdmin restarts it when the PC wakes. Closing the lid or pressing the power button still puts it to sleep."
        checked={state.enabled}
        disabled={saving}
        onChange={(enabled) => update({ keepAwake: { enabled } })}
      />
      {state.enabled && (
        <SwitchRow
          title="On battery, keep the screen on too"
          help="On battery, Windows only stays awake with the screen on. This uses more battery."
          checked={state.screenOnBattery}
          disabled={saving}
          onChange={(screenOnBattery) => update({ keepAwake: { screenOnBattery } })}
        />
      )}
      <p className="muted-note awake-now">{awakeNow(state)}</p>
    </>
  );
}

function Automation() {
  const { data, setData } = usePoll(api.automation, 0);
  const { busy, run } = useAction();
  const [newTime, setNewTime] = useState('18:00');

  const update = async (patch: Parameters<typeof api.setAutomation>[0]) => {
    const updated = await run('save', () => api.setAutomation(patch));
    if (updated) setData(updated);
  };

  if (!data) return <section className="card"><Spinner /></section>;
  const saving = busy === 'save';
  const { times, enabled } = data.restarts;

  return (
    <section className="card">
      <h3 className="card-title"><Timer size={16} />Starting up and staying up</h3>
      {data.openAtLogin !== null && (
        <SwitchRow
          title="Open CityHQ when Windows starts"
          help="It opens quietly in the tray, so backups and alerts keep working."
          checked={data.openAtLogin}
          disabled={saving}
          onChange={(openAtLogin) => update({ openAtLogin })}
        />
      )}
      <SwitchRow
        title="Start the server when the app opens"
        help="Together with the setting above, the server comes back by itself after your PC restarts."
        checked={data.autoStartServer}
        disabled={saving}
        onChange={(autoStartServer) => update({ autoStartServer })}
      />
      <SwitchRow
        title="Bring the server back if it goes down"
        help="If txAdmin or the database stops unexpectedly, the app starts them again and tells you. It gives up after 3 times in 15 minutes."
        checked={data.autoRecover}
        disabled={saving}
        onChange={(autoRecover) => update({ autoRecover })}
      />
      {data.keepAwake.supported && <KeepAwake state={data.keepAwake} saving={saving} update={update} />}
      <SwitchRow
        title="Scheduled restarts"
        help="Restarting daily keeps a server running smoothly. Players are warned in game 15, 5 and 1 minutes before, and their progress is saved."
        checked={enabled}
        disabled={saving}
        onChange={(on) => update({ restarts: { enabled: on, times } })}
      />
      {enabled && (
        <div className="restart-times">
          {times.length === 0 && <p className="muted-note">Add a time below.</p>}
          {times.map((time) => (
            <span key={time} className="time-chip">
              {new Date(`2000-01-01T${time}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              <button className="icon-btn" aria-label={`Remove ${time}`} disabled={saving} onClick={() => update({ restarts: { enabled, times: times.filter((t) => t !== time) } })}><X size={14} /></button>
            </span>
          ))}
          <div className="input-row add-time">
            <input className="input input-time" type="time" aria-label="New restart time" value={newTime} onChange={(e) => setNewTime(e.target.value)} />
            <Button icon={<Plus size={15} />} disabled={saving || !newTime || times.includes(newTime) || times.length >= 6} onClick={() => update({ restarts: { enabled, times: [...times, newTime] } })}>Add</Button>
          </div>
        </div>
      )}
      <p className="muted-note">These all need CityHQ open or in the tray. Closing its window keeps it running in the tray; right-click the tray icon to quit.</p>
    </section>
  );
}

export function SettingsPage({ online, onSignOut }: { online: boolean; onSignOut: () => void }) {
  const { data, error, refresh } = usePoll(api.settings, 0);
  const { run } = useAction();
  const confirm = useConfirm();

  const restartServer = async () => {
    const ok = await confirm({ title: 'Restart the server now?', body: <p>Changes to server.cfg apply after a restart. Players are saved and disconnected first.</p>, confirm: 'Restart' });
    if (ok) await api.restart();
  };

  if (!data) return error ? <Notice kind="error">{error}</Notice> : <Spinner />;

  return (
    <div className="page-stack">
      <header className="page-head">
        <h1>Settings</h1>
        {!data.local && <Button icon={<LogOut size={16} />} onClick={() => run('signout', async () => onSignOut())}>Sign out</Button>}
      </header>

      <ProfileCard />

      <section className="card help-card">
        <div>
          <h3 className="card-title"><BookOpen size={16} />New to running a server?</h3>
          <p className="muted-note">The Learn page explains how it all fits together and every term in plain words. The tour shows where everything is in CityHQ.</p>
        </div>
        <div className="button-row">
          <a className="btn btn-default" href="#learn"><BookOpen size={15} /><span>Learn the basics</span></a>
          <Button icon={<Compass size={15} />} onClick={startTour}>Take the tour</Button>
        </div>
      </section>

      <Automation />

      {data.local ? <PhoneAccess settings={data} reload={refresh} /> : (
        <Notice kind="info">Phone access and the passcode can only be changed on the PC running the server.</Notice>
      )}

      <section className="card">
        <h3 className="card-title"><Server size={16} />Server settings (<Term id="servercfg">server.cfg</Term>)</h3>
        <AdminsCard />
        <p className="muted-note">Your license key and database password stay hidden here and are kept when you save.</p>
        <SettingsEditor
          scope={SERVER_SCOPE}
          restartLabel="Save and restart server"
          onRestart={online ? restartServer : undefined}
          restartHint="Changes apply the next time the server starts."
        />
      </section>

      {data.local && data.paths && (
        <section className="card">
          <h3 className="card-title"><FolderOpen size={16} />Where things are</h3>
          <dl className="path-list">
            <dt>Everything</dt><dd><code>{data.paths.root}</code></dd>
            <dt>Your server files</dt><dd><code>{data.paths.serverData}</code></dd>
            <dt>Game port</dt><dd><code>{data.gamePort}</code></dd>
          </dl>
          <a className="btn btn-default" href={`http://localhost:${data.txAdminPort}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>Open txAdmin</span></a>
        </section>
      )}
    </div>
  );
}
