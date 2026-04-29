import { lazy, startTransition, Suspense, useEffect, useState } from 'react';
import { ConfirmHost, PromptOtpHost, RejectReasonHost, RiderPickerHost } from './components/ConfirmDialog';
import { BusyOverlay } from './components/BusyOverlay';
import LoginPopup from './components/LoginPopup';
import { apiGetMe, apiLogout } from './services/api';
import type { User } from './services/api';
import './App.css';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const RiderHome = lazy(() => import('./pages/RiderHome'));
const Storefront = lazy(() => import('./pages/Storefront'));
const TrackOrder = lazy(() => import('./pages/TrackOrder'));
const MyOrders = lazy(() => import('./pages/MyOrders'));

type Route =
  | { view: 'store' }
  | { view: 'login' }
  | { view: 'dashboard' }
  | { view: 'rider' }
  | { view: 'my-orders' }
  | { view: 'track'; code: string };

function readRoute(): Route {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'admin') return { view: 'dashboard' };
  if (pathParts[0] === 'rider') return { view: 'rider' };
  if (pathParts[0] === 'my-orders') return { view: 'my-orders' };
  if (pathParts[0] === 'login') return { view: 'login' };
  if (pathParts[0] === 'track' && pathParts[1]) {
    return { view: 'track', code: decodeURIComponent(pathParts[1]) };
  }

  // Legacy hash routes
  const hash = window.location.hash;
  if (hash.startsWith('#track/')) {
    return { view: 'track', code: decodeURIComponent(hash.replace('#track/', '')) };
  }
  if (hash === '#login') return { view: 'login' };
  if (hash === '#dashboard') return { view: 'dashboard' };
  if (hash === '#rider') return { view: 'rider' };
  if (hash === '#my-orders') return { view: 'my-orders' };

  return { view: 'store' };
}

function PageLoader() {
  return (
    <div className="page-loader">
      <div className="page-loader__orb" />
      <p>Loading…</p>
    </div>
  );
}

function App() {
  const [route, setRoute] = useState<Route>(() => readRoute());
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loginModalOpen, setLoginModalOpen] = useState(false);

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
    let path = '/';
    if (next.view === 'track') path = `/track/${encodeURIComponent(next.code)}`;
    else if (next.view === 'dashboard') path = '/admin';
    else if (next.view === 'rider') path = '/rider';
    else if (next.view === 'my-orders') path = '/my-orders';
    else if (next.view === 'login') path = '/login';

    if (window.location.pathname === path && !window.location.hash) {
      // Same URL — just refresh route state.
      setRoute(next);
      return;
    }
    window.history.pushState({}, '', path);
    // Clear any legacy hash so subsequent reads pick the path route.
    if (window.location.hash) {
      window.history.replaceState({}, '', path);
    }
    setRoute(next);
  }

  // While the initial auth check is in flight we don't block the whole
  // page — just render the route as anonymous and let Storefront show
  // its own loader. This prevents a second, differently-styled loader
  // from flashing on top of the storefront's initial-load spinner.
  if (loading && (route.view === 'dashboard' || route.view === 'my-orders' || route.view === 'rider')) {
    return (
      <div className="app-loading">
        <div className="app-loading__orb" />
        <p>Loading…</p>
      </div>
    );
  }

  const loginModal = loginModalOpen ? (
    <div
      className="login-modal"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) setLoginModalOpen(false); }}
    >
      <LoginPopup
        onClose={() => setLoginModalOpen(false)}
        onLoginSuccess={(nextUser) => {
          setUser(nextUser);
          setLoginModalOpen(false);
          // Send each role to its own home after sign-in.
          if (
            nextUser.role === 'superuser' ||
            nextUser.role === 'admin' ||
            nextUser.role === 'editor'
          ) {
            navigate({ view: 'dashboard' });
          } else if (nextUser.role === 'rider') {
            navigate({ view: 'rider' });
          }
          // viewer / customer stay on whatever page they were browsing.
        }}
      />
    </div>
  ) : null;

  // Tracking page works for anonymous + signed-in users.
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

  // Riders are routed to their own home as soon as they sign in.
  if (user && user.role === 'rider') {
    return (
      <>
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
        {loginModal}
      </>
    );
  }

  // Signed in but not a rider trying to reach /rider → bounce to store.
  if (user && route.view === 'rider') {
    navigate({ view: 'store' });
    return <PageLoader />;
  }

  // Anonymous users hitting protected routes: open login popup and stay on
  // the URL so the address bar still reflects the intent. After login,
  // role-based routing above takes over.
  if (
    !user &&
    (route.view === 'dashboard' ||
      route.view === 'rider' ||
      route.view === 'my-orders' ||
      route.view === 'login')
  ) {
    if (!loginModalOpen) setLoginModalOpen(true);
  }

  // Signed-in admin/editor screens.
  if (user && route.view === 'my-orders') {
    return (
      <>
        <Suspense fallback={<PageLoader />}>
          <MyOrders
            onBackToStore={() => navigate({ view: 'store' })}
            onTrack={(code) => navigate({ view: 'track', code })}
          />
        </Suspense>
        {loginModal}
      </>
    );
  }

  if (user && (route.view === 'dashboard' || route.view === 'login')) {
    return (
      <>
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
        {loginModal}
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<PageLoader />}>
        <Storefront
          user={user}
          onOpenLogin={() => setLoginModalOpen(true)}
          onOpenDashboard={() => navigate({ view: 'dashboard' })}
          onOpenMyOrders={() => {
            if (user) navigate({ view: 'my-orders' });
            else setLoginModalOpen(true);
          }}
          onTrack={(code) => navigate({ view: 'track', code })}
          onLogout={() => {
            setUser(null);
            apiLogout();
            navigate({ view: 'store' });
          }}
        />
      </Suspense>
      {loginModal}
    </>
  );
}

function AppWithHost() {
  return (
    <>
      <App />
      <ConfirmHost />
      <RejectReasonHost />
      <RiderPickerHost />
      <PromptOtpHost />
      <BusyOverlay />
    </>
  );
}

export default AppWithHost;
