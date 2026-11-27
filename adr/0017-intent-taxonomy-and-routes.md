# Таксономия намерений и маршруты

Классификатор использует закрытый список из десяти классов маршрутизации: `greeting`, `self_info`, `company_info`, `howto`, `complaint`, `product_known`, `product_unknown`, `quote`, `terms`, `out_of_scope`. Класс записывается в трассу вместе с выбранной дорожкой. Классы не смешиваются: `greeting`/`self_info` идут в статический профиль агента; `company_info`/`howto`/`complaint` — в БЗ; `product_known`/`product_unknown`/`quote`/`terms` — в каталог, слоты, расчёт кодом и проверку полномочий; `out_of_scope` — в безопасную дорожку без выдуманного ответа и без подмены БЗ/каталога. Сомнение классификатора выбирает `out_of_scope`.

Это не заменяет девять аналитических категорий обращений из R20 и миграции 170: `price_of_product`, `configuration`, `vendor_availability`, `discounts`, `individual_entrepreneur`, `other_purchase`, `government_procurement`, `quote_document`, `follow_up`. Категория описывает частотный тип обращения и пробелы БЗ, а класс выбирает маршрут; связь не 1:1 и фиксируется для аналитики следующим маппингом:

| Категория обращения | Возможные классы маршрутизации |
|---|---|
| `price_of_product` | `product_known`, `quote` |
| `configuration` | `product_known`, `product_unknown` |
| `vendor_availability` | `company_info`, `product_known` |
| `discounts` | `terms`, `out_of_scope` |
| `individual_entrepreneur` | `terms`, `out_of_scope` |
| `other_purchase` | `product_known`, `product_unknown`, `terms` |
| `government_procurement` | `terms`, `out_of_scope` |
| `quote_document` | `quote` |
| `follow_up` | `company_info`, `howto`, `product_known`, `out_of_scope` |

В клиентском тексте веб-чата и MAX URL не отправляются: ни ссылки на `docs.softline.com`, ни ссылки на карточки `store.softline.ru`. `answer.sources` сохраняет источники ответа, а трасса и кабинет менеджера используют их для проверки, цитирования и разбора эскалации. Валидатор по-прежнему сверяет утверждения с текстом источника; отсутствие URL в тексте не отключает проверку. Если клиенту нужна ссылка, он запрашивает её, а менеджер может предоставить её отдельно.