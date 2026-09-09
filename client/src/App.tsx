import { Routes, Route } from 'react-router-dom';
import TableParsePage from './pages/TableParsePage';
import LayoutRecognizePage from './pages/LayoutRecognizePage';
import DebugPage from './pages/DebugPage';
import LoginPage from './pages/LoginPage';
import HistoryPage from './pages/HistoryPage';
import AllHistoryPage from './pages/AllHistoryPage';
import TracePage from './pages/TracePage';
import QuotationTasksPage from './pages/QuotationTasksPage';
import InventoryDashboardPage from './pages/InventoryDashboardPage';
import WarehouseScanPage from './pages/WarehouseScanPage';
import WarehouseManagePage from './pages/WarehouseManagePage';
import AdminGuard from './components/AdminGuard';
import RoleGuard from './components/RoleGuard';

/** 除仓库角色外的业务角色集合（warehouse 仅可访问扫码页） */
const BUSINESS_ROLES: Array<'admin' | 'manager' | 'warehouse' | 'user'> = ['admin', 'manager', 'user'];

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RoleGuard allowedRoles={BUSINESS_ROLES}>
            <TableParsePage />
          </RoleGuard>
        }
      />
      <Route
        path="/history"
        element={
          <RoleGuard allowedRoles={BUSINESS_ROLES}>
            <HistoryPage />
          </RoleGuard>
        }
      />
      <Route
        path="/quotation-tasks"
        element={
          <RoleGuard allowedRoles={BUSINESS_ROLES}>
            <QuotationTasksPage />
          </RoleGuard>
        }
      />
      <Route
        path="/layout-recognize"
        element={
          <RoleGuard allowedRoles={BUSINESS_ROLES}>
            <LayoutRecognizePage />
          </RoleGuard>
        }
      />
      <Route
        path="/warehouse-scan"
        element={
          <RoleGuard allowedRoles={['admin', 'manager', 'warehouse']}>
            <WarehouseScanPage />
          </RoleGuard>
        }
      />
      <Route
        path="/warehouse-manage"
        element={
          <RoleGuard allowedRoles={['admin', 'manager']}>
            <WarehouseManagePage />
          </RoleGuard>
        }
      />
      <Route
        path="/inventory"
        element={
          <RoleGuard allowedRoles={['admin', 'manager']}>
            <InventoryDashboardPage />
          </RoleGuard>
        }
      />
      <Route
        path="/debug"
        element={
          <AdminGuard>
            <DebugPage />
          </AdminGuard>
        }
      />
      <Route
        path="/trace"
        element={
          <AdminGuard>
            <TracePage />
          </AdminGuard>
        }
      />
      <Route
        path="/all-history"
        element={
          <AdminGuard>
            <AllHistoryPage />
          </AdminGuard>
        }
      />
    </Routes>
  );
}
