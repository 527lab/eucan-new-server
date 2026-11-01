// const ExcelJS = require('exceljs');
import ExcelJS from 'exceljs';
import { digit } from '../types/types';
import { ClockSheetRow, displayRowHours, displayTime } from './clockin_sheet';

/**
 * Month sheet as Excel: first clock-in / last clock-out per day plus the day's work hours
 * (paired segments summed, soft-deleted segments excluded). Pass rows from buildMonthSheet.
 */
export async function output_excel(data: ClockSheetRow[], year: digit, month: digit): Promise<void> {
  const rows = data.slice().sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Sheet1');

  worksheet.addRow(['日期', '員工編號', '員工姓名', '首次上班', '末次下班', '當日工時', '修改紀錄', '修改原因', '修改時間']);

  rows.forEach(item => {
    worksheet.addRow([
      item.date,
      item.id,
      item.name,
      displayTime(item.clockin),
      displayTime(item.clockout),
      displayRowHours(item),
      item.modified ? '是' : '否',
      item.modified ? item.reason : '',
      item.modified && item.editedAt ? item.editedAt : ''
    ]);
  });

  await workbook.xlsx.writeFile(`/app/clock/${year}-${month}clockin_record.xlsx`);
  console.log('Excel file created successfully!');
}
