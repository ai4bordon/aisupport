import type { Metadata } from "next";
import Image from "next/image";
import logo from "./softline-logo.png";
import icon from "./icon.png";
import { AccessForm } from "./access-form";
import "./styles.css";

/**
 * Путь к статическому изображению.
 *
 * В сборке Next импорт даёт объект `StaticImageData` с полем `src`, а в
 * тестах сборщик отдаёт готовый URL-строку.
 */
function assetSrc(asset: string | { src: string }): string {
  return typeof asset === "string" ? asset : asset.src;
}

export const metadata: Metadata = {
  title: "Доступ к демонстрационному стенду — Софтлайн Решения",
  description: "Страница ввода кода доступа к демонстрационному стенду ИИ-агента поддержки.",
  // Favicon — утверждённый вариант логотипа «Софтлайн Решения + SOFL» (R26).
  icons: { icon: assetSrc(icon) },
};

/**
 * Страница ввода кода доступа к стенду.
 *
 * Форма живёт в клиентском компоненте `access-form.tsx`: она отправляет код
 * через `fetch` JSON-ом и показывает результат. Код доступа в разметку
 * страницы не попадает — ни в HTML, ни в метаданные.
 */
export default function AccessPage() {
  return (
    <main className="sl-access">
      <div className="sl-access__card">
        <div className="sl-access__brand">
          <Image
            src={logo}
            alt="Софтлайн Решения"
            width={240}
            height={53}
            priority
            className="sl-access__logo"
          />
        </div>

        <h1 className="sl-access__title">Доступ к демонстрационному стенду</h1>
        <p className="sl-access__lead">
          Введите код доступа из описания продукта. Код проверяется на сервере и не сохраняется в браузере.
        </p>

        <AccessForm />
      </div>
    </main>
  );
}
