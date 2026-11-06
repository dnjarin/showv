import { useEffect, useState } from "react";
import { receivablesApi } from "../services/api";
import { formatMoney, fromMicro } from "../utils/money";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro", saldo_favor: "Saldo a favor",
};

const localDate = (s) =>
  new Date(s.replace(" ", "T") + "Z").toLocaleString("es-VE", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

const Dash = () => <div className="my-2 border-t border-dashed border-slate-400" />;
const Row = ({ label, value, bold }) => (
  <div className={`flex justify-between gap-2 ${bold ? "font-bold" : ""}`}>
    <span>{label}</span><span className="whitespace-nowrap">{value}</span>
  </div>
);

export default function ReceiptTicket({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { receivablesApi.receipt(id).then(setD).catch((e) => setError(e.message)); }, [id]);

  const number = d ? `R-${String(d.number).padStart(6, "0")}` : "";

  return (
    <div className="ticket-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between bg-white px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Recibo de abono</div>
            <div className="font-mono text-lg font-semibold">{number || "…"}</div>
          </div>
          <button onClick={onClose} aria-label="Cerrar"
            className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100">×</button>
        </div>

        <div className="ticket-scroll flex-1 overflow-y-auto p-4">
          {error && <p className="text-center text-red-600">{error}</p>}
          {!d && !error && <p className="text-center text-slate-500">Cargando…</p>}
          {d && (
            <div className="ticket-print mx-auto w-[80mm] max-w-full bg-white px-3 py-4 font-mono text-[11px] leading-snug text-slate-900 shadow-md">
              <div className="text-center">
                <div className="text-sm font-bold uppercase">{d.issuerName}</div>
                <div>RIF: {d.issuerRif}</div>
                <div className="text-[10px] text-slate-600">{d.issuerAddress}</div>
              </div>
              <Dash />
              {d.voided && (
                <div className="mb-1 rounded border-2 border-red-700 p-1 text-center font-extrabold text-red-700">
                  *** ANULADO ***
                  <div className="text-[10px] font-normal">{d.voidReason}</div>
                </div>
              )}
              <div className="text-center font-bold tracking-wide">RECIBO DE ABONO</div>
              <div className="mt-1">
                <Row label="N°" value={number} bold />
                <Row label="Fecha" value={localDate(d.createdAt)} />
                <Row label="Cajero" value={d.cashier ?? "—"} />
              </div>
              <Dash />
              <div className="font-bold">CLIENTE</div>
              <div>{d.customerName}</div>
              <div>{d.customerIdType}-{d.customerIdNumber}</div>
              <Dash />
              <Row label="Forma de pago" value={METHODS[d.method] ?? d.method} />
              {d.reference && <Row label="Referencia" value={d.reference} />}
              <div className="my-1 border-t border-slate-900 pt-1">
                <Row label="MONTO RECIBIDO" value={formatMoney(d.amountMinor, d.currencyCode)} bold />
              </div>
              {d.currencyCode === "VES" && d.allocations.some((a) => a.currencyCode === "USD") && (
                <div className="text-[10px] text-slate-600">Tasa aplicada: {fromMicro(d.exchangeRateMicro)} Bs/USD</div>
              )}
              <Dash />
              <div className="font-bold">SE APLICÓ A</div>
              {d.allocations.map((a, i) => (
                <div key={i} className="mb-1">
                  <Row label={`Venta ${a.series}-${String(a.number).padStart(6, "0")}`}
                    value={formatMoney(a.appliedMinor, a.currencyCode)} />
                  <div className="text-[10px] text-slate-600">
                    Saldo actual de esa venta: {formatMoney(a.balanceMinor, a.currencyCode)}
                  </div>
                </div>
              ))}
              {d.advanceMinor > 0 && (
                <>
                  <Dash />
                  <Row label="SALDO A FAVOR GENERADO" value={formatMoney(d.advanceMinor, d.currencyCode)} bold />
                </>
              )}
              {d.legend && (
                <div className="mt-3 rounded border-2 border-slate-900 p-1.5 text-center text-[10px] font-extrabold">
                  {d.legend}
                </div>
              )}
              <div className="mt-3 text-center text-[10px] text-slate-500">¡Gracias por su pago!</div>
            </div>
          )}
        </div>

        <div className="flex gap-2 bg-white px-4 py-3">
          <button onClick={() => window.print()} disabled={!d}
            className="flex-1 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">Imprimir</button>
          <button onClick={onClose} className="rounded-lg border px-4 py-2">Cerrar</button>
        </div>
      </div>
    </div>
  );
}