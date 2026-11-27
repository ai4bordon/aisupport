"use client";

import { useEffect, useState } from "react";
import {
  ManagerCard,
  ManagerEmptyState,
  ManagerErrorState,
  ManagerLoading,
  ManagerTabs,
  type ManagerTab,
} from "@/app/manager/components";

/**
 * Клиентская часть раздела кабинера «База знаний».
 *
 * Раздел показывает три вещи:
 * 1) загруженные менеджером документы и их состояние («на проверке»,
 *    «опубликован», «ошибка разбора»);
 * 2) черновики статей, ждущие решения менеджера;
 * 3) форму загрузки документа.
 *
 * Все состояния явные: загрузка, ошибка загрузки списка, пустой список и
 * ошибка операции (одобрение или загрузка). Ошибка операции не прячет
 * список: менеджер видит, что произошло, и может повторить действие.
 *
 * Одобрение документа и одобрение черновика идут разными маршрутами
 * (`/kb/documents/{id}/approve` и `/kb/drafts/{id}/approve`): это разные
 * сущности с разными переходами состояний (ADR-0005).
 */

/** Документ в том виде, в каком его отдаёт маршрут данных раздела. */
type KnowledgeDocument = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  parse_status: string;
  parse_error: string | null;
  chunks_count: number;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
};

/** Черновик статьи в том же виде. */
type KnowledgeDraft = {
  id: string;
  title: string;
  status: string;
  conversation_id: string | null;
  source_message_ids: string[];
  source_excerpt: string | null;
  owner: string | null;
  created_at: string;
  approved_by: string | null;
  reviewed_at: string | null;
  published_at: string | null;
};

/**
 * Полный черновик статьи — то, что приходит с маршрута черновика.
 *
 * Отдельный тип от `KnowledgeDraft`: в списке раздела полного текста нет,
 * он лежит в `body_md` и приходит только при открытии материала.
 */
type DraftDetail = {
  id: string;
  title: string;
  body_md: string;
  status: string;
  version: number;
  conversation_id: string | null;
  source_message_ids: string[];
  source_excerpt: string | null;
  owner: string | null;
  created_at: string;
  approved_by: string | null;
  reviewed_at: string | null;
  published_at: string | null;
};

/** Тело маршрута данных раздела. */
type KnowledgePayload = {
  documents: KnowledgeDocument[];
  drafts: KnowledgeDraft[];
};

/** Тело ответа маршрута: у успеха есть `status`, у ошибки — `error`. */
type ApiBody = {
  status?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

/** Состояние одной операции менеджера. */
type OperationState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string };

/** Вкладки раздела. */
type KnowledgeTab = "documents" | "drafts";

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  pending: "На проверке",
  published: "Опубликован",
  rejected: "Отклонён",
  error: "Ошибка разбора",
};

const DRAFT_STATUS_LABELS: Record<string, string> = {
  pending_review: "Ждёт решения",
  approved: "Одобрен",
  published: "Опубликован",
  rejected: "Отклонён",
  draft: "Черновик",
};

/** Даты раздела показываются в одном формате. */
const DATE_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Чтение тела ответа: ошибка разбора не должна ронять раздел. */
async function readJson(response: Response): Promise<ApiBody> {
  try {
    return (await response.json()) as ApiBody;
  } catch {
    return {};
  }
}

/**
 * Модалка черновика статьи.
 *
 * В списке раздела видны только заголовок и выдержка из источника: полный
 * текст материала менеджер читает здесь. Отдельный компонент, а не часть
 * клиента раздела: у модалки свой жизненный цикл (открытие, правка,
 * копирование, удаление) и свои состояния.
 */
function DraftModal({
  draft,
  saving,
  error,
  onClose,
  onSave,
  onCopy,
  onDelete,
}: {
  draft: DraftDetail;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (bodyMd: string) => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(draft.body_md);
  const [confirming, setConfirming] = useState(false);

  // Escape закрывает окно, но не в момент правки: закрытие посреди
  // несохранённой правки потеряло бы текст молча.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape" || editing) return;
      onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [editing, onClose]);

  return (
    <div
      className="kn-modal-backdrop"
      onClick={(event) => {
        // Клик по фону закрывает окно, клик по самому окну — нет.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="kn-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Черновик статьи «${draft.title}»`}
      >
        <header className="kn-modal-head">
          <div className="kn-modal-headings">
            <h2 className="kn-modal-title">{draft.title}</h2>
            <p className="kn-modal-meta">
              <span className="kn-item-status">
                {DRAFT_STATUS_LABELS[draft.status] ?? draft.status}
              </span>
              <span>Версия {draft.version}</span>
              <span>{DATE_FORMATTER.format(new Date(draft.created_at))}</span>
              {draft.owner ? <span>{draft.owner}</span> : null}
            </p>
          </div>
          <button
            type="button"
            className="sl-m-button"
            aria-label="Закрыть"
            onClick={onClose}
          >
            Закрыть
          </button>
        </header>

        {editing ? (
          <div className="kn-modal-edit">
            <label className="kn-label" htmlFor="kn-draft-body">
              Текст статьи
            </label>
            <textarea
              id="kn-draft-body"
              className="kn-editor"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
        ) : (
          <div className="kn-modal-body">{draft.body_md}</div>
        )}

        {error ? (
          <p className="kn-note kn-note--error" role="alert">
            {error}
          </p>
        ) : null}

        <footer className="kn-modal-foot">
          {editing ? (
            <>
              <button
                type="button"
                className="sl-m-button sl-m-button--primary"
                disabled={saving}
                onClick={() => onSave(text)}
              >
                {saving ? "Сохраняем…" : "Сохранить"}
              </button>
              <button
                type="button"
                className="sl-m-button"
                disabled={saving}
                onClick={() => {
                  setText(draft.body_md);
                  setEditing(false);
                }}
              >
                Отмена
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="sl-m-button sl-m-button--primary"
                onClick={() => setEditing(true)}
              >
                Изменить
              </button>
              <button
                type="button"
                className="sl-m-button"
                onClick={onCopy}
              >
                Копировать
              </button>
              {confirming ? (
                <button
                  type="button"
                  className="sl-m-button kn-button--danger"
                  disabled={saving}
                  onClick={onDelete}
                >
                  Подтвердить удаление
                </button>
              ) : (
                <button
                  type="button"
                  className="sl-m-button"
                  onClick={() => setConfirming(true)}
                >
                  Удалить
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

export function KnowledgeClient() {
  const [payload, setPayload] = useState<KnowledgePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("documents");
  const [operations, setOperations] = useState<Record<string, OperationState>>({});
  const [upload, setUpload] = useState<OperationState>({ kind: "idle" });
  const [file, setFile] = useState<File | null>(null);
  // Открытый черновик: его полный текст приходит с маршрута черновика.
  const [openDraft, setOpenDraft] = useState<DraftDetail | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaving, setDraftSaving] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      try {
        const response = await fetch("/api/manager/knowledge", {
          signal: controller.signal,
          credentials: "same-origin",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = (await response.json()) as KnowledgePayload;
        setPayload(data);
        setLoadError(null);
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setLoadError("Не удалось загрузить базу знаний");
      }
    }
    void load();
    return () => controller.abort();
  }, [attempt]);

  /** Повтор загрузки списка после неудачи. */
  function retry(): void {
    setLoadError(null);
    setAttempt((value) => value + 1);
  }

  /**
   * Открытие черновика: полный текст материала приходит с маршрута.
   *
   * В списке видны только заголовок и выдержка, поэтому текст запрашивается
   * отдельно и только в момент открытия.
   */
  async function openDraftModal(id: string): Promise<void> {
    setDraftError(null);
    try {
      const response = await fetch(`/api/manager/knowledge/draft/${id}`, {
        credentials: "same-origin",
      });
      const body = await readJson(response);
      if (!response.ok) {
        setDraftError(
          body.error?.message ?? "Не удалось открыть черновик статьи.",
        );
        return;
      }
      const data = (body as unknown as { draft?: DraftDetail }).draft;
      if (!data) {
        setDraftError("Не удалось открыть черновик статьи.");
        return;
      }
      setOpenDraft(data);
    } catch {
      setDraftError("Нет связи с сервером. Попробуйте позже.");
    }
  }

  /** Закрытие окна: открытый материал забывается. */
  function closeDraftModal(): void {
    setOpenDraft(null);
    setDraftError(null);
  }

  /**
   * Сохранение правки текста.
   *
   * Версия материала растёт на сервере: в ответе приходит уже новая, и
   * менеджер видит, какой версией статьи он пользуется.
   */
  async function saveDraft(bodyMd: string): Promise<void> {
    if (!openDraft) return;
    setDraftSaving(true);
    setDraftError(null);
    try {
      const response = await fetch(
        `/api/manager/knowledge/draft/${openDraft.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body_md: bodyMd }),
        },
      );
      const body = await readJson(response);
      if (!response.ok) {
        setDraftError(
          body.error?.message ?? "Не удалось сохранить правку статьи.",
        );
        return;
      }
      const updated = (body as unknown as { draft?: DraftDetail }).draft;
      setOpenDraft(updated ?? { ...openDraft, body_md: bodyMd });
      setAttempt((value) => value + 1);
    } catch {
      setDraftError("Нет связи с сервером. Попробуйте позже.");
    } finally {
      setDraftSaving(false);
    }
  }

  /** Копирование текста статьи в буфер обмена. */
  async function copyDraft(): Promise<void> {
    if (!openDraft) return;
    try {
      await navigator.clipboard.writeText(openDraft.body_md);
      setDraftError(null);
    } catch {
      setDraftError("Не удалось скопировать текст: браузер не дал доступ к буферу.");
    }
  }

  /**
   * Удаление черновика.
   *
   * Материал уходит из списка вместе с записью: ушедший черновик в списке
   * оставаться не должен.
   */
  async function deleteDraft(): Promise<void> {
    if (!openDraft) return;
    setDraftSaving(true);
    setDraftError(null);
    try {
      const response = await fetch(
        `/api/manager/knowledge/draft/${openDraft.id}`,
        { method: "DELETE" },
      );
      const body = await readJson(response);
      if (!response.ok) {
        setDraftError(
          body.error?.message ?? "Не удалось удалить черновик статьи.",
        );
        return;
      }
      setPayload((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          drafts: previous.drafts.filter((draft) => draft.id !== openDraft.id),
        };
      });
      setOpenDraft(null);
    } catch {
      setDraftError("Нет связи с сервером. Попробуйте позже.");
    } finally {
      setDraftSaving(false);
    }
  }

  /**
   * Одобрение материала.
   *
   * Документ и статья одобряются разными маршрутами: переходы состояний
   * у них разные, и смешивать их нельзя (ADR-0005).
   */
  async function approve(
    kind: "document" | "draft",
    id: string,
  ): Promise<void> {
    const key = `${kind}:${id}`;
    setOperations((previous) => ({ ...previous, [key]: { kind: "running" } }));
    const url =
      kind === "document"
        ? `/api/kb/documents/${id}/approve`
        : `/api/kb/drafts/${id}/approve`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor: "manager" }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setOperations((previous) => ({
          ...previous,
          [key]: {
            kind: "failed",
            message:
              body.error?.message ??
              (kind === "document"
                ? "Не удалось одобрить документ."
                : "Не удалось одобрить статью."),
          },
        }));
        return;
      }

      const status = typeof body.status === "string" ? body.status : "published";
      setPayload((previous) => {
        if (!previous) return previous;
        if (kind === "document") {
          return {
            ...previous,
            documents: previous.documents.map((document) =>
              document.id === id ? { ...document, status } : document,
            ),
          };
        }
        return {
          ...previous,
          drafts: previous.drafts.map((draft) =>
            draft.id === id ? { ...draft, status } : draft,
          ),
        };
      });
      setOperations((previous) => ({
        ...previous,
        [key]: {
          kind: "done",
          message:
            kind === "document"
              ? "Документ одобрен и доступен поиску."
              : "Статья одобрена и опубликована.",
        },
      }));
    } catch {
      setOperations((previous) => ({
        ...previous,
        [key]: {
          kind: "failed",
          message: "Нет связи с сервером. Попробуйте позже.",
        },
      }));
    }
  }

  /**
   * Отклонение черновика статьи.
   *
   * Отклонённый материал не индексируется и в поиск не попадает: решение
   * менеджера сохраняется в истории, но агент его не увидит.
   */
  async function reject(id: string): Promise<void> {
    const key = `draft:${id}`;
    setOperations((previous) => ({ ...previous, [key]: { kind: "running" } }));

    try {
      const response = await fetch("/api/manager/knowledge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          draft_id: id,
          actor: "manager",
        }),
      });
      const body = await readJson(response);
      if (!response.ok) {
        setOperations((previous) => ({
          ...previous,
          [key]: {
            kind: "failed",
            message: body.error?.message ?? "Не удалось отклонить статью.",
          },
        }));
        return;
      }

      const status = typeof body.status === "string" ? body.status : "rejected";
      setPayload((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          drafts: previous.drafts.map((draft) =>
            draft.id === id ? { ...draft, status } : draft,
          ),
        };
      });
      setOperations((previous) => ({
        ...previous,
        [key]: {
          kind: "done",
          message: "Статья отклонена: в поиск она не попадёт.",
        },
      }));
    } catch {
      setOperations((previous) => ({
        ...previous,
        [key]: {
          kind: "failed",
          message: "Нет связи с сервером. Попробуйте позже.",
        },
      }));
    }
  }

  /** Загрузка документа: файл уходит на сервер, арендатор определяется там же. */
  async function uploadDocument(): Promise<void> {
    if (!file) {
      setUpload({
        kind: "failed",
        message: "Выберите файл документа.",
      });
      return;
    }
    setUpload({ kind: "running" });
    const body = new FormData();
    body.append("file", file);

    try {
      const response = await fetch("/api/kb/documents", {
        method: "POST",
        body,
      });
      const answer = await readJson(response);
      if (!response.ok) {
        setUpload({
          kind: "failed",
          message:
            answer.error?.message ?? "Не удалось загрузить документ.",
        });
        return;
      }
      setUpload({
        kind: "done",
        message: `Файл «${file.name}» загружен и ждёт проверки.`,
      });
      setFile(null);
      setAttempt((value) => value + 1);
    } catch {
      setUpload({
        kind: "failed",
        message: "Нет связи с сервером. Попробуйте позже.",
      });
    }
  }

  if (loadError) {
    return (
      <section className="kn-page" aria-label="База знаний">
        <ManagerErrorState
          title={loadError}
          description="Список документов и черновиков получить не удалось. Повторите попытку — данные кабинета при этом не менялись."
          action={
            <button
              type="button"
              className="sl-m-button sl-m-button--primary"
              onClick={retry}
            >
              Повторить
            </button>
          }
        />
      </section>
    );
  }

  if (!payload) {
    return (
      <section className="kn-page" aria-label="База знаний">
        <ManagerLoading label="Загружаем базу знаний" />
      </section>
    );
  }

  const tabs: ManagerTab[] = [
    {
      id: "documents",
      label: "Документы",
      badge: String(payload.documents.length),
    },
    {
      id: "drafts",
      label: "Черновики статей",
      badge: String(payload.drafts.length),
    },
  ];

  return (
    <section className="kn-page" aria-label="База знаний">
      <header className="kn-header">
        <p className="kn-eyebrow">Кабинет менеджера</p>
        <h1 className="kn-title">База знаний</h1>
        <p className="kn-lead">
          Загруженные документы и черновики статей. Материал попадает в поиск
          агента только после одобрения менеджером.
        </p>
      </header>

      <ManagerTabs
        tabs={tabs}
        activeId={activeTab}
        label="Разделы базы знаний"
        onSelect={(id) => setActiveTab(id === "drafts" ? "drafts" : "documents")}
      />

      <div
        className="kn-panel"
        role="tabpanel"
        aria-label={activeTab === "documents" ? "Документы" : "Черновики статей"}
      >
        {activeTab === "documents" ? (
          <>
            <ManagerCard
              id="kn-upload"
              title="Загрузить документ"
              description="PDF, DOCX, Markdown или TXT. Файл разбирается и индексируется, а в поиск попадает после одобрения."
            >
              <div className="kn-upload">
                <label className="kn-label" htmlFor="kn-file">
                  Файл документа
                </label>
                <input
                  id="kn-file"
                  className="kn-file"
                  type="file"
                  name="file"
                  accept=".pdf,.docx,.md,.txt,application/pdf,text/markdown,text/plain"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0] ?? null;
                    setFile(chosen);
                    setUpload({ kind: "idle" });
                  }}
                />
                <button
                  type="button"
                  className="sl-m-button sl-m-button--primary"
                  onClick={() => {
                    void uploadDocument();
                  }}
                  disabled={upload.kind === "running"}
                >
                  {upload.kind === "running" ? "Загружаем…" : "Загрузить документ"}
                </button>
              </div>
              {upload.kind === "done" ? (
                <p className="kn-note" role="status">
                  {upload.message}
                </p>
              ) : null}
              {upload.kind === "failed" ? (
                <p className="kn-note kn-note--error" role="alert">
                  {upload.message}
                </p>
              ) : null}
            </ManagerCard>

            <ManagerCard
              id="kn-documents"
              title="Загруженные документы"
              description="Документ в состоянии «на проверке» доступен поиску только после одобрения."
            >
              {payload.documents.length === 0 ? (
                <ManagerEmptyState
                  title="Документов пока нет"
                  description="Загрузите первый документ — он появится здесь со статусом «на проверке»."
                />
              ) : (
                <ul className="kn-list" aria-label="Загруженные документы">
                  {payload.documents.map((document) => {
                    const key = `document:${document.id}`;
                    const operation = operations[key] ?? { kind: "idle" as const };
                    return (
                      <li key={document.id} className="kn-item">
                        <div className="kn-item-main">
                          <p className="kn-item-title">{document.filename}</p>
                          <p className="kn-item-meta">
                            <span className="kn-item-status">
                              {DOCUMENT_STATUS_LABELS[document.status] ?? document.status}
                            </span>
                            <span>
                              {Math.max(1, Math.round(document.size_bytes / 1024))} КБ
                            </span>
                            <span>{document.chunks_count} чанков</span>
                            <span>
                              {DATE_FORMATTER.format(new Date(document.created_at))}
                            </span>
                          </p>
                          {document.parse_error ? (
                            <p className="kn-item-error">{document.parse_error}</p>
                          ) : null}
                          {operation.kind === "done" ? (
                            <p className="kn-note" role="status">
                              {operation.message}
                            </p>
                          ) : null}
                          {operation.kind === "failed" ? (
                            <p className="kn-note kn-note--error" role="alert">
                              {operation.message}
                            </p>
                          ) : null}
                        </div>
                        {document.status === "pending" ? (
                          <button
                            type="button"
                            className="sl-m-button sl-m-button--primary"
                            aria-label={`Одобрить документ ${document.filename}`}
                            disabled={operation.kind === "running"}
                            onClick={() => {
                              void approve("document", document.id);
                            }}
                          >
                            {operation.kind === "running" ? "Одобряем…" : "Одобрить"}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </ManagerCard>
          </>
        ) : (
          <ManagerCard
            id="kn-drafts"
            title="Черновики статей"
            description="Материал, собранный агентом из диалога, и уже опубликованные статьи базы знаний. До одобрения черновик в поиск не попадает."
          >
            {payload.drafts.length === 0 ? (
              <ManagerEmptyState
                title="Черновиков пока нет"
                description="Агент собирает материал из диалога — он появится здесь и будет ждать решения менеджера."
              />
            ) : (
              <ul className="kn-list" aria-label="Черновики статей">
                {payload.drafts.map((draft) => {
                  const key = `draft:${draft.id}`;
                  const operation = operations[key] ?? { kind: "idle" as const };
                  return (
                      <li key={draft.id} className="kn-item">
                      <div className="kn-item-main">
                        <button
                          type="button"
                          className="kn-item-title kn-item-title--button"
                          aria-label={`Открыть статью «${draft.title}»`}
                          onClick={() => {
                            void openDraftModal(draft.id);
                          }}
                        >
                          {draft.title}
                        </button>
                        <p className="kn-item-meta">
                          <span className="kn-item-status">
                            {DRAFT_STATUS_LABELS[draft.status] ?? draft.status}
                          </span>
                          <span>
                            {DATE_FORMATTER.format(new Date(draft.created_at))}
                          </span>
                        </p>
                        {draft.source_excerpt ? (
                          <p className="kn-item-excerpt">{draft.source_excerpt}</p>
                        ) : null}
                        {operation.kind === "done" ? (
                          <p className="kn-note" role="status">
                            {operation.message}
                          </p>
                        ) : null}
                        {operation.kind === "failed" ? (
                          <p className="kn-note kn-note--error" role="alert">
                            {operation.message}
                          </p>
                        ) : null}
                      </div>
                      {draft.status === "pending_review" ? (
                        <div className="kn-actions">
                          <button
                            type="button"
                            className="sl-m-button sl-m-button--primary"
                            aria-label={`Одобрить статью «${draft.title}»`}
                            disabled={operation.kind === "running"}
                            onClick={() => {
                              void approve("draft", draft.id);
                            }}
                          >
                            {operation.kind === "running" ? "Одобряем…" : "Одобрить"}
                          </button>
                          <button
                            type="button"
                            className="sl-m-button"
                            aria-label={`Отклонить статью «${draft.title}»`}
                            disabled={operation.kind === "running"}
                            onClick={() => {
                              void reject(draft.id);
                            }}
                          >
                            Отклонить
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </ManagerCard>
        )}
      </div>

      {openDraft ? (
        <DraftModal
          draft={openDraft}
          saving={draftSaving}
          error={draftError}
          onClose={closeDraftModal}
          onSave={(bodyMd) => {
            void saveDraft(bodyMd);
          }}
          onCopy={() => {
            void copyDraft();
          }}
          onDelete={() => {
            void deleteDraft();
          }}
        />
      ) : draftError ? (
        // Ошибка открытия материала видна в разделе: окно не открылось, и
        // сообщение о неудаче не должно остаться без места.
        <p className="kn-note kn-note--error" role="alert">
          {draftError}
        </p>
      ) : null}
    </section>
  );
}
