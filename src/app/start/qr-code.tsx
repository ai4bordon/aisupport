import { buildQrMatrix } from "./qr-matrix";

/**
 * QR-код на публичную ссылку бота MAX.
 *
 * Код строится на месте, без внешнего сервиса и без ключей: ссылка на бота
 * не уходит третьим лицам. Рисуется как SVG — он чёткий на любом экране и
 * не требует отдельного файла-картинки.
 */
export function QrCode({ value, size = 168 }: { value: string; size?: number }) {
  const matrix = buildQrMatrix(value);
  const quiet = 2;

  const rectangles: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.modules[row * matrix.size + col]) {
        col += 1;
        continue;
      }
      let width = 1;
      while (col + width < matrix.size && matrix.modules[row * matrix.size + col + width]) {
        width += 1;
      }
      rectangles.push(
        `M${col + quiet} ${row + quiet}h${width}v1h-${width}z`,
      );
      col += width;
    }
  }

  const viewBox = matrix.size + quiet * 2;

  return (
    <svg
      className="sl-start__qr-svg"
      viewBox={`0 0 ${viewBox} ${viewBox}`}
      width={size}
      height={size}
      role="img"
      aria-label={`QR-код со ссылкой на бота ${value}`}
      shapeRendering="crispEdges"
    >
      <rect width={viewBox} height={viewBox} fill="var(--sl-surface)" />
      <path d={rectangles.join("")} fill="var(--sl-text)" />
    </svg>
  );
}
