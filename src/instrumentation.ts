/**
 * Инициализация процесса при старте.
 *
 * Здесь выбирается провайдер эмбеддингов: при наличии ключа — живой
 * (вектор запроса и вектор чанка строятся одной моделью), без ключа —
 * детерминированная заглушка.
 *
 * Раньше провайдер всегда оставался заглушкой, а чанки в базе лежали с живыми
 * векторами: векторное сравнение было бессмысленным, и поиск по смыслу не
 * работал вовсе.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  const { initEmbeddingProvider } = await import("@/modules/knowledge");
  const provider = initEmbeddingProvider();
  console.log(
    `[boot] провайдер эмбеддингов: ${provider.model}`,
  );
}
