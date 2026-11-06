import { useEffect, useState } from "react";
import { suppliersApi } from "../../services/api";
import { formatDocument, parseDocument, searchTerm } from "../../utils/document";

const EMPTY = { name: "", document: "", phone: "", address: "" };

export default function SupplierPicker({ value, onChange }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); setSearched(false); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      suppliersApi.list(searchTerm(q), false)
        .then((r) => { if (!cancelled) { setResults(r.slice(0, 6)); setSearched(true); } })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  const pick = (s) => { onChange(s); setSearch(""); setResults([]); setSearched(false); };

  const onKeyDown = (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (!searched) return;
    if (results.length === 1) pick(results[0]);
    else if (results.length === 0) startCreate();
  };

  const startCreate = () => {
    const s = search.trim();
    const looksLikeId = /^[VEJGPC]?[-\s]?[\d.\-]+$/i.test(s);
    setForm({ ...EMPTY, document: looksLikeId ? s : "", name: looksLikeId ? "" : s });
    setError("");
    setCreating(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (form.name.trim().length < 2) return setError("Ingresa el nombre o la razón social");
    const doc = parseDocument(form.document);
    if (doc.error) return setError(doc.error);
    setBusy(true); setError("");
    try {
      const created = await suppliersApi.create({
        idType: doc.idType, idNumber: doc.idNumber, name: form.name,
        phone: form.phone, address: form.address,
      });
      pick(created);
      setCreating(false);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  const input = "mt-1 w-full rounded border p-2";

  if (value) {
    return (
      <div className="rounded border bg-slate-50 p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold">{value.name}</div>
            <div className="font-mono text-slate-600">{formatDocument(value)}</div>
            {value.phone && <div className="text-slate-600">Tel: {value.phone}</div>}
          </div>
          <button type="button" onClick={() => onChange(null)} className="shrink-0 underline">Cambiar</button>
        </div>
      </div>
    );
  }

  if (creating) {
    return (
      <form onSubmit={submit} className="space-y-2 rounded border bg-slate-50 p-3 text-sm">
        <div className="font-semibold">Nuevo proveedor</div>
        <label className="block">Nombre o razón social *
          <input className={input} autoFocus value={form.name} onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="block">RIF o cédula *
          <input className={input} placeholder="J-123456789" value={form.document}
            onChange={(e) => set("document", e.target.value)} />
        </label>
        <label className="block">Teléfono
          <input className={input} inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </label>
        <label className="block">Dirección
          <input className={input} value={form.address} onChange={(e) => set("address", e.target.value)} />
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button disabled={busy} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50">
            {busy ? "Guardando…" : "Guardar y usar"}
          </button>
          <button type="button" onClick={() => setCreating(false)} className="rounded border px-3 py-1">Cancelar</button>
        </div>
      </form>
    );
  }

  return (
    <div className="relative">
      <input className="w-full rounded border p-2" value={search} onKeyDown={onKeyDown}
        onChange={(e) => setSearch(e.target.value)} placeholder="Proveedor: nombre o RIF y Enter" />
      {search.trim() && searched && (
        <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
          {results.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => pick(s)}
                className="flex w-full justify-between gap-2 p-2 text-left hover:bg-slate-100">
                <span>{s.name}</span>
                <span className="font-mono text-sm text-slate-500">{formatDocument(s)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={startCreate}
              className="w-full border-t p-2 text-left text-sm font-semibold hover:bg-slate-100">
              {results.length === 0 ? "No se encontró. " : ""}+ Crear proveedor nuevo
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}