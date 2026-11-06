import { formatMoney } from "../utils/money";
import { localDate } from "../utils/dates";

const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "—");
const METHODS = {
  efectivo: "Efectivo", punto: "Punto de venta", pago_movil: "Pago móvil",
  transferencia: "Transferencia", zelle: "Zelle", otro: "Otro", saldo_favor: "Saldo a favor",
};

export default function StatementTicket({ acc, onClose }) {
  const print = () => {
    const style = document.createElement("style");
    style.textContent = "@page{size:letter;margin:12mm}";
    document.head.appendChild(style);
    window.print();
    setTimeout(() => style.remove(), 500);
  };
  const aging = acc.agingUsdMinor;
  const labels = ["1-15 d", "16-30 d", "31-60 d", "+60 d"];

  return (
    <div className="ticket-overlay fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-3 flex gap-2">
          <button onClick={print} className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white">Imprimir</button>
          <button onClick={onClose} className="rounded-lg bg-white px-4 py-2">Cerrar</button>
        </div>
        <div className="voucher-print relative mx-auto max-w-[190mm] bg-white p-8 text-sm text-slate-900 shadow-xl">
          <div className="flex justify-between border-b pb-3">
            <div>
              <div className="text-lg font-bold uppercase">{acc.issuerName}</div>
              <div>RIF: {acc.issuerRif}</div>
              <div className="text-xs text-slate-600">{acc.issuerAddress}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold">ESTADO DE CUENTA</div>
              <div className="text-xs">Emitido: {localDate(new Date().toISOString().slice(0, 19).replace("T", " "))}</div>
            </div>
          </div>

          <div className="mt-3">
            <div className="font-semibold">{acc.name}</div>
            <div>{acc.idType}-{acc.idNumber}{acc.phone ? ` · Tel. ${acc.phone}` : ""}</div>
          </div>

          <h3 className="mt-4 font-semibold">Documentos pendientes</h3>
          <table className="mt-1 w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1">Documento</th><th>Emisión</th><th>Vence</th>
                <th className="text-right">Total</th><th className="text-right">Saldo</th><th className="text-right">Atraso</th>
              </tr>
            </thead>
            <tbody>
              {acc.docs.map((d) => (
                <tr key={d.id} className="border-b">
                  <td className="py-1 font-mono">{d.series}-{String(d.number).padStart(6, "0")}</td>
                  <td>{fmtDate(d.issuedAt?.slice(0, 10))}</td>
                  <td>{fmtDate(d.dueDate)}</td>
                  <td className="text-right">{formatMoney(d.totalMinor, d.currencyCode)}</td>
                  <td className="text-right font-semibold">{formatMoney(d.balanceMinor, d.currencyCode)}</td>
                  <td className="text-right">{d.daysOverdue > 0 ? `${d.daysOverdue} d` : "Al día"}</td>
                </tr>
              ))}
              {acc.docs.length === 0 && (
                <tr><td colSpan={6} className="py-3 text-center text-slate-500">Sin deudas pendientes</td></tr>
              )}
            </tbody>
          </table>

          <div className="mt-3 grid grid-cols-5 gap-2 text-center text-xs">
            <div className="rounded border p-1">Por vencer<br /><b>{formatMoney(acc.notDueUsdMinor, "USD")}</b></div>
            {aging.map((v, i) => (
              <div key={i} className="rounded border p-1">{labels[i]}<br /><b>{formatMoney(v, "USD")}</b></div>
            ))}
          </div>
          <div className="mt-2 text-right font-bold">
            Deuda total (USD equiv.): {formatMoney(acc.credit.outstandingUsdMinor, "USD")}
          </div>
          {(acc.creditUsdMinor > 0 || acc.creditVesMinor > 0) && (
            <div className="text-right">
              Saldo a favor:{" "}
              {[acc.creditUsdMinor > 0 && formatMoney(acc.creditUsdMinor, "USD"),
                acc.creditVesMinor > 0 && formatMoney(acc.creditVesMinor, "VES")].filter(Boolean).join(" + ")}
            </div>
          )}

          {acc.receipts.length > 0 && (
            <>
              <h3 className="mt-4 font-semibold">Últimos abonos</h3>
              <table className="mt-1 w-full text-xs">
                <tbody>
                  {acc.receipts.map((r) => (
                    <tr key={r.id} className={`border-b ${r.voided ? "text-slate-400 line-through" : ""}`}>
                      <td className="py-1 font-mono">R-{String(r.number).padStart(6, "0")}</td>
                      <td>{localDate(r.createdAt)}</td>
                      <td>{METHODS[r.method] ?? r.method}</td>
                      <td className="text-right">{formatMoney(r.amountMinor, r.currencyCode)}{r.voided ? " (anulado)" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="mt-6 text-center text-[10px] text-slate-500">
            Documento informativo sin validez fiscal.
          </p>
        </div>
      </div>
    </div>
  );
}