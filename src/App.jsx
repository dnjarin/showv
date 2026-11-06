import { useEffect } from "react";
import { HashRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./store/authStore";
import Layout from "./components/Layout";
import { usePreventReload } from "./hooks/usePreventReload";
import Setup from "./pages/Setup";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Inventory from "./pages/Inventory";
import Customers from "./pages/Customers";
import Rates from "./pages/Rates";
import Sales from "./pages/Sales";
import Documents from "./pages/Documents";
import Reports from "./pages/Reports";
import Account from "./pages/Account";
import Users from "./pages/Users";
import Backups from "./pages/Backups";
import Settings from "./pages/Settings";
import Audit from "./pages/Audit";
import Purchases from "./pages/Purchases";
import Books from "./pages/Books";
import Profit from "./pages/Profit";
import Quotes from "./pages/Quotes";
import Pricing from "./pages/Pricing";
import LegacyMigration from "./pages/LegacyMigration";
import { AccountsHub, CashHub, ProductsHub } from "./pages/Hubs";

function Guard({ roles, children }) {
  const user = useAuth((s) => s.user);
  const { pathname } = useLocation();
  if (!user) return <Navigate to="/login" replace />;
  // Con una contraseña temporal solo se puede entrar a "Mi cuenta"
  if (user.mustChangePassword && pathname !== "/cuenta") return <Navigate to="/cuenta" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  const { init, loading, needsSetup, user } = useAuth();
  useEffect(() => { init(); }, [init]);
  usePreventReload();
  if (loading) return <div className="p-8 text-slate-500">Cargando…</div>;

  return (
    <HashRouter>
      <Routes>
        <Route path="/setup" element={needsSetup ? <Setup /> : <Navigate to="/login" replace />} />
        <Route path="/login" element={
          needsSetup ? <Navigate to="/setup" replace />
            : user ? <Navigate to="/" replace /> : <Login />} />

        <Route element={needsSetup ? <Navigate to="/setup" replace /> : <Guard><Layout /></Guard>}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/productos" element={<ProductsHub />} />
          <Route path="/inventario" element={<Guard roles={["admin", "almacen"]}><Inventory /></Guard>} />
          <Route path="/clientes" element={<Guard roles={["admin", "cajero"]}><Customers /></Guard>} />
          <Route path="/tasas" element={<Guard roles={["admin", "cajero"]}><Rates /></Guard>} />
          <Route path="/ventas" element={<Guard roles={["admin", "cajero"]}><Sales /></Guard>} />
          <Route path="/documentos" element={<Guard roles={["admin", "cajero"]}><Documents /></Guard>} />
          <Route path="/gastos" element={<Navigate to="/caja?tab=gastos" replace />} />
          <Route path="/libros" element={<Guard roles={["admin"]}><Books /></Guard>} />
          <Route path="/precios" element={<Guard roles={["admin"]}><Pricing /></Guard>} />
          <Route path="/cotizaciones" element={<Guard roles={["admin", "cajero"]}><Quotes /></Guard>} />
          <Route path="/importar" element={<Navigate to="/productos?tab=importar" replace />} />
          <Route path="/utilidad" element={<Guard roles={["admin"]}><Profit /></Guard>} />
          <Route path="/pagos" element={<Navigate to="/cuentas?tab=pagar" replace />} />
          <Route path="/cobranzas" element={<Navigate to="/cuentas?tab=cobrar" replace />} />
          <Route path="/cuentas" element={<Guard roles={["admin", "cajero"]}><AccountsHub /></Guard>} />
          <Route path="/caja" element={<Guard roles={["admin", "cajero"]}><CashHub /></Guard>} />
          <Route path="/reportes" element={<Guard roles={["admin"]}><Reports /></Guard>} />
          <Route path="/usuarios" element={<Guard roles={["admin"]}><Users /></Guard>} />
          <Route path="/auditoria" element={<Guard roles={["admin"]}><Audit /></Guard>} />
          <Route path="/configuracion" element={<Guard roles={["admin"]}><Settings /></Guard>} />
          <Route path="/respaldos" element={<Guard roles={["admin"]}><Backups /></Guard>} />
          <Route path="/migracion" element={<Guard roles={["admin"]}><LegacyMigration /></Guard>} />
          <Route path="/cuenta" element={<Account />} />
          <Route path="/compras" element={<Guard roles={["admin", "almacen"]}><Purchases /></Guard>} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
}