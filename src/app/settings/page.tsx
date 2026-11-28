import type { Metadata } from "next";
import Image from "next/image";
import { cookies } from "next/headers";
import logo from "./softline-logo.png";
import icon from "./icon.png";
import "./styles.css";
import {
  describeCapabilities,
  defaultSystemPrompt,
  listAuditEntries,
  listTestSessions,
  readCurrentSettings,
  readShadowMode,
  type CapabilityDescriptor,
} from "@/modules/agent-settings";
import { getTenantId } from "@/db/tenant";
import { ACCESS_COOKIE_NAME, readAccessSession } from "@/modules/access";
import { SettingsForm } from "./form";

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
  title: "Настройки агента — Софтлайн Решения",
  description:
    "Кабинет менеджера: настройки агента, песочница, история тестовых сессий и аудит изменений.",
  // Favicon — утверждённый вариант логотипа «Софтлайн Решения + SOFL» (R26).
  icons: { icon: assetSrc(icon) },
};

/**
 * Кабинет менеджера: вкладка «Агент» (бриф §8).
 *
 * Барьер кабинера — та же подписанная cookie доступа `support_access`, что и в
 * остальных маршрутах менеджера: без действующей cookie страница закрыта
 * (docs/api-contract.md §11.1).
 *
 * Форма собирается из реестра возможностей, а не из ручного списка полей:
 * состояние элемента управления в интерфейсе и в API не может разойтись.
 */
export default async function SettingsPage() {
  const cookieHeader = (await cookies()).get(ACCESS_COOKIE_NAME)?.value;
  const session = readAccessSession(
    cookieHeader === undefined ? undefined : `${ACCESS_COOKIE_NAME}=${cookieHeader}`,
  );
  if (session === null) {
    return (
      <main className="sl-settings sl-settings--closed" data-status="401">
        <div className="sl-settings__card">
          <h1 className="sl-settings__title">Кабинет менеджера закрыт</h1>
          <p className="sl-settings__lead">
            Нужен код доступа. Без действующей cookie страница настроек
            недоступна.
          </p>
        </div>
      </main>
    );
  }

  const tenantId = await getTenantId();
  const [settings, shadowMode, sessions, audit] = await Promise.all([
    readCurrentSettings(tenantId),
    readShadowMode(tenantId),
    listTestSessions(tenantId, 20),
    listAuditEntries(tenantId, 20),
  ]);

  const capabilities = describeCapabilities();
  const values: Record<string, string | number | boolean> = {
    provider: settings.provider,
    model: settings.model,
    endpoint: settings.endpoint,
    system_prompt: settings.systemPrompt,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    shadow_mode: shadowMode,
  };

  return (
    <main className="sl-settings">
      <header className="sl-settings__brand">
        <Image
          src={logo}
          alt="Софтлайн Решения"
          width={240}
          height={53}
          priority
          className="sl-settings__logo"
        />
        <h1 className="sl-settings__title">Настройки агента</h1>
        <p className="sl-settings__lead">
          Конфигурация версии {settings.version}. Изменение действует на следующий
          новый диалог: уже открытый диалог продолжает работать на прежней версии.
        </p>
      </header>

      <SettingsForm
        capabilities={capabilities}
        values={values}
        defaultPrompt={defaultSystemPrompt()}
      />

      <section className="sl-settings__section">
        <h2 className="sl-settings__heading">История тестирования</h2>
        {sessions.length === 0 ? (
          <p className="sl-settings__empty">Тестовых сессий пока нет.</p>
        ) : (
          <table className="sl-settings__table">
            <thead>
              <tr>
                <th scope="col">Версия</th>
                <th scope="col">Оценка</th>
                <th scope="col">Токены</th>
                <th scope="col">Затраты, ₽</th>
                <th scope="col">Модель</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.sessionId}>
                  <td>{session.settingsVersion}</td>
                  <td>{session.result.grade}</td>
                  <td>
                    {session.tokensIn} / {session.tokensOut}
                  </td>
                  <td>{session.costRub}</td>
                  <td>{String(session.settingsSnapshot["model"] ?? "")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="sl-settings__section">
        <h2 className="sl-settings__heading">Аудит изменений</h2>
        {audit.length === 0 ? (
          <p className="sl-settings__empty">Изменений пока не было.</p>
        ) : (
          <table className="sl-settings__table">
            <thead>
              <tr>
                <th scope="col">Кто</th>
                <th scope="col">Что</th>
                <th scope="col">До</th>
                <th scope="col">После</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.actor}</td>
                  <td>{entry.key ?? entry.entity}</td>
                  <td>{JSON.stringify(entry.before)}</td>
                  <td>{JSON.stringify(entry.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

/** Реестр возможностей — для тестов и для формы. */
export type { CapabilityDescriptor };
