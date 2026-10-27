import { type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout } from './components/layout/AdminLayout';
import { EmptyState } from './components/ui/EmptyState';
import { Card } from './components/ui/Card';
import { IconShieldCheck } from './components/ui/Icons';
import { useAuth } from './context/AuthContext';
import AuditPage from './pages/AuditPage';
import CommissionsPage from './pages/CommissionsPage';
import FinancePage from './pages/FinancePage';
import GamesPage from './pages/GamesPage';
import GiftsPage from './pages/GiftsPage';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import PartnersPage from './pages/PartnersPage';
import RechargesPage from './pages/RechargesPage';
import RoomConsolePage from './pages/RoomConsolePage';
import RoomsPage from './pages/RoomsPage';
import UsersPage from './pages/UsersPage';
import WithdrawalsPage from './pages/WithdrawalsPage';

function RequireAuth({ children }: { children: ReactElement }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

/**
 * Hides a page from an operator whose role does not carry the permission. This is the same list
 * the sidebar uses, and it is advice: `/api/admin/*` checks the operator's role in the database
 * on every call, so a hand-typed URL reaches a 403 rather than a live mutation.
 */
function RequirePermission({ permission, children }: { permission: string; children: ReactElement }) {
  const { can } = useAuth();
  if (!can(permission)) {
    return (
      <Card className="mx-auto max-w-xl">
        <EmptyState
          title="Not for your role"
          message="This screen needs a permission your account does not carry. The server would refuse it too."
          icon={<IconShieldCheck className="h-6 w-6" />}
        />
      </Card>
    );
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<RequirePermission permission="dashboard:read"><OverviewPage /></RequirePermission>} />
        <Route path="users" element={<RequirePermission permission="user:read"><UsersPage /></RequirePermission>} />
        <Route path="rooms" element={<RequirePermission permission="room:read"><RoomsPage /></RequirePermission>} />
        <Route path="rooms/:id" element={<RequirePermission permission="room:read"><RoomConsolePage /></RequirePermission>} />
        <Route path="gifts" element={<RequirePermission permission="dashboard:read"><GiftsPage /></RequirePermission>} />
        <Route path="withdrawals" element={<RequirePermission permission="withdrawal:review"><WithdrawalsPage /></RequirePermission>} />
        <Route path="games" element={<RequirePermission permission="game:read"><GamesPage /></RequirePermission>} />
        <Route path="partners" element={<RequirePermission permission="business:manage"><PartnersPage /></RequirePermission>} />
        <Route path="recharges" element={<RequirePermission permission="finance:read"><RechargesPage /></RequirePermission>} />
        <Route path="commissions" element={<RequirePermission permission="finance:read"><CommissionsPage /></RequirePermission>} />
        <Route path="finance" element={<RequirePermission permission="finance:read"><FinancePage /></RequirePermission>} />
        <Route path="audit" element={<RequirePermission permission="audit:read"><AuditPage /></RequirePermission>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
