/**
 * Тип статического импорта PNG в кабинете менеджера.
 *
 * Next.js генерирует `next-env.d.ts` с той же декларацией `*.png`, но файл
 * появляется только после сборки, а проверка типов (`npm run typecheck`)
 * идёт до неё. Декларация в этом каталоге нужна, чтобы типы импорта
 * логотипа были известны без сборки.
 *
 * В сборке Next импорт даёт объект `StaticImageData` с полем `src`, а в
 * тестах сборщик отдаёт готовый URL-строку, поэтому тип — объединение.
 */
declare module "*.png" {
  const content:
    | string
    | {
        src: string;
        height: number;
        width: number;
        blurDataURL?: string;
      };
  export default content;
}
