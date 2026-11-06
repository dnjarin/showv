import { useEffect, useMemo, useState } from "react";
import { clearAllDrafts } from "../hooks/useDraft";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../store/authStore";
import { useSessionGuard } from "../hooks/useSessionGuard";
import logoA from "../assets/brand/logo-a.png";
import logoB from "../assets/brand/logo-b.png";
import Icon from "./Icon";
import CommandPalette from "./CommandPalette";
import TopNav from "./TopNav";
import ThemeToggle from "./ThemeToggle";
import RateWatcher from "./RateWatcher";
import { navFor } from "../utils/nav";

/** true cuando la pantalla es de celular/tableta angosta (menos de 768 px). */
function useIsMobile() {
  const q = "(max-width: 767px)";
  const [m, setM] = useState(() => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false));
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return m;
}

const link = ({ isActive }) =>
  `block rounded px-3 py-1.5 text-sm ${isActive ? "bg-slate-700 font-medium text-white" : "text-slate-300 hover:bg-slate-800"}`;
const topLink = ({ isActive }) =>
  `flex items-center gap-2 rounded px-3 py-2 text-sm font-medium ${isActive ? "bg-slate-700 text-white" : "text-slate-200 hover:bg-slate-800"}`;

export default function Layout() {
  useSessionGuard();
  const { user, logout: rawLogout } = useAuth();
  // Cerrar sesión a propósito descarta los borradores; un cierre por inactividad los conserva
  const logout = () => { clearAllDrafts(); return rawLogout(); };
  const pending = user.mustChangePassword;
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  // En celular el menú es un cajón que se abre con ☰ y se cierra al navegar
  const [drawer, setDrawer] = useState(false);
  useEffect(() => { setDrawer(false); }, [pathname]);
  useEffect(() => {
    if (!isMobile) setDrawer(false);
  }, [isMobile]);
  const groups = useMemo(() => navFor(user.role), [user.role]);
  const accent = (groups.find((g) =>
    g.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`)))?.id) ?? "inicio";
  const activeId = groups.find((g) =>
    g.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`)))?.id;

  // Grupos abiertos: el de la página actual se abre solo; el resto se recuerda.
  const [openIds, setOpenIds] = useState(() => {
    try { return JSON.parse(localStorage.getItem("nav-open") || "[]"); } catch { return []; }
  });
  useEffect(() => {
    if (activeId) setOpenIds((o) => (o.includes(activeId) ? o : [...o, activeId]));
  }, [activeId]);
  useEffect(() => {
    try { localStorage.setItem("nav-open", JSON.stringify(openIds)); } catch { /* sin almacenamiento */ }
  }, [openIds]);
  const toggleGroup = (id) => setOpenIds((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));

  // Modo de menú: lateral (por defecto) o superior
  const [navMode, setNavMode] = useState(() => {
    try { return localStorage.getItem("nav-mode") === "top" ? "top" : "side"; } catch { return "side"; }
  });
  const switchMode = (m) => {
    setNavMode(m);
    try { localStorage.setItem("nav-mode", m); } catch { /* sin almacenamiento */ }
  };

  // Buscador rápido (Ctrl+K)
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Barra lateral: fija u oculta (aparece al acercar el mouse al borde izquierdo).
  const [pinned, setPinned] = useState(() => {
    try { return localStorage.getItem("sidebar") !== "hidden"; } catch { return true; }
  });
  const [hover, setHover] = useState(false);
  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    setHover(false);
    try { localStorage.setItem("sidebar", next ? "shown" : "hidden"); } catch { /* sin almacenamiento */ }
  };
  const open = isMobile ? drawer : (pinned || hover);

  if (navMode === "top" && !isMobile) {
    return (
      <div data-accent={accent} className="app-shell relative flex h-dvh flex-col overflow-hidden bg-slate-50">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 flex items-center justify-center">
          <img src={logoA} alt="" className="w-[26rem] max-w-[60%] opacity-[0.05]" />
        </div>
        <TopNav groups={groups} activeId={activeId} pending={pending} user={user}
          onSearch={() => setPaletteOpen(true)} onLogout={logout} onSwitch={() => switchMode("side")} />
        <main className="app-main relative z-10 min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
        <CommandPalette role={user.role} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
        {!pending && <RateWatcher user={user} />}
      </div>
    );
  }

  return (
    <div data-accent={accent} className="app-shell relative flex h-dvh overflow-hidden bg-slate-50">
      {/* Marca de agua (logo A, versión clara) */}
      <div aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 right-0 z-0 flex items-center justify-center ${pinned && !isMobile ? "left-60" : "left-0"}`}>
        <img src={logoA} alt="" className="w-[26rem] max-w-[60%] opacity-[0.05]" />
      </div>
      {!pinned && !isMobile && (
        <div className="absolute inset-y-0 left-0 z-20 w-3" onMouseEnter={() => setHover(true)} />
      )}
      {isMobile && drawer && (
        <div className="fixed inset-0 z-40 bg-black/50" onClick={() => setDrawer(false)} aria-hidden="true" />
      )}
      <aside
        onMouseLeave={() => !pinned && !isMobile && setHover(false)}
        className={`app-side flex shrink-0 flex-col gap-1 overflow-y-auto bg-slate-900 p-4 text-slate-100 transition-transform duration-200 ${
          isMobile ? "fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] shadow-2xl"
            : `w-60 ${pinned ? "" : "absolute inset-y-0 left-0 z-30 shadow-2xl"}`} ${open ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="mb-4 flex items-start justify-between font-semibold">
          <div className="flex flex-col items-start gap-1">
            <img src={logoB} alt="TEKADDON" className="h-20 w-auto" />
            <span className="text-xs font-medium text-slate-400">Inventario y Facturación</span>
          </div>
          {isMobile ? (
            <button onClick={() => setDrawer(false)} aria-label="Cerrar menú"
              className="rounded px-2 py-1 text-lg leading-none text-slate-300 hover:bg-slate-700">✕</button>
          ) : (
            <button onClick={togglePin} title={pinned ? "Ocultar barra automáticamente" : "Fijar barra"}
              className="rounded px-1 text-slate-300 hover:bg-slate-700">
              {pinned ? "«" : "📌"}
            </button>
          )}
        </div>

        {!pending && (
          <>
            <button type="button" onClick={() => { setDrawer(false); setPaletteOpen(true); }}
              className="mb-2 flex w-full items-center gap-2 rounded border border-slate-700 px-3 py-1.5 text-left text-sm text-slate-400 hover:bg-slate-800">
              <Icon name="search" />
              <span className="flex-1">Buscar…</span>
              <kbd className="hidden rounded border border-slate-600 px-1 text-[10px] md:inline">Ctrl K</kbd>
            </button>

            <NavLink to="/" end className={topLink}><Icon name="home" />Inicio</NavLink>

            {groups.map((g) => {
              const isOpen = openIds.includes(g.id);
              return (
                <div key={g.id}>
                  <button type="button" onClick={() => toggleGroup(g.id)} aria-expanded={isOpen}
                    className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm font-medium hover:bg-slate-800 ${
                      g.id === activeId ? "text-white" : "text-slate-200"}`}>
                    <span data-accent={g.id} className="nav-chip"><Icon name={g.icon} /></span>
                    <span className="flex-1">{g.label}</span>
                    {!isOpen && g.id === activeId && <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />}
                    <Icon name="chevron" className={`h-3.5 w-3.5 text-slate-500 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  </button>
                  {isOpen && (
                    <div className="mb-1 ml-5 space-y-0.5 border-l border-slate-700 pl-2">
                      {g.items.map((i) => (
                        <NavLink key={i.to} to={i.to} className={link}>{i.label}</NavLink>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}
        <NavLink to="/cuenta" className={topLink}><Icon name="user" />Mi cuenta</NavLink>

        <div className="mt-auto pt-6 text-sm text-slate-400">
          {user.fullName} ({user.role})
        </div>
        <ThemeToggle className="w-full" />
        {!isMobile && (
          <button onClick={() => switchMode("top")}
            className="w-full rounded border border-slate-600 px-3 py-1 text-left text-sm text-slate-300 hover:bg-slate-800">
            Menú superior
          </button>
        )}
        <button onClick={logout}
          className="w-full rounded border border-slate-600 px-3 py-1 text-left text-sm">
          Cerrar sesión
        </button>
      </aside>

      <main className="app-main relative z-10 flex min-w-0 flex-1 flex-col overflow-y-auto">
        {isMobile && (
          <header className="app-top sticky top-0 z-30 flex shrink-0 items-center gap-2 bg-slate-900 px-3 py-2 text-slate-100">
            <button type="button" onClick={() => setDrawer(true)} aria-label="Abrir menú" aria-expanded={drawer}
              className="rounded px-2 py-1 text-xl leading-none hover:bg-slate-800">☰</button>
            <img src={logoB} alt="TEKADDON" className="h-8 w-auto" />
            <span className="flex-1" />
            {!pending && (
              <button type="button" onClick={() => setPaletteOpen(true)} aria-label="Buscar"
                className="rounded px-2 py-1.5 hover:bg-slate-800"><Icon name="search" /></button>
            )}
          </header>
        )}
        <div className="min-w-0 flex-1 p-3 sm:p-4 md:p-6">
        {!pinned && !isMobile && (
          <button onClick={togglePin} title="Fijar barra lateral"
            className="mb-2 rounded border bg-white px-2 py-1 text-sm text-slate-600">☰ Menú</button>
        )}
        <Outlet />
        </div>
      </main>
      <CommandPalette role={user.role} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {!pending && <RateWatcher user={user} />}
    </div>
  );
}