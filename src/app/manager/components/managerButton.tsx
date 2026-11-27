import type { ReactNode } from "react";

/**
 * Кнопка оболочки кабинета.
 *
 * Пропсы:
 * - `variant` — вид кнопки: `primary` (главное действие) или `secondary` (обычное);
 * - `type` — тип кнопки в форме, по умолчанию `button`;
 * - `disabled` — кнопка выключена (например, действие ещё не реализовано);
 * - `children` — доступное имя кнопки.
 *
 * Кнопка без действия намеренно остаётся `disabled` и подписана: элемент не
 * имитирует работу, а честно говорит, что раздел в работе.
 */
export function ManagerButton({
  variant = "secondary",
  type = "button",
  disabled = false,
  children,
}: {
  variant?: "primary" | "secondary";
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      className={`sl-m-button sl-m-button--${variant}`}
      type={type}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
