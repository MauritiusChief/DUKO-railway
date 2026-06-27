import { Routes, Route } from 'react-router-dom';
import TableParsePage from './pages/TableParsePage';
import LayoutRecognizePage from './pages/LayoutRecognizePage';
import DebugPage from './pages/DebugPage';
import LoginPage from './pages/LoginPage';
import HistoryPage from './pages/HistoryPage';
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
        path="/layout-recognize"
        element={
          <AdminGuard>
            <LayoutRecognizePage />
          </AdminGuard>
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
    </Routes>
  );
}
