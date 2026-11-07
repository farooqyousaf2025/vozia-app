import { deflateRawSync } from 'zlib';

/**
 * A minimal .xlsx writer, with no dependency.
 *
 * The accounts brief asks for CSV *and* Excel. npm does not run on this machine, so a library is
 * not available — and a hand-written OOXML workbook is a small, testable format rather than a
 * compromise: an xlsx file is a ZIP of XML parts, and the only binary discipline it needs is a
 * correct CRC-32 and central directory per entry.
 *
 * Inline strings are used instead of a shared-strings table so a row can be written without
 * first collecting every distinct value, which for a statement export would mean holding the
 * whole file in memory to deduplicate it.
 */

export type WorkbookColumn = {
  header: string;
  /** The key read off each row object. */
  key: string;
  width?: number;
  /**
   * Force the column to be read as a number even though the value arrived as a string.
   *
   * Postgres hands `int8` and `numeric` back as strings through node-pg, and they do not become
   * numbers on their way here — so an amount column would otherwise land in Excel as left-aligned
   * text that the operator cannot sum. The values written are still strings only when they parse
   * as a plain number; anything else falls back to text rather than silently becoming zero.
   */
  numeric?: boolean;
};

export type WorkbookSheet = {
  name: string;
  columns: WorkbookColumn[];
  rows: Record<string, unknown>[];
};

const XML_ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const xml = (value: string): string => value.replace(/[&<>"]/g, (ch) => XML_ESCAPE[ch]);

/** `int8` and `numeric` arrive as strings; only a plain integer or decimal is safe to write as a number. */
const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/** 1 → A, 26 → Z, 27 → AA. Column letters are the one part of a cell reference that is not a number. */
function columnName(index: number): string {
  let label = '';
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

const CRC_POLYNOMIAL = 0xedb88320;
// Written out plainly rather than cleverly: a wrong CRC reads as a corrupt archive, and only in
// Excel, so this table is deliberately the textbook one.
const CRC32_TABLE: number[] = [];
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? CRC_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC32_TABLE[byte & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

type Entry = { name: string; data: Buffer };

/** A stored-or-deflated ZIP. Only the fields a reader actually consults are written. */
function zip(entries: Entry[], now: Date): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data, { level: 9 });
    // Deflate only helps when it actually shrinks the part; XML headers are often smaller stored.
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : entry.data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    centrals.push(central, nameBuffer);
    // The four trailing fields of the central record are all zero here, which the allocation above
    // already guarantees, as does `offset` being written after the directory entry is appended.
    central.writeUInt32LE(offset, 42);

    offset += local.length + nameBuffer.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function sheetXml(sheet: WorkbookSheet): string {
  const widths = sheet.columns
    .map((column, index) => `<col min="${index + 1}" max="${index + 1}" width="${column.width ?? 18}" customWidth="1"/>`)
    .join('');
  const header = sheet.columns
    .map((column, index) => `<c r="${columnName(index + 1)}1" t="inlineStr"><is><t>${xml(column.header)}</t></is></c>`)
    .join('');

  const body = sheet.rows
    .map((row, rowIndex) => {
      const cells = sheet.columns
        .map((column, columnIndex) => {
          const ref = `${columnName(columnIndex + 1)}${rowIndex + 2}`;
          const value = row[column.key];
          if (value === null || value === undefined || value === '') return `<c r="${ref}"/>`;
          if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
          if (column.numeric && typeof value === 'string' && NUMERIC_TEXT.test(value)) {
            // Written straight through, without a Number() round-trip: a minor-unit total can carry
            // more digits than a double holds exactly, and the text is already the exact value.
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          if (typeof value === 'boolean') return `<c r="${ref}"><v>${value ? 1 : 0}</v></c>`;
          const text = value instanceof Date ? value.toISOString() : String(value);
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 2}">${cells}</row>`;
    })
    .join('');

  const lastColumn = columnName(sheet.columns.length);
  const lastRow = sheet.rows.length + 1;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<dimension ref="A1:${lastColumn}${lastRow}"/>`
    + `<cols>${widths}</cols>`
    + `<sheetData><row r="1">${header}</row>${body}</sheetData>`
    + `</worksheet>`;
}

/** Excel refuses a sheet name longer than 31 characters or containing any of `[]:*?\/`. */
function safeSheetName(name: string, index: number): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

export function buildWorkbook(sheets: WorkbookSheet[], generatedAt = new Date()): Buffer {
  if (!sheets.length) throw new Error('a workbook needs at least one sheet');
  const names = sheets.map((sheet, index) => safeSheetName(sheet.name, index));

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>`
    + `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
    + names
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" `
            + `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('')
    + `</Types>`;

  // The stylesheet is deliberately empty: one font, one fill, one border. Numbers arriving as
  // numbers matters far more than any formatting, and formatting is what the operator adds next.
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>`
    + `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>`
    + `<borders count="1"><border/></borders>`
    + `<cellStyleXfs count="1"><xf/></cellStyleXfs>`
    + `<cellXfs count="1"><xf xfId="0"/></cellXfs>`
    + `</styleSheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" `
    + `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
    + `<sheets>`
    + names
        .map((name, index) => `<sheet name="${xml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('')
    + `</sheets></workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + names
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" `
            + `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" `
            + `Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join('')
    + `<Relationship Id="rId${names.length + 1}" `
    + `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>`
    + `</Relationships>`;

  return zip(
    [
      { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
      { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
      { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
      { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
      { name: 'xl/styles.xml', data: Buffer.from(styles, 'utf8') },
      ...sheets.map((sheet, index) => ({
        name: `xl/worksheets/sheet${index + 1}.xml`,
        data: Buffer.from(sheetXml(sheet), 'utf8'),
      })),
    ],
    generatedAt,
  );
}

/** The same rows as CSV, from the same column definition, so the two exports cannot disagree. */
export function buildCsv(sheet: WorkbookSheet): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [sheet.columns.map((column) => cell(column.header)).join(',')];
  for (const row of sheet.rows) lines.push(sheet.columns.map((column) => cell(row[column.key])).join(','));
  // A BOM is what makes Excel read a UTF-8 CSV as UTF-8 rather than as Windows-1252.
  return `\ufeff${lines.join('\r\n')}\r\n`;
}
