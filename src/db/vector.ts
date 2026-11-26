/**
 * Работа с колонками типа `vector` (pgvector).
 *
 * Значение в базе — текстовое представление `[0.1,0.2,...]`. Мы всегда
 * передаём вектор строкой, поэтому регистрация типов в пуле не влияет на
 * запись, а чтение разбираем сами: результат может прийти и строкой, и
 * уже разобранным массивом.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => Number(value).toString()).join(",")}]`;
}

export function parseVector(value: string | number[] | null): number[] | null {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(Number);
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
}
