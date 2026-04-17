import { useState, type FormEvent } from 'react';
import { apiLogin } from '../services/api';
import type { User } from '../services/api';

interface LoginPopupProps {
  onLoginSuccess: (user: User) => void;
  onClose: () => void;
}

const QUICK_ACCOUNTS: Array<{ label: string; email: string }> = [
  { label: 'Admin', email: 'admin@bestmart.local' },
  { label: 'Editor (Ops)', email: 'ops@bestmart.local' },
  { label: 'Viewer', email: 'viewer@bestmart.local' },
  { label: 'Rider 1 — Ravi Kumar', email: 'rider1@bestmart.local' },
  { label: 'Rider 2 — Priya Sharma', email: 'rider2@bestmart.local' },
];
const DEMO_PASSWORD = 'BestMart123!';

function LoginPopup({ onLoginSuccess, onClose }: LoginPopupProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password) return;
    setSubmitting(true);
    setError('');
    try {
      const data = await apiLogin(email.trim(), password);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  function handleQuickPick(value: string) {
    if (!value) return;
    setEmail(value);
    setPassword(DEMO_PASSWORD);
  }

  return (
    <div className="login-popup">
      <button
        type="button"
        className="login-popup__close"
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>

      <header className="login-popup__head">
        <h2>Sign in</h2>
        <p>Enter your username and password to continue.</p>
      </header>

      <form className="login-popup__form" onSubmit={handleSubmit}>
        <label className="login-popup__field">
          <span>Username</span>
          <input
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="username"
            autoFocus
            required
          />
        </label>

        <label className="login-popup__field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            required
          />
        </label>

        <label className="login-popup__field">
          <span>Quick sign-in (test accounts)</span>
          <select
            value=""
            onChange={(e) => handleQuickPick(e.target.value)}
            disabled={submitting}
          >
            <option value="">Select a test account…</option>
            {QUICK_ACCOUNTS.map((a) => (
              <option key={a.email} value={a.email}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        {error && <div className="login-popup__error">{error}</div>}

        <button
          type="submit"
          className="primary-button login-popup__submit"
          disabled={submitting || !email.trim() || !password}
        >
          {submitting ? 'Signing in…' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}

export default LoginPopup;
