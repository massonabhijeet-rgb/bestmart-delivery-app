import { useEffect, useState } from 'react';
import {
  apiGetBroadcastRecipients,
  apiLookupBroadcastRecipient,
  apiSendBroadcast,
  type BroadcastCustomer,
  type BroadcastResponse,
} from '../services/api';
import { confirm } from './ConfirmDialog';

type Scope = 'all' | 'individual';

const TITLE_MAX = 120;
const BODY_MAX = 1000;

export default function BroadcastPanel() {
  const [scope, setScope] = useState<Scope>('all');
  const [recipientCount, setRecipientCount] = useState<number | null>(null);
  const [identifier, setIdentifier] = useState('');
  const [lookup, setLookup] = useState<BroadcastCustomer | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BroadcastResponse | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const { customersWithDevices } = await apiGetBroadcastRecipients();
        setRecipientCount(customersWithDevices);
      } catch {
        setRecipientCount(null);
      }
    })();
  }, []);

  function resetForm() {
    setTitle('');
    setBody('');
    setUrl('');
  }

  async function handleLookup() {
    setError('');
    setLookup(null);
    const value = identifier.trim();
    if (!value) {
      setError('Enter a phone number or email to look up');
      return;
    }
    setLookupLoading(true);
    try {
      const customer = await apiLookupBroadcastRecipient(value);
      setLookup(customer);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Lookup failed');
    } finally {
      setLookupLoading(false);
    }
  }

  async function handleSend() {
    setError('');
    setResult(null);
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    if (!cleanTitle || !cleanBody) {
      setError('Title and message are both required');
      return;
    }

    const goingToAll = scope === 'all';
    if (scope === 'individual' && !lookup) {
      setError('Look up a customer before sending');
      return;
    }

    const audienceLabel = goingToAll
      ? recipientCount != null
        ? `${recipientCount} customer${recipientCount === 1 ? '' : 's'} with notifications enabled`
        : 'all customers with notifications enabled'
      : describeCustomer(lookup!);

    const ok = await confirm({
      title: goingToAll ? 'Send to all customers?' : 'Send to this customer?',
      message: `This will send a push notification to ${audienceLabel}. Carry on?`,
      confirmLabel: goingToAll ? 'Send to all' : 'Send notification',
      tone: goingToAll ? 'caution' : 'default',
    });
    if (!ok) return;

    setSending(true);
    try {
      const res = await apiSendBroadcast({
        title: cleanTitle,
        body: cleanBody,
        url: url.trim() || undefined,
        recipientIdentifier: scope === 'individual' ? identifier.trim() : undefined,
      });
      setResult(res);
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send');
    } finally {
      setSending(false);
    }
  }

  const audienceSummary = scope === 'all'
    ? recipientCount == null
      ? 'Loading recipient count…'
      : `${recipientCount} customer${recipientCount === 1 ? '' : 's'} with push enabled will receive this.`
    : lookup
      ? `Will send to ${describeCustomer(lookup)}.`
      : 'Look up a customer by phone or email first.';

  return (
    <div className="section-box">
      <div className="section-box__head">
        <div>
          <h2>Push notifications</h2>
          <p>Send a notification to every customer, or to one person by phone or email.</p>
        </div>
      </div>

      <div className="broadcast-panel">
        <div className="broadcast-panel__scope">
          <label>
            <input
              type="radio"
              name="broadcast-scope"
              checked={scope === 'all'}
              onChange={() => {
                setScope('all');
                setResult(null);
                setError('');
              }}
            />
            <span>All customers</span>
          </label>
          <label>
            <input
              type="radio"
              name="broadcast-scope"
              checked={scope === 'individual'}
              onChange={() => {
                setScope('individual');
                setResult(null);
                setError('');
              }}
            />
            <span>Specific customer</span>
          </label>
        </div>

        {scope === 'individual' && (
          <div className="broadcast-panel__lookup">
            <label>
              <span>Phone or email</span>
              <div className="broadcast-panel__lookup-row">
                <input
                  value={identifier}
                  onChange={(e) => {
                    setIdentifier(e.target.value);
                    setLookup(null);
                  }}
                  placeholder="+91 98xxx xxxxx or name@example.com"
                />
                <button
                  type="button"
                  className="ghost-button"
                  onClick={handleLookup}
                  disabled={lookupLoading || identifier.trim() === ''}
                >
                  {lookupLoading ? 'Looking…' : 'Look up'}
                </button>
              </div>
            </label>
            {lookup && (
              <div className="broadcast-panel__lookup-result">
                <strong>{lookup.fullName?.trim() || 'Customer'}</strong>
                <span>{lookup.phone || lookup.email || `#${lookup.id}`}</span>
              </div>
            )}
          </div>
        )}

        <label>
          <span>Title ({title.length}/{TITLE_MAX})</span>
          <input
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Fresh fruits just landed"
          />
        </label>

        <label>
          <span>Message ({body.length}/{BODY_MAX})</span>
          <textarea
            rows={4}
            value={body}
            maxLength={BODY_MAX}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Shown on the notification body. Keep it short and clear."
          />
        </label>

        <label>
          <span>Open URL <em style={{ opacity: 0.6, fontStyle: 'normal' }}>(optional)</em></span>
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.bestmart.co.in/offers/…"
          />
        </label>

        <p className="broadcast-panel__audience">{audienceSummary}</p>

        {error && <p className="broadcast-panel__error">{error}</p>}

        {result && (
          <div className="broadcast-panel__result">
            <strong>
              {result.scope === 'individual'
                ? `Sent to ${describeCustomer(result.recipient ?? null)}`
                : 'Broadcast sent'}
            </strong>
            <span>
              {result.sentCount} delivered
              {result.failedCount > 0 && ` · ${result.failedCount} failed`}
              {result.staleRemoved > 0 && ` · ${result.staleRemoved} dead tokens pruned`}
            </span>
          </div>
        )}

        <div className="broadcast-panel__actions">
          <button
            type="button"
            className="primary-button"
            onClick={handleSend}
            disabled={sending}
          >
            {sending ? 'Sending…' : scope === 'all' ? 'Send to all customers' : 'Send notification'}
          </button>
        </div>
      </div>
    </div>
  );
}

function describeCustomer(c: BroadcastCustomer | null) {
  if (!c) return 'customer';
  const name = c.fullName?.trim() || 'Customer';
  const contact = c.phone || c.email;
  return contact ? `${name} (${contact})` : name;
}
