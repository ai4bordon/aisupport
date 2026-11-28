"use client";

export type PromiseItem = {
  id: string;
  conversation_id: string;
  text: string;
  due_at: string;
  owner: string;
  status: string;
};

type PromiseJournalProps = {
  promises: PromiseItem[];
};

const STATUS_LABELS: Record<string, string> = {
  open: "В работе",
  done: "Выполнено",
  overdue: "Просрочено",
};

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

/** Журнал обещаний: просроченные записи показаны отдельной группой. */
export function PromiseJournal({ promises }: PromiseJournalProps) {
  const overdue = promises.filter((item) => item.status === "overdue");
  const current = promises.filter((item) => item.status !== "overdue");

  if (promises.length === 0) {
    return (
      <section className="queue-empty" aria-label="Журнал обещаний">
        <p>Журнал обещаний пуст</p>
        {/* Объясняем, что сюда попадает и откуда: иначе пустой журнал
            читается как сбой. */}
        <p className="queue-empty-hint">
          Сюда попадают обещания, данные менеджером в диалоге: срок, что
          обещано и кто ответственный. Обещание появляется, когда менеджер
          нажимает «Запомнить ответ» в раскрытом обращении.
        </p>
      </section>
    );
  }

  return (
    <div className="queue-promise-groups">
      {overdue.length > 0 ? (
        <section aria-labelledby="queue-overdue-title" className="queue-promise-group">
          <h2 id="queue-overdue-title">Просроченные обещания</h2>
          <ul className="queue-promise-list">
            {overdue.map((item) => (
              <li key={item.id} className="queue-promise-item queue-promise-item--overdue">
                <p className="queue-promise-text">{item.text}</p>
                <dl className="queue-promise-meta">
                  <div>
                    <dt>Срок</dt>
                    <dd>{formatDate(item.due_at)}</dd>
                  </div>
                  <div>
                    <dt>Ответственный</dt>
                    <dd>{item.owner}</dd>
                  </div>
                  <div>
                    <dt>Статус</dt>
                    <dd>{STATUS_LABELS[item.status] ?? item.status}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {current.length > 0 ? (
        <section aria-labelledby="queue-current-title" className="queue-promise-group">
          <h2 id="queue-current-title">Актуальные обещания</h2>
          <ul className="queue-promise-list">
            {current.map((item) => (
              <li key={item.id} className="queue-promise-item">
                <p className="queue-promise-text">{item.text}</p>
                <dl className="queue-promise-meta">
                  <div>
                    <dt>Срок</dt>
                    <dd>{formatDate(item.due_at)}</dd>
                  </div>
                  <div>
                    <dt>Ответственный</dt>
                    <dd>{item.owner}</dd>
                  </div>
                  <div>
                    <dt>Статус</dt>
                    <dd>{STATUS_LABELS[item.status] ?? item.status}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
