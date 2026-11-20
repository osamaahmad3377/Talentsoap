import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import {
  Home, Boxes, Factory, ShoppingCart, Truck, Users, Building2, Wallet, BarChart3, UserCheck, Search, Settings as Cog,
  LogOut, Menu, Droplets, Receipt, PieChart, Landmark, CalendarRange,
} from 'lucide-react';
import { AppProvider, useApp, api, useAction } from './lib.jsx';
import { Loading, Field } from './components.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { StockList, ItemDetail } from './pages/Stock.jsx';
import { ProductionList, NewBatch } from './pages/Production.jsx';
import { SalesList, NewSale, Invoice } from './pages/Sales.jsx';
import { ReturnsList, CreditNote } from './pages/Returns.jsx';
import { Setup } from './pages/Setup.jsx';
import { PurchaseList, NewPurchase, PurchaseDetail } from './pages/Purchases.jsx';
import { PartyList, PartyLedger } from './pages/Parties.jsx';
import CashBank from './pages/Cash.jsx';
import Reports from './pages/Reports.jsx';
import { FinanceOverview, Expenses } from './pages/Finance.jsx';
import { FySwitcher, FyBanner, FiscalYears, CloseYearWizard, OpeningBalances } from './pages/FiscalYears.jsx';
import { Staff, Payslip } from './pages/Staff.jsx';
import { TraceSearch, LotTrace } from './pages/Trace.jsx';
import Settings from './pages/Settings.jsx';

// role = minimum role that sees the menu item
const NAV = [
  { group: 'Daily work' },
  { to: '/', label: 'Home', icon: Home, role: 'staff', end: true },
  { to: '/stock', label: 'Stock', icon: Boxes, role: 'staff' },
  { to: '/production', label: 'Production', icon: Factory, role: 'staff' },
  { to: '/sales', label: 'Sales & Invoices', icon: ShoppingCart, role: 'staff' },
  { to: '/purchases', label: 'Purchases', icon: Truck, role: 'manager' },
  { group: 'Money' },
  { to: '/customers', label: 'Customers', icon: Users, role: 'staff' },
  { to: '/suppliers', label: 'Suppliers', icon: Building2, role: 'manager' },
  { to: '/finance', label: 'Profit & Loss', icon: PieChart, role: 'manager' },
  { to: '/expenses', label: 'Expenses', icon: Receipt, role: 'manager' },
  { to: '/cash', label: 'Cash & Bank', icon: Landmark, role: 'manager' },
  { to: '/reports', label: 'Reports', icon: BarChart3, role: 'manager' },
  { group: 'People & tools' },
  { to: '/staff', label: 'Staff & Attendance', icon: UserCheck, role: 'staff' },
  { to: '/trace', label: 'Product History', icon: Search, role: 'staff' },
  { to: '/financial-years', label: 'Financial Years', icon: CalendarRange, role: 'manager' },
  { to: '/settings', label: 'Settings', icon: Cog, role: 'staff' },
];

function Brand({ name }) {
  return <div className="brand"><div className="brand-logo"><Droplets size={22} /></div><span>{name || 'Soap Factory'}</span></div>;
}

function Shell({ children }) {
  const { me, can, setMe, settings, fy } = useApp();
  const [more, setMore] = useState(false);
  const loc = useLocation();
  const items = NAV.filter((n) => n.group || can(n.role));
  const logout = async () => { await api.post('/auth/logout'); setMe(null); };
  const isActive = (p) => (p === '/' ? loc.pathname === '/' : loc.pathname.startsWith(p));

  return (
    <div className={`app ${fy?.readOnly ? 'fy-readonly' : ''}`}>
      <aside className="sidebar" aria-label="Main menu">
        <Brand name={settings.company_name} />
        <FySwitcher dark />
        {items.map((n, i) => n.group
          ? <div key={i} className="nav-group">{n.group}</div>
          : <NavLink key={n.to} to={n.to} end={n.end} className="nav-link"><n.icon size={22} />{n.label}</NavLink>)}
        <div className="sidebar-foot">
          <div className="avatar" aria-hidden="true">{me.full_name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()}</div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <b className="who">{me.full_name}</b>
            <span className="role">{me.role}</span>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={logout} title="Log out" aria-label="Log out"><LogOut size={18} /></button>
        </div>
      </aside>

      <header className="topbar no-print">
        <Brand name={settings.company_name} />
        <div className="spacer" />
        <FySwitcher dark />
      </header>

      <main className="main"><FyBanner />{children}</main>

      <nav className="bottom-nav no-print" aria-label="Quick menu">
        <NavLink to="/" end><Home size={26} />Home</NavLink>
        <NavLink to="/stock"><Boxes size={26} />Stock</NavLink>
        <NavLink to="/production"><Factory size={26} />Make</NavLink>
        <NavLink to="/sales"><ShoppingCart size={26} />Sell</NavLink>
        <button onClick={() => setMore(true)} className={more ? 'active' : ''}><Menu size={26} />More</button>
      </nav>
      {more && (
        <div className="more-sheet" onClick={() => setMore(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="row" style={{ marginBottom: 12 }}>
              <div><b>{me.full_name}</b> <span className="muted small" style={{ textTransform: 'capitalize' }}>· {me.role}</span></div>
              <div className="spacer" />
              <button className="btn btn-sm" onClick={logout}><LogOut size={18} /> Log out</button>
            </div>
            <div className="grid">
              {items.filter((n) => !n.group).map((n) => (
                <NavLink key={n.to} to={n.to} onClick={() => setMore(false)} style={isActive(n.to) ? { borderColor: 'var(--primary)', background: 'var(--primary-soft)' } : undefined}>
                  <n.icon size={28} />{n.label}
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Login() {
  const { refreshMe } = useApp();
  const [fresh, setFresh] = useState(null);
  useEffect(() => { api.get('/setup/status').then((x) => setFresh(!!x.fresh)).catch(() => setFresh(false)); }, []);
  if (fresh === null) return <Loading />;
  if (fresh) return <Setup onDone={() => setFresh(false)} />;
  return <LoginForm refreshMe={refreshMe} />;
}

function LoginForm({ refreshMe }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [run, busy] = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => { await api.post('/auth/login', { username: u, password: p }); await refreshMe(); });
  };
  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <Brand name="Soap Factory ERP" />
        <Field label="Username"><input className="input" autoFocus autoCapitalize="none" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} /></Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !u || !p}>Log in</button>
      </form>
    </div>
  );
}

function Gate({ role, children }) {
  const { can } = useApp();
  return can(role) ? children : <Navigate to="/" replace />;
}

function Root() {
  const { me, fy } = useApp();
  if (me === undefined) return <Loading />;
  if (!me) return <Login />;
  if (!fy) return <Loading label="Loading financial year…" />;
  return (
    <Shell>
      <Routes key={fy.id /* switching year remounts every page with that year's defaults */}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/stock" element={<StockList />} />
        <Route path="/stock/:id" element={<ItemDetail />} />
        <Route path="/production" element={<ProductionList />} />
        <Route path="/production/new" element={<NewBatch />} />
        <Route path="/recipes/*" element={<Navigate to="/production/new" replace />} />
        <Route path="/sales" element={<SalesList />} />
        <Route path="/sales/new" element={<NewSale />} />
        <Route path="/sales/:id" element={<Invoice />} />
        <Route path="/returns" element={<ReturnsList />} />
        <Route path="/returns/:id" element={<CreditNote />} />
        <Route path="/purchases" element={<Gate role="manager"><PurchaseList /></Gate>} />
        <Route path="/purchases/new" element={<Gate role="manager"><NewPurchase /></Gate>} />
        <Route path="/purchases/:id" element={<Gate role="manager"><PurchaseDetail /></Gate>} />
        <Route path="/trace/purchase/:id" element={<Gate role="manager"><PurchaseDetail /></Gate>} />
        <Route path="/customers" element={<PartyList type="customer" />} />
        <Route path="/suppliers" element={<Gate role="manager"><PartyList type="supplier" /></Gate>} />
        <Route path="/parties/:id" element={<PartyLedger />} />
        <Route path="/cash" element={<Gate role="manager"><CashBank /></Gate>} />
        <Route path="/reports" element={<Gate role="manager"><Reports /></Gate>} />
        <Route path="/finance" element={<Gate role="manager"><FinanceOverview /></Gate>} />
        <Route path="/expenses" element={<Gate role="manager"><Expenses /></Gate>} />
        <Route path="/staff" element={<Staff />} />
        <Route path="/payroll/:id" element={<Gate role="manager"><Payslip /></Gate>} />
        <Route path="/trace" element={<TraceSearch />} />
        <Route path="/trace/lot/:id" element={<LotTrace />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/financial-years" element={<Gate role="manager"><FiscalYears /></Gate>} />
        <Route path="/financial-years/:id/close" element={<Gate role="manager"><CloseYearWizard /></Gate>} />
        <Route path="/financial-years/:id/opening" element={<Gate role="manager"><OpeningBalances /></Gate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider><Root /></AppProvider>
    </BrowserRouter>
  );
}
