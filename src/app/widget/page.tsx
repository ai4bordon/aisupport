import "./widget.css";
import { Chat } from "./chat";

/**
 * Минимальный веб-виджет чата для ручной проверки.
 *
 * Демо-данные синтетические: реальных персональных данных и токенов в
 * виджете нет.
 */
export default function WidgetPage() {
  return (
    <main className="widget">
      <Chat />
    </main>
  );
}
