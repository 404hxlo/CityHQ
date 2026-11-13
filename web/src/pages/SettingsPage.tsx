import {
  BellRing, BookOpen, CloudUpload, Compass, ExternalLink, FolderOpen, KeyRound, LogOut, Plus, QrCode, RefreshCw, Repeat, Send, Server, Smartphone, Timer, X,
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
import { ReportButton } from '../Report';
import { UpdatesCard } from '../Updates';
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
        help="If the server stops unexpectedly and doesn't come back by itself, CityHQ starts it again and tells you why it went down. It gives up after 3 times in 15 minutes."
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

/** txAdmin's page at the host: a button when it can be reached, and how to open its port when not. */
function HostedTxAdminCard() {
  const { data, error, setData } = usePoll(api.hostedTxAdmin, 0);
  const { busy, run } = useAction();
  const recheck = async () => {
    const result = await run('check', () => api.hostedTxAdmin(true));
    if (result) setData(result);
  };

  let body;
  if (!data) body = error ? <Notice kind="error">{error}</Notice> : <Spinner />;
  else if (data.sftp) body = <p className="muted-note">With SFTP only, CityHQ can't read your host's settings, so it can't tell txAdmin's port. Your host's panel shows it.</p>;
  else if (data.enabled === false) body = <Notice kind="info">txAdmin is turned off in your host's settings for the server. In your host's panel, open Startup, turn it on, then restart the server.</Notice>;
  else if (!data.port) body = <p className="muted-note">CityHQ couldn't find txAdmin's port in your host's settings for the server. Your host's panel shows it, usually under Startup or Network.</p>;
  else if (!data.open) {
    body = (
      <>
        <Notice kind="info">txAdmin uses port {data.port}, but your host hasn't opened that port for your server, so its page can't be reached.</Notice>
        <ol className="alert-steps">
          <li>In your host's panel, open Network and add a port (create an allocation). Note its number.</li>
          <li>Open Startup and set txAdmin's port to that number. On some hosts, you turn txAdmin on there and it uses the new port by itself.</li>
          <li>Restart the server, then check again here.</li>
        </ol>
      </>
    );
  } else {
    body = (
      <>
        {data.answers === false && <Notice kind="info">txAdmin's page didn't answer just now. It starts with the server: if the server is running, restart it.</Notice>}
        <p className="muted-note">
          The first time, txAdmin asks for a PIN and to link your Cfx.re account. The PIN shows in the console as the server starts (search for "PIN" on the Console page in Pro).
        </p>
      </>
    );
  }

  return (
    <section className="card">
      <div className="card-row">
        <h3 className="card-title"><Server size={16} />txAdmin</h3>
        <div className="button-row">
          {data?.url && <a className="btn btn-default" href={data.url} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>Open txAdmin</span></a>}
          {data && !data.sftp && <Button variant="ghost" icon={<RefreshCw size={15} />} busy={busy === 'check'} onClick={recheck}>Check again</Button>}
        </div>
      </div>
      {body}
    </section>
  );
}

/** Crash alerts: Windows and Things to fix always; a Discord channel once its webhook is pasted. */
function CrashAlerts({ local }: { local: boolean }) {
  const { data, setData } = usePoll(api.alerts, 0);
  const { busy, run } = useAction();
  const confirm = useConfirm();
  const [url, setUrl] = useState('');

  if (!data) return <section className="card"><Spinner /></section>;
  const { discord } = data;

  const save = async () => {
    const result = await run('save', () => api.setDiscordWebhook(url.trim()), 'Saved. Send a test message to check it.');
    if (result) { setData(result); setUrl(''); }
  };
  const test = async () => {
    const result = await run('test', () => api.testDiscord(), 'Sent. Check your Discord channel.');
    if (result) setData(result);
  };
  const remove = async () => {
    const ok = await confirm({
      title: 'Stop alerts on Discord?',
      body: <p>CityHQ forgets the webhook link. Windows notifications and Things to fix keep working.</p>,
      confirm: 'Stop Discord alerts',
    });
    if (!ok) return;
    const result = await run('remove', () => api.forgetDiscordWebhook(), 'Discord alerts are off.');
    if (result) setData(result);
  };

  let body;
  if (!local) body = <Notice kind="info">Discord alerts can only be set up on the PC running CityHQ.</Notice>;
  else if (!discord.canKeep) body = <Notice kind="info">Discord alerts need the CityHQ desktop app, which locks the link with Windows' own protection.</Notice>;
  else if (discord.set) {
    body = (
      <>
        <p className="field-help">Discord alerts are on.</p>
        {discord.lastError && <Notice kind="error">The last alert didn't reach Discord: {discord.lastError}</Notice>}
        <div className="button-row">
          <Button icon={<Send size={15} />} busy={busy === 'test'} onClick={test}>Send a test message</Button>
          <Button variant="ghost" busy={busy === 'remove'} onClick={remove}>Stop Discord alerts</Button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <ol className="alert-steps">
          <li>In Discord, open the settings of the channel you want alerts in (the gear next to its name).</li>
          <li>Go to Integrations, then Webhooks. Press New Webhook, then Copy Webhook URL.</li>
          <li>Paste it below and save.</li>
        </ol>
        <div className="input-row">
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="Discord webhook link"
            placeholder="https://discord.com/api/webhooks/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Button variant="primary" busy={busy === 'save'} disabled={!url.trim()} onClick={save}>Save</Button>
        </div>
        <p className="muted-note">Anyone with this link can post in that channel, so CityHQ keeps it locked on this PC and never shows it again.</p>
      </>
    );
  }

  return (
    <section className="card">
      <h3 className="card-title"><BellRing size={16} />Crash alerts</h3>
      <p className="muted-note">
        When the server crashes or goes down, CityHQ shows a Windows notification and puts what happened in Things to fix on Home: why, and a button when
        it can fix it. It can also post to a Discord channel, so you hear about it on your phone.
      </p>
      {body}
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

  const changeServer = async () => {
    const ok = await confirm({
      title: 'Choose a different server?',
      body: <p>CityHQ starts again on its Welcome screen, where you pick another server or make a new one. This server keeps running, and nothing in its folder is removed.</p>,
      confirm: 'Choose another server',
    });
    if (ok) await run('forget', () => api.welcomeForget(), (r) => (r.relaunching ? 'CityHQ is starting again...' : 'Close CityHQ from its tray icon and open it again.'));
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
          <p className="muted-note">The Learn page explains how it all fits together and every term in plain words. The tour shows where everything is in CityHQ. Found something wrong with CityHQ itself? Report it.</p>
        </div>
        <div className="button-row">
          <a className="btn btn-default" href="#learn"><BookOpen size={15} /><span>Learn the basics</span></a>
          <Button icon={<Compass size={15} />} onClick={startTour}>Take the tour</Button>
          <ReportButton />
        </div>
      </section>

      <Automation />

      <CrashAlerts local={data.local} />

      {data.hosted && <HostedTxAdminCard />}

      {data.local && <UpdatesCard />}

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
          <div className="button-row">
            <a className="btn btn-default" href={`http://localhost:${data.txAdminPort}`} target="_blank" rel="noreferrer"><ExternalLink size={16} /><span>Open txAdmin</span></a>
            {data.rootSource === 'saved' && data.desktop && <Button icon={<Repeat size={15} />} onClick={changeServer}>Change server</Button>}
          </div>
          {data.rootSource === 'folder' && <p className="muted-note">This copy of CityHQ is installed inside the server folder, so it always manages this server.</p>}
        </section>
      )}

      {data.local && data.desktop && !data.hosted && (
        <section className="card">
          <h3 className="card-title"><CloudUpload size={16} />Move to a host</h3>
          <p className="muted-note">
            Rent a server from a host such as RocketNode and CityHQ moves this one there: every resource (maps and cars too), the database and
            server.cfg. It picks up where it stopped if your internet drops, and your server here stays as it is, as a fallback.
          </p>
          <div className="button-row"><a className="btn btn-default" href="#move"><CloudUpload size={16} /><span>Move to a host</span></a></div>
        </section>
      )}
    </div>
  );
}
