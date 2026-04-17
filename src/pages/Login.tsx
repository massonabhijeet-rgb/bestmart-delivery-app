import { useState, type FormEvent } from 'react';
import { apiLogin, apiSignup } from '../services/api';
import type { User } from '../services/api';

interface LoginProps {
  onLoginSuccess: (user: User) => void;
  onBackToStore: () => void;
}

const demoAccounts = [
  { label: 'Admin', email: 'admin@bestmart.local' },
  { label: 'Editor (Ops)', email: 'ops@bestmart.local' },
  { label: 'Viewer', email: 'viewer@bestmart.local' },
  { label: 'Rider 1 — Ravi Kumar', email: 'rider1@bestmart.local' },
  { label: 'Rider 2 — Priya Sharma', email: 'rider2@bestmart.local' },
];
const DEMO_PASSWORD = 'BestMart123!';

function Login({ onLoginSuccess, onBackToStore }: LoginProps) {
  const [email, setEmail] = useState('admin@bestmart.local');
  const [password, setPassword] = useState('BestMart123!');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [showSignup, setShowSignup] = useState(false);
  const [signupEmail, setSignupEmail] = useState('');
  const [signupPassword, setSignupPassword] = useState('');
  const [signupConfirm, setSignupConfirm] = useState('');
  const [signupSubmitting, setSignupSubmitting] = useState(false);
  const [signupError, setSignupError] = useState('');

  async function doLogin(signInEmail: string, signInPassword: string) {
    setSubmitting(true);
    setError('');
    try {
      const data = await apiLogin(signInEmail, signInPassword);
      onLoginSuccess(data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await doLogin(email, password);
  }

  async function handleQuickLogin(accountEmail: string) {
    setEmail(accountEmail);
    setPassword(DEMO_PASSWORD);
    await doLogin(accountEmail, DEMO_PASSWORD);
  }

  async function handleSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSignupError('');
    if (signupPassword !== signupConfirm) {
      setSignupError('Passwords do not match.');
      return;
    }
    setSignupSubmitting(true);
    try {
      const data = await apiSignup(signupEmail.trim(), signupPassword);
      setShowSignup(false);
      onLoginSuccess(data.user);
    } catch (err) {
      setSignupError(err instanceof Error ? err.message : 'Unable to sign up');
    } finally {
      setSignupSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      {/* Brand Panel */}
      <section className="auth-panel auth-panel--brand">
        <img src="/bestmart-logo.svg" alt="BestMart" style={{ height: '56px', width: 'auto' }} />
        <p className="eyebrow">Staff Portal</p>
        <h1>Manage your grocery store operations.</h1>
        <p>
          Track orders, manage stock levels, assign delivery riders, and keep your catalog
          up to date — all in one place.
        </p>

        <div className="auth-demo-list">
          <p style={{ fontSize: '0.78rem', color: 'rgba(245,237,226,0.5)', marginBottom: '0.4rem' }}>
            QUICK ACCESS (TEST)
          </p>
          <select
            className="auth-demo-select"
            value=""
            disabled={submitting}
            onChange={(e) => {
              const picked = e.target.value;
              if (picked) void handleQuickLogin(picked);
            }}
          >
            <option value="">
              {submitting ? 'Signing in…' : 'Select a test account to sign in'}
            </option>
            {demoAccounts.map((account) => (
              <option key={account.email} value={account.email}>
                {account.label} — {account.email}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Form Panel */}
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card__header">
            <p className="eyebrow">Staff Sign In</p>
            <h2>Welcome back</h2>
          </div>

          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              <span>Email address</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@bestmart.local"
                autoComplete="email"
              />
            </label>

            <label>
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••••"
                autoComplete="current-password"
              />
            </label>

            {error && <div className="message message--error">{error}</div>}

            <div className="auth-actions">
              <button type="submit" className="primary-button" disabled={submitting}>
                {submitting ? 'Signing in…' : 'Sign In'}
              </button>
              <button type="button" className="ghost-button" onClick={onBackToStore}>
                Back to Store
              </button>
            </div>
          </form>

          <p className="helper-text">
            New to BestMart?{' '}
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setShowSignup(true);
                setSignupError('');
              }}
            >
              Create a free account
            </button>
          </p>

          <p className="helper-text" style={{ opacity: 0.65 }}>
            Default password for seeded staff accounts: <code>BestMart123!</code>
          </p>
        </div>
      </section>

      {showSignup && (
        <div
          className="signup-modal"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowSignup(false);
          }}
        >
          <div className="signup-modal__card">
            <div className="signup-modal__head">
              <div>
                <p className="eyebrow">Sign up</p>
                <h3>Create your BestMart account</h3>
              </div>
              <button
                type="button"
                className="signup-modal__close"
                aria-label="Close"
                onClick={() => setShowSignup(false)}
              >
                ×
              </button>
            </div>
            <form className="auth-form" onSubmit={handleSignup}>
              <label>
                <span>Email</span>
                <input
                  type="email"
                  value={signupEmail}
                  onChange={(e) => setSignupEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  required
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  value={signupPassword}
                  onChange={(e) => setSignupPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  minLength={6}
                  autoComplete="new-password"
                  required
                />
              </label>
              <label>
                <span>Confirm password</span>
                <input
                  type="password"
                  value={signupConfirm}
                  onChange={(e) => setSignupConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>

              {signupError && <div className="message message--error">{signupError}</div>}

              <div className="auth-actions">
                <button type="submit" className="primary-button" disabled={signupSubmitting}>
                  {signupSubmitting ? 'Creating account…' : 'Sign Up'}
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => setShowSignup(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </main>
  );
}

export default Login;
