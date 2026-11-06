import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../../store/authStore";
import { retentionsApi, suppliersApi } from "../../services/api";
import { formatDocument, parseDocument, searchTerm } from "../../utils/document";

function SupplierForm({ supplier, onSaved, onCancel }) {
  const [form, setForm] = useState(
    supplier
      ? { name: supplier.name, document: formatDocument(supplier), phone: supplier.phone ?? "", address: supplier.address ?? "" }
      : { name: "", document: "", phone: "", address: "" }
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (form.name.trim().length < 2) return setError("Ingresa el nombre o la razón social");
    const doc = parseDocument(form.document);
    if (doc.error) return setError(doc.error);
    const payload = { idType: doc.idType, idNumber: doc.idNumber, name: form.name, phone: form.phone, address: form.address };
    setBusy(true); setError("");
    try {
      supplier ? await suppliersApi.update(supplier.id, payload) : await suppliersApi.create(payload);
      onSaved();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const input = "mt-1 w-full rounded border p-2";
  return (
    <form onSubmit={submit} className="mb-6 max-w-xl space-y-3 rounded-xl bg-white p-4 shadow">
      <h2 className="font-semibold">{supplier ? "Editar proveedor" : "Nuevo proveedor"}</h2>
      <label className="block text-sm">Nombre o razón social *
        <input className={input} autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="block text-sm">RIF o cédula *
        <input className={input} placeholder="J-123456789" value={form.document} onChange={(e) => set("document", e.target.value)} />
      </label>
      <label className="block text-sm">Teléfono
        <input className={input} inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
      </label>
      <label className="block text-sm">Dirección
        <input className={input} value={form.address} onChange={(e) => set("address", e.target.value)} />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">{busy ? "Guardando…" : "Guardar"}</button>
        <button type="button" onClick={onCancel} className="rounded border px-4 py-2">Cancelar</button>
      </div>
    </form>
  );
}

export default function SuppliersTab() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null); // null | "new" | proveedor
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setItems(await suppliersApi.list(search.trim() ? searchTerm(search) : null, showInactive));
      setError("");
    } catch (e) { setError(e.message); }
  }, [search, showInactive]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const toggle = async (s) => {
    try { await suppliersApi.setActive(s.id, !s.active); load(); } catch (e) { setError(e.message); }
  };

  const RET_LABEL = { "": "Predeterminada", 7500: "75 %", 10000: "100 %", 0: "No retener" };
  const setRet = async (s, value) => {
    try {
      await retentionsApi.setSupplierIva(s.id, value === "" ? null : Number(value));
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div>
      {!editing && (
        <button onClick={() => setEditing("new")} className="mb-3 rounded bg-slate-900 px-4 py-2 text-white">Nuevo proveedor</button>
      )}
      {editing && (
        <SupplierForm supplier={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}

      <div className="mb-3 flex items-center gap-4">
        <input className="w-72 rounded border p-2" placeholder="Buscar por nombre o RIF" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        {isAdmin && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Mostrar inactivos
          </label>
        )}
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      <div className="overflow-x-auto rounded-xl bg-white shadow">
        <table className="w-full text-left text-sm">
          <thead className="border-b bg-slate-100">
            <tr><th className="p-3">Nombre / Razón social</th><th className="p-3">RIF o cédula</th>
              <th className="p-3">Teléfono</th><th className="p-3">Dirección</th>
              <th className="p-3">Retención de IVA</th><th className="p-3"></th></tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id} className={`border-b ${s.active ? "" : "opacity-50"}`}>
                <td className="p-3">{s.name}</td>
                <td className="p-3 font-mono">{formatDocument(s)}</td>
                <td className="p-3">{s.phone ?? "—"}</td>
                <td className="p-3">{s.address ?? "—"}</td>
                <td className="p-3">
                  {isAdmin ? (
                    <select className="rounded border p-1 text-xs" value={s.ivaRetentionBp ?? ""} onChange={(e) => setRet(s, e.target.value)}>
                      <option value="">Predeterminada</option>
                      <option value="7500">75 %</option>
                      <option value="10000">100 %</option>
                      <option value="0">No retener</option>
                    </select>
                  ) : RET_LABEL[s.ivaRetentionBp ?? ""]}
                </td>
                <td className="space-x-2 p-3 text-right">
                  <button onClick={() => setEditing(s)} className="underline">Editar</button>
                  {isAdmin && <button onClick={() => toggle(s)} className="underline">{s.active ? "Desactivar" : "Activar"}</button>}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-500">Sin proveedores</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}