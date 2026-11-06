import { useState } from "react";
import { useAuth } from "../store/authStore";
import { TabBar } from "../components/Tabs";
import NewPurchaseTab from "../components/purchases/NewPurchaseTab";
import PurchaseOrdersTab from "../components/purchases/PurchaseOrdersTab";
import HistoryTab from "../components/purchases/HistoryTab";
import SuppliersTab from "../components/purchases/SuppliersTab";
import RetentionsTab from "../components/purchases/RetentionsTab";
import RetentionConfigTab from "../components/purchases/RetentionConfigTab";

export default function Purchases() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const tabs = [
    ["nueva", "Nueva compra"],
    ["ordenes", "Órdenes de compra"],
    ["historial", "Historial"],
    ["proveedores", "Proveedores"],
    ["retenciones", "Retenciones"],
    ...(isAdmin ? [["config", "Config. retenciones"]] : []),
  ];
  const [tab, setTab] = useState("nueva");
  const [refresh, setRefresh] = useState(0); // recarga el historial tras registrar una compra
  const [fromOrder, setFromOrder] = useState(null); // orden de compra que se está recibiendo

  const receive = (prefill) => { setFromOrder(prefill); setTab("nueva"); };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Compras</h1>
      <TabBar tabs={tabs} value={tab} onChange={setTab} />
      {tab === "nueva" && (
        <NewPurchaseTab
          fromOrder={fromOrder}
          onOrderUsed={() => setFromOrder(null)}
          onCreated={() => setRefresh((n) => n + 1)}
        />
      )}
      {tab === "ordenes" && <PurchaseOrdersTab key={refresh} onReceive={receive} />}
      {tab === "historial" && <HistoryTab key={refresh} />}
      {tab === "proveedores" && <SuppliersTab />}
      {tab === "retenciones" && <RetentionsTab key={refresh} />}
      {tab === "config" && isAdmin && <RetentionConfigTab />}
    </div>
  );
}
