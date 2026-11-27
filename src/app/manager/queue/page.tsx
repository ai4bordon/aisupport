import type { Metadata } from "next";
import { QueueClient } from "./queue-client";
import "./styles.css";

export const metadata: Metadata = {
  title: "Очередь обращений — кабинет менеджера",
  description: "Очередь эскалаций, трасса обращения и журнал обещаний.",
};

/** Страница раздела кабинета менеджера «Очередь». */
export default function ManagerQueuePage() {
  return <QueueClient />;
}
