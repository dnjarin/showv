export default function DraftBanner({ what = "trabajo", onDiscard, onKeep }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-amber-900">
      <span>Se recuperó un {what} que quedó sin terminar. Revísalo antes de continuar.</span>
      <span className="space-x-4">
        <button type="button" className="underline" onClick={onKeep}>Continuar</button>
        <button type="button" className="underline" onClick={onDiscard}>Descartar</button>
      </span>
    </div>
  );
}
