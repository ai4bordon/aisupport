import type { Metadata } from "next";
import { KnowledgeClient } from "./knowledge-client";
import "./styles.css";

export const metadata: Metadata = {
  title: "База знаний — кабинет менеджера",
  description:
    "Загруженные документы, черновики статей, загрузка файла и одобрение материала.",
};

/**
 * Страница раздела кабинета менеджера «База знаний».
 *
 * Раздел работает с двумя разными сущностями: загруженными документами и
 * черновиками статей. Их состояния и маршруты одобрения разные
 * (ADR-0005), поэтому список общий только для показа, а решение по
 * каждому материалу принимается своим маршрутом.
 */
export default function ManagerKnowledgePage() {
  return <KnowledgeClient />;
}
