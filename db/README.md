# Локальная база

Локальная среда разработки: PostgreSQL 16 + pgvector в Docker. Нужна для тестов, миграций и импорта фида. Продакшен-стенд владельца использует тот же образ, но разворачивается приложением Dokploy — этот README про локальную среду.

## Образ и требования

| Параметр | Значение |
|---|---|
| Образ | `pgvector/pgvector:pg16` (PostgreSQL 16, pgvector 0.8.7) |
| Порт | 5433 снаружи, 5432 внутри контейнера |
| Расширение | `vector` — создаётся миграцией `100_extensions.sql` |
| Пользователь | `postgres`, пароль задаётся при запуске |

## Запуск

```bash
docker run -d --name support-agent-pg \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=support_agent \
  -p 5433:5432 \
  pgvector/pgvector:pg16
```

Проверка готовности:

```bash
docker exec support-agent-pg pg_isready -U postgres
```

## База на срез

Каждый срез волны работает в своей базе, имя с суффиксом тикета — чтобы тяжёлые прогоны не мешали друг другу и данные не смешивались.

```bash
docker exec support-agent-pg createdb -U postgres support_agent_01
```

Имена баз по срезам: `support_agent_01`, `support_agent_02`, `support_agent_05`, `support_agent_11`, `support_agent_12`, `support_agent_13`.

## Подключение

Строка подключения передаётся только через переменную окружения, не в репозиторий и не в командную строку:

```bash
export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5433/support_agent_01'
```

Файл `.env.example` в корне содержит шаблон без значений.

## Миграции

Миграции лежат в `db/migrations/`, порядковые номера закреплены за срезами: ядро 100–999, каталог 1000–1999, база знаний 2000–2999, документы 3000–3999, доступ 4000–4999, каналы 5000–5999.

```bash
npm run db:migrate:up      # применить все миграции
npm run db:migrate:status  # состояние миграций
npm run db:migrate:down    # откатить последнюю
```

Миграция `100_extensions.sql` создаёт `pgcrypto` и `vector`. Расширение `vector` не создаётся автоматически при старте контейнера — без миграции `100` векторный поиск не работает.

Проверка после миграций:

```bash
docker exec support-agent-pg psql -U postgres -d support_agent_01 \
  -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

## Сид и импорт фида

```bash
npm run db:seed
npm run import:feed -- --source-url https://store.softline.ru/feeds/Softline.yml.gz \
  --fallback "Агент поддержки-20261126T080905Z-1-001/Агент поддержки/Mindbox.yml.gz.xml"
```

Импорт фида — тяжёлая операция: 136 040 позиций, чтение потоковое. Запускать её нельзя одновременно с обходом сайта базы знаний — на машине 4 vCPU и 8 ГБ.

## Очистка

```bash
docker rm -f support-agent-pg
```

Данные теряются вместе с контейнером; повторное развёртывание и миграции воспроизводят их за минуты.
