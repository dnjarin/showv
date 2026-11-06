import { useEffect, useState } from "react";
import { quotesApi } from "../services/api";
import {
  renderQuote, canvasToJpeg, buildPdf, toBase64, isDesktopApp, browserSave, PAGE_W, PAGE_H,
} from "../utils/quoteRender";

// La cotización se dibuja una sola vez en canvas: lo que se ve es lo que se imprime,
// se guarda como JPG o se empaqueta en PDF.
export default function QuoteTicket({ q, onClose }) {
  const [canvases, setCanvases] = useState([]);
  const [urls, setUrls] = useState([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setCanvases([]); setUrls([]);
    renderQuote(q)
      .then((cs) => {
        if (!alive) return;
        setCanvases(cs);
        setUrls(cs.map((c) => c.toDataURL("image/jpeg", 0.85)));
      })
      .catch((e) => alive && setMsg(`Error al generar la cotización: ${e.message}`));
    return () => { alive = false; };
  }, [q]);

  const save = async (filename, bytes, mime) => {
    if (isDesktopApp()) {
      const path = await quotesApi.saveFile(filename, toBase64(bytes));
      return `Guardado: ${path}`;
    }
    browserSave(filename, bytes, mime);
    return `Descargado: ${filename}`;
  };

  const run = async (fn) => {
    setBusy(true); setMsg("");
    try { setMsg(await fn()); } catch (e) { setMsg(`Error: ${e.message ?? e}`); } finally { setBusy(false); }
  };

  const toPdf = () => run(async () => {
    const pages = [];
    for (const c of canvases) pages.push({ jpeg: await canvasToJpeg(c, 0.9), w: PAGE_W, h: PAGE_H });
    return save(`${q.number}.pdf`, buildPdf(pages), "application/pdf");
  });

  const toJpg = () => run(async () => {
    const out = [];
    for (let i = 0; i < canvases.length; i++) {
      const name = canvases.length > 1 ? `${q.number}-${i + 1}.jpg` : `${q.number}.jpg`;
      out.push(await save(name, await canvasToJpeg(canvases[i], 0.92), "image/jpeg"));
    }
    return out.join(" · ");
  });

  const print = () => {
    const style = document.createElement("style");
    style.textContent = "@page{size:letter;margin:0}";
    document.head.appendChild(style);
    window.print();
    setTimeout(() => style.remove(), 500);
  };

  const ready = canvases.length > 0 && !busy;
  const btn = "rounded-lg px-4 py-2 font-medium disabled:opacity-50";

  return (
    <div className="ticket-overlay fixed inset-0 z-50 overflow-y-auto bg-black/60 p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button disabled={!ready} onClick={toPdf} className={`${btn} bg-slate-900 text-white`}>Descargar PDF</button>
          <button disabled={!ready} onClick={toJpg} className={`${btn} bg-slate-900 text-white`}>Descargar JPG</button>
          <button disabled={!ready} onClick={print} className={`${btn} bg-white`}>Imprimir</button>
          <button onClick={onClose} className={`${btn} bg-white`}>Cerrar</button>
        </div>
        {msg && <div className="mb-3 break-all rounded bg-white p-2 text-sm">{msg}</div>}
        {urls.length === 0 && !msg && <div className="rounded bg-white p-6 text-center text-sm">Generando cotización…</div>}
        <div className="voucher-print mx-auto max-w-[210mm] space-y-4 print:space-y-0">
          {urls.map((u, i) => (
            <img key={i} src={u} alt={`Cotización ${q.number}, página ${i + 1}`} className="quote-page w-full bg-white shadow-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
