import express, { Express, Request, Response } from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { sql } from './plugins/sql';
import logger from './plugins/logger';
import { mailer } from './plugins/mailer';
import { sqli_detect } from './plugins/anti_SQLI';
import { check_working_day, main as generateCalendarExcel } from './plugins/dayoff_calendar';
import { startArchiveSchedule } from './plugins/archive_schedule';
import { aggregateDay, ClockEdit, decideEdit, displayRowHours, isRealDate, taipeiToday } from './plugins/clockin_sheet';
import { computeDayHours, displayWorkHours, formatWorkMinutes, mergeLegacyEdit } from './plugins/clockin_segments';
import { personalClockinPdf, readMasterClockinPdf } from './plugins/clockin_archive';
import path from 'path';
import fs from 'fs';

const log = new logger(`./logs/${new Date().toISOString().split('T')[0]}.log`);
const sqlPlugin: sql = new sql();
const mailers = new mailer();
const app: Express = express();
const PORT: number = 3000;

app.use(bodyParser.urlencoded({
  extended: true
}));

app.use(bodyParser.json());

app.use(cors({
  "origin": "https://eucan.ddns.net",
  "methods": "GET,POST,OPTIONS",
  "credentials": true,             // MUST be true if sending cookies/sessions
  "optionsSuccessStatus": 204
}));

app.all('/', (req: Request, res: Response) => {
  res.send("System online.");
});

app.get('/api/calendar/years', (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');

    if (!account || !cookie) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
      res.sendStatus(403);
      return;
    }

    const years = new Set<number>();
    const calendarDir = './api';
    if (fs.existsSync(calendarDir)) {
      for (const fileName of fs.readdirSync(calendarDir)) {
        const match = fileName.match(/^office_calendar_(\d{2,3})\.json$/);
        if (!match) {
          continue;
        }
        years.add(parseInt(match[1], 10) + 1911);
      }
    }

    if (years.size === 0) {
      years.add(new Date().getFullYear());
    }

    res.json({ years: Array.from(years).sort((a, b) => a - b) });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/years', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');

    if (!account || !cookie) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const years = sqlPlugin.clockinYears();
    res.json({ years: years.length > 0 ? years : [new Date().getFullYear()] });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

const posts: Array<string> = ['login', 'users', 'session', "register", 'dayoff', 'request', 'query', 'permit', 'init', 'approved', 'empquery', 'delete', "modify", "quota", "clockin", "sync", "calendar", "clrecord", "tmodify", "modemp", "batchrequest"];
posts.forEach(v => {
  const utils = require(`./system/${v}.js`).bind(null, sqlPlugin, log, mailers);
  app.post(`/${v}`, (req: Request, res: Response) => {
    if (sqli_detect(req.body)) {
      res.sendStatus(400);
      return;
    }
    try {
      utils(req, res);
    } catch (e) {
      log.logFormat((e as string), new Date());
      res.sendStatus(500);
    }
  });
})

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  log.logFormat("Server online.");
  const mailerStatus = mailers.verify();
  if (!mailerStatus) {
    console.error("Mailer Verify Failed!");
  }
  startArchiveSchedule(sqlPlugin, log);
});

// Public view endpoint: return calendar JSON (weeks grid)
app.get('/api/calendar/view', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const year = parseInt(String(req.query.year || '0'));
    const month = parseInt(String(req.query.month || '0'));

    if (!account || !cookie || !year || !month) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null) {
      res.sendStatus(403);
      return;
    }

    // Build calendar JSON (re-using the same logic as dayoff_calendar)
    const reminders = sqlPlugin.showQueryInMonth(year, month);
    const totalDays = new Date(year, month, 0).getDate();
    let dailyReminders: { [key: number]: string[] } = {};
    for (let d = 1; d <= totalDays; d++) {
      dailyReminders[d] = [];
    }

    // Fill non-working day comments
    for (let d = 1; d <= totalDays; d++) {
      let cal = await check_working_day(year, month.toString(), d.toString());
      if (cal['status'] === 1 && cal['comment']) {
        dailyReminders[d].push(cal['comment']);
      }
    }

    for (const rem of reminders) {
      const start = new Date(rem.start.replace(' ', 'T'));
      const end = new Date(rem.end.replace(' ', 'T'));
      const name = rem.name;
      const startDay = start.getDate();
      const endDay = end.getDate();

      for (let day = startDay; day <= endDay; day++) {
        const cal = await check_working_day(year, month.toString(), day.toString());
        if (cal['status'] === 1) continue;
        const shortdayoffd: { [k: string]: string } = {
          '事假': '事', '特休假_N': '特N', '家庭照顧假': '家', '病假': '病', '婚假': '婚', '喪假': '喪', '分娩假': '娩', '產檢假': '檢', '流產假': '流', '陪產假': '陪', '產假': '產', '公假': '公', '停班停課': '停', '其他': '其'
        };
        let text = `${name}`;
        if (rem.type != '特休假') {
          text += `(${shortdayoffd[rem.type as keyof typeof shortdayoffd]})`;
        }
        let temp = '';
        if (start.getTime() === end.getTime()) continue;
        if (startDay === endDay) {
          temp += `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}~${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
        } else if (day === startDay) {
          temp += `${start.getHours().toString().padStart(2, '0')}:${start.getMinutes().toString().padStart(2, '0')}~17:30`;
        } else if (day === endDay) {
          temp += `08:30~${end.getHours().toString().padStart(2, '0')}:${end.getMinutes().toString().padStart(2, '0')}`;
        }
        if (temp != '08:30~17:30') {
          text += temp;
        }
        const two_times = temp.split('~');
        if (two_times[0] == two_times[1]) continue;
        dailyReminders[day].push(text);
      }
    }

    // Build weeks (grid)
    const weeks: Array<Array<null | { day: number, reminders: string[] }>> = [];
    let currentWeek: Array<null | { day: number, reminders: string[] }> = [];
    const firstDayIndex = new Date(year, month - 1, 1).getDay();
    for (let i = 0; i < firstDayIndex; i++) currentWeek.push(null);
    for (let day = 1; day <= totalDays; day++) {
      currentWeek.push({ day, reminders: dailyReminders[day] });
      if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
    }
    if (currentWeek.length > 0) { while (currentWeek.length < 7) currentWeek.push(null); weeks.push(currentWeek); }

    res.json({ year, month, weeks });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Public view endpoint: return clock-in records JSON (admin only)
app.get('/api/clockin/view', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    const day = parseInt(String(req.query.day || ''), 10);

    if (!account || !cookie || !parsed || !Number.isInteger(day)) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const { year, month, yearKey, monthKey } = parsed;
    const totalDays = new Date(year, month, 0).getDate();
    if (day < 1 || day > totalDays) {
      res.sendStatus(400);
      return;
    }

    const date = `${yearKey}-${monthKey}-${day.toString().padStart(2, '0')}`;
    const users = sqlPlugin.getAllUsers().filter((user) =>
      user.id !== 'monitor' &&
      user.status === 1 &&
      user.type === 'employee' &&
      (user.name || '').trim().length > 0
    );
    users.sort((a, b) => compareEmployeeId(a.id, b.id));
    const monthRecords = await sqlPlugin.clockinRecord(yearKey, monthKey);
    const punches = indexPunches(monthRecords);
    const edits = indexEdits(sqlPlugin.clockinEditsForMonth(yearKey, monthKey));
    const segmentEdits = indexEdits(sqlPlugin.clockinSegmentSummariesForMonth(yearKey, monthKey));
    const downloadableIds = new Set(sqlPlugin.clockinMasterRows(yearKey, monthKey).map((row) => row.id));
    const onLeaveIds = new Set(sqlPlugin.approvedLeaveIdsOnDate(date));
    const records = users.map((user) => {
      const live = summarizeClockinDay(punches.get(clockinKey(user.id, date)) || [], edits.get(clockinKey(user.id, date)) || null, user.name, segmentEdits.get(clockinKey(user.id, date)) || null);
      return {
        id: user.id,
        name: user.name,
        clockin: live.clockin,
        clockout: live.clockout,
        workHours: live.workHours,
        workMinutes: live.workMinutes,
        incompleteSegments: live.incompleteSegments,
        hasRecord: live.hasRecord,
        onLeave: onLeaveIds.has(user.id),
        downloadable: downloadableIds.has(user.id),
        modified: live.modified,
        reason: live.reason,
        editorName: live.editorName,
        editedAt: live.editedAt,
      };
    });

    res.json({
      year,
      month,
      day,
      masterReady: sqlPlugin.clockinMasterReady(yearKey, monthKey),
      records,
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Public view endpoint: return clock-in status for a specific day (admin only)
app.get('/api/clockin/day', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const year = parseInt(String(req.query.year || '0'));
    const month = parseInt(String(req.query.month || '0'));
    const day = parseInt(String(req.query.day || '0'));

    if (!account || !cookie || !year || !month || !day) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const monthKey = month.toString().padStart(2, '0');
    const dayKey = day.toString().padStart(2, '0');
    const targetDate = `${year}-${monthKey}-${dayKey}`;
    const users = sqlPlugin.getAllUsers().filter((user) =>
      user.id !== 'monitor' &&
      user.status === 1 &&
      user.type === 'employee' &&
      (user.name || '').trim().length > 0
    );
    const recordsForMonth = await sqlPlugin.clockinRecord(year, monthKey);
    const punches = indexPunches(recordsForMonth);
    const edits = indexEdits(sqlPlugin.clockinEditsForDate(targetDate));
    const segmentEdits = indexEdits(sqlPlugin.clockinSegmentSummariesForDate(targetDate));
    const data = users.map((user) => {
      const live = summarizeClockinDay(punches.get(clockinKey(user.id, targetDate)) || [], edits.get(clockinKey(user.id, targetDate)) || null, user.name, segmentEdits.get(clockinKey(user.id, targetDate)) || null);
      return {
        id: user.id,
        name: user.name,
        clockin: live.clockin,
        clockout: live.clockout,
        workHours: live.workHours,
        workMinutes: live.workMinutes,
        incompleteSegments: live.incompleteSegments,
        hasRecord: live.hasRecord,
        modified: live.modified,
        reason: live.reason,
        editorName: live.editorName,
        editedAt: live.editedAt,
      };
    });
    data.sort((a, b) => compareEmployeeId(a.id, b.id));

    res.json({ year, month, day, records: data });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/directory', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const activity = new Set(sqlPlugin.employeeIdsWithMonthActivity(parsed.yearKey, parsed.monthKey));
    const employees = sqlPlugin.getAllUsers().filter((user) => {
      if (user.type !== 'employee' || user.id === 'monitor' || !(user.name || '').trim()) {
        return false;
      }
      if (user.status === 1) {
        return true;
      }
      return user.status === 0 && activity.has(user.id);
    }).map((user) => ({
      id: user.id,
      name: user.name,
      status: user.status,
    }));
    employees.sort((a, b) => compareEmployeeId(a.id, b.id));
    res.json({ employees });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/employee', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const id = String(req.query.id || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !id || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const user = sqlPlugin.getUser(id);
    if (!user || user.type !== 'employee' || user.id === 'monitor') {
      res.status(404).json({ message: '找不到這位員工' });
      return;
    }

    const { year, month, yearKey, monthKey } = parsed;
    const monthRecords = await sqlPlugin.clockinRecord(yearKey, monthKey);
    const punches = indexPunches(monthRecords.filter((item) => item.id === id));
    const edits = indexEdits(sqlPlugin.clockinEditsForMonth(yearKey, monthKey).filter((item) => item.id === id));
    const segmentEdits = indexEdits(sqlPlugin.clockinSegmentSummariesForMonth(yearKey, monthKey).filter((item) => item.id === id));
    const snapshot = sqlPlugin.clockinMasterRows(yearKey, monthKey, id);
    const totalDays = new Date(year, month, 0).getDate();
    const days = [];
    for (let day = 1; day <= totalDays; day++) {
      const date = `${yearKey}-${monthKey}-${day.toString().padStart(2, '0')}`;
      const live = summarizeClockinDay(punches.get(clockinKey(id, date)) || [], edits.get(clockinKey(id, date)) || null, user.name || '', segmentEdits.get(clockinKey(id, date)) || null);
      days.push({
        day,
        date,
        clockin: live.clockin,
        clockout: live.clockout,
        workHours: live.workHours,
        workMinutes: live.workMinutes,
        incompleteSegments: live.incompleteSegments,
        hasRecord: live.hasRecord,
        modified: live.modified,
        reason: live.reason,
        editorName: live.editorName,
        editedAt: live.editedAt,
      });
    }

    res.json({
      employee: { id: user.id, name: user.name, status: user.status },
      masterReady: sqlPlugin.clockinMasterReady(yearKey, monthKey),
      downloadable: snapshot.length > 0,
      days,
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.post('/api/clockin/edit', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body as { [key: string]: unknown } : {};
    const account = bodyText(body['account']);
    const cookie = bodyText(body['cookie']);
    const id = bodyText(body['id']);
    const date = bodyText(body['date']);
    const clockin = body['clockin'] == null ? null : String(body['clockin']);
    const clockout = body['clockout'] == null ? null : String(body['clockout']);
    const reason = body['reason'] == null ? '' : String(body['reason']);

    if (!account || !cookie || !id || !date) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const user = sqlPlugin.getUser(id);
    if (!user || user.type !== 'employee' || user.id === 'monitor') {
      res.status(404).json({ message: '找不到這位員工' });
      return;
    }

    if (isRealDate(date) && sqlPlugin.hasClockinSegmentLog(id, date)) {
      res.status(409).json({ message: '這一天已改用分段補正，請用「展開各段」修改' });
      return;
    }

    const today = taipeiToday();
    let currentClockin: string | null = null;
    let currentClockout: string | null = null;
    if (isRealDate(date) && date <= today) {
      const yearKey = date.slice(0, 4);
      const monthKey = date.slice(5, 7);
      const monthRecords = await sqlPlugin.clockinRecord(yearKey, monthKey);
      const punches = monthRecords.filter((item) => item.id === id && item.date === date);
      const dayEdits = sqlPlugin.clockinEditsForDate(date);
      let edit: ClockEdit | null = null;
      for (const item of dayEdits) {
        if (item.id === id) {
          edit = item;
          break;
        }
      }
      const live = summarizeClockinDay(punches, edit, user.name || '');
      currentClockin = live.clockin;
      currentClockout = live.clockout;
    }

    const decision = decideEdit(
      { clockin: currentClockin, clockout: currentClockout },
      { date, clockin, clockout, reason },
      today
    );
    if (!decision.ok) {
      res.status(400).json({ message: decision.message });
      return;
    }
    if (decision.kind === 'unchanged') {
      res.status(200).json({ status: 'unchanged', message: '時間沒有變更' });
      return;
    }

    sqlPlugin.saveClockinEdit({
      id: user.id,
      date,
      name: user.name || '',
      clockin: decision.clockin,
      clockout: decision.clockout,
      reason: decision.reason,
      editorId: account,
      editorName: ret['name'],
    });
    log.logFormat(`${ret['name']} (${account}) corrected clock-in of ${user.name} (${id}) on ${date}.`);
    res.status(200).json({ status: 'saved' });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Segment-level view of one person/day (admin only): every segment incl. soft-deleted, plus audit log.
app.get('/api/clockin/segments', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const id = String(req.query.id || '');
    const date = String(req.query.date || '');
    if (!account || !cookie || !id || !isRealDate(date)) {
      res.sendStatus(400);
      return;
    }
    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }
    const user = sqlPlugin.getUser(id);
    if (!user || user.type !== 'employee' || user.id === 'monitor') {
      res.status(404).json({ message: '找不到這位員工' });
      return;
    }
    const segmentMode = sqlPlugin.hasClockinSegmentLog(id, date);
    const segments = sqlPlugin.clockinSegmentsForDay(id, date, true);
    const legacy = sqlPlugin.clockinEditsForDate(date).find((item) => item.id === id) || null;
    // A day with only a legacy correction: show what segment editing will start from (legacy values folded in).
    const legacyPreview = !segmentMode && legacy !== null;
    if (legacyPreview && legacy) {
      const nextNum = segments.reduce((max, segment) => Math.max(max, segment.num), 0) + 1;
      for (const change of mergeLegacyEdit(segments, legacy, nextNum)) {
        const existing = segments.find((segment) => segment.num === change.num);
        if (existing) {
          existing.clockin = change.after.clockin;
          existing.clockout = change.after.clockout;
        } else {
          segments.push({ num: change.num, clockin: change.after.clockin, clockout: change.after.clockout, deleted: false });
        }
      }
    }
    const hours = computeDayHours(segments);
    res.json({
      employee: { id: user.id, name: user.name },
      date,
      segments,
      workHours: displayWorkHours(hours),
      workMinutes: hours.minutes,
      incompleteSegments: hours.incomplete,
      segmentMode,
      legacyPreview,
      legacyEdit: legacy,
      log: sqlPlugin.clockinSegmentLog(id, date),
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

type SegmentAction = 'edit' | 'add' | 'delete';

async function handleSegmentChange(action: SegmentAction, req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body as { [key: string]: unknown } : {};
    const account = bodyText(body['account']);
    const cookie = bodyText(body['cookie']);
    const id = bodyText(body['id']);
    const date = bodyText(body['date']);
    const numRaw = body['num'];
    const num = typeof numRaw === 'number' ? numRaw : parseInt(bodyText(numRaw), 10);
    if (!account || !cookie || !id || !date || (action !== 'add' && !Number.isInteger(num))) {
      res.sendStatus(400);
      return;
    }
    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }
    const user = sqlPlugin.getUser(id);
    if (!user || user.type !== 'employee' || user.id === 'monitor') {
      res.status(404).json({ message: '找不到這位員工' });
      return;
    }
    if (!isRealDate(date)) {
      res.status(400).json({ message: '日期不正確' });
      return;
    }
    if (date > taipeiToday()) {
      res.status(400).json({ message: '不能修改未來的日期' });
      return;
    }
    const input = {
      id: user.id,
      name: user.name || '',
      date,
      clockin: body['clockin'] == null ? null : String(body['clockin']),
      clockout: body['clockout'] == null ? null : String(body['clockout']),
      reason: body['reason'] == null ? '' : String(body['reason']),
      editorId: account,
      editorName: ret['name'],
    };
    const result = action === 'add'
      ? sqlPlugin.addClockinSegment(input)
      : action === 'edit'
        ? sqlPlugin.editClockinSegment({ ...input, num })
        : sqlPlugin.deleteClockinSegment({ ...input, num });
    if (!result.ok) {
      res.status(result.status).json({ message: result.message });
      return;
    }
    if (result.status === 'unchanged') {
      res.status(200).json({ status: 'unchanged', message: '時間沒有變更' });
      return;
    }
    log.logFormat(`${ret['name']} (${account}) ${action} clock-in segment ${result.num} of ${user.name} (${id}) on ${date}.`);
    res.status(200).json({ status: 'saved', num: result.num });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
}

app.post('/api/clockin/segment/edit', (req: Request, res: Response) => handleSegmentChange('edit', req, res));
app.post('/api/clockin/segment/add', (req: Request, res: Response) => handleSegmentChange('add', req, res));
app.post('/api/clockin/segment/delete', (req: Request, res: Response) => handleSegmentChange('delete', req, res));

app.get('/api/clockin/master', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const result = readMasterClockinPdf(sqlPlugin, parsed.yearKey, parsed.monthKey);
    if (result.kind === 'no-master') {
      res.status(409).json({ message: '請先重新載入，產生該月總表' });
      return;
    }

    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', clockinMasterDisposition(result.filename, parsed.yearKey, parsed.monthKey));
    res.send(result.buffer);
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

app.get('/api/clockin/personal', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const id = String(req.query.id || '');
    const parsed = parseClockinYearMonth(req.query.year, req.query.month);
    if (!account || !cookie || !id || !parsed) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    const result = await personalClockinPdf(sqlPlugin, parsed.yearKey, parsed.monthKey, id);
    if (result.kind === 'no-master') {
      res.status(409).json({ message: '請先重新載入，產生該月總表' });
      return;
    }
    if (result.kind === 'no-rows') {
      res.status(404).json({ message: '總表沒有這位員工的紀錄' });
      return;
    }

    res.status(200);
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', clockinAttachmentDisposition(result.filename, parsed.yearKey, parsed.monthKey, id));
    res.send(result.buffer);
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

// Export endpoint: generate and download Excel (admin only)
app.get('/api/calendar/export', async (req: Request, res: Response) => {
  try {
    const account = String(req.query.account || '');
    const cookie = String(req.query.cookie || '');
    const year = parseInt(String(req.query.year || '0'));
    const month = parseInt(String(req.query.month || '0'));

    if (!account || !cookie || !year || !month) {
      res.sendStatus(400);
      return;
    }

    const ret = sqlPlugin.checkHash(account, cookie);
    if (ret == null || ret['accountType'] == 'employee') {
      res.sendStatus(403);
      return;
    }

    await generateCalendarExcel(year, month, sqlPlugin);
    const filePath = `/app/calendars/${year}-${month}calendar.xlsx`;
    res.download(filePath, `${year}-${month}calendar.xlsx`, (err) => {
      if (err) {
        log.logFormat(`Failed to send calendar file: ${String(err)}`);
        res.sendStatus(500);
      }
    });
  } catch (e) {
    log.logFormat((e as string), new Date());
    res.sendStatus(500);
  }
});

function compareEmployeeId(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hant', { numeric: true, sensitivity: 'base' });
}

function parseClockinYearMonth(yearRaw: unknown, monthRaw: unknown): { year: number; month: number; yearKey: string; monthKey: string } | null {
  const yearText = String(yearRaw == null ? '' : yearRaw).trim();
  const monthText = String(monthRaw == null ? '' : monthRaw).trim();
  if (!/^\d{4}$/.test(yearText) || !/^\d{1,2}$/.test(monthText)) {
    return null;
  }
  const year = parseInt(yearText, 10);
  const month = parseInt(monthText, 10);
  if (month < 1 || month > 12) {
    return null;
  }
  return {
    year,
    month,
    yearKey: yearText,
    monthKey: month.toString().padStart(2, '0'),
  };
}

function bodyText(value: unknown): string {
  if (value == null) {
    return '';
  }
  return String(value);
}

function clockinKey(id: string, date: string): string {
  return `${id}\t${date}`;
}

function indexPunches<T extends { id: string; date: string }>(records: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const record of records) {
    const key = clockinKey(record.id, record.date);
    const list = map.get(key);
    if (list) {
      list.push(record);
    } else {
      map.set(key, [record]);
    }
  }
  return map;
}

function indexEdits(edits: ClockEdit[]): Map<string, ClockEdit> {
  const map = new Map<string, ClockEdit>();
  for (const edit of edits) {
    map.set(clockinKey(edit.id, edit.date), edit);
  }
  return map;
}

function summarizeClockinDay(
  punches: Array<{ id: string; name: string; date: string; num: number; clockin: string | null; clockout: string | null }>,
  edit: ClockEdit | null,
  fallbackName: string,
  segmentEdit: ClockEdit | null = null
): {
  clockin: string | null;
  clockout: string | null;
  workHours: string;
  workMinutes: number;
  incompleteSegments: number;
  hasRecord: boolean;
  modified: boolean;
  reason: string;
  editorName: string | null;
  editedAt: string | null;
} {
  const row = aggregateDay(punches, edit, fallbackName, segmentEdit);
  return {
    clockin: row ? row.clockin : null,
    clockout: row ? row.clockout : null,
    workHours: row ? displayRowHours(row) : formatWorkMinutes(0),
    workMinutes: row ? row.workMinutes : 0,
    incompleteSegments: row ? row.incompleteSegments : 0,
    hasRecord: punches.length > 0 || edit !== null || segmentEdit !== null,
    modified: row ? row.modified : false,
    reason: row ? row.reason : '',
    editorName: row ? row.editorName : null,
    editedAt: row ? row.editedAt : null,
  };
}

function clockinMasterDisposition(filename: string, yearKey: string, monthKey: string): string {
  const ascii = `${yearKey}-${monthKey}_clockin.pdf`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function clockinAttachmentDisposition(filename: string, yearKey: string, monthKey: string, id: string): string {
  const safeId = id.replace(/[^A-Za-z0-9._-]/g, '_') || 'employee';
  const ascii = `${yearKey}-${monthKey}_${safeId}_clockin.pdf`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
