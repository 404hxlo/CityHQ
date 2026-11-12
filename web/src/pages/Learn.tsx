import {
  BookOpen, Compass, LifeBuoy, PackagePlus, Search, Server, Users,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { GLOSSARY_LIST } from '../glossary';
import { startTour } from '../Tour';
import { Term } from '../Term';
import { Button } from '../ui';

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="card learn-section">
      <h3 className="card-title">{icon}{title}</h3>
      <div className="learn-body">{children}</div>
    </section>
  );
}

/** The basics of running a FiveM server, in plain words, plus every term explained. */
export function Learn() {
  const [q, setQ] = useState('');
  const terms = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? GLOSSARY_LIST.filter((t) => `${t.term} ${t.short}`.toLowerCase().includes(s)) : GLOSSARY_LIST;
  }, [q]);
  return (
    <div className="page-stack">
      <header className="page-head">
        <div>
          <h1>Learn the basics</h1>
          <p className="muted-note">How a FiveM server fits together, in plain words. Dotted words anywhere in CityHQ explain themselves when you point at or tap them.</p>
        </div>
        <Button icon={<Compass size={16} />} onClick={startTour}>Take the tour</Button>
      </header>

      <Section icon={<Server size={16} />} title="How your server fits together">
        <ol>
          <li><Term id="txadmin">txAdmin</Term> starts <Term id="fxserver">FXServer</Term>, the server program, and restarts it if it stops answering.</li>
          <li>FXServer reads <Term id="servercfg">server.cfg</Term>: your <Term id="licensekey">license key</Term>, player slots, admins, and which <Term id="resource">resources</Term> to start with <Term id="ensure">ensure</Term> lines.</li>
          <li>Resources load in the order server.cfg lists them. Your <Term id="framework">framework</Term>, <Term id="qbcore">QBCore</Term> (qb-core) or <Term id="qbox">Qbox</Term> (qbx_core), is what most of them build on, so it starts early.</li>
          <li>Everything players do is saved in the <Term id="database">database</Term>, which runs alongside the server.</li>
          <li>CityHQ watches all of this, explains problems, and keeps backups and a history of changes so you can always go back.</li>
        </ol>
      </Section>

      <Section icon={<PackagePlus size={16} />} title="Adding a script safely">
        <ol>
          <li>Make a backup first (Backups, then Back up now). It takes a minute and players stay connected.</li>
          <li>On Resources, choose Add a resource and give it the download (a GitHub link, a zip, or a folder).</li>
          <li>Read the <strong>install check</strong> that appears: it says if the script is made for another framework like <Term id="esx">ESX</Term>, what it needs (<Term id="dependency">dependencies</Term>), whether its <Term id="table">database tables</Term> exist, and what it <Term id="replaces">replaces</Term>.</li>
          <li>Run its <Term id="sql">.sql file</Term> if it has one, and follow the author's notes, which the check shows too.</li>
          <li>Start it, then look at the Health page and the Overview for problems. If it broke something, undo it under Backups, What changed.</li>
        </ol>
      </Section>

      <Section icon={<LifeBuoy size={16} />} title="When something breaks">
        <ul>
          <li><strong>The Overview</strong> lists errors from the last start, explained, with links to the script's own docs and fix buttons where it's safe.</li>
          <li><strong>Health</strong> checks for common setup traps and explains every restart, including when the PC went to sleep (a big <Term id="hitch">hitch warning</Term>).</li>
          <li><strong>Backups, What changed</strong> lists every change made through CityHQ with Undo, so you can go back to when it worked.</li>
          <li><strong>The <Term id="console">console</Term></strong> shows the server's full log if you need more detail.</li>
        </ul>
      </Section>

      <Section icon={<Users size={16} />} title="Letting friends join">
        <p>People on your Wi-Fi can join straight away. For friends anywhere else, your router needs <Term id="portforward">port forwarding</Term>. The Health page walks you through it with the exact values for your PC, and tells you when it works.</p>
      </Section>

      <Section icon={<BookOpen size={16} />} title="Every term, explained">
        <label className="search learn-search">
          <Search size={16} />
          <input type="search" placeholder={`Search ${GLOSSARY_LIST.length} terms`} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <dl className="glossary">
          {terms.map((t) => (
            <div key={t.id} className="glossary-row">
              <dt>{t.term}</dt>
              <dd>{t.short}</dd>
            </div>
          ))}
        </dl>
        {!terms.length && <p className="muted-note">No term matches "{q}".</p>}
      </Section>
    </div>
  );
}
