/**
 * Состояние загрузки раздела кабинета.
 *
 * Пропсы:
 * - `label` — что именно грузится (например, «Загружаем очередь»).
 *
 * Состояние объявлено как `status` и сопровождается текстом: экран не молчит,
 * пока данных нет.
 */
export function ManagerLoading({ label }: { label: string }) {
  return (
    <div className="sl-m-loading" role="status" aria-live="polite">
      <span className="sl-m-loading__spinner" aria-hidden="true" />
      <span className="sl-m-loading__label">{label}</span>
    </div>
  );
}
