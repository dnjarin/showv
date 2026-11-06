import { useEffect, useState } from "react";
import { customersApi } from "../services/api";
import { formatDocument, parseDocument, searchTerm } from "../utils/document";

const EMPTY = { name: "", document: "", phone: "", address: "" };

export default function CustomerPicker({ value, onChange }) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState([]);
  const [searched, setSearched] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // Búsqueda mientras se escribe
  useEffect(() => {
    const q = search.trim();
    if (!q) { setResults([]); setSearched(false); return; }
    let cancelled = false;
    const t = setTimeout(() => {
      customersApi.list(searchTerm(q), false)
        .then((r) => { if (!cancelled) { setResults(r.slice(0, 6)); setSearched(true); } })
        .catch(() => {});
    }, 200);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search]);

  const pick = (c) => {
    onChange(c);
    setSearch(""); setResults([]); setSearched(false);
  };

  // Enter: un solo resultado se selecciona; si no hay ninguno, abre el formulario de alta
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
    if (form.name.trim().length < 2) return setError("Ingresa el nombre y apellido o la razón social");
    const doc = parseDocument(form.document);
    if (doc.error) return setError(doc.error);

    setBusy(true);
    setError("");
    try {
      const created = await customersApi.create({
        idType: doc.idType,
        idNumber: doc.idNumber,
        name: form.name,
        phone: form.phone,
        fiscalAddress: form.address,
        email: null,
      });
      pick(created);
      setCreating(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "mt-1 w-full rounded border p-2";

  // 1) Cliente ya seleccionado
  if (value) {
    return (
      <div className="mb-3 rounded border bg-white p-3 text-sm">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-semibold">{value.name}</div>
            <div className="font-mono text-slate-600">{formatDocument(value)}</div>
            {value.phone && <div className="text-slate-600">Tel: {value.phone}</div>}
            {value.fiscalAddress && <div className="text-slate-600">{value.fiscalAddress}</div>}
          </div>
          <button type="button" onClick={() => onChange(null)} className="shrink-0 underline">
            Cambiar
          </button>
        </div>
      </div>
    );
  }

  // 2) Alta rápida
  if (creating) {
    return (
      <form onSubmit={submit} className="mb-3 space-y-2 rounded border bg-white p-3 text-sm">
        <div className="font-semibold">Nuevo cliente</div>
        <label className="block">Nombre y apellido o razón social *
          <input className={input} autoFocus value={form.name}
            onChange={(e) => set("name", e.target.value)} />
        </label>
        <label className="block">Cédula o RIF *
          <input className={input} placeholder="V-12345678 o J-123456789" value={form.document}
            onChange={(e) => set("document", e.target.value)} />
        </label>
        <label className="block">Número de teléfono
          <input className={input} inputMode="tel" value={form.phone}
            onChange={(e) => set("phone", e.target.value)} />
        </label>
        <label className="block">Dirección
          <input className={input} value={form.address}
            onChange={(e) => set("address", e.target.value)} />
        </label>
        {error && <p className="text-red-600">{error}</p>}
        <div className="flex gap-2">
          <button disabled={busy} className="rounded bg-slate-900 px-3 py-1 text-white disabled:opacity-50">
            {busy ? "Guardando…" : "Guardar y usar"}
          </button>
          <button type="button" onClick={() => setCreating(false)} className="rounded border px-3 py-1">
            Cancelar
          </button>
        </div>
      </form>
    );
  }

  // 3) Buscador
  return (
    <div className="relative mb-3">
      <input className="w-full rounded border bg-white p-2" value={search} autoFocus
        onChange={(e) => setSearch(e.target.value)} onKeyDown={onKeyDown}
        placeholder="Cédula o RIF (o nombre) y Enter" />
      {!search.trim() && (
        <div className="mt-1 text-xs text-slate-500">
          Sin cliente: se emitirá a nombre de «Consumidor final».
        </div>
      )}
      {search.trim() && searched && (
        <ul className="absolute z-10 mt-1 w-full rounded border bg-white shadow">
          {results.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => pick(c)}
                className="flex w-full justify-between gap-2 p-2 text-left hover:bg-slate-100">
                <span>{c.name}</span>
                <span className="font-mono text-sm text-slate-500">{formatDocument(c)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={startCreate}
              className="w-full border-t p-2 text-left text-sm font-semibold hover:bg-slate-100">
              {results.length === 0 ? "No se encontró. " : ""}+ Crear cliente nuevo
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}