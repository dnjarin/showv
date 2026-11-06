import { useEffect, useState } from "react";
import { returnsApi } from "../services/api";
import { formatMoney } from "../utils/money";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
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

export default function ReturnTicket({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => { returnsApi.get(id).then(setD).catch((e) => setError(e.message)); }, [id]);

  const m = (v) => formatMoney(v, d.currencyCode);
  const number = d ? `${d.series}-${String(d.number).padStart(6, "0")}` : "";

  return (
    <div className="ticket-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between bg-white px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Nota de crédito</div>
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
              <div className="text-center font-bold tracking-wide">NOTA DE CRÉDITO</div>
              <div className="mt-1">
                <Row label="N°" value={number} bold />
                <Row label="Fecha" value={localDate(d.issuedAt)} />
                <Row label="Cajero" value={d.cashier ?? "—"} />
                <Row label="Sobre venta" value={`${d.originalSeries}-${String(d.originalNumber).padStart(6, "0")}`} />
              </div>
              {d.reason && <div className="mt-1">Motivo: {d.reason}</div>}
              <Dash />
              <div className="font-bold">CLIENTE</div>
              <div>{d.customerName ?? "Consumidor final"}</div>
              {d.customerIdType && <div>{d.customerIdType}-{d.customerIdNumber}</div>}
              <Dash />
              <div className="mb-1 flex justify-between font-bold"><span>DEVOLUCIÓN</span><span>TOTAL</span></div>
              {d.items.map((it, i) => (
                <div key={i} className="mb-1.5">
                  <div className="font-semibold">{it.description}{it.taxRateBp === 0 ? " (E)" : ""}</div>
                  <div className="flex justify-between text-slate-600">
                    <span>{it.quantity} x {m(it.unitPriceMinor)}</span>
                    <span className="font-semibold text-slate-900">{m(it.lineTotalMinor)}</span>
                  </div>
                  {it.discountMinor > 0 && (
                    <div className="text-slate-600">Incluye descuento de {m(it.discountMinor)}</div>
                  )}
                </div>
              ))}
              <Dash />
              <Row label="Base imponible" value={m(d.subtotalMinor)} />
              {d.exemptMinor > 0 && <Row label="Exento" value={m(d.exemptMinor)} />}
              <Row label="IVA" value={m(d.taxMinor)} />
              <div className="my-1 border-t border-slate-900 pt-1">
                <Row label="TOTAL ACREDITADO" value={m(d.totalMinor)} bold />
              </div>
              {d.igtfMinor > 0 && <Row label="IGTF devuelto" value={m(d.igtfMinor)} />}
              {d.balanceAppliedMinor > 0 && (
                <Row label="Aplicado al saldo pendiente" value={m(d.balanceAppliedMinor)} />
              )}
              <Dash />
              <div className="font-bold">REINTEGRO AL CLIENTE</div>
              {d.refunds.length === 0 && <div>No hubo entrega de dinero</div>}
              {d.refunds.map((r, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span>{METHODS[r.method] ?? r.method}{r.reference ? ` #${r.reference}` : ""}</span>
                  <span className="whitespace-nowrap">{formatMoney(r.amountMinor, r.currencyCode)}</span>
                </div>
              ))}
              {d.legend && (
                <div className="mt-3 rounded border-2 border-slate-900 p-1.5 text-center text-[10px] font-extrabold">
                  {d.legend}
                </div>
              )}
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