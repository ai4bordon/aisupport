import type { ReactNode } from "react";

/**
 * Состояние ошибки раздела кабинета.
 *
 * Пропсы:
 * - `title` — что сломалось;
 * - `description` — понятное объяснение и что делать дальше;
 * - `action` — необязательное действие (например, кнопка «Повторить»).
 *
 * Состояние объявлено как `alert`: об ошибке сообщаем сразу, а не молча.
 */
export function ManagerErrorState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="sl-m-error" role="alert">
      <p className="sl-m-error__title">{title}</p>
      {description ? <p className="sl-m-error__description">{description}</p> : null}
      {action ? <div className="sl-m-error__action">{action}</div> : null}
    </div>
  );
}
