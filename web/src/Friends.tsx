import {
  CheckCircle2, Clock, Copy, ExternalLink, Globe, Home, RefreshCw, Router, Shield, XCircle,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from './api';
import { Term } from './Term';
import {
  Button, Spinner, useAction, usePoll, useToast,
} from './ui';

function CopyLine({ text }: { text: string }) {
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Couldn\'t copy. Select the text and copy it instead.', 'error');
    }
  };
  return (
    <div className="copy-line">
      <code>{text}</code>
      <button type="button" className="icon-btn" aria-label={`Copy ${text}`} title="Copy" onClick={copy}><Copy size={15} /></button>
    </div>
  );
}

function Step({ n, icon, title, state, children }: { n: number; icon: ReactNode; title: string; state: 'done' | 'todo' | 'info'; children: ReactNode }) {
  return (
    <li className={`friend-step step-${state}`}>
      <div className="friend-step-head">
        <span className="friend-step-n">{state === 'done' ? <CheckCircle2 size={16} /> : n}</span>
        {icon}
        <h4>{title}</h4>
      </div>
      <div className="friend-step-body">{children}</div>
    </li>
  );
}

/** A step-by-step guide to letting people outside your home join, checked against this PC. */
export function FriendsCard() {
  const report = usePoll(api.reach, 0);
  const { busy, run } = useAction();
  const [asked, setAsked] = useState(false);
  const r = report.data;
  const askFirewall = async () => {
    if (await run('fw', () => api.reachFirewall(), 'Windows will ask for permission. Choose Yes, then press Check again.')) setAsked(true);
  };

  return (
    <section className="card" id="friends">
      <div className="card-title-row">
        <h3 className="card-title"><Globe size={16} />Let friends join</h3>
        <Button variant="ghost" icon={<RefreshCw size={15} />} disabled={!r} onClick={() => report.refresh()}>Check again</Button>
      </div>
      {!r && !report.error && <Spinner label="Looking at this PC's network" />}
      {report.error && <p className="muted-note">{report.error}</p>}
      {r && (
        <>
          <div className={`reach-status reach-${r.listing.status}`}>
            {r.listing.status === 'ok' && <><CheckCircle2 size={18} /><span>FiveM's server list can reach your server, so friends can join from anywhere.</span></>}
            {r.listing.status === 'blocked' && <><XCircle size={18} /><span>Friends outside your home can't reach the server yet. FiveM's server list tried and couldn't. Follow the steps below.</span></>}
            {r.listing.status === 'pending' && <><Clock size={18} /><span>FiveM's server list checks a few minutes after each start. {r.listing.lastFailed ? 'Last time, it couldn\'t reach your server.' : 'Check again in a few minutes.'}</span></>}
          </div>
          <ol className="friend-steps">
            <Step n={1} icon={<Home size={16} />} title="Friends on your own Wi-Fi" state="info">
              <p>They can join right now. In FiveM, press F8 and type:</p>
              {r.localIp ? <CopyLine text={`connect ${r.localIp}:${r.port}`} /> : <p className="muted-note">This PC's network address couldn't be found.</p>}
            </Step>
            <Step n={2} icon={<Shield size={16} />} title="Windows Firewall" state={r.firewall?.ok ? 'done' : 'todo'}>
              {r.firewall?.ok && <p>The server is allowed through Windows Firewall.</p>}
              {r.firewall && !r.firewall.ok && (
                <>
                  <p>Windows Firewall doesn't let the server through yet ({[!r.firewall.tcp && 'TCP', !r.firewall.udp && 'UDP'].filter(Boolean).join(' and ')} blocked){r.profile ? ` on this ${r.profile.toLowerCase()} network` : ''}.</p>
                  {r.local && <Button variant="primary" icon={<Shield size={15} />} busy={busy === 'fw'} onClick={askFirewall}>{asked ? 'Ask Windows again' : 'Allow it through (Windows asks first)'}</Button>}
                  <details className="install-notes">
                    <summary>Or do it by hand</summary>
                    <p className="muted-note">Open PowerShell as administrator and run:</p>
                    <pre>{r.firewallCommand}</pre>
                  </details>
                </>
              )}
              {!r.firewall && <p className="muted-note">The firewall settings couldn't be read.</p>}
            </Step>
            <Step n={3} icon={<Router size={16} />} title="Your router: forward the port" state={r.listing.status === 'ok' ? 'done' : 'todo'}>
              <p>Your router has to send FiveM traffic from the internet to this PC. This is called <Term id="portforward">port forwarding</Term>, and it's set up on the router's own page.</p>
              {r.gateway && (
                <p><a className="btn btn-default" href={`http://${r.gateway}`} target="_blank" rel="noreferrer"><ExternalLink size={15} /><span>Open your router's page ({r.gateway})</span></a></p>
              )}
              <ol className="health-steps">
                <li>Sign in. The password is often on a sticker on the router.</li>
                <li>Find <strong>Port Forwarding</strong>. Some routers call it Virtual Server, NAT, or Gaming, often under Advanced.</li>
                <li>Add a rule with these values:</li>
              </ol>
              <dl className="forward-values">
                <dt>Protocol</dt><dd>TCP and UDP (or "Both")</dd>
                <dt>External / start port</dt><dd>{r.port}</dd>
                <dt>Internal / end port</dt><dd>{r.port}</dd>
                <dt>Device or IP address</dt><dd>{r.localIp || 'this PC'}</dd>
              </dl>
              <p className="muted-note">Tip: in the router, reserve {r.localIp || 'this PC\'s address'} for this PC (often called DHCP reservation), or the rule stops working when the address changes. If it still can't be reached after this, your internet provider may share one address between customers (CGNAT); ask them for a public IP address.</p>
            </Step>
            <Step n={4} icon={<Globe size={16} />} title="Friends anywhere" state={r.listing.status === 'ok' ? 'done' : 'info'}>
              {r.listing.status === 'ok'
                ? <p>Friends can find your server in FiveM's server list, or connect directly{r.listing.publicIp ? ' with:' : '.'}</p>
                : <p>Once the steps above are done, FiveM checks again within a few minutes. Then friends can find your server in the server list, or connect directly{r.listing.publicIp ? ' with:' : '.'}</p>}
              {r.listing.publicIp && <CopyLine text={`connect ${r.listing.publicIp}:${r.port}`} />}
            </Step>
          </ol>
        </>
      )}
    </section>
  );
}
