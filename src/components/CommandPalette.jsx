import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import Icon from "./Icon";
import { normalize, paletteFor } from "../utils/nav";

/** Buscador rápido de pantallas (Ctrl+K). */
export default function CommandPalette({ role, open, onClose }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  const entries = useMemo(() => paletteFor(role), [role]);

  const results = useMemo(() => {
    const terms = normalize(q).split(/\s+/).filter(Boolean);
    const list = terms.length === 0
      ? entries
      : entries.filter((e) => {
          const hay = normalize(`${e.label} ${e.group} ${e.keywords}`);
          return terms.every((t) => hay.includes(t));
        });
    return list.slice(0, 8);
  }, [q, entries]);

  useEffect(() => {
    if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);
  useEffect(() => { setIdx(0); }, [q]);

  if (!open) return null;

  const go = (e) => { if (!e) return; onClose(); navigate(e.to); };
  const onKey = (ev) => {
    if (ev.key === "Escape") { ev.preventDefault(); onClose(); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (ev.key === "Enter") { ev.preventDefault(); go(results[idx]); }
  };

  return (
    <div className="dm fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[15vh]" onMouseDown={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b px-3">
          <Icon name="search" className="h-4 w-4 text-slate-400" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="¿A dónde quieres ir? (ej.: cobrar, gastos, usuarios)"
            className="w-full py-3 outline-none" />
          <kbd className="rounded border px-1.5 text-xs text-slate-400">Esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {results.map((e, i) => (
            <li key={e.to + e.label}>
              <button type="button" onMouseEnter={() => setIdx(i)} onClick={() => go(e)}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${i === idx ? "bg-slate-100" : ""}`}>
                <span>{e.label}</span>
                <span className="text-xs text-slate-400">{e.group}</span>
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="px-4 py-6 text-center text-sm text-slate-500">Sin coincidencias</li>}
        </ul>
      </div>
    </div>
  );
}
