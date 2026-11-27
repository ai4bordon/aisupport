import Image from "next/image";

import logo from "./softline-logo.png";

/**
 * Фирменная шапка экрана демо.
 *
 * Логотип — утверждённый вариант «Софтлайн Решения» из пакета заказчика
 * (R26). Охранное поле вокруг логотипа задаётся в `styles.css` и не меньше
 * высоты самого логотипа.
 */
export function BrandHeader() {
  return (
    <header className="sl-start__header">
      <div className="sl-start__brand">
        <Image
          src={logo}
          alt="Софтлайн Решения"
          width={2000}
          height={442}
          priority
          className="sl-start__logo"
        />
      </div>
      <div>
        <h1 className="sl-start__title">Демонстрационный стенд ИИ-агента поддержки</h1>
        <p className="sl-start__subtitle">
          Веб-чат, канал MAX и кабинет — на одном экране
        </p>
      </div>
      <div className="sl-start__header-spacer" />
      <span className="sl-start__badge">Монтаж продукта</span>
    </header>
  );
}
