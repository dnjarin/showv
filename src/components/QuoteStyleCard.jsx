import { useEffect, useRef, useState } from "react";
import { quotesApi } from "../services/api";
import { shrinkLogo } from "../utils/quoteRender";

export default function QuoteStyleCard() {
  const [logo, setLogo] = useState(null);
  const [title, setTitle] = useState("");
  const [warranty, setWarranty] = useState("");
  const [footer, setFooter] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    quotesApi.styleGet().then((s) => {
      setLogo(s.logo ?? null);
      setTitle(s.warrantyTitle ?? "");
      setWarranty(s.warranty ?? "");
      setFooter(s.footer ?? "");
    }).catch((e) => setMsg(`Error: ${e.message ?? e}`));
  }, []);

  const pick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setMsg("");
    try {
      if (!/^image\/(png|jpeg)$/.test(f.type)) throw new Error("Usa una imagen PNG o JPG");
      setLogo(await shrinkLogo(f));
    } catch (err) { setMsg(`Error: ${err.message ?? err}`); }
  };

  const save = async () => {
    setBusy(true); setMsg("");
    try {
      await quotesApi.styleSave({ logo, warrantyTitle: title, warranty, footer });
      setMsg("Formato de cotización guardado.");
    } catch (err) { setMsg(`Error: ${err.message ?? err}`); } finally { setBusy(false); }
  };

  const input = "w-full rounded border p-2 text-sm";
  return (
    <section className="rounded-xl border bg-white p-4 shadow-sm">
      <h2 className="font-semibold">Formato de cotización</h2>
      <p className="mt-1 text-xs text-slate-500">
        El logo se carga una sola vez y se usa en todas las cotizaciones (PNG o JPG).
      </p>
      <div className="mt-3 flex items-center gap-4">
        <div className="flex h-24 w-40 items-center justify-center rounded border bg-slate-50">
          {logo ? <img src={logo} alt="Logo" className="max-h-full max-w-full object-contain" />
            : <span className="text-xs text-slate-400">Sin logo</span>}
        </div>
        <div className="flex flex-col gap-2">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={pick} />
          <button type="button" onClick={() => fileRef.current?.click()} className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white">
            {logo ? "Cambiar logo" : "Cargar logo"}
          </button>
          {logo && <button type="button" onClick={() => setLogo(null)} className="rounded-lg bg-slate-100 px-3 py-2 text-sm">Quitar logo</button>}
        </div>
      </div>
      <label className="mt-3 block text-sm">Título de garantías
        <input className={input} maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">Garantías (una por línea)
        <textarea className={input} rows={6} value={warranty} onChange={(e) => setWarranty(e.target.value)} />
      </label>
      <label className="mt-3 block text-sm">Texto al pie
        <input className={input} maxLength={120} value={footer} onChange={(e) => setFooter(e.target.value)} />
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button disabled={busy} onClick={save} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Guardar</button>
        {msg && <span className="text-sm">{msg}</span>}
      </div>
    </section>
  );
}
