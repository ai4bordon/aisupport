import "@/app/styles/tokens.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Корневая разметка приложения.
 *
 * Next.js требует корневой layout для любой страницы, и он лежит строго в
 * `src/app`. Общие токены фирменного стиля подключаются здесь, чтобы
 * страницы не импортировали их по раз (`src/app/access/page.tsx`,
 * `src/app/widget/page.tsx`).
 */

export const metadata: Metadata = {
  title: "Софтлайн Решения — ИИ-агент поддержки",
  description: "Демонстрационный стенд ИИ-агента поддержки.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
