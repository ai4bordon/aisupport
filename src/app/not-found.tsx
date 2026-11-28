import Link from "next/link";
import "./not-found.css";

/**
 * Страница «страница не найдена» на русском.
 *
 * Раньше Next.js отдавал для неизвестного адреса английский текст «This
 * page could not be found» без единой ссылки: из кабинета или со стенда
 * было некуда пойти дальше. Страница говорит по-русски и ведёт обратно.
 */
export default function NotFound() {
  return (
    <main className="sl-nf">
      <h1 className="sl-nf__title">Страница не найдена</h1>
      <p className="sl-nf__lead">
        Такого адреса на стенде нет. Возможно, ссылка устарела или в адресе
        опечатка.
      </p>
      <nav className="sl-nf__links" aria-label="Куда перейти">
        <Link className="sl-nf__button sl-nf__button--primary" href="/start">
          На стенд
        </Link>
        <Link className="sl-nf__button" href="/manager">
          В кабинет менеджера
        </Link>
      </nav>
    </main>
  );
}
