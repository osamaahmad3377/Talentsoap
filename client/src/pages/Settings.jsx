import { useEffect, useState } from 'react';
import { Save, Plus, KeyRound, Building, Users as UsersIcon } from 'lucide-react';
import { useFetch, useApp, useAction, api, fmtDate } from '../lib.jsx';
import { PageHead, Async, Field, Modal, DataTable, Badge, Alert } from '../components.jsx';
import { DataFileCard } from './Setup.jsx';

export default function Settings() {
  const { can } = useApp();
  return (
    <>
      <PageHead title="Settings" />
      <div className="stack" style={{ gap: 18 }}>
        {can('admin') && <Company />}
        <Password />
        {can('admin') && <UsersCard />}
        {can('admin') && <DataFileCard />}
      </div>
    </>
  );
}

function Company() {
  const { refreshMe } = useApp();
  const q = useFetch('/settings');
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (q.data) setF(q.data); }, [q.data]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  return (
    <div className="card">
      <div className="card-head"><h2><Building size={20} style={{ verticalAlign: -3 }} /> Company (shown on invoices)</h2></div>
      <div className="form-grid">
        <Field label="Company name"><input className="input" value={f.company_name || ''} onChange={set('company_name')} /></Field>
        <Field label="Phone"><input className="input" value={f.company_phone || ''} onChange={set('company_phone')} /></Field>
        <Field label="Address" className="full"><input className="input" value={f.company_address || ''} onChange={set('company_address')} /></Field>
        <Field label="Currency symbol" help="Shift, overtime and leave rules are under Staff → Monthly Payroll"><input className="input" value={f.currency || ''} onChange={set('currency')} /></Field>
        <Field label="Invoice footer" className="full"><input className="input" value={f.invoice_footer || ''} onChange={set('invoice_footer')} /></Field>
      </div>
      <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={() => run(() => api.put('/settings', f), 'Settings saved').then(refreshMe)}><Save size={20} /> Save</button>
    </div>
  );
}

function Password() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [run, busy] = useAction();
  const mismatch = f.again && f.next !== f.again;
  return (
    <div className="card">
      <div className="card-head"><h2><KeyRound size={20} style={{ verticalAlign: -3 }} /> Change my password</h2></div>
      <div className="form-grid">
        <Field label="Current password" className="full"><input className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" help="At least 6 characters"><input className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="New password again"><input className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
      </div>
      {mismatch && <div style={{ marginTop: 12 }}><Alert type="danger">The two new passwords are not the same.</Alert></div>}
      <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !f.current || f.next.length < 6 || mismatch}
        onClick={() => run(() => api.post('/auth/password', { current: f.current, next: f.next }), 'Password changed').then((r) => r && setF({ current: '', next: '', again: '' }))}>
        <Save size={20} /> Change password
      </button>
    </div>
  );
}

const ROLE_HELP = { staff: 'Stock, production, sales entry, attendance', manager: 'Everything except settings & users', admin: 'Full access' };

function UsersCard() {
  const q = useFetch('/users');
  const [edit, setEdit] = useState(null);
  return (
    <div className="card">
      <div className="card-head"><h2><UsersIcon size={20} style={{ verticalAlign: -3 }} /> Users who can log in</h2><button className="btn btn-primary" onClick={() => setEdit({})}><Plus size={20} /> Add user</button></div>
      <Async q={q}>{(rows) => (
        <DataTable rows={rows} searchKeys={false} onRow={setEdit} rowClass={(u) => (u.active ? '' : 'cancelled')}
          columns={[
            { key: 'full_name', label: 'Name', render: (u) => <div><b>{u.full_name}</b><div className="small muted mono">{u.username}</div></div> },
            { key: 'role', label: 'Access', render: (u) => <Badge tone={u.role === 'admin' ? 'danger' : u.role === 'manager' ? 'info' : 'gray'}>{u.role}</Badge> },
            { key: 'created_at', label: 'Added', render: (u) => fmtDate(u.created_at) },
          ]} />
      )}</Async>
      {edit && <UserForm user={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); q.reload(); }} />}
    </div>
  );
}

function UserForm({ user, onClose, onSaved }) {
  const isNew = !user.id;
  const [f, setF] = useState({ username: '', full_name: '', role: 'staff', password: '', active: 1, ...user });
  const [run, busy] = useAction();
  const save = () => run(() => (isNew ? api.post('/users', f) : api.put(`/users/${user.id}`, f)), 'User saved').then((r) => r && onSaved());
  return (
    <Modal title={isNew ? 'New user' : `Edit ${user.full_name}`} onClose={onClose}
      footer={<>{!isNew && <button className="btn btn-ghost" onClick={() => run(() => api.put(`/users/${user.id}`, { active: !f.active }), f.active ? 'User blocked' : 'User unblocked').then((r) => r && onSaved())}>{f.active ? 'Block login' : 'Unblock'}</button>}
        <button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !f.full_name || (isNew && (!f.username || f.password.length < 6))} onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="Full name"><input className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        {isNew && <Field label="Username"><input className="input" autoCapitalize="none" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>}
        <Field label="Access level">
          <div className="choice">{['staff', 'manager', 'admin'].map((r) => <button key={r} className={`btn ${f.role === r ? 'on' : ''}`} style={{ textTransform: 'capitalize' }} onClick={() => setF({ ...f, role: r })}>{r}</button>)}</div>
          <div className="help">{ROLE_HELP[f.role]}</div>
        </Field>
        <Field label={isNew ? 'Password' : 'New password (leave empty to keep)'} help="At least 6 characters"><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
