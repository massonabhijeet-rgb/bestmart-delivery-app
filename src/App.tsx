import { lazy, startTransition, Suspense, useEffect, useState } from 'react';
import { ConfirmHost, RiderPickerHost } from './components/ConfirmDialog';
import { apiGetMe, apiLogout } from './services/api';
import type { User } from './services/api';
import './App.css';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Login = lazy(() => import('./pages/Login'));
const RiderHome = lazy(() => import('./pages/RiderHome'));
const Storefront = lazy(() => import('./pages/Storefront'));
const TrackOrder = lazy(() => import('./pages/TrackOrder'));
const MyOrders = lazy(() => import('./pages/MyOrders'));

type Route =
  | { view: 'store' }
  | { view: 'login' }
  | { view: 'dashboard' }
  | { view: 'my-orders' }
  | { view: 'track'; code: string };

function readRoute(): Route {
  const hash = window.location.hash;

  if (hash.startsWith('#track/')) {
    return { view: 'track', code: decodeURIComponent(hash.replace('#track/', '')) };
  }
  if (hash === '#login') {
    return { view: 'login' };
  }
  if (hash === '#dashboard') {
    return { view: 'dashboard' };
  }
  if (hash === '#my-orders') {
    return { view: 'my-orders' };
  }

  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'track' && pathParts[1]) {
    return { view: 'track', code: decodeURIComponent(pathParts[1]) };
  }

  return { view: 'store' };
}

function PageLoader() {
  return (
    <div className="app-loading">
      <div className="app-loading__orb" />
      <p>Loading...</p>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const syncRoute = () => {
      startTransition(() => {
        setRoute(readRoute());
      });
    };

    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);

    return () => {
      window.removeEventListener('hashchange', syncRoute);
      window.removeEventListener('popstate', syncRoute);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      const token = localStorage.getItem('token');
      if (!token) {
        setLoading(false);
        return;
      }

      try {
        const data = await apiGetMe();
        if (!cancelled) {
          setUser(data.user);
        }
      } catch {
        apiLogout();
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadUser();

    return () => {
      cancelled = true;
    };
  }, []);

  function navigate(next: Route) {
    if (next.view === 'track') {
      window.location.hash = `#track/${encodeURIComponent(next.code)}`;
      return;
    }
    window.location.hash = next.view === 'store' ? '' : `#${next.view}`;
  }

  if (loading) {
    return (
      <div className="app-loading">
        <div className="app-loading__orb" />
        <p>Loading BestMart...</p>
      </div>
    );
  }

  if (route.view === 'track') {
    return (
      <Suspense fallback={<PageLoader />}>
        <TrackOrder
          trackingCode={route.code}
          onBackToStore={() => navigate({ view: 'store' })}
          onTrack={(code) => navigate({ view: 'track', code })}
        />
      </Suspense>
    );
  }

  if (!user) {
    const goToDashboardAfterLogin = route.view === 'dashboard';
    return (
      <Suspense fallback={<PageLoader />}>
        <Login
          onBackToStore={() => navigate({ view: 'store' })}
          onLoginSuccess={(nextUser) => {
            setUser(nextUser);
            navigate({ view: goToDashboardAfterLogin ? 'dashboard' : 'store' });
          }}
        />
      </Suspense>
    );
  }

  if (user && user.role === 'rider') {
    return (
      <Suspense fallback={<PageLoader />}>
        <RiderHome
          user={user}
          onLogout={() => {
            setUser(null);
            apiLogout();
            navigate({ view: 'store' });
          }}
        />
      </Suspense>
    );
  }

  if (user && route.view === 'my-orders') {
    return (
      <Suspense fallback={<PageLoader />}>
        <MyOrders
          onBackToStore={() => navigate({ view: 'store' })}
          onTrack={(code) => navigate({ view: 'track', code })}
        />
      </Suspense>
    );
  }

  if (user && (route.view === 'dashboard' || route.view === 'login')) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Dashboard
          user={user}
          onLogout={() => {
            setUser(null);
            apiLogout();
            navigate({ view: 'store' });
          }}
          onOpenStore={() => navigate({ view: 'store' })}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Storefront
        user={user}
        onOpenLogin={() => navigate({ view: 'login' })}
        onOpenDashboard={() => navigate({ view: 'dashboard' })}
        onOpenMyOrders={() => navigate({ view: 'my-orders' })}
        onTrack={(code) => navigate({ view: 'track', code })}
        onLogout={() => {
          setUser(null);
          apiLogout();
          navigate({ view: 'store' });
        }}
      />
    </Suspense>
  );
}

function AppWithHost() {
  return (
    <>
      <App />
      <ConfirmHost />
      <RiderPickerHost />
    </>
  );
}

export default AppWithHost;
