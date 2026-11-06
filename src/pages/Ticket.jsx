import { useEffect, useState } from "react";
import { salesApi } from "../services/api";
import { formatMoney, fromMicro } from "../utils/money";

const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro",
};

const localDate = (s) =>
  new Date(s.replace(" ", "T") + "Z").toLocaleString("es-VE", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

const Dash = () => <div className="my-2 border-t border-dashed border-slate-400" />;

const Row = ({ label, value, bold, big }) => (
  <div className={`flex justify-between gap-2 ${bold ? "font-bold" : ""} ${big ? "text-sm" : ""}`}>
    <span>{label}</span>
    <span className="whitespace-nowrap">{value}</span>
  </div>
);

export default function Ticket({ id, onClose }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    salesApi.get(id).then(setD).catch((e) => setError(e.message));
  }, [id]);

  const voided = d?.status === "voided";
  const m = (v) => formatMoney(v, d.currencyCode);
  const number = d ? `${d.series}-${String(d.number).padStart(6, "0")}` : "";
  const totalDiscount = d ? d.items.reduce((s, it) => s + (it.discountMinor ?? 0), 0) : 0;
  const hasExempt = d?.items.some((it) => it.taxRateBp === 0);

  return (
    <div className="ticket-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        {/* Encabezado de la ventana (no se imprime) */}
        <div className="flex items-center justify-between bg-white px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-slate-500">Comprobante</div>
            <div className="font-mono text-lg font-semibold">{number || "…"}</div>
          </div>
          <div className="flex items-center gap-3">
            {d && (
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${voided ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                {voided ? "Anulado" : "Emitido"}
              </span>
            )}
            <button onClick={onClose} aria-label="Cerrar"
              className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100">
              ×
            </button>
          </div>
        </div>

        {/* Zona con scroll: la "hoja" de papel */}
        <div className="ticket-scroll flex-1 overflow-y-auto p-4">
          {error && <p className="text-center text-red-600">{error}</p>}
          {!d && !error && <p className="text-center text-slate-500">Cargando…</p>}

          {d && (
            <div className="ticket-print relative mx-auto w-[80mm] max-w-full bg-white px-3 py-4 font-mono text-[11px] leading-snug text-slate-900 shadow-md">
              {voided && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden">
                  <span className="-rotate-12 rounded border-4 border-red-500/60 px-4 py-1 text-3xl font-extrabold tracking-widest text-red-500/60">
                    ANULADO
                  </span>
                </div>
              )}

              {/* Empresa */}
              <div className="text-center">
                <div className="text-sm font-bold uppercase">{d.issuerName}</div>
                <div>RIF: {d.issuerRif}</div>
                <div className="text-[10px] text-slate-600">{d.issuerAddress}</div>
              </div>

              <Dash />

              {/* Documento */}
              <div className="text-center font-bold tracking-wide">COMPROBANTE DE VENTA</div>
              <div className="mt-1">
                <Row label="N°" value={number} bold />
                <Row label="Fecha" value={localDate(d.issuedAt)} />
                <Row label="Cajero" value={d.cashier ?? "—"} />
              </div>
              {voided && d.voidReason && (
                <div className="mt-1 font-bold">Motivo de anulación: {d.voidReason}</div>
              )}

              <Dash />

              {/* Cliente */}
              <div className="font-bold">CLIENTE</div>
              <div>{d.customerName}</div>
              {d.customerIdType && <div>{d.customerIdType}-{d.customerIdNumber}</div>}
              {d.customerAddress && <div className="text-[10px] text-slate-600">{d.customerAddress}</div>}

              <Dash />

              {/* Líneas */}
              <div className="mb-1 flex justify-between font-bold">
                <span>DESCRIPCIÓN</span><span>TOTAL</span>
              </div>
              {d.items.map((it, i) => (
                <div key={i} className="mb-1.5">
                  <div className="font-semibold">{it.description}{it.taxRateBp === 0 ? " (E)" : ""}</div>
                  <div className="flex justify-between text-slate-600">
                    <span>{it.quantity} x {m(it.unitPriceMinor)}</span>
                    <span className="font-semibold text-slate-900">{m(it.lineTotalMinor)}</span>
                  </div>
                  {it.discountMinor > 0 && (
                    <div className="flex justify-between text-slate-600">
                      <span>Descuento {it.discountBp / 100}%</span>
                      <span>-{m(it.discountMinor)}</span>
                    </div>
                  )}
                </div>
              ))}
              {hasExempt && <div className="text-[10px] text-slate-500">(E) Producto exento de IVA</div>}

              <Dash />

              {/* Totales */}
              {totalDiscount > 0 && <Row label="Descuentos otorgados" value={`-${m(totalDiscount)}`} />}
              <Row label="Base imponible" value={m(d.subtotalMinor)} />
              {d.exemptMinor > 0 && <Row label="Exento" value={m(d.exemptMinor)} />}
              <Row label="IVA" value={m(d.taxMinor)} />
              <div className="my-1 border-t border-slate-900 pt-1">
                <Row label="TOTAL" value={m(d.totalMinor)} bold big />
              </div>

              {d.igtfMinor > 0 && (
                <div className="mt-1 rounded border border-slate-900 p-1.5">
                  <Row label="IGTF" value={m(d.igtfMinor)} />
                  <Row label="TOTAL A PAGAR" value={m(d.totalMinor + d.igtfMinor)} bold big />
                </div>
              )}

              {d.currencyCode !== "VES" && (
                <div className="mt-1 text-slate-600">
                  <Row label="Equivalente en Bs." value={formatMoney(d.totalVesMinor, "VES")} />
                  <div className="text-[10px]">Tasa aplicada: {fromMicro(d.exchangeRateMicro)} Bs/USD</div>
                </div>
              )}{(d.taxWaived || d.igtfWaived) && (
                <div className="mt-1 text-[10px] font-bold">
                  {d.taxWaived && <div>* IVA NO COBRADO</div>}
                  {d.igtfWaived && <div>* IGTF NO COBRADO</div>}
                  {d.waiverReason && <div className="font-normal">Motivo: {d.waiverReason}</div>}
                </div>
              )}

              <Dash />

              {/* Pagos */}
              <div className="font-bold">PAGOS</div>
              {d.payments.map((p, i) => (
                <div key={i} className="flex justify-between gap-2">
                  <span>{METHODS[p.method] ?? p.method}{p.reference ? ` #${p.reference}` : ""}</span>
                  <span className="whitespace-nowrap">{formatMoney(p.amountMinor, p.currencyCode)}</span>
                </div>
              ))}
              {d.payments.filter((p) => p.tenderedMinor).map((p, i) => (
                <div key={`t${i}`} className="text-[10px] text-slate-600">
                  Recibido: {formatMoney(p.tenderedMinor, p.currencyCode)}
                </div>
              ))}
              {d.changeMinor > 0 && (
                <div className="mt-1">
                  <Row label="VUELTO" value={formatMoney(d.changeMinor, d.changeCurrency)} bold />
                </div>
              )}

              {d.creditSale && (
                <div className="mt-2 rounded border border-slate-900 p-1.5">
                  <div className="text-center font-bold">VENTA A CRÉDITO</div>
                  <Row label="Pago inicial" value={m(d.paidInitialMinor)} />
                  <Row label="Saldo pendiente" value={m(d.balanceMinor)} bold />
                  {d.dueDate && <Row label="Vence" value={d.dueDate.split("-").reverse().join("/")} />}
                </div>
              )}

              {d.legend && (
                <div className="mt-3 rounded border-2 border-slate-900 p-1.5 text-center text-[10px] font-extrabold">
                  {d.legend}
                </div>
              )}

              <div className="mt-3 text-center text-[10px] text-slate-500">¡Gracias por su compra!</div>
            </div>
          )}
        </div>

        {/* Botones (no se imprimen) */}
        <div className="flex gap-2 bg-white px-4 py-3">
          <button onClick={() => window.print()} disabled={!d}
            className="flex-1 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">
            Imprimir
          </button>
          <button onClick={onClose} className="rounded-lg border px-4 py-2">Cerrar</button>
        </div>
      </div>
    </div>
  );
}