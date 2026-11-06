import { useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { dashboardApi, backupApi } from "../services/api";
import { formatMoney, fromMicro } from "../utils/money";
import { localDate, todayStr } from "../utils/dates";

const pct = (bp) => `${(bp / 100).toFixed(1).replace(".", ",")} %`;
const usd = (v) => formatMoney(v, "USD");
const ves = (v) => formatMoney(v, "VES");

const TONES = {
  blue: "border-blue-200 border-t-4 border-t-blue-500 bg-gradient-to-br from-blue-50 to-white",
  green: "border-green-200 border-t-4 border-t-green-500 bg-gradient-to-br from-green-50 to-white",
  amber: "border-amber-200 border-t-4 border-t-amber-500 bg-gradient-to-br from-amber-50 to-white",
  red: "border-red-200 border-t-4 border-t-red-500 bg-gradient-to-br from-red-50 to-white",
  slate: "border-slate-200 border-t-4 border-t-slate-400 bg-gradient-to-br from-slate-50 to-white",
  violet: "border-violet-200 border-t-4 border-t-violet-500 bg-gradient-to-br from-violet-50 to-white",
};
const LABELS = {
  blue: "text-blue-700", green: "text-green-700", amber: "text-amber-700",
  red: "text-red-700", slate: "text-slate-500", violet: "text-violet-700",
};

/** Bloque semi-rectangular del panel. */
function Tile({ label, tone = "slate", children, foot }) {
  return (
    <div className={`tile flex min-h-[6.5rem] flex-col justify-between rounded-xl border bg-white p-3.5 shadow-sm ${TONES[tone]}`}>
      <div>
        <div className={`text-[11px] font-semibold uppercase tracking-wide ${LABELS[tone]}`}>{label}</div>
        <div className="mt-1">{children}</div>
      </div>
      {foot && <div className="mt-2 text-xs text-slate-500">{foot}</div>}
    </div>
  );
}

const Big = ({ children, className = "" }) => (
  <div className={`text-2xl font-semibold leading-tight text-slate-900 ${className}`}>{children}</div>
);
const Sub = ({ children }) => <div className="text-sm text-slate-600">{children}</div>;

function Delta({ bp }) {
  if (bp == null) return null;
  const up = bp >= 0;
  return (
    <span className={`ml-2 rounded-full px-2 py-0.5 align-middle text-xs font-medium ${up ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
      {up ? "▲" : "▼"} {pct(Math.abs(bp))}
    </span>
  );
}

export default function Dashboard() {
  const user = useAuth((s) => s.user);
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  const [noExtraBackup, setNoExtraBackup] = useState(false);

  useEffect(() => {
    dashboardApi.summary().then(setD).catch((e) => setError(e.message));
    if (user.role === "admin") {
      backupApi.status().then((s) => setNoExtraBackup(!s.extraDir)).catch(() => {});
    }
  }, [user.role]);

  const monthName = d
    ? new Date(`${d.monthStart}T12:00:00`).toLocaleDateString("es-VE", { month: "long", year: "numeric" })
    : "";
  const a = d?.admin;
  const own = d && d.role !== "admin";
  const rateStale = d?.rate && d.rate.rateDate < todayStr();

  return (
    <div>
      <h1 className="text-2xl font-semibold">Inicio</h1>
      <p className="mt-1 text-slate-600">
        Hola, <b>{user.fullName}</b>.{d?.month && ` Resumen de ${monthName}${own ? " (tus ventas)" : ""}.`}
      </p>
      {d && (d.rate || d.cash) && (
        <p className="mt-1 text-sm text-slate-500">
          {d.rate && (
            <span className={rateStale ? "font-medium text-amber-700" : ""}>
              Tasa: {fromMicro(d.rate.rateMicro)} Bs/USD{rateStale ? " (desactualizada: registra la de hoy)" : ""}
            </span>
          )}
          {d.rate && d.cash && " · "}
          {d.cash && (d.cash.open ? `Caja abierta desde ${localDate(d.cash.openedAt)}` : "Caja cerrada")}
        </p>
      )}
      {noExtraBackup && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <b>Tus respaldos están solo en este equipo.</b> Si el disco falla o se pierde el equipo, se pierden los datos y los
          respaldos juntos. Configura una carpeta externa (una USB o una carpeta sincronizada) en <b>Respaldos</b>.
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {!d && !error && <p className="mt-3 text-slate-500">Cargando indicadores…</p>}

      {d && (
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {d.month && (
            <Tile label={own ? "Vendido en el mes (tuyo)" : "Vendido en el mes"} tone="blue"
              foot={`${d.month.docs} operaciones · ticket promedio ${usd(d.month.avgTicketUsdMinor)}`}>
              <Big>{usd(d.month.revenueUsdMinor)}<Delta bp={a?.changeBp} /></Big>
              <Sub>{ves(d.month.revenueVesMinor)}</Sub>
            </Tile>
          )}
          {a && (
            <Tile label="Ganancia bruta del mes" tone="green"
              foot={`Margen ${pct(a.marginBp)}${a.estimatedCost ? " · incluye costos estimados" : ""}`}>
              <Big className={a.profitUsdMinor < 0 ? "!text-red-700" : ""}>{usd(a.profitUsdMinor)}</Big>
              <Sub>{ves(a.profitVesMinor)}</Sub>
            </Tile>
          )}
          {d.today && (
            <Tile label={own ? "Tus ventas de hoy" : "Ventas de hoy"} tone="blue" foot={`${d.today.docs} operaciones`}>
              <Big>{usd(d.today.revenueUsdMinor)}</Big>
              <Sub>{ves(d.today.revenueVesMinor)}</Sub>
            </Tile>
          )}
          {a && (
            <Tile label="Por cobrar a clientes" tone="violet"
              foot={`${a.receivable.parties} cliente(s) · ${a.receivable.docs} venta(s)`}>
              <Big>{usd(a.receivable.totalUsdMinor)}</Big>
              <Sub>{a.receivable.overdueUsdMinor > 0
                ? <span className="text-red-700">Vencido: {usd(a.receivable.overdueUsdMinor)}</span> : "Nada vencido"}</Sub>
            </Tile>
          )}
          {a && (
            <Tile label="Por pagar a proveedores" tone="red"
              foot={`${a.payable.parties} proveedor(es) · ${a.payable.docs} compra(s)`}>
              <Big>{usd(a.payable.totalUsdMinor)}</Big>
              <Sub>{a.payable.overdueUsdMinor > 0
                ? <span className="text-red-700">Vencido: {usd(a.payable.overdueUsdMinor)}</span> : "Nada vencido"}</Sub>
            </Tile>
          )}
          {d.stock && (
            <Tile label="Inventario" tone={d.stock.low > 0 ? "amber" : "slate"}
              foot={`${d.stock.products} productos con control de stock${a ? ` · valor a costo ${usd(a.stockValueUsdMinor)}` : ""}`}>
              <Big className={d.stock.low > 0 ? "!text-amber-700" : ""}>{d.stock.low}</Big>
              <Sub>{d.stock.low > 0 ? "producto(s) en o bajo el mínimo" : "Todo sobre el mínimo"}</Sub>
            </Tile>
          )}
        </div>
      )}
      {d && !d.month && !d.stock && <p className="mt-4 text-slate-600">Selecciona un módulo del menú.</p>}
    </div>
  );
}
