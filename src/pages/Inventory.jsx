import { useState } from "react";
import { TabBar } from "../components/Tabs";
import StockTab from "../components/inventory/StockTab";
import MovementsTab from "../components/inventory/MovementsTab";
import TransfersTab from "../components/inventory/TransfersTab";
import WarehousesTab from "../components/inventory/WarehousesTab";
import CategoriesTab from "../components/inventory/CategoriesTab";
import LotsTab from "../components/inventory/LotsTab";

const TABS = [
  ["existencias", "Existencias", StockTab],
  ["movimientos", "Movimientos", MovementsTab],
  ["lotes", "Lotes", LotsTab],
  ["transferencias", "Transferencias", TransfersTab],
  ["almacenes", "Almacenes", WarehousesTab],
  ["categorias", "Categorías", CategoriesTab],
];

export default function Inventory() {
  const [tab, setTab] = useState("existencias");
  const Current = TABS.find((t) => t[0] === tab)[2];
  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Inventario</h1>
      <TabBar tabs={TABS.map(([id, label]) => [id, label])} value={tab} onChange={setTab} />
      <Current />
    </div>
  );
}