import { Routes, Route } from 'react-router-dom';
import TableParsePage from './pages/TableParsePage';
import LayoutRecognizePage from './pages/LayoutRecognizePage';
import DebugPage from './pages/DebugPage';
import LoginPage from './pages/LoginPage';
import HistoryPage from './pages/HistoryPage';
import AllHistoryPage from './pages/AllHistoryPage';
import TracePage from './pages/TracePage';
import QuotationTasksPage from './pages/QuotationTasksPage';
import AuthGuard from './components/AuthGuard';
import AdminGuard from './components/AdminGuard';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <AuthGuard>
            <TableParsePage />
          </AuthGuard>
        }
      />
      <Route
        path="/history"
        element={
          <AuthGuard>
            <HistoryPage />
          </AuthGuard>
        }
      />
      <Route
        path="/quotation-tasks"
        element={
          <AuthGuard>
            <QuotationTasksPage />
          </AuthGuard>
        }
      />
      <Route
        path="/layout-recognize"
        element={
          <AuthGuard>
            <LayoutRecognizePage />
          </AuthGuard>
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
