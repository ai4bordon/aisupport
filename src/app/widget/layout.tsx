import "@/app/styles/tokens.css";
import type { ReactNode } from "react";

/**
 * Корневая разметка виджета.
 *
 * Next.js требует корневой layout для любой страницы. Файл лежит в
 * каталоге виджета, а не в `src/app/layout.tsx`: общий `src/app` — не мой
 * каталог. Если Next потребует layout строго в корне `src/app`, этот файл
 * переносится exec'ом (см. отчёт среза).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
