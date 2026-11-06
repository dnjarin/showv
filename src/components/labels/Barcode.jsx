import { useMemo } from "react";
import { encode } from "../../utils/barcode";

/** Dibuja las barras de un código (EAN-13, EAN-8 o Code 128) como SVG que se estira al tamaño del contenedor. */
export default function Barcode({ value }) {
  const e = useMemo(() => encode(value), [value]);
  if (!e) return null;
  return (
    <svg viewBox={`0 0 ${e.modules} 1`} preserveAspectRatio="none" shapeRendering="crispEdges"
      style={{ width: "100%", height: "100%", display: "block" }} role="img" aria-label={`Código ${e.text}`}>
      <rect x="0" y="0" width={e.modules} height="1" fill="#fff" />
      {e.bars.map((b, i) => <rect key={i} x={b.x} y="0" width={b.w} height="1" fill="#000" />)}
    </svg>
  );
}
