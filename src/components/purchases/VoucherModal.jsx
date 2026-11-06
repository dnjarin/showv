import { useEffect, useState } from "react";
import { retentionsApi } from "../../services/api";
import { formatMoney } from "../../utils/money";
import { localDate } from "../../utils/dates";

const pct = (bp) => `${String(bp / 100).replace(".", ",")} %`;

export default function VoucherModal({ id, onClose }) {
  const [v, setV] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    retentionsApi.voucher(id).then(setV).catch((e) => setError(e.message));
  }, [id]);

  // Tamaño carta solo durante la impresión de este comprobante
  const print = () => {
    const s = document.createElement("style");
    s.textContent = "@page{size:letter;margin:12mm}";
    document.head.appendChild(s);
    const done = () => { s.remove(); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    window.print();
  };

  const m = (x) => formatMoney(x, "VES");
  const isIva = v?.kind === "IVA";
  const voided = v?.status === "voided";

  return (
    <div className="ticket-overlay fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="flex max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-slate-100 shadow-2xl">
        <div className="flex items-center justify-between bg-white px-4 py-3">
          <div className="font-mono text-lg font-semibold">{v?.voucherNumber ?? "…"}</div>
          <button onClick={onClose} aria-label="Cerrar" className="rounded-full px-2 text-2xl leading-none text-slate-500 hover:bg-slate-100">×</button>
        </div>

        <div className="ticket-scroll flex-1 overflow-y-auto p-4">
          {error && <p className="text-center text-red-600">{error}</p>}
          {!v && !error && <p className="text-center text-slate-500">Cargando…</p>}
          {v && (
            <div className="voucher-print relative mx-auto max-w-[190mm] bg-white p-8 text-sm text-slate-900 shadow-md">
              {voided && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden">
                  <span className="-rotate-12 rounded border-4 border-red-500/60 px-6 py-2 text-5xl font-extrabold tracking-widest text-red-500/60">ANULADO</span>
                </div>
              )}

              <h1 className="mb-1 text-center text-base font-bold uppercase">
                Comprobante de retención del {isIva ? "impuesto al valor agregado" : "impuesto sobre la renta"}
              </h1>
              <div className="mb-4 grid grid-cols-3 gap-2 border-y py-2 text-xs">
                <div><div className="text-slate-500">N.º de comprobante</div><div className="font-mono font-semibold">{v.voucherNumber}</div></div>
                <div><div className="text-slate-500">Fecha de emisión</div><div>{localDate(v.createdAt)}</div></div>
                <div><div className="text-slate-500">Período fiscal</div><div>{v.period.replace("-", "/")}</div></div>
              </div>

              <div className="mb-4 grid grid-cols-2 gap-4 text-xs">
                <div className="rounded border p-2">
                  <div className="font-bold">AGENTE DE RETENCIÓN</div>
                  <div>{v.agentName}</div><div>RIF: {v.agentRif}</div><div>{v.agentAddress}</div>
                </div>
                <div className="rounded border p-2">
                  <div className="font-bold">SUJETO RETENIDO</div>
                  <div>{v.supplierName}</div><div>RIF/C.I.: {v.supplierDoc}</div>
                  {v.supplierAddress && <div>{v.supplierAddress}</div>}
                </div>
              </div>

              <div className="mb-2 text-xs">
                Factura {v.invoiceNumber ?? "—"} · N.º de control {v.invoiceControl ?? "—"} · Fecha {v.invoiceDate ?? "—"} · Compra C-{String(v.purchaseNumber).padStart(6, "0")}
              </div>

              {isIva ? (
                <table className="mb-4 w-full text-left text-xs">
                  <thead className="border-b bg-slate-100">
                    <tr><th className="p-2">Total compra (incl. IVA)</th><th className="p-2">Exento</th><th className="p-2">Base imponible</th>
                      <th className="p-2">Alícuota</th><th className="p-2">Impuesto IVA</th><th className="p-2">% retenido</th><th className="p-2 text-right">IVA retenido</th></tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="p-2">{m(v.invoiceTotalVesMinor)}</td><td className="p-2">{m(v.exemptVesMinor)}</td>
                      <td className="p-2">{m(v.baseVesMinor)}</td><td className="p-2">{pct(v.ivaRateBp)}</td>
                      <td className="p-2">{m(v.taxVesMinor)}</td><td className="p-2">{pct(v.rateBp)}</td>
                      <td className="p-2 text-right font-bold">{m(v.amountVesMinor)}</td>
                    </tr>
                  </tbody>
                </table>
              ) : (
                <table className="mb-4 w-full text-left text-xs">
                  <thead className="border-b bg-slate-100">
                    <tr><th className="p-2">Concepto</th><th className="p-2">Monto sujeto</th><th className="p-2">Tarifa</th>
                      <th className="p-2">Sustraendo</th><th className="p-2 text-right">ISLR retenido</th></tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="p-2">{v.conceptName}</td><td className="p-2">{m(v.baseVesMinor)}</td>
                      <td className="p-2">{pct(v.rateBp)}</td><td className="p-2">{m(v.sustraendoVesMinor)}</td>
                      <td className="p-2 text-right font-bold">{m(v.amountVesMinor)}</td>
                    </tr>
                  </tbody>
                </table>
              )}
              {!isIva && v.priorBaseVesMinor > 0 && (
                <p className="mb-3 text-xs text-slate-600">
                  Cálculo acumulado del mes: pagos previos sujetos {m(v.priorBaseVesMinor)} y retenido previamente {m(v.priorRetVesMinor)}.
                </p>
              )}
              <p className="mb-4 text-xs text-slate-500">Montos expresados en bolívares{v.currencyCode !== "VES" ? ` (la compra fue en ${v.currencyCode}, convertida con la tasa vigente al registrarla)` : ""}.</p>

              <div className="mb-4 grid grid-cols-2 gap-8 pt-10 text-center text-xs">
                <div className="border-t pt-1">Firma y sello del agente de retención</div>
                <div className="border-t pt-1">Firma y sello del sujeto retenido</div>
              </div>

              <div className="rounded border-2 border-slate-900 p-2 text-center text-[11px] font-extrabold">
                DOCUMENTO DE SOPORTE GENERADO POR EL SISTEMA. SIN VALIDEZ FISCAL HASTA QUE SE EMITA POR UN MEDIO AUTORIZADO POR EL SENIAT.
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-2 bg-white px-4 py-3">
          <button onClick={print} disabled={!v} className="flex-1 rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50">Imprimir</button>
          <button onClick={onClose} className="rounded-lg border px-4 py-2">Cerrar</button>
        </div>
      </div>
    </div>
  );
}