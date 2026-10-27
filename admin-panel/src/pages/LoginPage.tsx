// ---------------------------------------------------------------------------
// Sign-in screen. Uses POST /api/admin/login; surfaces ApiError messages
// inline (the API client never redirects for login calls).
// ---------------------------------------------------------------------------
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Spinner } from '../components/ui/Spinner';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { IconAlert, IconEye, IconSearch } from '../components/ui/Icons';
import { ApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { isAuthenticated, login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (username.trim().length === 0 || password.length === 0) {
      setError('Enter both username and password.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401
            ? 'Invalid username or password. Check the bootstrap credentials in the README.'
            : err.message,
        );
      } else {
        setError('Unexpected error while signing in. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden p-4">
      {/* ambient background */}
      <div className="pointer-events-none absolute -left-40 -top-40 h-[480px] w-[480px] rounded-full bg-violet-700/20 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 -right-32 h-[520px] w-[520px] rounded-full bg-fuchsia-700/15 blur-3xl" />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-brand-gradient text-2xl font-black text-white shadow-glow">
            V
          </span>
          <h1 className="mt-4 text-2xl font-bold text-ink">Voiza Admin</h1>
          <p className="mt-1 text-sm text-muted">Back office for the party platform</p>
        </div>

        <form onSubmit={onSubmit} className="panel space-y-4 p-6 shadow-glow" noValidate>
          {error !== null && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2.5 text-xs text-rose-200"
            >
              <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <Input
            label="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="admin"
            autoComplete="username"
            autoFocus
            leadingIcon={<IconSearch className="h-4 w-4" />}
          />

          <div className="relative">
            <Input
              label="Password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2.5 top-[34px] text-faint transition hover:text-muted"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              <IconEye className="h-4 w-4" />
            </button>
          </div>

          <Button type="submit" variant="primary" size="lg" className="w-full" disabled={submitting}>
            {submitting ? <Spinner className="h-4 w-4" /> : null}
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>

          <div className="rounded-lg border border-violet-500/30 bg-brand-gradient-soft px-3 py-2.5 text-[11px] leading-relaxed text-violet-200">
            <span className="font-semibold">Bootstrap hint:</span> on a fresh dev stack the backend seeds a
            super-admin from its <code className="rounded bg-black/30 px-1">ADMIN_USERNAME</code> /
            <code className="rounded bg-black/30 px-1">ADMIN_PASSWORD</code> env
            vars — with the defaults in <code className="rounded bg-black/30 px-1">docker-compose.yml</code>{' '}
            that is username <span className="font-semibold">admin</span> / password{' '}
            <span className="font-semibold">voiza-admin</span>. See the panel README for details.
          </div>
        </form>

        <p className="mt-6 text-center text-[11px] text-faint">
          All requests go to the Voiza backend under <code>/api/admin/*</code>
        </p>
      </div>
    </div>
  );
}
