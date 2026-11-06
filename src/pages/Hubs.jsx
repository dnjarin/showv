import { useAuth } from "../store/authStore";
import { TabBar, useTabParam } from "../components/Tabs";
import Cash from "./Cash";
import Receivables from "./Receivables";
import Payables from "./Payables";
import SaleRetentionsTab from "../components/receivables/SaleRetentionsTab";
import Products from "./Products";
import ImportProducts from "./ImportProducts";
import Labels from "./Labels";
import { CategoriesTab, ExpensesTab, MovementsTab } from "./Expenses";

/** Páginas hermanas reunidas en una sola con pestañas. */
function Hub({ title, tabs, children }) {
  const ids = tabs.map((t) => t[0]);
  const [tab, setTab] = useTabParam(ids, ids[0]);
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <TabBar tabs={tabs} value={tab} onChange={setTab} />
      {children(tab)}
    </div>
  );
}

export function CashHub() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const tabs = [
    ["caja", "Caja"], ["gastos", "Gastos"], ["mov", "Movimientos de caja"],
    ...(isAdmin ? [["cats", "Categorías de gasto"]] : []),
  ];
  return (
    <Hub title="Caja y gastos" tabs={tabs}>
      {(tab) => (
        <>
          {tab === "caja" && <Cash embedded />}
          {tab === "gastos" && <ExpensesTab isAdmin={isAdmin} />}
          {tab === "mov" && <MovementsTab isAdmin={isAdmin} />}
          {tab === "cats" && isAdmin && <CategoriesTab />}
        </>
      )}
    </Hub>
  );
}

export function AccountsHub() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const tabs = [["cobrar", "Por cobrar"], ["retsuf", "Retenciones sufridas"], ...(isAdmin ? [["pagar", "Por pagar"]] : [])];
  return (
    <Hub title={isAdmin ? "Cuentas" : "Cuentas por cobrar"} tabs={tabs}>
      {(tab) => (tab === "pagar" && isAdmin ? <Payables embedded />
        : tab === "retsuf" ? <SaleRetentionsTab /> : <Receivables embedded />)}
    </Hub>
  );
}

export function ProductsHub() {
  const canManage = useAuth((s) => ["admin", "almacen"].includes(s.user.role));
  const tabs = [
    ["catalogo", "Catálogo"],
    ...(canManage ? [["etiquetas", "Etiquetas y códigos"], ["importar", "Importar / exportar"]] : []),
  ];
  return (
    <Hub title="Productos" tabs={tabs}>
      {(tab) => {
        if (tab === "importar" && canManage) return <ImportProducts embedded />;
        if (tab === "etiquetas" && canManage) return <Labels embedded />;
        return <Products embedded />;
      }}
    </Hub>
  );
}
