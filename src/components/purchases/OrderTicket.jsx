import { formatMoney } from "../../utils/money";
import { localDate } from "../../utils/dates";

const fmtDate = (s) => (s ? s.split("-").reverse().join("/") : "—");

export default function OrderTicket({ o, onClose }) {
  const print = () => {
    const style = document.createElement("style");
    style.textContent = "@page{size:letter;margin:12mm}";
    document.head.appendChild(style);
    window.print();
    setTimeout(() => style.remove(), 500);
  };
  const cur = o.currencyCode;
  const units = o.items.reduce((s, i) => s + i.quantity, 0);

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
              <div className="text-lg font-bold uppercase">{o.issuerName}</div>
              <div>RIF: {o.issuerRif}</div>
              <div className="text-xs text-slate-600">{o.issuerAddress}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-bold">ORDEN DE COMPRA</div>
              <div className="font-mono">{o.number}</div>
              <div className="text-xs">Emitida: {localDate(o.createdAt)}</div>
              {o.expectedDate && <div className="text-xs font-semibold">Entrega esperada: {fmtDate(o.expectedDate)}</div>}
            </div>
          </div>

          <div className="mt-3">
            <div className="text-xs uppercase text-slate-500">Proveedor</div>
            <div className="font-semibold">{o.supplierName}</div>
            <div>{o.supplierDoc}{o.supplierPhone ? ` · Tel. ${o.supplierPhone}` : ""}</div>
            {o.supplierAddress && <div className="text-xs text-slate-600">{o.supplierAddress}</div>}
          </div>

          <table className="mt-4 w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th className="py-1">SKU</th><th>Descripción</th><th className="text-right">Cant.</th>
                <th className="text-right">Costo unit.</th><th className="text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {o.items.map((l, i) => (
                <tr key={i} className="border-b">
                  <td className="py-1 font-mono">{l.sku}</td>
                  <td>{l.description}</td>
                  <td className="text-right">{l.quantity}</td>
                  <td className="text-right">{formatMoney(l.unitCostMinor, cur)}</td>
                  <td className="text-right">{formatMoney(l.lineTotalMinor, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 ml-auto w-64 space-y-1">
            <div className="flex justify-between text-slate-600"><span>Unidades</span><span>{units}</span></div>
            <div className="flex justify-between border-t pt-1 text-base font-bold">
              <span>TOTAL (sin IVA)</span><span>{formatMoney(o.totalMinor, cur)}</span>
            </div>
          </div>

          {o.notes && <p className="mt-4 whitespace-pre-line text-xs">{o.notes}</p>}
          <div className="mt-12 grid grid-cols-2 gap-10 text-center text-xs">
            <div className="border-t pt-1">Autorizado por{o.createdByName ? `: ${o.createdByName}` : ""}</div>
            <div className="border-t pt-1">Recibido conforme (proveedor)</div>
          </div>
          <p className="mt-6 text-center text-[10px] text-slate-500">
            Orden de compra interna sin validez fiscal. Los montos no incluyen IVA.
          </p>
        </div>
      </div>
    </div>
  );
}
