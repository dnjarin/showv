import Barcode from "./Barcode";
import { formatMoney } from "../../utils/money";
import { encode } from "../../utils/barcode";

/** Precios que lleva la etiqueta (IVA incluido si se pide) en USD y Bs. a la tasa del día. */
export function labelPrices(p, ctx, includeTax) {
  const taxBp = includeTax ? (ctx?.taxRates?.find((t) => t.id === p.taxRateId)?.rateBp ?? 0) : 0;
  const base = p.priceMinor + Math.round((p.priceMinor * taxBp) / 10000);
  const rate = ctx?.usdRateMicro || null;
  if (p.priceCurrency === "USD") {
    return { usd: base, ves: rate ? Math.round((base * rate) / 1_000_000) : null };
  }
  return { ves: base, usd: rate ? Math.round((base * 1_000_000) / rate) : null };
}

const clamp2 = (n) => ({
  display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: n, overflow: "hidden",
});

/** Una etiqueta de w × h milímetros. */
export default function LabelView({ p, cfg, ctx, w, h }) {
  const code = p.barcode || p.sku;
  const s = Math.max(0.6, Math.min(2, Math.min(w / 50, h / 30)));
  const fs = (k) => `${(k * s).toFixed(2)}mm`;
  const show = cfg.show;
  const pr = labelPrices(p, ctx, cfg.includeTax);
  const hasPrice = show.usd || show.ves;
  const enc = encode(code);
  const compact = h < 24;

  return (
    <div style={{
      width: `${w}mm`, height: `${h}mm`, boxSizing: "border-box", padding: `${(1.2 * s).toFixed(2)}mm`,
      overflow: "hidden", display: "flex", flexDirection: "column", background: "#fff", color: "#000",
      fontFamily: "Arial, Helvetica, sans-serif", lineHeight: 1.1,
    }}>
      {show.biz && ctx?.businessName && (
        <div style={{ fontSize: fs(2), textTransform: "uppercase", textAlign: "center", letterSpacing: "0.1mm",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ctx.businessName}</div>
      )}
      {show.name && (
        <div style={{ fontSize: fs(2.8), fontWeight: 700, ...clamp2(compact ? 1 : 2) }}>{p.name}</div>
      )}
      <div style={{ flex: 1, minHeight: 0, padding: `${(0.6 * s).toFixed(2)}mm 0` }}>
        {enc ? <Barcode value={code} /> : <div style={{ fontSize: fs(2.4) }}>Código no válido</div>}
      </div>
      {show.code && (
        <div style={{ fontSize: fs(2.4), textAlign: "center", fontFamily: "monospace", letterSpacing: "0.2mm" }}>{code}</div>
      )}
      {(show.sku || hasPrice) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: "1mm", marginTop: "0.4mm" }}>
          <div style={{ fontSize: fs(2.2), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {show.sku ? p.sku : ""}
          </div>
          {hasPrice && (
            <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
              {show.usd && <div style={{ fontSize: fs(4.2), fontWeight: 700 }}>{pr.usd != null ? formatMoney(pr.usd, "USD") : "—"}</div>}
              {show.ves && <div style={{ fontSize: fs(show.usd ? 3 : 4.2), fontWeight: show.usd ? 400 : 700 }}>
                {pr.ves != null ? formatMoney(pr.ves, "VES") : "Sin tasa"}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
