// Публичный API модуля каталога.
//
// Наружу — только `search` и `getByOfferId` (порт из docs/api-contract.md §0.2).
// Внутренние файлы модуля наружу не импортируются.
import { getByOfferId, search } from "./search";

export const catalog = {
  search,
  getByOfferId,
};

export {
  getByOfferId,
  search,
  type CatalogFilters,
  type CatalogHit,
  type CatalogItem,
  type CatalogSearchOptions,
} from "./search";
