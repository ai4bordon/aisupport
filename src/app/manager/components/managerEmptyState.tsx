/**
 * Пустое состояние раздела кабинета: данных нет, и это не ошибка.
 *
 * Пропсы:
 * - `title` — заголовок состояния;
 * - `description` — пояснение, что именно пусто и что будет дальше.
 *
 * Состояние объявлено как `status` для assistive-технологий.
 */
export function ManagerEmptyState({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="sl-m-empty" role="status">
      <p className="sl-m-empty__title">{title}</p>
      {description ? <p className="sl-m-empty__description">{description}</p> : null}
    </div>
  );
}
