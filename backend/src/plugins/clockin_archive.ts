import fs from 'fs';
import path from 'path';
import { sql } from './sql';
import {
  ClockPunch,
  buildMonthSheet,
  clockinMasterFileName,
  renderClockinPdf,
  resolveClockinFont,
} from './clockin_sheet';

export async function writeClockinMaster(sqlPlugin: sql, year: string | number, month: string | number): Promise<string> {
  const yearText = String(year);
  const monthText = String(month).padStart(2, '0');
  const punches = await sqlPlugin.clockinRecord(yearText, monthText) as ClockPunch[];
  const edits = sqlPlugin.clockinEditsForMonth(yearText, monthText);
  const namesById = new Map<string, string>();
  for (const user of sqlPlugin.getAllUsers()) {
    namesById.set(user.id, user.name || '');
  }
  const segmentEdits = sqlPlugin.clockinSegmentSummariesForMonth(yearText, monthText);
  const rows = buildMonthSheet(punches, edits, namesById, segmentEdits);
  const title = `祐肯打卡紀錄 ${yearText}年${monthText}月`;
  const pdf = await renderClockinPdf(title, rows, resolveClockinFont());
  const directory = path.join(process.cwd(), 'clock');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, clockinMasterFileName(yearText, monthText));
  fs.writeFileSync(filePath, pdf);
  sqlPlugin.replaceClockinMaster(yearText, monthText, rows);
  return filePath;
}

export function readMasterClockinPdf(
  sqlPlugin: sql,
  year: string | number,
  month: string | number
): { kind: 'no-master' } | { kind: 'pdf'; buffer: Buffer; filename: string } {
  const yearText = String(year);
  const monthText = String(month).padStart(2, '0');
  const filePath = path.join(process.cwd(), 'clock', clockinMasterFileName(yearText, monthText));
  if (!sqlPlugin.clockinMasterReady(yearText, monthText) || !fs.existsSync(filePath)) {
    return { kind: 'no-master' };
  }
  return {
    kind: 'pdf',
    buffer: fs.readFileSync(filePath),
    filename: `${yearText}-${monthText}_打卡紀錄.pdf`,
  };
}

export async function personalClockinPdf(
  sqlPlugin: sql,
  year: string | number,
  month: string | number,
  employeeId: string
): Promise<
  | { kind: 'no-master' }
  | { kind: 'no-rows' }
  | { kind: 'pdf'; buffer: Buffer; filename: string }
> {
  const yearText = String(year);
  const monthText = String(month).padStart(2, '0');
  if (!sqlPlugin.clockinMasterReady(yearText, monthText)) {
    return { kind: 'no-master' };
  }
  const rows = sqlPlugin.clockinMasterRows(yearText, monthText, employeeId);
  if (rows.length === 0) {
    return { kind: 'no-rows' };
  }
  let name = employeeId;
  for (let i = rows.length - 1; i >= 0; i--) {
    if ((rows[i].name || '').trim()) {
      name = rows[i].name;
      break;
    }
  }
  const title = `祐肯打卡紀錄 ${yearText}年${monthText}月　${name}（${employeeId}）`;
  const buffer = await renderClockinPdf(title, rows, resolveClockinFont());
  return {
    kind: 'pdf',
    buffer,
    filename: `${yearText}-${monthText}_${employeeId}_打卡紀錄.pdf`,
  };
}
