import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import Icon from "./Icon";
import logoB from "../assets/brand/logo-b.png";
import ThemeToggle from "./ThemeToggle";

const item = ({ isActive }) =>
  `block rounded px-3 py-2 text-sm ${isActive ? "bg-slate-100 font-medium text-slate-900" : "text-slate-700 hover:bg-slate-100"}`;
const top = ({ isActive }) =>
  `flex items-center gap-2 rounded px-3 py-2 text-sm font-medium ${isActive ? "bg-slate-700 text-white" : "text-slate-200 hover:bg-slate-800"}`;

/** Menú horizontal con desplegables (alternativa a la barra lateral). */
export default function TopNav({ groups, activeId, pending, user, onSearch, onLogout, onSwitch }) {
  const [openId, setOpenId] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpenId(null); };
    const onKey = (e) => { if (e.key === "Escape") setOpenId(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <header ref={ref} className="app-top relative z-30 flex flex-wrap items-center gap-1 bg-slate-900 px-4 py-2 text-slate-100">
      <img src={logoB} alt="TEKADDON" className="mr-3 h-10 w-auto" />

      {!pending && (
        <nav className="flex flex-wrap items-center gap-1">
          <NavLink to="/" end className={top} onClick={() => setOpenId(null)}><Icon name="home" />Inicio</NavLink>
          {groups.map((g) => {
            const isOpen = openId === g.id;
            return (
              <div key={g.id} className="relative">
                <button type="button" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : g.id)}
                  className={`flex items-center gap-2 rounded px-3 py-2 text-sm font-medium hover:bg-slate-800 ${
                    g.id === activeId ? "bg-slate-800 text-white" : "text-slate-200"}`}>
                  <span data-accent={g.id} className="nav-chip"><Icon name={g.icon} /></span>
                  {g.label}
                  <Icon name="chevron" className={`h-3.5 w-3.5 text-slate-500 transition-transform ${isOpen ? "-rotate-90" : "rotate-90"}`} />
                </button>
                {isOpen && (
                  <div className="dm absolute left-0 top-full z-40 mt-1 min-w-[14rem] rounded-lg border bg-white p-1 shadow-xl">
                    {g.items.map((i) => (
                      <NavLink key={i.to} to={i.to} className={item} onClick={() => setOpenId(null)}>{i.label}</NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      )}

      <div className="ml-auto flex flex-wrap items-center gap-2 text-sm">
        {!pending && (
          <button type="button" onClick={onSearch}
            className="flex items-center gap-2 rounded border border-slate-700 px-3 py-1.5 text-slate-400 hover:bg-slate-800">
            <Icon name="search" /><span>Buscar…</span>
            <kbd className="rounded border border-slate-600 px-1 text-[10px]">Ctrl K</kbd>
          </button>
        )}
        <NavLink to="/cuenta" className={top}><Icon name="user" />{user.fullName} ({user.role})</NavLink>
        <ThemeToggle className="py-1.5" />
        <button type="button" onClick={onSwitch} title="Volver al menú lateral"
          className="rounded border border-slate-600 px-3 py-1.5 hover:bg-slate-800">Menú lateral</button>
        <button type="button" onClick={onLogout} className="rounded border border-slate-600 px-3 py-1.5 hover:bg-slate-800">
          Cerrar sesión
        </button>
      </div>
    </header>
  );
}
