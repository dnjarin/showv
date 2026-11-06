import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { salesApi } from "../services/api";
import { formatMoney } from "../utils/money";
import Ticket from "../components/Ticket";
import ReturnModal from "../components/ReturnModal.jsx";
import ReturnTicket from "../components/ReturnTicket";

const localDate = (s) => new Date(s.replace(" ", "T") + "Z").toLocaleString("es-VE");

export default function Documents() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState("");
  const [view, setView] = useState(null); // { id, isReturn }
  const [returning, setReturning] = useState(null); // id de la venta
  const [voiding, setVoiding] = useState(null); // { id, reason }
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try { setRows(await salesApi.list(search.trim() || null, 100)); }
    catch (e) { setError(e.message); }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const confirmVoid = async () => {
    setError("");
    try {
      await salesApi.void(voiding.id, voiding.reason);
      setVoiding(null);
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div>
      <h1 className="mb-4 text-2xl font-semibold">Documentos emitidos</h1>
      <input className="mb-3 w-72 rounded border p-2" placeholder="Buscar por número o cliente"
        value={search} onChange={(e) => setSearch(e.target.value)} />
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {voiding && (
        <div className="mb-4 flex max-w-xl items-center gap-2 rounded-xl border border-red-300 bg-red-50 p-3">
          <input className="flex-1 rounded border p-2" placeholder="Motivo de la anulación"
            value={voiding.reason} onChange={(e) => setVoiding({ ...voiding, reason: e.target.value })} />
          <button onClick={confirmVoid} className="rounded bg-red-700 px-3 py-2 text-white">Anular</button>
          <button onClick={() => setVoiding(null)} className="rounded border px-3 py-2">Cancelar</button>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Número</th><th className="p-3">Fecha</th><th className="p-3">Cliente</th>
              <th className="p-3">Total</th><th className="p-3">IGTF</th><th className="p-3">Estado</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`border-b ${r.status === "voided" ? "opacity-50" : ""} ${r.docType === "DEVOLUCION" ? "bg-amber-50" : ""}`}>
                <td className="p-3 font-mono">{r.series}-{String(r.number).padStart(6, "0")}</td>
                <td className="p-3">{localDate(r.issuedAt)}</td>
                <td className="p-3">{r.customerName ?? "—"}</td>
                <td className="p-3">{formatMoney(r.totalMinor, r.currencyCode)}</td>
                <td className="p-3">{r.igtfMinor > 0 ? formatMoney(r.igtfMinor, r.currencyCode) : "—"}</td>
                <td className="p-3">
                  {r.docType === "DEVOLUCION" ? "Nota de crédito" : r.docType === "SALDO_INICIAL" ? "Saldo inicial" : r.status === "voided" ? "Anulado" : "Emitido"}
                </td>
                <td className="space-x-2 p-3 text-right">
                  {r.docType !== "SALDO_INICIAL" && (
                    <button onClick={() => setView({ id: r.id, isReturn: r.docType === "DEVOLUCION" })}
                      className="underline">Ver / imprimir</button>
                  )}
                  {isAdmin && r.status === "issued" && r.docType === "COMPROBANTE" && (
                    <button onClick={() => setReturning(r.id)} className="underline">Devolver</button>
                  )}
                  {isAdmin && r.status === "issued" && r.docType === "COMPROBANTE" && (
                    <button onClick={() => setVoiding({ id: r.id, reason: "" })} className="underline">Anular</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-500">Sin documentos</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {view && !view.isReturn && <Ticket id={view.id} onClose={() => setView(null)} />}
      {view && view.isReturn && <ReturnTicket id={view.id} onClose={() => setView(null)} />}
      {returning && (
        <ReturnModal
          documentId={returning}
          onClose={() => setReturning(null)}
          onDone={(id) => { setReturning(null); setView({ id, isReturn: true }); load(); }}
        />
      )}
    </div>
  );
}