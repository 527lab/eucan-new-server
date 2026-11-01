import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';
import { computeDayHours, displayWorkHours, legacyEditHours } from './clockin_segments';

export type ClockPunch = {
  id: string;
  name: string;
  date: string;
  num: number;
  clockin: string | null;
  clockout: string | null;
};

export type ClockEdit = {
  id: string;
  name: string;
  date: string;
  clockin: string | null;
  clockout: string | null;
  reason: string;
  editorId: string;
  editorName: string;
  editedAt: string;
};

export type ClockSheetRow = {
  id: string;
  name: string;
  date: string;
  clockin: string | null;
  clockout: string | null;
  modified: boolean;
  reason: string;
  editorName: string | null;
  editedAt: string | null;
  /** Minutes worked that day: complete (in+out) segments summed, soft-deleted segments excluded. */
  workMinutes: number;
  /** Live segments that could not be paired into a work period. */
  incompleteSegments: number;
};

export type EditDecision =
  | { ok: true; kind: 'unchanged' }
  | { ok: true; kind: 'save'; clockin: string | null; clockout: string | null; reason: string }
  | { ok: false; message: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function taipeiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(now);
}

export function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function normalizeTime(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    return null;
  }
  return text;
}

export function displayTime(value: string | null): string {
  return value ? value : '無';
}

/**
 * Build one sheet row for a person/day.
 * `segmentEdit` is the latest segment-level correction summary (clockin/clockout unused). When present the
 * day is in "segment mode": live segments are authoritative and any legacy clockin_edit row is ignored
 * (it was folded into the segments when segment editing started and is kept in the table untouched).
 */
export function aggregateDay(punches: ClockPunch[], edit: ClockEdit | null, fallbackName: string, segmentEdit: ClockEdit | null = null): ClockSheetRow | null {
  const sample = punches[0];
  const id = segmentEdit?.id || edit?.id || sample?.id;
  const date = segmentEdit?.date || edit?.date || sample?.date;
  if (!id || !date) {
    return null;
  }
  const name = fallbackName.trim() || edit?.name || namedPunch(punches) || id;
  if (edit && !segmentEdit) {
    const hours = legacyEditHours(edit.clockin, edit.clockout);
    return {
      id,
      name,
      date,
      clockin: edit.clockin,
      clockout: edit.clockout,
      modified: true,
      reason: edit.reason,
      editorName: edit.editorName,
      editedAt: edit.editedAt,
      workMinutes: hours.minutes,
      incompleteSegments: hours.incomplete,
    };
  }

  let clockin: string | null = null;
  let clockout: string | null = null;
  for (const punch of punches) {
    if (punch.clockin && (clockin === null || punch.clockin < clockin)) {
      clockin = punch.clockin;
    }
    if (punch.clockout && (clockout === null || punch.clockout > clockout)) {
      clockout = punch.clockout;
    }
  }
  const hours = computeDayHours(punches);
  return {
    id,
    name,
    date,
    clockin,
    clockout,
    modified: segmentEdit !== null,
    reason: segmentEdit ? segmentEdit.reason : '',
    editorName: segmentEdit ? segmentEdit.editorName : null,
    editedAt: segmentEdit ? segmentEdit.editedAt : null,
    workMinutes: hours.minutes,
    incompleteSegments: hours.incomplete,
  };
}

export function buildMonthSheet(punches: ClockPunch[], edits: ClockEdit[], namesById: Map<string, string>, segmentEdits: ClockEdit[] = []): ClockSheetRow[] {
  const groups = new Map<string, ClockPunch[]>();
  for (const punch of punches) {
    if (punch.id === 'monitor') {
      continue;
    }
    const key = sheetKey(punch.id, punch.date);
    const list = groups.get(key) || [];
    list.push(punch);
    groups.set(key, list);
  }

  const editMap = new Map<string, ClockEdit>();
  for (const edit of edits) {
    if (edit.id === 'monitor') {
      continue;
    }
    editMap.set(sheetKey(edit.id, edit.date), edit);
  }

  const segmentMap = new Map<string, ClockEdit>();
  for (const edit of segmentEdits) {
    if (edit.id === 'monitor') {
      continue;
    }
    segmentMap.set(sheetKey(edit.id, edit.date), edit);
  }

  const rows: ClockSheetRow[] = [];
  const keys = new Set<string>([...groups.keys(), ...editMap.keys(), ...segmentMap.keys()]);
  for (const key of keys) {
    const [id] = key.split('\t');
    const group = groups.get(key) || [];
    const edit = editMap.get(key) || null;
    const fallback = namesById.get(id) || '';
    const row = aggregateDay(group, edit, fallback, segmentMap.get(key) || null);
    if (row) {
      rows.push(row);
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'zh-Hant', { numeric: true, sensitivity: 'base' }));
  return rows;
}

export function decideEdit(current: { clockin: string | null; clockout: string | null }, input: { date: string; clockin: string | null; clockout: string | null; reason: string }, today: string): EditDecision {
  if (!isRealDate(input.date)) {
    return { ok: false, message: '日期不正確' };
  }
  if (input.date > today) {
    return { ok: false, message: '不能修改未來的日期' };
  }

  const clockin = normalizeTime(input.clockin);
  const clockout = normalizeTime(input.clockout);
  if (clockin && !TIME_PATTERN.test(clockin)) {
    return { ok: false, message: '上班時間須為 HH:MM' };
  }
  if (clockout && !TIME_PATTERN.test(clockout)) {
    return { ok: false, message: '下班時間須為 HH:MM' };
  }
  if (!clockin && !clockout) {
    return { ok: false, message: '上班與下班至少填一個' };
  }
  if (current.clockin && !clockin) {
    return { ok: false, message: '已有的上班時間不能清空' };
  }
  if (current.clockout && !clockout) {
    return { ok: false, message: '已有的下班時間不能清空' };
  }
  if (clockin && clockout && clockout < clockin) {
    return { ok: false, message: '下班時間不得早於上班時間' };
  }
  if (clockin === current.clockin && clockout === current.clockout) {
    return { ok: true, kind: 'unchanged' };
  }

  const reason = input.reason.trim();
  if (!reason) {
    return { ok: false, message: '請填寫修改原因' };
  }
  if (Array.from(reason).length > 200) {
    return { ok: false, message: '修改原因最多 200 字' };
  }
  if (/[\u0000-\u001F]/.test(reason)) {
    return { ok: false, message: '修改原因不能包含控制字元' };
  }
  return { ok: true, kind: 'save', clockin, clockout, reason };
}

type PdfColumn = {
  title: string;
  width: number;
  value: (row: ClockSheetRow) => string;
};

export function renderClockinPdf(title: string, rows: ClockSheetRow[], fontPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'portrait', margin: 36, info: { Title: title } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.font(fontPath);
    const titleWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    doc.fontSize(16).text(title, doc.page.margins.left, doc.page.margins.top, {
      width: titleWidth,
      align: 'center',
    });
    doc.moveDown(0.6);

    const columns = pdfColumns(doc);
    let y = doc.y;
    y = drawHeader(doc, columns, y);
    rows.forEach((row) => {
      const height = rowHeight(doc, columns, row);
      if (y + height > doc.page.height - doc.page.margins.bottom) {
        doc.addPage({ size: 'A4', layout: 'portrait', margin: 36 });
        y = doc.page.margins.top;
        y = drawHeader(doc, columns, y);
      }
      drawRow(doc, columns, row, y, height, '#ffffff');
      y += height;
    });
    doc.end();
  });
}

export function resolveClockinFont(): string {
  const candidates = [
    process.env.CLOCKIN_PDF_FONT || '',
    path.resolve(__dirname, '../fonts/NotoSansTC-Regular.otf'),
    'C:\\Windows\\Fonts\\kaiu.ttf',
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('找不到中文字型，無法產生打卡紀錄 PDF');
}

export function clockinMasterFileName(year: string, month: string): string {
  return `${year}-${month}clockin_record.pdf`;
}

function namedPunch(punches: ClockPunch[]): string {
  const named = punches.slice().sort((a, b) => a.num - b.num).find((punch) => punch.name.trim());
  return named ? named.name : '';
}

function sheetKey(id: string, date: string): string {
  return `${id}\t${date}`;
}

function pdfColumns(doc: PDFKit.PDFDocument): PdfColumn[] {
  const usable = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const editedAtWidth = 70;
  const fixed: PdfColumn[] = [
    { title: '日期', width: 62, value: (row) => row.date },
    { title: '員工編號', width: 46, value: (row) => row.id },
    { title: '員工姓名', width: 52, value: (row) => row.name },
    { title: '首次上班', width: 42, value: (row) => displayTime(row.clockin) },
    { title: '末次下班', width: 42, value: (row) => displayTime(row.clockout) },
    { title: '當日工時', width: 62, value: displayRowHours },
    { title: '修改紀錄', width: 42, value: (row) => row.modified ? '是' : '否' },
  ];
  const used = fixed.reduce((sum, column) => sum + column.width, 0) + editedAtWidth;
  return fixed.concat(
    {
      title: '修改原因',
      width: Math.max(usable - used, 80),
      value: (row) => row.reason,
    },
    {
      title: '修改時間',
      width: editedAtWidth,
      value: displayEditedAt,
    },
  );
}

export function displayRowHours(row: { workMinutes: number; incompleteSegments: number }): string {
  return displayWorkHours({ minutes: row.workMinutes, incomplete: row.incompleteSegments });
}

function displayEditedAt(row: ClockSheetRow): string {
  if (!row.modified || !row.editedAt) {
    return '';
  }
  return row.editedAt;
}

function drawHeader(doc: PDFKit.PDFDocument, columns: PdfColumn[], y: number): number {
  doc.fontSize(8);
  const height = Math.max(22, rowHeight(doc, columns, null) );
  drawRow(doc, columns, null, y, height, '#e8eef5');
  return y + height;
}

function rowHeight(doc: PDFKit.PDFDocument, columns: PdfColumn[], row: ClockSheetRow | null): number {
  let height = 20;
  for (const column of columns) {
    const text = row ? column.value(row) : column.title;
    const textHeight = doc.heightOfString(text || ' ', { width: column.width - 8 });
    height = Math.max(height, textHeight + 8);
  }
  return height;
}

function drawRow(doc: PDFKit.PDFDocument, columns: PdfColumn[], row: ClockSheetRow | null, y: number, height: number, fill: string): void {
  let x = doc.page.margins.left;
  doc.fontSize(8);
  for (const column of columns) {
    doc.save();
    doc.rect(x, y, column.width, height).fillAndStroke(fill, '#cbd5e1');
    doc.fillColor('#0f172a');
    const text = row ? column.value(row) : column.title;
    const textWidth = column.width - 8;
    const textHeight = doc.heightOfString(text || ' ', { width: textWidth });
    const textY = row ? y + 4 : y + Math.max(3, (height - textHeight) / 2);
    doc.text(text, x + 4, textY, {
      width: textWidth,
      height: Math.max(height - (textY - y) - 2, textHeight),
      align: row ? 'left' : 'center',
    });
    doc.restore();
    x += column.width;
  }
}
