// Payment method picker + labels, shared by every screen that moves money.
import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Banknote, Landmark, FileCheck2, ArrowLeftRight, CircleDot } from 'lucide-react';
import { useFetch, useMoney } from './lib.jsx';
import { Badge } from './components.jsx';

export const METHOD_LABEL = { cash: 'Cash', bank_transfer: 'Bank transfer', cheque: 'Cheque', transfer: 'Internal transfer', opening: 'Opening balance', credit: 'Credit (unpaid)' };
export const METHOD_ICON = { cash: Banknote, bank_transfer: Landmark, cheque: FileCheck2, transfer: ArrowLeftRight, opening: CircleDot };
const METHOD_TONE = { cash: 'ok', bank_transfer: 'info', cheque: 'warn', transfer: 'gray', opening: 'gray', credit: 'gray' };
export const PAY_METHODS = ['cash', 'bank_transfer', 'cheque'];

/** Small coloured label: "Cash", "Bank transfer", "Cheque #004512 · pending". */
export function MethodBadge({ method, chequeNo, status, reference, small }) {
  if (!method) return null;
  const Icon = METHOD_ICON[method];
  return (
    <span className="method-badge">
      <Badge tone={METHOD_TONE[method] || 'gray'}>{Icon && <Icon size={13} />} {METHOD_LABEL[method] || method}{chequeNo ? ` #${chequeNo}` : ''}</Badge>
      {status === 'pending' && <Badge tone="warn">not cleared</Badge>}
      {status === 'cleared' && <Badge tone="ok">cleared</Badge>}
      {status === 'bounced' && <Badge tone="danger">bounced</Badge>}
      {reference && !small && <span className="small muted"> Ref {reference}</span>}
    </span>
  );
}

export const emptyPayment = () => ({ payment_method: 'cash', account_id: '', cheque_no: '', cheque_date: '', bank_name: '', reference: '' });

/** Fields to spread into any request body. */
export const paymentBody = (p) => ({
  payment_method: p.payment_method,
  account_id: p.account_id || undefined,
  cheque_no: p.payment_method === 'cheque' ? p.cheque_no : undefined,
  cheque_date: p.payment_method === 'cheque' ? p.cheque_date || undefined : undefined,
  bank_name: p.payment_method === 'cheque' ? p.bank_name : undefined,
  reference: p.payment_method !== 'cash' ? p.reference : undefined,
});

/** Loads the open cash/bank accounts once per screen. */
export function useFunds() {
  const q = useFetch('/accounts/cash');
  return q.data || [];
}

/**
 * One-tap payment method selector.
 *  direction 'in'  = money received (customer cheque asks for the customer's bank)
 *  direction 'out' = money paid
 */
export function PaymentPicker({ value, onChange, funds, direction = 'out', amount, label }) {
  const money = useMoney();
  const type = value.payment_method === 'cash' ? 'cash' : 'bank';
  const options = funds.filter((f) => f.fund_type === type);
  const current = options.find((f) => String(f.id) === String(value.account_id)) || options[0];

  // keep the chosen account valid for the chosen method
  useEffect(() => {
    if (current && String(current.id) !== String(value.account_id)) onChange({ ...value, account_id: current.id });
  }, [value.payment_method, current?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => onChange({ ...value, [k]: e?.target ? e.target.value : e });
  const after = current?.balance !== undefined && amount > 0 ? current.balance + (direction === 'in' ? amount : -amount) : null;

  return (
    <div className="pay-picker">
      <div className="label">{label || (direction === 'in' ? 'How was it received?' : 'How was it paid?')}</div>
      <div className="pay-methods" role="radiogroup" aria-label="Payment method">
        {PAY_METHODS.map((m) => {
          const Icon = METHOD_ICON[m];
          return (
            <button key={m} type="button" role="radio" aria-checked={value.payment_method === m} className={value.payment_method === m ? 'on' : ''}
              onClick={() => onChange({ ...value, payment_method: m, account_id: '' })}>
              <Icon size={24} /><span>{METHOD_LABEL[m]}</span>
            </button>
          );
        })}
      </div>

      {options.length === 0 ? (
        <div className="alert alert-warn" style={{ marginTop: 10 }}>No {type} account yet. <Link to="/cash">Add one in Cash &amp; Bank</Link>.</div>
      ) : options.length > 1 ? (
        <div className="choice" style={{ marginTop: 10 }}>
          {options.map((f) => (
            <button key={f.id} type="button" className={`btn btn-sm ${String(current?.id) === String(f.id) ? 'on' : ''}`} onClick={() => onChange({ ...value, account_id: f.id })}>
              {f.name}{f.balance !== undefined && <span className="small" style={{ opacity: .8 }}>&nbsp;· {money(f.balance)}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="small muted" style={{ marginTop: 6 }}>{direction === 'in' ? 'Goes into' : 'Comes out of'} <b>{current.name}</b>{current.balance !== undefined && <> · balance {money(current.balance)}</>}</div>
      )}

      {value.payment_method === 'cheque' && (
        <div className="pay-refs">
          <input className="input" value={value.cheque_no} onChange={set('cheque_no')} placeholder="Cheque no. (optional)" aria-label="Cheque number" inputMode="numeric" />
          <input className="input" type="date" value={value.cheque_date} onChange={set('cheque_date')} aria-label="Cheque date" title="Cheque date" />
          {direction === 'in' && <input className="input" value={value.bank_name} onChange={set('bank_name')} placeholder="Customer's bank, e.g. HBL (optional)" aria-label="Bank name" />}
        </div>
      )}
      {value.payment_method === 'bank_transfer' && (
        <div className="pay-refs">
          <input className="input" value={value.reference} onChange={set('reference')} placeholder="Transaction / reference ID (optional)" aria-label="Transaction reference" />
        </div>
      )}
      {after !== null && <div className="small muted" style={{ marginTop: 6 }}>{current.name} after this: <b style={{ color: after < 0 ? 'var(--danger)' : undefined }}>{money(after)}</b></div>}
    </div>
  );
}

/** Method filter chips for lists: All · Cash · Bank transfer · Cheque (· Credit). */
export function MethodFilter({ value, onChange, withCredit, withTransfer }) {
  const opts = ['', ...PAY_METHODS, ...(withTransfer ? ['transfer'] : []), ...(withCredit ? ['credit'] : [])];
  return (
    <div className="choice seg" role="radiogroup" aria-label="Payment method filter">
      {opts.map((m) => (
        <button key={m || 'all'} type="button" className={`btn btn-sm ${value === m ? 'on' : ''}`} onClick={() => onChange(m)}>
          {m ? METHOD_LABEL[m] : 'All methods'}
        </button>
      ))}
    </div>
  );
}
