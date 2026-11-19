import { useState } from 'react';
import { Upload, Download, Sparkles, ShieldCheck, FileCheck2, AlertTriangle, DatabaseBackup } from 'lucide-react';
import { api, useAction, useApp, fmtDate } from '../lib.jsx';
import { Field, Alert, Modal } from '../components.jsx';

/** Read a data file chosen by the user and summarise what is in it. */
async function readDataFile(file) {
  let dump;
  try { dump = JSON.parse(await file.text()); } catch { throw new Error('That file is not a data file from this ERP.'); }
  if (dump?.format !== 'soap-factory-erp-data' || !dump.tables) throw new Error('That file is not a data file from this ERP.');
  const t = dump.tables;
  const n = (name) => t[name]?.rows?.length || 0;
  const col = (name, c) => t[name]?.columns?.indexOf(c);
  const users = (t.users?.rows || [])
    .filter((r) => r[col('users', 'role')] === 'admin' && r[col('users', 'active')])
    .map((r) => r[col('users', 'username')]);
  const company = (t.settings?.rows || []).find((r) => r[col('settings', 'key')] === 'company_name')?.[col('settings', 'value')];
  return {
    dump, users, company,
    summary: { items: n('items'), sales: n('sales'), purchases: n('purchases'), parties: n('parties'), employees: n('employees'), batches: n('production_batches') },
    when: dump.exported_at,
  };
}

function FileSummary({ info }) {
  const s = info.summary;
  return (
    <div className="data-file">
      <FileCheck2 size={22} />
      <div>
        <b>{info.company || 'Data file'}</b>
        <div className="small muted">Downloaded {fmtDate(info.when.slice(0, 10))} · {s.items} items · {s.parties} customers &amp; suppliers · {s.sales} invoices · {s.purchases} purchases · {s.batches} batches · {s.employees} staff</div>
      </div>
    </div>
  );
}

function FilePicker({ onPick, busy }) {
  const [err, setErr] = useState(null);
  return (
    <>
      <label className="btn btn-lg btn-block file-btn">
        <Upload size={20} /> Choose data file (.json)
        <input type="file" accept=".json,application/json" disabled={busy} onChange={async (e) => {
          const f = e.target.files?.[0]; e.target.value = '';
          if (!f) return;
          try { setErr(null); onPick(await readDataFile(f)); } catch (x) { setErr(x.message); onPick(null); }
        }} />
      </label>
      {err && <Alert type="danger">{err}</Alert>}
    </>
  );
}

/**
 * First visit to a brand-new system (e.g. just put on Cloudflare): bring the data
 * from the factory computer, or start empty, and choose the admin password.
 */
export function Setup({ onDone }) {
  const { refreshMe } = useApp();
  const [mode, setMode] = useState('file');
  const [info, setInfo] = useState(null);
  const [username, setUsername] = useState('admin');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [run, busy] = useAction();

  const pick = (x) => { setInfo(x); if (x?.users?.length) setUsername(x.users.includes('admin') ? 'admin' : x.users[0]); };
  const mismatch = pw2 && pw !== pw2;
  const ready = pw.length >= 8 && pw === pw2 && (mode === 'empty' || info);

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const user = mode === 'empty' ? 'admin' : username;
      await api.post('/setup/restore', { data: mode === 'file' ? info.dump : undefined, username: user, password: pw });
      await api.post('/auth/login', { username: user, password: pw });
      await refreshMe();
      onDone?.();
    }, mode === 'file' ? 'Your data is in. Welcome!' : 'All set. Welcome!');
  };

  return (
    <div className="login">
      <form className="card stack setup" onSubmit={submit}>
        <div>
          <h1 style={{ margin: 0 }}>Welcome</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>This is a new, empty system. Set it up once — after that this page is gone.</p>
        </div>
        <div className="choice">
          <button type="button" className={`btn btn-lg ${mode === 'file' ? 'on' : ''}`} onClick={() => setMode('file')}><DatabaseBackup size={20} /> Bring my data</button>
          <button type="button" className={`btn btn-lg ${mode === 'empty' ? 'on' : ''}`} onClick={() => { setMode('empty'); setInfo(null); }}><Sparkles size={20} /> Start empty</button>
        </div>

        {mode === 'file' ? (
          <>
            <p className="small muted" style={{ margin: 0 }}>On the factory computer: <b>Settings → Download all data</b>. Then choose that file here.</p>
            {info ? <FileSummary info={info} /> : null}
            <FilePicker onPick={pick} busy={busy} />
            {info && (info.users.length > 1
              ? <Field label="Admin account to use"><select className="input" value={username} onChange={(e) => setUsername(e.target.value)}>{info.users.map((u) => <option key={u}>{u}</option>)}</select></Field>
              : <div className="small muted">You will log in as <b>{info.users[0] || 'admin'}</b>.</div>)}
          </>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>You will log in as <b>admin</b> and add items, customers and staff yourself.</p>
        )}

        <Field label="New admin password" help="At least 8 characters. Write it down somewhere safe.">
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Type it again" help={mismatch ? 'The two passwords are different.' : undefined}>
          <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !ready}>
          <ShieldCheck size={20} /> {mode === 'file' ? 'Load my data & finish' : 'Finish setup'}
        </button>
      </form>
    </div>
  );
}

/** Settings card (admin): download all data, or replace everything from a data file. */
export function DataFileCard() {
  const [info, setInfo] = useState(null);
  const [word, setWord] = useState('');
  const [run, busy] = useAction();
  const restore = () => run(async () => {
    await api.post('/backup/restore', info.dump);
    setTimeout(() => window.location.assign('/'), 900);
  }, 'Data restored. Please log in again.');
  return (
    <div className="card">
      <div className="card-head"><h2><Download size={20} style={{ verticalAlign: -3 }} /> Your data</h2></div>
      <p className="muted" style={{ marginTop: 0 }}>
        Download everything — stock, invoices, accounts, staff — as one file. Keep a copy on a USB drive or Google Drive at least once a week.
        The same file moves the ERP to another computer or to the cloud.
      </p>
      <div className="row" style={{ gap: 10 }}>
        <a className="btn btn-primary btn-lg" href="/api/backup"><Download size={22} /> Download all data</a>
        <label className="btn btn-lg file-btn"><Upload size={20} /> Restore from a file…
          <input type="file" accept=".json,application/json" onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = '';
            if (!f) return;
            try { setInfo(await readDataFile(f)); setWord(''); } catch (x) { alert(x.message); }
          }} />
        </label>
      </div>
      {info && (
        <Modal title="Replace ALL data with this file?" onClose={() => setInfo(null)}
          footer={<>
            <button className="btn" onClick={() => setInfo(null)}>No, keep my data</button>
            <button className="btn btn-danger" disabled={busy || word.trim().toUpperCase() !== 'RESTORE'} onClick={restore}>Replace everything</button>
          </>}>
          <div className="stack">
            <FileSummary info={info} />
            <Alert type="danger"><AlertTriangle size={18} style={{ verticalAlign: -3 }} /> Everything entered here after that file was downloaded will be <b>lost</b>. Download your current data first if you are not sure. Everyone will need to log in again.</Alert>
            <Field label={<>Type <b className="mono">RESTORE</b> to confirm</>}>
              <input className="input" value={word} onChange={(e) => setWord(e.target.value)} placeholder="RESTORE" autoCapitalize="characters" autoComplete="off" />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  );
}
