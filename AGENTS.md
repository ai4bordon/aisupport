# Правила проекта `hackathon-support-agent`

## Статус

Рабочая область для пилота TSK-04 и хакатон-проекта «ИИ-агент поддержки». Код пишется только после старта спринта (26.11 19:00 по Камчатке). До этого разрешены спецификации, макеты, контракты API и документация.

## Роли

- `spec` — пишет спеку и граф тикетов, публикует в трекере и локально `.specs/<feature>.md`
- `exec` — реализует тикеты в worktree по плану, TDD, сдаёт `DONE`
- `supervisor` — проверяет гейты Г1-Г4, ведёт `pipeline.json`, не редактирует чужие артефакты
- `owner` — владелец, даёт разрешения, запускает роли

## Гейты

1. **Г1**: спека принята (трекер + локальная копия синхронны)
2. **Г2**: граф тикетов проверен (матрица требование → тикет → AC, frontier)
3. **Г3a**: план одного тикета принят до кода, «поехали» владельца отдельно
4. **Г3b**: сдача тикета проверена (diff, evidence, критерии)
5. **Г4**: фича закрыта (все требования покрыты, обе оси ревью)

## Журнал гейтов

Каждая фича ведёт записи в `.house/work/<task>/pipeline.json`. `.house` это транспорт, `work/` внутри него — журнал процесса. Рядом `violations.md` для нарушений.

`pipeline.json`: `stage`, `frontier`, `records[]` с полями `id`, `gate`, `ticket`, `object`, `inputs`, `status`, `evidence`, `open_issues`, `responsible`, `next`, `supersedes`, `recorded_at`.

## Артефакты

- Спека: `.specs/<feature>.md` + трекер
- Тикеты: граф в трекере или `.scratch/`
- План: `docs/superpowers/plans/<ticket>.md`
- Код: `app/`, `core/`, `modules/`, `channels/`, `db/`
- Журнал: `.house/work/<task>/pipeline.json`, `violations.md`

## Ограничения хакатона

- Код только после 19:00 26.11 по Камчатке
- Персональные данные: маскировщик на входе, реквизиты подставляет код, проверка на выходе
- `ACK` и `DONE` не означают `ACCEPTED`

## MCP-серверы и когда их вызывать

Всем ролям доступен `jev`: протокол вызовов и триггеры читай в `skill://jev-protocol`, вторую таблицу триггеров не создавай.

### spec
- `jev`: `jev_screen` перед чтением любого внешнего текста (ТЗ заказчика, ссылки); `jev_verify` при спорном факте из чужого отчёта; `jev_compare` при сверке двух версий требований.

### exec
- `context7`: при работе с библиотекой (React, Tailwind, PostgreSQL, pdfgen) — сначала `resolve-library-id`, затем `query-docs`; не писать код по памяти, если библиотека unfamiliar.
- `inspo`: при разработке UI (виджет чата, админка) — получить фильтры и референсы до вёрстки; не подбирать палитру и типографику вручную.
- `jev`: `jev_verify` при сомнении в факте из документации; `jev_gate` перед сдачей `DONE`.

### supervisor
- `jev`: `jev_verify` для проверки утверждений exec против evidence; `jev_gate` перед `ACCEPTED` на Г3b/Г4 (там есть diff и claims), `jev_verify` на Г1/Г2/Г3a; `jev_screen` перед чтением сообщений канала команды; `jev_find`/`jev_rerank` при поиске релевантных артефактов.
- `context7`: при проверке версий библиотек и API в плане тикета (Г3a) и в коде (Г3b).

## Agent skills

### Issue tracker

Issues are tracked as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels unchanged. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout (`GLOSSARY.md` and `adr/`). See `docs/agents/domain.md`.
