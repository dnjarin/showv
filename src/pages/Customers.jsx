import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../store/authStore";
import { customersApi } from "../services/api";
import { formatDocument, parseDocument, searchTerm } from "../utils/document";

function CustomerForm({ customer, onSaved, onCancel }) {
  const [form, setForm] = useState(
    customer
      ? {
          name: customer.name,
          document: formatDocument(customer),
          phone: customer.phone ?? "",
          address: customer.fiscalAddress ?? "",
        }
      : { name: "", document: "", phone: "", address: "" }
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (form.name.trim().length < 2) return setError("Ingresa el nombre y apellido o la razón social");
    const doc = parseDocument(form.document);
    if (doc.error) return setError(doc.error);

    const payload = {
      idType: doc.idType,
      idNumber: doc.idNumber,
      name: form.name,
      phone: form.phone,
      fiscalAddress: form.address,
      email: customer?.email ?? null, // conserva el correo si el cliente ya tenía uno
    };
    setBusy(true);
    setError("");
    try {
      customer ? await customersApi.update(customer.id, payload) : await customersApi.create(payload);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "mt-1 w-full rounded border p-2";
  return (
    <form onSubmit={submit} className="mb-6 max-w-xl space-y-3 rounded-xl bg-white p-4 shadow">
      <h2 className="font-semibold">{customer ? "Editar cliente" : "Nuevo cliente"}</h2>
      <label className="block text-sm">Nombre y apellido o razón social *
        <input className={input} autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} />
      </label>
      <label className="block text-sm">Cédula o RIF *
        <input className={input} placeholder="V-12345678 o J-123456789" value={form.document}
          onChange={(e) => set("document", e.target.value)} />
      </label>
      <label className="block text-sm">Número de teléfono
        <input className={input} inputMode="tel" value={form.phone}
          onChange={(e) => set("phone", e.target.value)} />
      </label>
      <label className="block text-sm">Dirección
        <input className={input} value={form.address} onChange={(e) => set("address", e.target.value)} />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-50">
          {busy ? "Guardando…" : "Guardar"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border px-4 py-2">Cancelar</button>
      </div>
    </form>
  );
}

export default function Customers() {
  const isAdmin = useAuth((s) => s.user.role === "admin");
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState(null); // null | "new" | cliente
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const q = search.trim() ? searchTerm(search) : null;
      setItems(await customersApi.list(q, showInactive));
    } catch (e) { setError(e.message); }
  }, [search, showInactive]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const toggle = async (c) => {
    try { await customersApi.setActive(c.id, !c.active); load(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clientes</h1>
        {!editing && (
          <button onClick={() => setEditing("new")} className="rounded bg-slate-900 px-4 py-2 text-white">
            Nuevo cliente
          </button>
        )}
      </div>

      {editing && (
        <CustomerForm customer={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}

      <div className="mb-3 flex items-center gap-4">
        <input className="w-72 rounded border p-2" placeholder="Buscar por nombre o cédula/RIF"
          value={search} onChange={(e) => setSearch(e.target.value)} />
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
            <tr>
              <th className="p-3">Nombre y apellido / Razón social</th>
              <th className="p-3">Cédula o RIF</th>
              <th className="p-3">Teléfono</th>
              <th className="p-3">Dirección</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} className={`border-b ${c.active ? "" : "opacity-50"}`}>
                <td className="p-3">{c.name}</td>
                <td className="p-3 font-mono">{formatDocument(c)}</td>
                <td className="p-3">{c.phone ?? "—"}</td>
                <td className="p-3">{c.fiscalAddress ?? "—"}</td>
                <td className="space-x-2 p-3 text-right">
                  <button onClick={() => setEditing(c)} className="underline">Editar</button>
                  {isAdmin && (
                    <button onClick={() => toggle(c)} className="underline">
                      {c.active ? "Desactivar" : "Activar"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr><td colSpan={5} className="p-6 text-center text-slate-500">Sin resultados</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}