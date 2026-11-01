// Run: npm test  (compiles with tsc, then runs this file with plain node; no framework needed)
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  computeDayHours,
  decideSegmentEdit,
  displayWorkHours,
  formatWorkMinutes,
  isDuplicatePunch,
  mergeLegacyEdit,
} from '../plugins/clockin_segments';
import { buildMonthSheet, ClockEdit, ClockPunch } from '../plugins/clockin_sheet';

let passed = 0;
function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}`);
    throw e;
  }
}

// ---------- pure logic ----------
test('duplicate punch: under 5 minutes is duplicate, 5 minutes is not', () => {
  assert.strictEqual(isDuplicatePunch(['09:00'], '09:04'), true);
  assert.strictEqual(isDuplicatePunch(['09:00'], '09:00'), true);
  assert.strictEqual(isDuplicatePunch(['09:00'], '09:05'), false);
  assert.strictEqual(isDuplicatePunch(['09:00'], '08:56'), true);
  assert.strictEqual(isDuplicatePunch([null, '12:00'], '09:00'), false);
  assert.strictEqual(isDuplicatePunch([], '09:00'), false);
});

test('work hours: pairs summed, deleted skipped, incomplete flagged', () => {
  const hours = computeDayHours([
    { num: 1, clockin: '09:00', clockout: '12:00' },
    { num: 2, clockin: '13:00', clockout: '18:00' },
    { num: 3, clockin: '19:00', clockout: null },
    { num: 4, clockin: '08:00', clockout: '23:00', deleted: true },
    { num: 5, clockin: null, clockout: null },
    { num: 6, clockin: '15:00', clockout: '14:00' },
  ]);
  assert.deepStrictEqual(hours, { minutes: 8 * 60, incomplete: 2 });
  assert.strictEqual(formatWorkMinutes(8 * 60 + 5), '8:05');
  assert.strictEqual(displayWorkHours(hours), '8:00（2段不完整）');
  assert.strictEqual(displayWorkHours({ minutes: 90, incomplete: 0 }), '1:30');
});

test('segment edit validation', () => {
  const cur = { clockin: '09:00', clockout: '12:00' };
  assert.deepStrictEqual(decideSegmentEdit(cur, { clockin: '09:00', clockout: '12:00', reason: '' }), { ok: true, kind: 'unchanged' });
  assert.strictEqual(decideSegmentEdit(cur, { clockin: '09:30', clockout: '12:00', reason: '' }).ok, false);
  assert.strictEqual(decideSegmentEdit(cur, { clockin: '9:30', clockout: '12:00', reason: 'x' }).ok, false);
  assert.strictEqual(decideSegmentEdit(cur, { clockin: '13:00', clockout: '12:00', reason: 'x' }).ok, false);
  assert.strictEqual(decideSegmentEdit(cur, { clockin: null, clockout: null, reason: 'x' }).ok, false);
  assert.strictEqual(decideSegmentEdit(cur, { clockin: '09:30', clockout: '12:00', reason: 'a'.repeat(201) }).ok, false);
  const ok = decideSegmentEdit(cur, { clockin: '09:30', clockout: '', reason: ' 忘記打卡 ' });
  assert.deepStrictEqual(ok, { ok: true, kind: 'save', clockin: '09:30', clockout: null, reason: '忘記打卡' });
});

test('legacy merge folds first-in / last-out into segments', () => {
  const live = [
    { num: 1, clockin: '09:10', clockout: '12:00' },
    { num: 2, clockin: '13:00', clockout: '18:00' },
  ];
  const changes = mergeLegacyEdit(live, { clockin: '09:00', clockout: '18:30' }, 3);
  assert.strictEqual(changes.length, 2);
  assert.deepStrictEqual(changes[0].after, { clockin: '09:00', clockout: '12:00' });
  assert.deepStrictEqual(changes[1].after, { clockin: '13:00', clockout: '18:30' });
  assert.deepStrictEqual(mergeLegacyEdit(live, { clockin: '09:10', clockout: '18:00' }, 3), []);
  const created = mergeLegacyEdit([], { clockin: '09:00', clockout: '17:00' }, 1);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].created, true);
});

test('month sheet keeps first-in / last-out and adds hours; legacy edit still wins when no segment edit', () => {
  const punch = (num: number, clockin: string | null, clockout: string | null): ClockPunch => ({ id: 'E1', name: 'A', date: '2026-03-02', num, clockin, clockout });
  const punches = [punch(1, '09:00', '12:00'), punch(2, '13:00', '18:00')];
  const rows = buildMonthSheet(punches, [], new Map([['E1', 'A']]));
  assert.strictEqual(rows[0].clockin, '09:00');
  assert.strictEqual(rows[0].clockout, '18:00');
  assert.strictEqual(rows[0].workMinutes, 8 * 60);

  const legacy: ClockEdit = { id: 'E1', name: 'A', date: '2026-03-02', clockin: '08:00', clockout: '17:00', reason: 'r', editorId: 'm', editorName: 'M', editedAt: '2026-03-03 10:00' };
  const legacyRows = buildMonthSheet(punches, [legacy], new Map());
  assert.strictEqual(legacyRows[0].clockin, '08:00');
  assert.strictEqual(legacyRows[0].modified, true);
  assert.strictEqual(legacyRows[0].workMinutes, 9 * 60);

  const summary: ClockEdit = { ...legacy, clockin: null, clockout: null, reason: 'seg', editedAt: '2026-03-04 10:00' };
  const segRows = buildMonthSheet(punches, [legacy], new Map(), [summary]);
  assert.strictEqual(segRows[0].clockin, '09:00');
  assert.strictEqual(segRows[0].reason, 'seg');
  assert.strictEqual(segRows[0].workMinutes, 8 * 60);
});

// ---------- database (temp dir, same schema as production) ----------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clockin-seg-'));
fs.mkdirSync(path.join(work, 'databases'));
fs.mkdirSync(path.join(work, 'logs'));
const original = process.cwd();
process.chdir(work);
const dbFile = path.join(work, 'databases', 'loginDatabase.db');
const seed = new Database(dbFile);
seed.exec(`
  CREATE TABLE userinfo (id TEXT PRIMARY KEY,pwd TEXT NOT NULL,type TEXT DEFAULT employee,email TEXT NOT NULL,name TEXT NOT NULL,joinTime DATETIME DEFAULT (strftime('%Y-%m-%d', 'now', '+8 hours')), mgroup INT NOT NULL,permit INT DEFAULT 1,status INT DEFAULT 1);
  CREATE TABLE clockinrecord (id TEXT NOT NULL,name TEXT NOT NULL,date DATETIME DEFAULT (strftime('%Y-%m-%d', 'now', '+8 hours')),num INT DEFAULT 1,clockin DATETIME,clockout DATETIME);
  INSERT INTO userinfo (id,pwd,email,name,mgroup) VALUES ('E1','x','a@b.c','王小明',1);
  INSERT INTO clockinrecord (id,name,date,num,clockin,clockout) VALUES ('E1','王小明','2026-02-02',1,'09:10','12:00'),('E1','王小明','2026-02-02',2,'13:00','18:00');
  CREATE TABLE clockin_edit (id TEXT NOT NULL,date TEXT NOT NULL,name TEXT NOT NULL,clockin TEXT,clockout TEXT,reason TEXT NOT NULL,editor_id TEXT NOT NULL,editor_name TEXT NOT NULL,edited_at TEXT NOT NULL,PRIMARY KEY (id, date));
  INSERT INTO clockin_edit VALUES ('E1','2026-02-02','王小明','09:00','18:30','忘記打卡','m1','管理員','2026-02-03 09:00');
`);
seed.close();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sql } = require('../plugins/sql');

async function database(): Promise<void> {
  const db = new sql();
  // Opening a second time must be a no-op migration (idempotent).
  new sql();

  const editor = { editorId: 'm2', editorName: '管理員二' };
  const base = { id: 'E1', name: '王小明', date: '2026-02-02' };

  test('migration is repeatable and keeps legacy clockin_edit', () => {
    assert.strictEqual(db.clockinEditsForDate('2026-02-02').length, 1);
    assert.strictEqual(db.clockinSegmentsForDay('E1', '2026-02-02').length, 2);
  });

  test('rejected / no-op segment edits change nothing (legacy not folded)', () => {
    let r = db.editClockinSegment({ ...base, ...editor, num: 1, clockin: '09:30', clockout: '12:00', reason: '' });
    assert.strictEqual(r.ok, false);
    r = db.editClockinSegment({ ...base, ...editor, num: 1, clockin: '09:00', clockout: '12:00', reason: 'same' }); // legacy-effective values
    assert.strictEqual(r.status, 'unchanged');
    r = db.editClockinSegment({ ...base, ...editor, num: 99, clockin: '09:30', clockout: '12:00', reason: 'x' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(db.hasClockinSegmentLog('E1', '2026-02-02'), false);
    assert.strictEqual(db.clockinSegmentsForDay('E1', '2026-02-02')[0].clockin, '09:10');
  });

  test('first segment edit folds the legacy correction, then applies the edit; all logged', () => {
    const r = db.editClockinSegment({ ...base, ...editor, num: 2, clockin: '13:00', clockout: '19:00', reason: '加班' });
    assert.deepStrictEqual(r, { ok: true, status: 'saved', num: 2 });
    const segs = db.clockinSegmentsForDay('E1', '2026-02-02');
    assert.strictEqual(segs[0].clockin, '09:00'); // legacy first-in folded in
    assert.strictEqual(segs[1].clockout, '19:00');
    const log = db.clockinSegmentLog('E1', '2026-02-02');
    assert.deepStrictEqual(log.map((l: { action: string }) => l.action), ['legacy-merge', 'legacy-merge', 'update']);
    assert.strictEqual(log[2].editorName, '管理員二');
    assert.strictEqual(log[2].reason, '加班');
    assert.strictEqual(db.clockinEditsForDate('2026-02-02').length, 1); // still there
  });

  test('add a segment, then soft-delete it (row kept, hidden from reports)', () => {
    const added = db.addClockinSegment({ ...base, ...editor, clockin: '20:00', clockout: '21:00', reason: '補登晚班' });
    assert.strictEqual(added.ok && added.num, 3);
    assert.strictEqual(db.addClockinSegment({ ...base, ...editor, clockin: null, clockout: null, reason: 'x' }).ok, false);
    assert.strictEqual(db.deleteClockinSegment({ ...base, ...editor, num: 3, reason: '' }).ok, false);
    assert.strictEqual(db.deleteClockinSegment({ ...base, ...editor, num: 3, reason: '誤登' }).ok, true);
    assert.strictEqual(db.clockinSegmentsForDay('E1', '2026-02-02').length, 2);
    const all = db.clockinSegmentsForDay('E1', '2026-02-02', true);
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[2].deleted, true);
    const raw = new Database(dbFile, { readonly: true });
    assert.strictEqual((raw.prepare('SELECT COUNT(*) AS n FROM clockinrecord').get() as { n: number }).n, 3);
    raw.close();
  });

  const punches = await db.clockinRecord('2026', '02');
  test('reports use only live segments and segment-mode summary', () => {
    assert.strictEqual(punches.length, 2);
    const rows = buildMonthSheet(punches, db.clockinEditsForMonth('2026', '02'), new Map([['E1', '王小明']]), db.clockinSegmentSummariesForMonth('2026', '02'));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].clockin, '09:00');
    assert.strictEqual(rows[0].clockout, '19:00');
    assert.strictEqual(rows[0].workMinutes, 3 * 60 + 6 * 60);
    assert.strictEqual(rows[0].modified, true);
    assert.strictEqual(rows[0].reason, '誤登');
    db.replaceClockinMaster('2026', '02', rows);
    assert.strictEqual(db.clockinMasterRows('2026', '02', 'E1')[0].workMinutes, 9 * 60);
  });

  test('clock-in duplicate guard (<5 min) through clockinAction', () => {
    const t = (h: number, m: number) => new Date(2026, 2, 3, h, m);
    assert.deepStrictEqual(db.clockinAction('E1', 1, t(9, 0)), { status: 200 });
    assert.deepStrictEqual(db.clockinAction('E1', 1, t(9, 3)), { status: 409 });
    assert.deepStrictEqual(db.clockinAction('E1', -1, t(9, 4)), { status: 200 }); // other kind is independent
    assert.deepStrictEqual(db.clockinAction('E1', -1, t(9, 6)), { status: 409 });
    assert.deepStrictEqual(db.clockinAction('E1', 1, t(9, 5)), { status: 200 }); // exactly 5 min later is allowed
    assert.strictEqual(db.clockinAction('E1', 0, t(10, 0)).length, 2);
  });

  test('soft-deleted segment does not break num allocation or slot filling', () => {
    const t = (h: number, m: number) => new Date(2026, 2, 4, h, m);
    db.clockinAction('E1', 1, t(9, 0));
    db.clockinAction('E1', -1, t(12, 0));
    db.clockinAction('E1', 1, t(13, 0)); // segment 2
    db.deleteClockinSegment({ id: 'E1', name: '王小明', date: '2026-03-04', ...editor, num: 2, reason: '誤打' });
    db.clockinAction('E1', 1, t(14, 0)); // must open num 3, not collide with deleted num 2
    const all = db.clockinSegmentsForDay('E1', '2026-03-04', true);
    assert.deepStrictEqual(all.map((s: { num: number }) => s.num), [1, 2, 3]);
  });
}

database().then(() => {
  process.chdir(original);
  console.log(`${passed} checks passed`);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
