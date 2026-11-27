/**
 * Генератор QR-кода для ссылки на бота MAX.
 *
 * Код строится на месте, в браузере: ни внешний сервис картинок, ни ключи, ни
 * секреты не нужны, и ссылка на бота не уходит третьим лицам. Алгоритм —
 * стандартный QR (ISO/IEC 18004), байтовый режим, уровень коррекции M,
 * версия подбирается под длину строки.
 *
 * Модуль самодостаточен намеренно: внешняя библиотека в проекте не нужна, а
 * проверяется он тестом расшифровкой (сканер читает код обратно в ссылку).
 */

/** Параметры версий 1–10 для уровня коррекции ошибок M. */
const VERSION_SPECS = [
  { total: 26, ec: 10, blocks: 1 },
  { total: 44, ec: 16, blocks: 1 },
  { total: 70, ec: 26, blocks: 1 },
  { total: 100, ec: 18, blocks: 2 },
  { total: 134, ec: 24, blocks: 2 },
  { total: 172, ec: 16, blocks: 4 },
  { total: 196, ec: 18, blocks: 4 },
  { total: 242, ec: 22, blocks: 4 },
  { total: 292, ec: 22, blocks: 5 },
  { total: 346, ec: 26, blocks: 5 },
] as const;

/** Остаточные биты версий 1–10: ими заполняется конец символа. */
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0] as const;

/** Центры выравнивающих узоров версий 1–10. */
const ALIGNMENT_CENTERS = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
] as const;

/** Уровень коррекции M в двух битах информационного поля формата. */
const ECC_LEVEL_M = 0b00;

/** Маска формата: 15 бит, старший бит — младший бит данных. */
const FORMAT_MASK = 0b101010000010010;

/** Порядковый номер версии QR: 1–10. */
export type QrVersion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Готовая матрица QR: размер в модулях и заполнение. */
export type QrMatrix = {
  size: number;
  modules: boolean[];
};

/** Параметры версии для уровня коррекции M. */
function versionSpec(version: QrVersion) {
  return VERSION_SPECS[version - 1] as (typeof VERSION_SPECS)[number];
}

/** Данные версии в кодовых словах: всего и на один блок коррекции. */
function dataCodewords(version: QrVersion): number {
  const spec = versionSpec(version);
  return spec.total - spec.ec * spec.blocks;
}

/** Старшая версия, в которую строка помещается. */
function chooseVersion(byteLength: number): QrVersion {
  for (let version = 1; version <= VERSION_SPECS.length; version += 1) {
    const countBits = version <= 9 ? 8 : 16;
    const capacityBits = dataCodewords(version as QrVersion) * 8 - 4 - countBits;
    if (byteLength * 8 <= capacityBits) return version as QrVersion;
  }
  throw new Error("Строка не помещается в QR версии 10");
}

/** Добавляет биты числа в поток, старшим битом первым. */
function pushBits(bits: boolean[], value: number, length: number): void {
  for (let i = length - 1; i >= 0; i -= 1) {
    bits.push(((value >>> i) & 1) === 1);
  }
}

/** Умножение в поле Галуа GF(256) с примитивным многочленом 0x11d. */
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Порождающий многочлен кода Рида — Соломона степени `degree`. */
function generatorPolynomial(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j] as number, root);
      if (j + 1 < result.length) {
        result[j] = (result[j] as number) ^ (result[j + 1] as number);
      }
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** Остаток от деления данных на порождающий многочлен: слова коррекции. */
function errorCorrection(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const byte of data) {
    const factor = (byte ^ (result[0] as number)) & 0xff;
    result.shift();
    result.push(0);
    for (let i = 0; i < result.length; i += 1) {
      result[i] = (result[i] as number) ^ gfMultiply(divisor[i] as number, factor);
    }
  }
  return result;
}

/**
 * Разбивка данных на блоки и чередование кодовых слов.
 *
 * Коротких блоков на один меньше кодового слова, чем у длинных; при
 * чередовании слова разной длины вставляются по очереди, иначе порядок
 * блоков после чередования будет неверным.
 */
function interleave(data: number[], version: QrVersion): number[] {
  const spec = versionSpec(version);
  const blockEccLength = spec.ec;
  const blockCount = spec.blocks;
  const totalData = dataCodewords(version);
  const shortBlockCount = blockCount - (totalData % blockCount);
  const shortBlockData = Math.floor(totalData / blockCount);

  const blocks: number[][] = [];
  const divisor = generatorPolynomial(blockEccLength);
  let offset = 0;
  for (let block = 0; block < blockCount; block += 1) {
    const length = shortBlockData + (block < shortBlockCount ? 0 : 1);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    blocks.push([...chunk, ...errorCorrection(chunk, divisor)]);
  }

  const result: number[] = [];
  const maxLength = Math.max(...blocks.map((block) => block.length));
  for (let i = 0; i < maxLength; i += 1) {
    for (const block of blocks) {
      if (i < block.length) result.push(block[i] as number);
    }
  }
  return result;
}

/** Кодовые слова символа: режим, длина, данные, заполнение. */
function encodeData(text: string, version: QrVersion): number[] {
  const bytes = [...new TextEncoder().encode(text)];
  const countBits = version <= 9 ? 8 : 16;
  const capacity = dataCodewords(version) * 8;

  const bits: boolean[] = [];
  pushBits(bits, 0b0100, 4);
  pushBits(bits, bytes.length, countBits);
  for (const byte of bytes) {
    pushBits(bits, byte, 8);
  }
  for (let i = 0; i < 4 && bits.length < capacity; i += 1) {
    bits.push(false);
  }
  while (bits.length % 8 !== 0) {
    bits.push(false);
  }
  let padByte = 0xec;
  while (bits.length < capacity) {
    pushBits(bits, padByte, 8);
    padByte ^= 0xec ^ 0x11;
  }

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let word = 0;
    for (let j = 0; j < 8; j += 1) {
      word = (word << 1) | (bits[i + j] ? 1 : 0);
    }
    words.push(word);
  }
  return words;
}

/** Поле формата: 5 бит данных, 10 бит BCH и маска 0x5412. */
function formatBits(mask: number): number {
  const data = (ECC_LEVEL_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }
  return ((data << 10) | remainder) ^ FORMAT_MASK;
}

/** Поле версии для версий 7 и выше: 6 бит данных и 12 бит BCH. */
function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  }
  return (version << 12) | remainder;
}

/** Штраф за серию из пяти и более одинаковых модулей подряд. */
function penaltyRuns(modules: boolean[], size: number): number {
  let penalty = 0;
  const scan = (get: (index: number) => boolean): void => {
    let runLength = 1;
    for (let i = 1; i < size; i += 1) {
      if (get(i) === get(i - 1)) {
        runLength += 1;
      } else {
        if (runLength >= 5) penalty += 3 + (runLength - 5);
        runLength = 1;
      }
    }
    if (runLength >= 5) penalty += 3 + (runLength - 5);
  };
  for (let row = 0; row < size; row += 1) {
    scan((index) => modules[row * size + index] as boolean);
  }
  for (let col = 0; col < size; col += 1) {
    scan((index) => modules[index * size + col] as boolean);
  }
  return penalty;
}

/** Штраф за блок 2×2 из одинаковых модулей. */
function penaltyBlocks(modules: boolean[], size: number): number {
  let penalty = 0;
  for (let row = 0; row < size - 1; row += 1) {
    for (let col = 0; col < size - 1; col += 1) {
      const value = modules[row * size + col];
      if (
        modules[row * size + col + 1] === value &&
        modules[(row + 1) * size + col] === value &&
        modules[(row + 1) * size + col + 1] === value
      ) {
        penalty += 3;
      }
    }
  }
  return penalty;
}

/** Штраф за узоры, похожие на искомую позицию в коде: 1:1:3:1:1. */
function penaltyPatterns(modules: boolean[], size: number): number {
  const target = [true, false, true, true, true, false, true, false, false, false, false];
  const reversed = [...target].reverse();
  let penalty = 0;
  const matches = (get: (index: number) => boolean, start: number, pattern: boolean[]): boolean =>
    pattern.every((value, offset) => get(start + offset) === value);

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col + 11 <= size; col += 1) {
      const get = (index: number): boolean => modules[row * size + index] as boolean;
      if (matches(get, col, target) || matches(get, col, reversed)) penalty += 40;
    }
  }
  for (let col = 0; col < size; col += 1) {
    for (let row = 0; row + 11 <= size; row += 1) {
      const get = (index: number): boolean => modules[index * size + col] as boolean;
      if (matches(get, row, target) || matches(get, row, reversed)) penalty += 40;
    }
  }
  return penalty;
}

/** Штраф за отклонение доли тёмных модулей от половины. */
function penaltyBalance(modules: boolean[], size: number): number {
  let dark = 0;
  for (const value of modules) {
    if (value) dark += 1;
  }
  const percent = (dark * 100) / modules.length;
  return Math.floor(Math.abs(percent - 50) / 5) * 10;
}

/** Полный штраф символа по четырём правилам стандарта. */
function penalty(modules: boolean[], size: number): number {
  return (
    penaltyRuns(modules, size) +
    penaltyBlocks(modules, size) +
    penaltyPatterns(modules, size) +
    penaltyBalance(modules, size)
  );
}

/** Функции масок: индекс маски и координаты модуля. */
const MASK_FUNCTIONS: ((row: number, col: number) => boolean)[] = [
  (row, col) => (row + col) % 2 === 0,
  (row, col) => (row % 2) + (col % 3) === 0,
  (_row, col) => col % 3 === 0,
  (row, col) => (row + col) % 3 === 0,
  (row, col) => (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0,
  (row, col) => ((row * col) % 2) + ((row * col) % 3) === 0,
  (row, col) => (((row * col) % 2) + ((row * col) % 3)) % 2 === 0,
  (row, col) => (((row + col) % 2) + ((row * col) % 3)) % 2 === 0,
];

/**
 * Строит матрицу QR для строки.
 *
 * Возвращает готовую к отрисовке матрицу модулей: `modules[row * size + col]`
 * — `true` означает тёмный модуль.
 */
export function buildQrMatrix(text: string): QrMatrix {
  const bytes = [...new TextEncoder().encode(text)];
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;

  const modules = new Array<boolean>(size * size).fill(false);
  const isFunction = new Array<boolean>(size * size).fill(false);

  const setFunction = (row: number, col: number, dark: boolean): void => {
    modules[row * size + col] = dark;
    isFunction[row * size + col] = true;
  };

  // Поисковые узоры вместе с разделителями.
  const drawFinder = (topRow: number, leftCol: number): void => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const row = topRow + dy;
        const col = leftCol + dx;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunction(row, col, distance === 0 || distance === 1 || distance === 3);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Синхрополосы.
  for (let i = 8; i < size - 8; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Выравнивающие узоры: кроме трёх углов, занятых поисковыми узорами.
  const centers = ALIGNMENT_CENTERS[version - 1] as readonly number[];
  for (const row of centers) {
    for (const col of centers) {
      const isFinderCorner =
        (row === centers[0] && col === centers[0]) ||
        (row === centers[0] && col === centers[centers.length - 1]) ||
        (row === centers[centers.length - 1] && col === centers[0]);
      if (isFinderCorner) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(row + dy, col + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Синхрополосы: они тянутся через весь символ, и данные в их клетки не
  // кладутся. Без полного резерва поток данных заходит на синхрополосу и
  // код перестаёт читаться.
  for (let i = 0; i < size; i += 1) {
    isFunction[6 * size + i] = true;
    isFunction[i * size + 6] = true;
  }
  // Поле формата: полосы вокруг верхнего левого узора (строка 8 и столбец 8)
  // и вокруг верхнего правого с нижним левым. Данные в эти полосы не идут.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      isFunction[8 * size + i] = true;
      isFunction[i * size + 8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    isFunction[8 * size + (size - 1 - i)] = true;
    isFunction[(size - 1 - i) * size + 8] = true;
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      isFunction[b * size + a] = true;
      isFunction[a * size + b] = true;
    }
  }

  // Размещение данных: зигзаг снизу вверх, справа налево, колонками по две.
  const codewords = interleave(encodeData(text, version), version);
  let bitIndex = 0;
  const totalBits = codewords.length * 8 + REMAINDER_BITS[version - 1];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const col = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vertical : vertical;
        if (isFunction[row * size + col]) continue;
        const dark =
          bitIndex < codewords.length * 8
            ? (((codewords[bitIndex >>> 3] as number) >>> (7 - (bitIndex & 7))) & 1) === 1
            : false;
        modules[row * size + col] = dark;
        bitIndex += 1;
      }
    }
  }
  void totalBits;

  // Выбор маски по минимальному штрафу; поле формата зависит от маски,
  // поэтому оно переносится внутрь перебора.
  let best: { modules: boolean[]; penalty: number } | null = null;
  for (let mask = 0; mask < MASK_FUNCTIONS.length; mask += 1) {
    const candidate = modules.slice();
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (isFunction[row * size + col]) continue;
        if ((MASK_FUNCTIONS[mask] as (r: number, c: number) => boolean)(row, col)) {
          candidate[row * size + col] = !((candidate[row * size + col] as boolean) ?? false);
        }
      }
    }
    writeFormatBits(candidate, size, mask);
    if (version >= 7) {
      writeVersionBits(candidate, size, version);
    }
    const score = penalty(candidate, size);
    if (!best || score < best.penalty) {
      best = { modules: candidate, penalty: score };
    }
  }

  return { size, modules: (best as { modules: boolean[] }).modules };
}

/** Переносит поле формата в обе его позиции. */
function writeFormatBits(modules: boolean[], size: number, mask: number): void {
  const bits = formatBits(mask);
  const bit = (index: number): boolean => ((bits >>> index) & 1) === 1;

  // Первая копия — вокруг верхнего левого поискового узора: биты 0–5 идут
  // вниз по столбцу 8, бит 6 — в (7,8), бит 7 — в (8,8), бит 8 — в (8,7),
  // биты 9–14 — вправо по строке 8.
  for (let i = 0; i <= 5; i += 1) {
    modules[i * size + 8] = bit(i);
  }
  modules[7 * size + 8] = bit(6);
  modules[8 * size + 8] = bit(7);
  modules[8 * size + 7] = bit(8);
  for (let i = 9; i < 15; i += 1) {
    modules[8 * size + (14 - i)] = bit(i);
  }

  // Вторая копия — под верхним правым и над нижним левым узорами.
  for (let i = 0; i < 8; i += 1) {
    modules[8 * size + (size - 1 - i)] = bit(i);
  }
  for (let i = 8; i < 15; i += 1) {
    modules[(size - 15 + i) * size + 8] = bit(i);
  }
  // Всегда тёмный модуль между нижним левым и правым узорами.
  modules[(size - 8) * size + 8] = true;
}

/** Переносит поле версии в обе его позиции. */
function writeVersionBits(modules: boolean[], size: number, version: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b * size + a] = dark;
    modules[a * size + b] = dark;
  }
}
