import { Component } from "react";

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Error de interfaz:", error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="grid min-h-screen place-items-center bg-slate-100 p-6">
        <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow">
          <h1 className="mb-2 text-xl font-semibold text-red-700">Ocurrió un error en esta pantalla</h1>
          <p className="mb-3 text-sm text-slate-600">
            Tus datos están a salvo. Puedes volver al inicio y seguir trabajando. Si se repite, anota este mensaje:
          </p>
          <pre className="mb-4 max-h-40 overflow-auto rounded bg-slate-100 p-3 text-xs">
            {String(this.state.error?.message ?? this.state.error)}
          </pre>
          <button
            onClick={() => { window.location.hash = "#/"; window.location.reload(); }}
            className="rounded bg-slate-900 px-4 py-2 text-white">
            Volver al inicio
          </button>
        </div>
      </div>
    );
  }
}