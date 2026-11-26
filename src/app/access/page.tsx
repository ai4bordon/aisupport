import type { Metadata } from "next";
import Image from "next/image";
import logo from "./softline-logo.png";
import icon from "./icon.png";
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

        <form className="sl-access__form" action="/api/access" method="post">
          <label className="sl-access__label" htmlFor="sl-access-code">
            Код доступа
          </label>
          <input
            className="sl-access__input"
            id="sl-access-code"
            name="code"
            type="password"
            autoComplete="off"
            required
          />
          <button className="sl-access__button" type="submit">
            Войти
          </button>
        </form>

        <p className="sl-access__note" role="status">
          Если код не принят, обновите страницу и попробуйте снова. Лимиты стенда общие для всех
          посетителей и не обнуляются при повторном входе.
        </p>
      </div>
    </main>
  );
}
