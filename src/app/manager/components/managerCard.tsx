import type { ReactNode } from "react";

/**
 * Карточка оболочки кабинета — базовый контейнер для содержимого раздела.
 *
 * Пропсы:
 * - `title` — заголовок карточки (необязателен, если у карточки свой `aria-label`);
 * - `description` — пояснение под заголовком;
 * - `footer` — нижний блок карточки (кнопки, ссылки);
 * - `id` — якорь карточки (нужен для перехода по навигации);
 * - `children` — содержимое карточки.
 *
 * Разметка семантическая: `<section>` с заголовком `<h2>`, чтобы навигация
 * по разделам работала с клавиатуры и читалась скринридером.
 */
export function ManagerCard({
  title,
  description,
  footer,
  id,
  children,
}: {
  title?: string;
  description?: string;
  footer?: ReactNode;
  id?: string;
  children?: ReactNode;
}) {
  // `aria-labelledby` ставится только когда заголовок есть: ссылка на
  // несуществующий id ломает навигацию скринридера.
  const titleId = title && id ? `${id}-title` : undefined;

  return (
    <section className="sl-m-card" id={id} aria-labelledby={titleId}>
      {title ? (
        <h2 className="sl-m-card__title" id={titleId}>
          {title}
        </h2>
      ) : null}
      {description ? <p className="sl-m-card__description">{description}</p> : null}
      {children ? <div className="sl-m-card__body">{children}</div> : null}
      {footer ? <div className="sl-m-card__footer">{footer}</div> : null}
    </section>
  );
}
