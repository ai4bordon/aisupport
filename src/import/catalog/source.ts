// Источник фида: потоковая загрузка по HTTP с распаковкой gzip на лету.
//
// Требования: 292 МБ в память не грузить. Файл сначала скачивается потоком
// на диск (снимок), затем читается с диска построчно — так хеш снимка и дата
// фида считаются по тому же байту, который ушёл в базу.
//
// Если живой источник недоступен, используется последний снимок на диске —
// для демо это не ошибка.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const LIVE_FEED_URL = "https://store.softline.ru/feeds/Softline.yml.gz";

export type SourceKind = "live_feed" | "local_snapshot";

export type FeedSource = {
  /** Поток с распакованным YML — построчный разбор. */
  stream: Readable;
  /** Путь к снимку на диске: из него считается хеш и читается фид. */
  snapshotPath: string;
  /** SHA-256 снимка. */
  snapshotHash: string;
  /** URL живого источника истины, если фид взят из сети. */
  sourceUrl: string | null;
  /** Вид источника: живой фид или запасной снимок. */
  sourceKind: SourceKind;
};

export type SourceOptions = {
  /** URL живого фида; если не задан, читается только локальный снимок. */
  sourceUrl?: string | null;
  /** Путь к запасному снимку на диске. */
  fallbackPath?: string | null;
  /** Каталог для промежуточных файлов загрузки. */
  workDir?: string;
  /** Таймаут загрузки живого фида, мс. */
  timeoutMs?: number;
};

function looksGzipped(head: Buffer): boolean {
  return head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b;
}

/**
 * Читает из web-потока первые байты, чтобы понять, gzip это или нет,
 * и возвращает поток, начинающийся с этих байтов.
 */
async function readWithHead(
  body: ReadableStream<Uint8Array>,
): Promise<{ stream: Readable; head: Buffer }> {
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let headLength = 0;
  while (headLength < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(Buffer.from(value));
    headLength += value.length;
  }
  const head = Buffer.concat(chunks).subarray(0, 2);
  const rest = chunks.length > 0 ? chunks[chunks.length - 1] : undefined;
  void rest;

  async function* replay(): AsyncGenerator<Uint8Array> {
    for (const chunk of chunks) yield chunk;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  }

  return { stream: Readable.from(replay()), head };
}

/**
 * Потоковая загрузка живого фида: ответ пишется на диск, gzip распаковывается
 * на лету, в память целиком файл не попадает.
 */
async function downloadLiveFeed(url: string, targetPath: string, timeoutMs: number): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new Error(`живой фид ${url} ответил ${response.status}`);
  }

  const { stream, head } = await readWithHead(response.body);
  const decoded = looksGzipped(head) ? stream.pipe(createGunzip()) : stream;
  await pipeline(decoded, createWriteStream(targetPath));
}

/** SHA-256 файла, считается потоком. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/**
 * Готовит источник фида: пробует живой URL, при недоступности берёт запасной
 * снимок. Возвращает поток с распакованным YML и провенанс снимка.
 */
export async function openFeedSource(options: SourceOptions = {}): Promise<FeedSource> {
  const workDir = resolve(options.workDir ?? join(process.cwd(), ".cache", "feed"));
  await mkdir(workDir, { recursive: true });

  const sourceUrl = options.sourceUrl ?? null;
  if (sourceUrl) {
    const targetPath = join(workDir, "download.xml");
    try {
      await downloadLiveFeed(sourceUrl, targetPath, options.timeoutMs ?? 300_000);
      const snapshotHash = await hashFile(targetPath);
      return {
        stream: createReadStream(targetPath, { encoding: "utf8" }),
        snapshotPath: targetPath,
        snapshotHash,
        sourceUrl,
        sourceKind: "live_feed",
      };
    } catch {
      await rm(targetPath, { force: true }).catch(() => undefined);
    }
  }

  const fallback = options.fallbackPath ? resolve(options.fallbackPath) : null;
  if (!fallback) {
    throw new Error("нет ни живого фида, ни запасного снимка");
  }
  const fallbackStat = await stat(fallback);
  if (!fallbackStat.isFile()) {
    throw new Error(`запасной снимок ${fallback} не найден`);
  }
  const snapshotHash = await hashFile(fallback);
  return {
    stream: createReadStream(fallback, { encoding: "utf8" }),
    snapshotPath: fallback,
    snapshotHash,
    sourceUrl,
    sourceKind: "local_snapshot",
  };
}

/** Копирует снимок в постоянное место, чтобы он пережил перезапуск процесса. */
export async function persistSnapshot(source: FeedSource, targetPath: string): Promise<string> {
  await mkdir(dirname(targetPath), { recursive: true });
  const staging = `${targetPath}.part`;
  await pipeline(createReadStream(source.snapshotPath), createWriteStream(staging));
  await rename(staging, targetPath);
  return targetPath;
}
