import crypto from "crypto";
import Database from "better-sqlite3";
import logger from './logger'
import { getSplitTimestamp, fetch_all_nwd, getROCYearsInRange } from "./dayoff_calculate"
import { userinfo, dayoffinfo, clockinrecord, requestquery, logininfo, digit, dayofftype, dayoffinfo_ret } from "../types/types";
import { ClockEdit, ClockSheetRow, normalizeTime } from "./clockin_sheet";
import { decideSegmentEdit, isDuplicatePunch, mergeLegacyEdit, Segment, validateReason } from "./clockin_segments";
import { join } from "path";
// const logger = require("./logger.js");
const log: logger = new logger(`./logs/${new Date().toISOString().split('T')[0]}.log`);

export class sql {

  private login_db: Database.Database;

  public constructor() {
    this.login_db = new Database('./databases/loginDatabase.db');
    this.login_db.pragma('journal_mode = WAL');
    this.ensureUserinfoLeaveDateColumn();
    this.ensureClockinTables();
    log.logFormat("Database is connected with server.", new Date());
  }

  private ensureUserinfoLeaveDateColumn(): void {
    const columns = this.login_db.prepare(`PRAGMA table_info(userinfo);`).all() as Array<{ name: string }>;
    const hasLeaveDate = columns.some((column) => column.name === 'leaveDate');
    if (!hasLeaveDate) {
      this.login_db.prepare(`ALTER TABLE userinfo ADD COLUMN leaveDate DATETIME DEFAULT NULL;`).run();
    }
  }

  private ensureClockinTables(): void {
    this.login_db.exec(`
      CREATE TABLE IF NOT EXISTS clockin_edit (
        id TEXT NOT NULL,
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        clockin TEXT,
        clockout TEXT,
        reason TEXT NOT NULL,
        editor_id TEXT NOT NULL,
        editor_name TEXT NOT NULL,
        edited_at TEXT NOT NULL,
        PRIMARY KEY (id, date)
      );
      CREATE TABLE IF NOT EXISTS clockin_master (
        year TEXT NOT NULL,
        month TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        PRIMARY KEY (year, month)
      );
      CREATE TABLE IF NOT EXISTS clockin_master_row (
        year TEXT NOT NULL,
        month TEXT NOT NULL,
        date TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        clockin TEXT,
        clockout TEXT,
        modified INTEGER NOT NULL,
        reason TEXT NOT NULL,
        edited_at TEXT,
        PRIMARY KEY (year, month, date, id)
      );
    `);
    this.ensureClockinMasterEditedAtColumn();
    this.ensureClockinSegmentSchema();
  }

  private tableColumns(table: string): string[] {
    return (this.login_db.prepare(`PRAGMA table_info(${table});`).all() as Array<{ name: string }>).map((column) => column.name);
  }

  /**
   * Idempotent migration for multi-segment clock-in corrections:
   * - clockinrecord.deleted: soft delete flag (rows are never DELETEd)
   * - clockin_segment_log: append-only audit trail of every segment add/edit/delete
   * - clockin_master_row.work_minutes / incomplete: per-day work hours snapshot
   */
  private ensureClockinSegmentSchema(): void {
    const hasRecordTable = this.login_db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'clockinrecord';`).get() != null;
    if (hasRecordTable && !this.tableColumns('clockinrecord').includes('deleted')) {
      this.login_db.prepare(`ALTER TABLE clockinrecord ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;`).run();
    }
    this.login_db.exec(`
      CREATE TABLE IF NOT EXISTS clockin_segment_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        date TEXT NOT NULL,
        num INTEGER NOT NULL,
        action TEXT NOT NULL,
        old_clockin TEXT,
        old_clockout TEXT,
        new_clockin TEXT,
        new_clockout TEXT,
        reason TEXT NOT NULL,
        editor_id TEXT NOT NULL,
        editor_name TEXT NOT NULL,
        edited_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS clockin_segment_log_day ON clockin_segment_log (id, date);
    `);
    const masterColumns = this.tableColumns('clockin_master_row');
    if (!masterColumns.includes('work_minutes')) {
      this.login_db.prepare(`ALTER TABLE clockin_master_row ADD COLUMN work_minutes INTEGER NOT NULL DEFAULT 0;`).run();
    }
    if (!masterColumns.includes('incomplete')) {
      this.login_db.prepare(`ALTER TABLE clockin_master_row ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0;`).run();
    }
  }

  private ensureClockinMasterEditedAtColumn(): void {
    const columns = this.login_db.prepare(`PRAGMA table_info(clockin_master_row);`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'edited_at')) {
      this.login_db.prepare(`ALTER TABLE clockin_master_row ADD COLUMN edited_at TEXT;`).run();
    }
  }

  login(user: string, pwd: string | null, cookie: string | null): { msg: string, accountType?: string, sessionKey?: string, name?: string } {
    if (cookie !== null) {
      if (user.match(/['"?><:;\\|)(*&^%$#@!~`]/) || cookie.match(/['"?><:;\\|)(*&^%$#@!~`]/) || cookie.match(/['"?><:;\\|)(*&^%$#@!~`]/)) {
        return { msg: "wrong type" };
      }
    }
    const currentTime: Date = new Date();
    const sqldata: userinfo | undefined = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo | undefined);
    const loginHashData: logininfo | undefined = (this.login_db.prepare(`SELECT * FROM logininfo WHERE id= ?;`).get(user) as logininfo | undefined);


    if (sqldata == undefined) {
      log.logFormat(`Someone failed to log in with an incorrect account.`, currentTime);
      return { msg: "wrong account" };
    }

    if (sqldata["status"] == 0) {
      log.logFormat(`${user} tried to log in but the account is marked as resigned.`, currentTime);
      return { msg: "resigned account" };
    }

    // cookie here must be stripped.
    // accepted types: null, string.
    var hash: string = "";
    var expired: boolean = false;
    if (cookie && loginHashData != undefined) {   // if u got a cookie, there must be ur data in the database.
      const ret: null | object = this.checkHash(user, cookie);
      if (ret && user != "monitor") {
        log.logFormat(`${user} has logined with cookie successfully.`);
        return { msg: "success", accountType: sqldata["type"], sessionKey: cookie, name: sqldata["name"] };
      }
      else expired = true;
    }
    if (pwd == sqldata["pwd"]) {
      // Checking database if the user have logined before.
      if (loginHashData == undefined) {
        // Generating hash.
        hash = crypto.randomBytes(5).toString('hex');
        while (this.login_db.prepare(`SELECT * FROM logininfo WHERE sKey= ?;`).get(hash)) {
          hash = crypto.randomBytes(5).toString('hex');
        }
        this.login_db.prepare(`INSERT INTO logininfo (id,sKey) VALUES (?,?);`).run(user, hash);
      } else {
        // hash expired.
        hash = crypto.randomBytes(5).toString('hex');
        while (this.login_db.prepare(`SELECT * FROM logininfo WHERE sKey= ?;`).get(hash)) {
          hash = crypto.randomBytes(5).toString('hex');
        }
        this.login_db.prepare(`UPDATE logininfo SET createTime = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours'),sKey= ? WHERE id= ?;`).run(hash, user);
      }
      if (user != "monitor")
        log.logFormat(`${user} has logined with password successfully.`, currentTime);
      return { msg: "success", accountType: sqldata["type"], sessionKey: hash, name: sqldata["name"] };
    } else {
      log.logFormat(`${user} Failed to log in with password: ${pwd}`, currentTime);
      return { msg: "wrong pwd" };
    }
  }

  /**
   * 
   * @returns {Array<object>}
   */
  getAllUsers(): userinfo[] {
    const data = (this.login_db.prepare(`SELECT * FROM userinfo;`).all() as userinfo[]);
    return data;
  }

  getEmployeeDayOffList(user: string, year: string): null | dayoffinfo_ret {
    try {
      const userinfo = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ?;`).get(user) as userinfo);
      const joinTime = userinfo["joinTime"];
      if (joinTime.split('-')[0] == year) {
        const rq_all = (this.login_db.prepare(`SELECT * FROM requestquery WHERE id= ? AND year= ? AND state=1;`).all(user, year) as requestquery[] | undefined);
        const joinMonth = parseInt(userinfo.joinTime.split("-")[1]);
        const joinDay = parseInt(userinfo.joinTime.split("-")[2]);
        var first_half: dayoffinfo = {
          id: user,
          annual: 0,
          personal: 0,
          care: 0,
          sick: 0,
          wedding: 0,
          funeral: 0,
          birth: 0,
          pcheckup: 0,
          miscarriage: 0,
          paternity: 0,
          maternity: 0,
          official: 0,
          typhoon: 0,
          other: 0,
          total: 0,
          year: year
        };
        var second_half: dayoffinfo = {
          id: user,
          annual: 0,
          personal: 0,
          care: 0,
          sick: 0,
          wedding: 0,
          funeral: 0,
          birth: 0,
          pcheckup: 0,
          miscarriage: 0,
          paternity: 0,
          maternity: 0,
          official: 0,
          typhoon: 0,
          other: 0,
          total: 0,
          year: year
        };
        const table = {
          "特休假": "annual",
          "特休假_N": "特N",
          "事假": "personal",
          "家庭照顧假": "care",
          "病假": "sick",
          "婚假": "wedding",
          "喪假": "funeral",
          "分娩假": "birth",
          "產檢假": "pcheckup",
          "流產假": "miscarriage",
          "陪產假": "paternity",
          "產假": "maternity",
          "公假": "official",
          "停班停課": "typhoon",
          "其他": "other"
        };
        rq_all?.forEach((v: requestquery, i, a) => {
          const reqMonth = parseInt(v.month);
          const reqYear = parseInt(v.start.split("-")[0]);
          const joinYear = parseInt(userinfo.joinTime.split("-")[0]);
          const monthDiff = (reqYear - joinYear) * 12 + (reqMonth - joinMonth);
          console.log(`Month diff: ${monthDiff}`);
          if (monthDiff < 6) {
            (first_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime;
          } else if (monthDiff === 6) {
            // Split totalTime between first_half and second_half based on day boundary.
            (parseInt(v["start"].split("-")[2]) < joinDay) ? (first_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime : (second_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime;
          } else {
            (second_half[table[v.type as keyof dayofftype] as keyof dayoffinfo] as number) += v.totalTime;
          }
        })
        // const dayoffData_LF = (this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id='${user}' AND year='${year}';`).all()[0] as dayoffinfo|undefined);
        return { "separate": true, "data": [first_half, second_half] };
      } else {
        const df = (this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).all(user, year) as dayoffinfo[]);
        if (df.length == 0) {
          this.login_db.prepare(`INSERT INTO dayoffinfo (id,year) VALUES (?,?);`).run(user, year);
          return { "separate": false, "data": [(this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(user, year) as dayoffinfo)] };
        } else {
          return { "separate": false, "data": [df[0]] };
        }
      }

    } catch {
      return null;
    }
  }

  register(user: string, password: string, mail: string, name: string, type: string, jointime: string, mgroup: digit, permit: digit): void {
    // id,pwd,type,email,name,type,mgroup
    this.login_db.prepare(`INSERT INTO userinfo (id,pwd,type,email,name,joinTime,mgroup,permit) VALUES (?,?,?,?,?,(strftime('%Y-%m-%d',?)),?,?);`).run(user, password, type, mail, name, jointime, mgroup, permit);
    return;
  }

  modify(user: string, year: digit, dayoff: string) {
    const table = {
      "特休假": "annual",
      "事假": "personal",
      "家庭照顧假": "care",
      "病假": "sick",
      "婚假": "wedding",
      "喪假": "funeral",
      "分娩假": "birth",
      "產檢假": "pcheckup",
      "流產假": "miscarriage",
      "陪產假": "paternity",
      "產假": "maternity",
      "公假": "official",
      "颱風假": "typhoon",
      "其他": "other"
    };
    const entries: [string, string][] = Object.entries(dayoff)
    const query: string[] = entries.map((v, i, a) => {
      return `${v[0]} = ?`;
    });
    // console.log(query.join(","))
    this.login_db.prepare(`UPDATE dayoffinfo SET ${query.join(",")} WHERE id= ? AND year= ?`).run(user, year.toString());
    return;

  }

  /**
   * 
   * @param {string} user 
   * @param {string} cookie 
   * @returns 
   */
  checkHash(user: string, cookie: string): { msg: string, accountType: string, sessionKey: string, name: string } | null {
    if (user.match(/['"?><:;\\|)(*&^%$#@!~`]/) || cookie.match(/['"?><:;\\|)(*&^%$#@!~`]/)) {
      return null;
    }
    const sqldata = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo);
    const loginHashData = (this.login_db.prepare(`SELECT * FROM logininfo WHERE id= ?;`).get(user) as logininfo);
    const current: Date = new Date();
    const lastLogin = Date.parse(loginHashData["createTime"]);
    const DateLastLogin = new Date(lastLogin);

    if (sqldata["status"] == 0) {
      log.logFormat(`${user} tried to log in but the account is marked as resigned.`, current);
      return null
    }

    if (((current.getTime() - DateLastLogin.getTime()) / 1000 / 60 / 60) <= 1) {    // Caculating the elapsed time
      // if elapsed time <= 1 hr
      if (loginHashData["sKey"] == cookie) {
        // if cookie correct.
        this.login_db.prepare(`UPDATE logininfo SET createTime = strftime('%Y-%m-%d %H:%M:%S', 'now', '+8 hours') WHERE id= ?;`).run(user);
        return { msg: "success", accountType: sqldata["type"], sessionKey: cookie, name: sqldata["name"] };
      } else {
        return null;
      }
    } else {  // if elapsed time > 1 hr
      // log.logFormat(`${user} tried to login with cookie but it had expired.`,current);
      return null;
    }
  }

  init(user: string, year?: digit | undefined) {
    // {
    //     "annual":0,
    //     "personal":0,
    //     "care":0,
    //     "sick":0,
    //     "wedding":0,
    //     "funeral":0,
    //     "birth":0,
    //     "pcheckup":0,
    //     "miscarriage":0,
    //     "paternity":0,
    //     "maternity":0,
    //     "official":0,
    //     "typhoon":0,
    //     "other":0,
    //     "total":0,
    //     "year":0,
    // }
    // ["annual","personal","care","sick","wedding","funeral","birth","pcheckup","miscarriage","paternity","maternity","other","total","year"]

    try {
      if (year != undefined) {
        this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(user, year);
        this.login_db.prepare(`DELETE FROM dayoffinfo WHERE id= ? AND year= ?;`).run(user, year);
        this.login_db.prepare(`INSERT INTO dayoffinfo (id,year) VALUES (?,?);`).run(user, year);
      } else {
        throw new Error("cant find the user");
      }
    } catch (e) {
      this.login_db.prepare(`INSERT INTO dayoffinfo (id) VALUES (?);`).run(user);
      log.logFormat(`${user}'s dayoffinfo has been initialize.`, new Date());
    }

  }

  /**
   * Get dayoff info
   * @param {*} user 
   * @param {*} year 
   * @returns 
   */
  dayoff(user: string, year: digit): dayoffinfo | null {
    try {
      const sqldata = (this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ? `).get(user, year) as dayoffinfo | undefined);
      // console.log(sqldata);
      if (sqldata === undefined) return null;
      return sqldata;
    } catch (e) {
      console.warn(e);
      return null;
    }
  }

  /**
   * 
   * @param {*} user 
   * @param {*} type 
   * @param {*} start 
   * @param {*} end 
   * @returns 
   */
  async newRequest(user: string, type: string, start: string, end: string, totalTime: digit, reason: string): Promise<{ mgroup: digit, name: string, num: string, multiple: boolean } | null> {
    const query: userinfo = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo);
    const joinDate = new Date(query["joinTime"]);
    const now = new Date();
    const checkpoint: Date = new Date(`${end.split("-")[0]}-${query["joinTime"].substring(5)}`);
    const endDate: Date = new Date(end.split(" ")[0]);
    const year: string = checkpoint > endDate ? (parseInt(end.split("-")[0]) - 1).toString() : end.split("-")[0];
    const new_reason = reason.replace("<", "").replace(">", "").replace('"', '');
    const tTime = parseFloat(`${totalTime}`);

    // m = months joined
    const { m } = calculate(joinDate, now);

    const quotaInfoY = this.calculateAnnualQuota(user, year);
    const usedInYObj = this.login_db.prepare(`SELECT annual FROM dayoffinfo WHERE id= ? AND year= ?`).get(user, year) as dayoffinfo;
    const usedInY = usedInYObj ? (usedInYObj["annual"] as number) : 0;

    // Current Year Quota Available (q1)
    const q1 = quotaInfoY.separate ? (m < 6 ? 0 : 24 - usedInY) : (quotaInfoY.data[0].quota - usedInY);

    let tickets: { start: string, end: string, time: number, type: string }[] = [];
    if (type === "特休假") {
      if (tTime <= q1) {
        // Case 1: Quota sufficient, straightforward insertion
        tickets.push({ start, end, time: tTime, type: "特休假" });
      } else {
        // Case 2: Out of boundaries (Check Spillover Year + 1)
        const quotaInfoYPlus1 = this.calculateAnnualQuota(user, parseInt(year) + 1);
        const usedInYPlus1Obj = this.login_db.prepare(`SELECT annual FROM dayoffinfo WHERE id= ? AND year= ?`).get(user, parseInt(year) + 1) as dayoffinfo;
        const usedInYPlus1 = usedInYPlus1Obj ? (usedInYPlus1Obj["annual"] as number) : 0;

        const q2 = quotaInfoY.separate ? 24 : (quotaInfoYPlus1.data[0].quota - usedInYPlus1);

        if (q2 < (tTime - q1)) {
          log.logFormat(`${user} try to request a dayoff but exceed total quota.`);
          return null;
        }

        if (q1 > 0) {
          // Determine exact valid breakpoints skipping non-working days
          const startD = new Date(start);
          const rocYears = getROCYearsInRange(startD, startD);
          const allNonWorkingDays = await fetch_all_nwd(rocYears);

          // Fetch split logic that strictly complies with shift time requirements
          const splits = await getSplitTimestamp(start, q1, allNonWorkingDays);

          tickets.push({ start: start, end: splits.calc1, time: q1, type: "特休假" });
          tickets.push({ start: splits.calc2, end: end, time: tTime - q1, type: "特休假_N" });
        } else {
          // If q1 is flat 0, ONLY create 1 special ticket per requirement
          tickets.push({ start: start, end: end, time: tTime, type: "特休假_N" });
        }
      }
    } else {
      tickets.push({ start, end, time: tTime, type: type });
    }

    // Store into DB
    let lastCount = "";
    const multiple: boolean = tickets.length > 1;
    for (const t of tickets) {
      const currentYear = new Date().getFullYear();
      const serials: requestquery[] | [] = (this.login_db.prepare(`SELECT serialnum FROM requestquery WHERE serialnum LIKE ? ORDER BY serialnum ASC`).all(`${currentYear}%`) as requestquery[] | []);
      const count: string = serials[serials.length - 1] ? `${currentYear}${(parseInt(serials[serials.length - 1]["serialnum"].substring(4)) + 1).toString().padStart(4, '0')}` : `${currentYear}0000`;

      this.login_db.prepare(`INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,totalTime,reason,month,year) VALUES (?,?,?,?,(strftime('%Y-%m-%d %H:%M',?)),(strftime('%Y-%m-%d %H:%M',?)),?,?,?,?,?);`)
        .run(count, user, query["name"], t.type, t.start, t.end, query["mgroup"], t.time, new_reason, parseInt(start.split("-")[1]), year);

      lastCount = count;
      log.logFormat(`${user} just request a new dayoff. Ticket id: #${count}.`, new Date());
    }

    return { "mgroup": query["mgroup"], "name": query["name"], "num": lastCount, "multiple": multiple };
  }

  //  newRequest(user: string, type: string, start: string, end: string, totalTime: digit, reason: string): { mgroup: digit, name: string, num: string } | null {
  //    const query: userinfo = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo);
  //    const checkpoint: Date = new Date(`${end.split("-")[0]}-${query["joinTime"].substring(5)}`);
  //    const endDate: Date = new Date(end.split(" ")[0]);
  //    const year: string = checkpoint > endDate ? (parseInt(end.split("-")[0]) - 1).toString() : end.split("-")[0];
  //    const currentYear: number = new Date().getFullYear();
  //    const month: number = parseInt(start.split("-")[1]);
  //    const serials: requestquery[] | [] = (this.login_db.prepare(`SELECT serialnum FROM requestquery WHERE serialnum LIKE ? ORDER BY serialnum ASC`).all(`${currentYear}%`) as requestquery[] | []);
  //    const count: string = serials[serials.length - 1] ? `${currentYear}${(parseInt(serials[serials.length - 1]["serialnum"].substring(4)) + 1).toString().padStart(4, '0')}` : `${currentYear}0000`;
  //    const name: string = query["name"];
  //    const new_reason: string = reason.replace("<", "").replace(">", "").replace('"', '');
  //
  //    const { m, d } = calculate(new Date(start), new Date(end));
  //    if (this.checkRemainAnnual(user, parseInt(year), parseInt(`${totalTime}`), m < 6) == false) {
  //      log.logFormat(`${user} try to request a dayoff but exceed annual quota.`);
  //      return null;
  //    }
  //
  //    this.login_db.prepare(`INSERT INTO requestquery (serialnum,id,name,type,start,end,mgroup,totalTime,reason,month,year) VALUES (?,?,?,?,(strftime('%Y-%m-%d %H:%M',?)),(strftime('%Y-%m-%d %H:%M',?)),?,?,?,?,?);`).run(count, user, name, type, start, end, query["mgroup"], totalTime, new_reason, month, year);
  //    log.logFormat(`${user} just request a new dayoff. Ticket id: #${count}.`, new Date())
  //    return { "mgroup": query["mgroup"], "name": name, "num": count };
  //  }

  showQuery(user: string, state: number = 0, search_query: string = "", limit_query: string = ""): requestquery[] | [] {
    // const mgroup = this.login_db.prepare(`SELECT * FROM userinfo WHERE id='${user}'`).all()[0]["mgroup"];
    const query: requestquery[] | [] = (this.login_db.prepare(`SELECT serialnum,name,type,start,end,reason,totalTime FROM requestquery WHERE state= ? ${search_query} ${limit_query};`).all(state) as requestquery[] | []);
    // log.logFormat(`showquery executed with query: SELECT serialnum,name,type,start,end,reason,totalTime FROM requestquery WHERE state=${state} ${search_query} ${limit_query};`);
    return query;
  }

  setPermit(num: string, state: number): string {
    const query = (this.login_db.prepare(`SELECT * FROM requestquery WHERE serialnum= ? `).get(num) as requestquery);
    const year: string = query["year"];
    const table = {
      "特休假": "annual",
      "特休假_N": "annual_special",
      "事假": "personal",
      "家庭照顧假": "care",
      "病假": "sick",
      "婚假": "wedding",
      "喪假": "funeral",
      "分娩假": "birth",
      "產檢假": "pcheckup",
      "流產假": "miscarriage",
      "陪產假": "paternity",
      "產假": "maternity",
      "公假": "official",
      "停班停課": "typhoon",
      "其他": "other"
    };
    console.log(query["type"]);

    if (state == 1) {
      if (table[(query["type"] as keyof dayofftype)] == "annual_special") {
        const ny: number = parseInt(year) + 1;
        if (!this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(query["id"], ny)) {
          this.init(query["id"], ny);
        }

        this.login_db.prepare(`UPDATE dayoffinfo SET annual=annual+? WHERE id= ? AND year= ?;`).run(query["totalTime"], query["id"], ny);
      } else {
        if (!this.login_db.prepare(`SELECT * FROM dayoffinfo WHERE id= ? AND year= ?;`).get(query["id"], year)) {
          this.init(query["id"], year);
        }

        this.login_db.prepare(`UPDATE dayoffinfo SET ${table[(query["type"] as keyof dayofftype)]}=${table[(query["type"] as keyof dayofftype)]}+? WHERE id= ? AND year= ?;`).run(query["totalTime"], query["id"], year);
      }
    }
    this.login_db.prepare(`UPDATE requestquery SET state= ? WHERE serialnum= ?;`).run(state, num);
    log.logFormat(`Dayoff ticket #${num} has been set to ${state ? "accepted" : "denied"}.`);
    return (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(query["id"]) as userinfo)["email"];
  }

  /**
   * The function check if the user requires the permission to have a dayoff
   * @param {*} user 
   * @returns {number|null} 1 means require a permission
   */
  getPermission(user: string): userinfo["permit"] | null {
    const query = (this.login_db.prepare(`SELECT permit FROM userinfo WHERE id= ? `).get(user) as userinfo | undefined);
    if (query) return query["permit"];
    return null
  }

  clockinAction(user: string, type: number, now: Date): clockinrecord[] | { status: digit } | null {
    const year: number = now.getFullYear();
    const month: digit = now.getMonth() + 1 > 9 ? (now.getMonth() + 1) : '0' + (now.getMonth() + 1).toString();
    const date: digit = now.getDate() > 9 ? (now.getDate()) : '0' + (now.getDate()).toString();
    const hour: string = now.getHours() > 9 ? (now.getHours().toString()) : '0' + (now.getHours()).toString();
    const min: digit = now.getMinutes() > 9 ? (now.getMinutes()) : '0' + (now.getMinutes()).toString();
    var datetime: string;
    if (parseInt(hour) >= 18) {
      datetime = `${year}-${month}-${date} 18:00`;
    } else {
      datetime = `${year}-${month}-${date} ${hour}:${min}`;
    }
    const today = datetime.split(" ")[0];
    const nowTime = datetime.split(" ")[1];
    const data: clockinrecord[] = (this.login_db.prepare(`SELECT * FROM clockinrecord WHERE date= ? AND id= ? AND deleted = 0 ORDER BY num;`).all(today, user) as clockinrecord[]);
    if (type == 0) {
      return data;
    }
    const column = type == 1 ? "clockin" : "clockout";
    // Duplicate guard: same kind of punch less than 5 minutes after the previous one is not recorded.
    if (isDuplicatePunch(data.map((row) => row[column]), nowTime)) {
      return { "status": 409 };
    }
    const name: string = (this.login_db.prepare(`SELECT name FROM userinfo WHERE id= ?;`).get(user) as userinfo)["name"];
    // Fill the first live segment missing this kind of punch, otherwise open a new segment.
    const target = data.find((row) => !row[column]);
    if (target) {
      this.login_db.prepare(`UPDATE clockinrecord SET ${column}= ? WHERE id= ? AND num= ? AND date= ?;`).run(nowTime, user, target.num, today);
      return { "status": 200 };
    }
    // num must stay unique per person/day, soft-deleted segments included.
    const maxRow = this.login_db.prepare(`SELECT MAX(num) AS maxNum FROM clockinrecord WHERE id= ? AND date= ?;`).get(user, today) as { maxNum: number | null };
    const nextNum = (maxRow.maxNum || 0) + 1;
    this.login_db.prepare(`INSERT INTO clockinrecord (id,name,date,${column},num) VALUES (?,?,?,?,?);`).run(user, name, today, nowTime, nextNum);
    return { "status": 200 };
  }

  showPersonalQuery(user: string, year: string): requestquery[] | [] {
    const query = (this.login_db.prepare(`SELECT serialnum,name,type,start,end,reason,totalTime,state FROM requestquery WHERE id= ? AND year= ? `).all(user, year) as requestquery[] | []);
    return query;
  }

  deleteAccount(user: string): void {
    this.login_db.prepare(`DELETE FROM userinfo WHERE id= ? `).run(user);
    return;
  }

  calculateAnnualQuota(user: string, year: digit): { separate: boolean, data: { quota: number, years: number, month: number, days: number, joinTime: string }[] } {
    const db_jt: string = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ? `).get(user) as userinfo)["joinTime"];
    const joinTime: Date = new Date(db_jt);
    const month: number = parseInt(db_jt.split("-")[1]);
    const endTime: Date = month == -1 ? new Date(`${year}-${db_jt.split("-")[1]}-${db_jt.split("-")[2]}`) : new Date(`${year}-${month}-${db_jt.split("-")[2]}`);
    const elapse: { m: number, d: number } = calculate(joinTime, endTime);
    const months = elapse['m'], days = elapse['d'];
    const years = months / 12;
    const realMonth: number = (months - (Math.floor(years) * 12));
    var quota: number = 0;
    console.log(`Calculating annual quota for ${user} in ${year}-${month}. Join time: ${db_jt}, Elapsed: ${years} years, ${realMonth} months, ${days} days.`);
    if (years < 1) {
      return { separate: true, data: [{ "quota": 0, "years": Math.floor(years) + (realMonth < 6 ? 0 : 0.5), "month": realMonth, "days": days, "joinTime": db_jt }, { "quota": 3 * 8, "years": Math.floor(years) + (realMonth < 6 ? 0 : 0.5), "month": 6, "days": days, "joinTime": db_jt }] };
    } else if (years >= 1 && years < 2) {
      quota = 7;
    } else if (years >= 2 && years < 3) {
      quota = 10;
    } else if (years >= 3 && years < 5) {
      quota = 14;
    } else if (years >= 5 && years < 10) {
      quota = 15;
    } else if (years >= 10) {
      const w = Math.floor(years) + 6;
      quota = (w >= 30 ? 30 : w);
    }

    return { separate: false, data: [{ "quota": quota * 8, "years": Math.floor(years) + (realMonth < 6 ? 0 : 0.5), "month": realMonth, "days": days, "joinTime": db_jt }] };

  }

  showQueryInMonth(year: number, month: number): requestquery[] | [] {
    const query = (this.login_db.prepare(`SELECT name,start,end,type FROM requestquery WHERE state=1 AND start LIKE ? `).all(`${year}-${month.toString().padStart(2, '0')}%`) as requestquery[] | []);
    return query;
  }

  checkRemainAnnual(user: string, year: digit, adds: number, first_half: boolean): boolean {
    const quotaData = this.calculateAnnualQuota(user, year);
    const used = (this.login_db.prepare(`SELECT annual FROM dayoffinfo WHERE id= ? AND year= ?`).get(user, year) as dayoffinfo)["annual"] as number;
    if (quotaData.separate) {
      const q = first_half ? 0 : 24
      if (used + adds <= q) {
        return true;
      }
    } else {
      const quota = quotaData.data[0]["quota"];
      if (used + adds <= quota) {
        return true;
      }
    }
    return false;
  }

  /**
   * 
   * @param {string} year 
   * @param {string} month 
   */
  async clockinRecord(year: digit, month: digit): Promise<[] | clockinrecord[]> {
    const query = (this.login_db.prepare(`SELECT * FROM clockinrecord WHERE date LIKE ? AND deleted = 0;`).all(`${year}-${month}-%`) as clockinrecord[] | []);
    return new Promise(res => { res(query) });
  }

  clockinYears(): number[] {
    const rows = this.login_db.prepare(`SELECT DISTINCT substr(date, 1, 4) AS year FROM clockinrecord ORDER BY year;`).all() as Array<{ year: string }>;
    return rows
      .map((row) => parseInt(row.year, 10))
      .filter((year) => !Number.isNaN(year));
  }

  syncTickets(user: string, year: digit): void {
    const tickets = (this.login_db.prepare(`SELECT * FROM requestquery WHERE id= ? AND year= ? AND state=1;`).all(user, year) as requestquery[] | []);
    const ny: number = parseInt(`${year}`) + 1;
    const last_tickets = (this.login_db.prepare(`SELECT * FROM requestquery WHERE id= ? AND year= ? AND state=1;`).all(user, ny - 2) as requestquery[] | []);
    const table = {
      "特休假": "annual",
      "特休假_N": "annual_special",
      "事假": "personal",
      "家庭照顧假": "care",
      "病假": "sick",
      "婚假": "wedding",
      "喪假": "funeral",
      "分娩假": "birth",
      "產檢假": "pcheckup",
      "流產假": "miscarriage",
      "陪產假": "paternity",
      "產假": "maternity",
      "公假": "official",
      "停班停課": "typhoon",
      "其他": "other"
    };
    const amount = {
      "annual": 0,
      "annual_special": 0,
      "personal": 0,
      "care": 0,
      "sick": 0,
      "wedding": 0,
      "funeral": 0,
      "birth": 0,
      "pcheckup": 0,
      "miscarriage": 0,
      "paternity": 0,
      "maternity": 0,
      "official": 0,
      "typhoon": 0,
      "other": 0
    };
    const last_amount = {
      "annual": 0,
      "annual_special": 0,
      "personal": 0,
      "care": 0,
      "sick": 0,
      "wedding": 0,
      "funeral": 0,
      "birth": 0,
      "pcheckup": 0,
      "miscarriage": 0,
      "paternity": 0,
      "maternity": 0,
      "official": 0,
      "typhoon": 0,
      "other": 0
    };
    type atp = {
      "annual": 0,
      "annual_special": 0,
      "personal": 0,
      "care": 0,
      "sick": 0,
      "wedding": 0,
      "funeral": 0,
      "birth": 0,
      "pcheckup": 0,
      "miscarriage": 0,
      "paternity": 0,
      "maternity": 0,
      "official": 0,
      "typhoon": 0,
      "other": 0
    };
    for (let ticket of tickets) {
      amount[(table[(ticket["type"] as keyof dayofftype)] as keyof atp)] += ticket["totalTime"];
    }
    for (let ticket of last_tickets) {
      last_amount[(table[(ticket["type"] as keyof dayofftype)] as keyof atp)] += ticket["totalTime"];
    }
    this.init(user, year);
    var amount_array: string[] = [];
    amount["annual"] += last_amount["annual_special"];
    const values = [];
    for (let type of Object.keys(amount)) {
      if (type == "undefined") continue;
      // console.log(type);
      if (type == "annual_special") {
        continue;
      }
      amount_array.push(`${type} = ? `);
      values.push(amount[(type as keyof atp)]);
    }
    values.push(user, year);
    let queryString = amount_array.join(", ");
    log.logFormat(`Syncing ${user}'s data with query: ${queryString}`);
    this.login_db.prepare(`UPDATE dayoffinfo SET ${queryString} WHERE id= ? AND year= ?;`).run(values);
    return;
  }

  resyncEmployeeDayoff(user: string): void {
    const years = this.login_db.prepare(`SELECT DISTINCT year FROM dayoffinfo WHERE id= ? UNION SELECT DISTINCT year FROM requestquery WHERE id= ?;`).all(user, user) as Array<{ year: string }>;
    years.forEach((yearInfo) => {
      this.syncTickets(user, yearInfo.year);
    });
  }

  modifyTicket(num: string, action: number, type: string, start: string, end: string, totalTime: number, state: digit, reason: string): number | null {
    const ticket = (this.login_db.prepare(`SELECT * FROM requestquery WHERE serialnum= ?;`).get(num) as requestquery);
    const user = ticket["id"];
    const query = (this.login_db.prepare(`SELECT * FROM userinfo WHERE id= ?;`).get(user) as userinfo);
    // const userinfo = this.login_db.prepare(`SELECT * FROM userinfo WHERE id='${query["id"]}'`).all()[0];
    const checkpoint = new Date(`${end.split("-")[0]}-${query["joinTime"].substring(5)}`);
    const endDate = new Date(end.split(" ")[0]);
    const year = checkpoint > endDate ? (parseInt(end.split("-")[0]) - 1).toString() : end.split("-")[0];
    if (action == 0) {
      // Delete
      this.login_db.prepare(`DELETE FROM requestquery WHERE serialnum= ?;`).run(num);
      log.logFormat(`Ticket #${num} has been DELETED.`);
      this.syncTickets(user, ticket["year"]);
      return 0;
    }
    const { m, d } = calculate(new Date(start), new Date(end));
    if (this.checkRemainAnnual(user, parseInt(year), parseInt(`${totalTime}`) - ticket.totalTime, m < 6) == false) {
      log.logFormat(`${user} try to request a dayoff but exceed annual quota.`);
      return null;
    }
    const new_reason: string = reason.replace("<", "").replace(">", "").replace('"', '');
    this.login_db.prepare(`UPDATE requestquery SET type= ?, start= ?, end= ?, totalTime= ?, state= ?, year= ?, reason= ? WHERE serialnum= ?;`).run(type, start, end, totalTime, state, year, new_reason, num);
    // log.logFormat(`Ticket #${num} from ${user} has been MODIFIED: type='${type}', start='${start}', end='${end}', totalTime=${totalTime}, state=${state}, year='${year}'`);
    this.syncTickets(user, ticket["year"]);
    return 0;
  }

  modifyEmployeeInfo(user: string, pwd: string, type: string, email: string, name: string, joinTime: string, mgroup: digit, permit: digit, status: digit, leaveDate: string | null): void {
    this.login_db.prepare(`UPDATE userinfo SET pwd= ?,type= ?,email= ?,name= ?,joinTime= ?,mgroup= ?,permit= ?,status= ?,leaveDate= ? WHERE id= ?;`).run(pwd, type, email, name, joinTime, mgroup, permit, status, leaveDate, user);
    return;
  }

  getUser(id: string): userinfo | null {
    const row = this.login_db.prepare(`SELECT * FROM userinfo WHERE id = ?;`).get(id) as userinfo | undefined;
    return row ? row : null;
  }

  clockinEditsForMonth(year: string | number, month: string | number): ClockEdit[] {
    const parts = this.clockMonthParts(year, month);
    const rows = this.login_db.prepare(
      `SELECT id, date, name, clockin, clockout, reason, editor_id, editor_name, edited_at
       FROM clockin_edit WHERE date LIKE ?;`
    ).all(`${parts.year}-${parts.month}-%`) as ClockEditSqlRow[];
    return rows.map((row) => this.toClockEdit(row));
  }

  clockinEditsForDate(date: string): ClockEdit[] {
    const rows = this.login_db.prepare(
      `SELECT id, date, name, clockin, clockout, reason, editor_id, editor_name, edited_at
       FROM clockin_edit WHERE date = ?;`
    ).all(date) as ClockEditSqlRow[];
    return rows.map((row) => this.toClockEdit(row));
  }

  saveClockinEdit(input: {
    id: string;
    date: string;
    name: string;
    clockin: string | null;
    clockout: string | null;
    reason: string;
    editorId: string;
    editorName: string;
  }): void {
    this.login_db.prepare(
      `INSERT INTO clockin_edit (id, date, name, clockin, clockout, reason, editor_id, editor_name, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M', 'now', '+8 hours'))
       ON CONFLICT(id, date) DO UPDATE SET
         name = excluded.name,
         clockin = excluded.clockin,
         clockout = excluded.clockout,
         reason = excluded.reason,
         editor_id = excluded.editor_id,
         editor_name = excluded.editor_name,
         edited_at = strftime('%Y-%m-%d %H:%M', 'now', '+8 hours');`
    ).run(
      input.id,
      input.date,
      input.name,
      normalizeTime(input.clockin),
      normalizeTime(input.clockout),
      input.reason,
      input.editorId,
      input.editorName
    );
  }

  /** Segments of one person/day ordered by num. Soft-deleted ones only when `includeDeleted`. */
  clockinSegmentsForDay(id: string, date: string, includeDeleted: boolean = false): ClockSegmentRow[] {
    const rows = this.login_db.prepare(
      `SELECT num, clockin, clockout, deleted FROM clockinrecord
       WHERE id = ? AND date = ? ${includeDeleted ? '' : 'AND deleted = 0'} ORDER BY num;`
    ).all(id, date) as Array<{ num: number; clockin: string | null; clockout: string | null; deleted: number }>;
    return rows.map((row) => ({
      num: row.num,
      clockin: normalizeTime(row.clockin),
      clockout: normalizeTime(row.clockout),
      deleted: Number(row.deleted) === 1,
    }));
  }

  clockinSegmentLog(id: string, date: string): ClockSegmentLogEntry[] {
    const rows = this.login_db.prepare(
      `SELECT seq, num, action, old_clockin, old_clockout, new_clockin, new_clockout, reason, editor_id, editor_name, edited_at
       FROM clockin_segment_log WHERE id = ? AND date = ? ORDER BY seq;`
    ).all(id, date) as Array<{
      seq: number; num: number; action: string; old_clockin: string | null; old_clockout: string | null;
      new_clockin: string | null; new_clockout: string | null; reason: string; editor_id: string; editor_name: string; edited_at: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      num: row.num,
      action: row.action,
      oldClockin: row.old_clockin,
      oldClockout: row.old_clockout,
      newClockin: row.new_clockin,
      newClockout: row.new_clockout,
      reason: row.reason,
      editorId: row.editor_id,
      editorName: row.editor_name,
      editedAt: row.edited_at,
    }));
  }

  /** Latest segment-level correction per person/day for a month (clockin/clockout fields unused). */
  clockinSegmentSummariesForMonth(year: string | number, month: string | number): ClockEdit[] {
    const parts = this.clockMonthParts(year, month);
    return this.segmentSummaries(`${parts.year}-${parts.month}-%`, true);
  }

  clockinSegmentSummariesForDate(date: string): ClockEdit[] {
    return this.segmentSummaries(date, false);
  }

  hasClockinSegmentLog(id: string, date: string): boolean {
    return this.login_db.prepare(`SELECT 1 FROM clockin_segment_log WHERE id = ? AND date = ? LIMIT 1;`).get(id, date) != null;
  }

  editClockinSegment(input: SegmentEditInput & { num: number }): SegmentEditResult {
    return this.runSegmentEdit(input, (live) => {
      const target = live.find((segment) => segment.num === input.num);
      if (!target) {
        return { ok: false, status: 404, message: '找不到這一段' };
      }
      const decision = decideSegmentEdit(target, input);
      if (!decision.ok) {
        return { ok: false, status: 400, message: decision.message };
      }
      if (decision.kind === 'unchanged') {
        return { ok: true, status: 'unchanged', num: target.num };
      }
      this.login_db.prepare(`UPDATE clockinrecord SET clockin = ?, clockout = ? WHERE id = ? AND date = ? AND num = ?;`)
        .run(decision.clockin, decision.clockout, input.id, input.date, target.num);
      this.logSegment(input, target.num, 'update', target, { clockin: decision.clockin, clockout: decision.clockout }, decision.reason);
      return { ok: true, status: 'saved', num: target.num };
    });
  }

  addClockinSegment(input: SegmentEditInput): SegmentEditResult {
    return this.runSegmentEdit(input, () => {
      const decision = decideSegmentEdit({ clockin: null, clockout: null }, input);
      if (!decision.ok) {
        return { ok: false, status: 400, message: decision.message };
      }
      if (decision.kind === 'unchanged') {
        return { ok: false, status: 400, message: '上班與下班至少填一個' };
      }
      const nextNum = this.nextSegmentNum(input.id, input.date);
      this.login_db.prepare(`INSERT INTO clockinrecord (id, name, date, clockin, clockout, num) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(input.id, input.name, input.date, decision.clockin, decision.clockout, nextNum);
      this.logSegment(input, nextNum, 'add', { clockin: null, clockout: null }, { clockin: decision.clockin, clockout: decision.clockout }, decision.reason);
      return { ok: true, status: 'saved', num: nextNum };
    });
  }

  /** Soft delete: the row stays in clockinrecord with deleted = 1 and is logged. */
  deleteClockinSegment(input: SegmentEditInput & { num: number }): SegmentEditResult {
    return this.runSegmentEdit(input, (live) => {
      const target = live.find((segment) => segment.num === input.num);
      if (!target) {
        return { ok: false, status: 404, message: '找不到這一段' };
      }
      const reason = validateReason(input.reason);
      if (!reason.ok) {
        return { ok: false, status: 400, message: reason.message };
      }
      this.login_db.prepare(`UPDATE clockinrecord SET deleted = 1 WHERE id = ? AND date = ? AND num = ?;`).run(input.id, input.date, target.num);
      this.logSegment(input, target.num, 'delete', target, { clockin: null, clockout: null }, reason.reason);
      return { ok: true, status: 'saved', num: target.num };
    });
  }

  private runSegmentEdit(input: SegmentEditInput, action: (live: ClockSegmentRow[]) => SegmentEditResult): SegmentEditResult {
    const run = this.login_db.transaction((): SegmentEditResult => {
      this.foldLegacyEdit(input.id, input.date, input.name);
      const live = this.clockinSegmentsForDay(input.id, input.date, false);
      const result = action(live);
      if (!result.ok || result.status === 'unchanged') {
        // Roll back the legacy fold too, so a rejected or no-op request changes nothing.
        throw new SegmentRejected(result);
      }
      return result;
    });
    try {
      return run();
    } catch (e) {
      if (e instanceof SegmentRejected) {
        return e.result;
      }
      throw e;
    }
  }

  /**
   * First segment edit of a day that has a legacy clockin_edit row: copy its first-in / last-out into
   * the segments (logged as 'legacy-merge') so the day looks the same. The clockin_edit row is kept.
   */
  private foldLegacyEdit(id: string, date: string, name: string): void {
    if (this.hasClockinSegmentLog(id, date)) {
      return;
    }
    const legacy = this.login_db.prepare(
      `SELECT clockin, clockout, reason, editor_id, editor_name, edited_at FROM clockin_edit WHERE id = ? AND date = ?;`
    ).get(id, date) as { clockin: string | null; clockout: string | null; reason: string; editor_id: string; editor_name: string; edited_at: string } | undefined;
    if (!legacy) {
      return;
    }
    const live = this.clockinSegmentsForDay(id, date, false);
    const changes = mergeLegacyEdit(live, { clockin: normalizeTime(legacy.clockin), clockout: normalizeTime(legacy.clockout) }, this.nextSegmentNum(id, date));
    const insertLog = this.login_db.prepare(
      `INSERT INTO clockin_segment_log (id, date, num, action, old_clockin, old_clockout, new_clockin, new_clockout, reason, editor_id, editor_name, edited_at)
       VALUES (?, ?, ?, 'legacy-merge', ?, ?, ?, ?, ?, ?, ?, ?);`
    );
    for (const change of changes) {
      if (change.created) {
        this.login_db.prepare(`INSERT INTO clockinrecord (id, name, date, clockin, clockout, num) VALUES (?, ?, ?, ?, ?, ?);`)
          .run(id, name, date, change.after.clockin, change.after.clockout, change.num);
      } else {
        this.login_db.prepare(`UPDATE clockinrecord SET clockin = ?, clockout = ? WHERE id = ? AND date = ? AND num = ?;`)
          .run(change.after.clockin, change.after.clockout, id, date, change.num);
      }
      insertLog.run(id, date, change.num, change.before.clockin, change.before.clockout, change.after.clockin, change.after.clockout,
        legacy.reason || '舊補正', legacy.editor_id, legacy.editor_name, legacy.edited_at);
    }
    if (changes.length === 0) {
      // Nothing to copy, but still mark the day as segment-mode with an audit row.
      insertLog.run(id, date, 0, null, null, normalizeTime(legacy.clockin), normalizeTime(legacy.clockout),
        legacy.reason || '舊補正', legacy.editor_id, legacy.editor_name, legacy.edited_at);
    }
  }

  private nextSegmentNum(id: string, date: string): number {
    const row = this.login_db.prepare(`SELECT MAX(num) AS maxNum FROM clockinrecord WHERE id = ? AND date = ?;`).get(id, date) as { maxNum: number | null };
    return (row.maxNum || 0) + 1;
  }

  private logSegment(
    input: SegmentEditInput,
    num: number,
    action: string,
    before: { clockin: string | null; clockout: string | null },
    after: { clockin: string | null; clockout: string | null },
    reason: string
  ): void {
    this.login_db.prepare(
      `INSERT INTO clockin_segment_log (id, date, num, action, old_clockin, old_clockout, new_clockin, new_clockout, reason, editor_id, editor_name, edited_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M', 'now', '+8 hours'));`
    ).run(input.id, input.date, num, action, before.clockin, before.clockout, after.clockin, after.clockout, reason, input.editorId, input.editorName);
  }

  private segmentSummaries(datePattern: string, like: boolean): ClockEdit[] {
    const rows = this.login_db.prepare(
      `SELECT l.id, l.date, l.reason, l.editor_id, l.editor_name, l.edited_at
       FROM clockin_segment_log l
       JOIN (SELECT id, date, MAX(seq) AS seq FROM clockin_segment_log WHERE date ${like ? 'LIKE' : '='} ? GROUP BY id, date) latest
         ON latest.seq = l.seq;`
    ).all(datePattern) as Array<{ id: string; date: string; reason: string; editor_id: string; editor_name: string; edited_at: string }>;
    return rows.map((row) => ({
      id: row.id,
      name: '',
      date: row.date,
      clockin: null,
      clockout: null,
      reason: row.reason || '',
      editorId: row.editor_id,
      editorName: row.editor_name,
      editedAt: row.edited_at,
    }));
  }

  replaceClockinMaster(year: string | number, month: string | number, rows: ClockSheetRow[]): void {
    const parts = this.clockMonthParts(year, month);
    const remove = this.login_db.prepare(`DELETE FROM clockin_master_row WHERE year = ? AND month = ?;`);
    const insert = this.login_db.prepare(
      `INSERT INTO clockin_master_row (year, month, date, id, name, clockin, clockout, modified, reason, edited_at, work_minutes, incomplete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
    );
    const mark = this.login_db.prepare(
      `INSERT INTO clockin_master (year, month, generated_at)
       VALUES (?, ?, strftime('%Y-%m-%d %H:%M', 'now', '+8 hours'))
       ON CONFLICT(year, month) DO UPDATE SET
         generated_at = strftime('%Y-%m-%d %H:%M', 'now', '+8 hours');`
    );
    const writeRows = this.login_db.transaction(() => {
      remove.run(parts.year, parts.month);
      for (const row of rows) {
        insert.run(
          parts.year,
          parts.month,
          row.date,
          row.id,
          row.name,
          row.clockin,
          row.clockout,
          row.modified ? 1 : 0,
          row.modified ? row.reason : '',
          row.modified ? row.editedAt : null,
          row.workMinutes,
          row.incompleteSegments
        );
      }
      mark.run(parts.year, parts.month);
    });
    writeRows();
  }

  clockinMasterReady(year: string | number, month: string | number): boolean {
    const parts = this.clockMonthParts(year, month);
    const row = this.login_db.prepare(`SELECT 1 AS ready FROM clockin_master WHERE year = ? AND month = ?;`).get(parts.year, parts.month);
    return row != null;
  }

  clockinMasterRows(year: string | number, month: string | number, id?: string): ClockSheetRow[] {
    const parts = this.clockMonthParts(year, month);
    const rows = (id == null
      ? this.login_db.prepare(
        `SELECT date, id, name, clockin, clockout, modified, reason, edited_at, work_minutes, incomplete
         FROM clockin_master_row WHERE year = ? AND month = ?;`
      ).all(parts.year, parts.month)
      : this.login_db.prepare(
        `SELECT date, id, name, clockin, clockout, modified, reason, edited_at, work_minutes, incomplete
         FROM clockin_master_row WHERE year = ? AND month = ? AND id = ?;`
      ).all(parts.year, parts.month, id)) as ClockMasterSqlRow[];
    const mapped = rows.map((row) => this.toClockSheetRow(row));
    mapped.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id, 'zh-Hant', { numeric: true, sensitivity: 'base' }));
    return mapped;
  }

  employeeIdsWithMonthActivity(year: string | number, month: string | number): string[] {
    const parts = this.clockMonthParts(year, month);
    const prefix = `${parts.year}-${parts.month}-%`;
    const rows = this.login_db.prepare(
      `SELECT id FROM clockinrecord WHERE date LIKE ?
       UNION
       SELECT id FROM clockin_edit WHERE date LIKE ?
       UNION
       SELECT id FROM clockin_master_row WHERE year = ? AND month = ?;`
    ).all(prefix, prefix, parts.year, parts.month) as Array<{ id: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.id) {
        ids.push(row.id);
      }
    }
    return ids;
  }

  approvedLeaveIdsOnDate(date: string): string[] {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return [];
    }
    const rows = this.login_db.prepare(
      `SELECT DISTINCT id FROM requestquery
       WHERE state = 1 AND date(start) <= ? AND date(end) >= ?;`
    ).all(date, date) as Array<{ id: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      if (row.id) {
        ids.push(row.id);
      }
    }
    return ids;
  }

  private clockMonthParts(year: string | number, month: string | number): { year: string; month: string } {
    return {
      year: String(year),
      month: String(month).padStart(2, '0'),
    };
  }

  private toClockEdit(row: ClockEditSqlRow): ClockEdit {
    return {
      id: row.id,
      name: row.name || '',
      date: row.date,
      clockin: normalizeTime(row.clockin),
      clockout: normalizeTime(row.clockout),
      reason: row.reason || '',
      editorId: row.editor_id,
      editorName: row.editor_name,
      editedAt: row.edited_at,
    };
  }

  private toClockSheetRow(row: ClockMasterSqlRow): ClockSheetRow {
    const modified = Number(row.modified) === 1;
    return {
      id: row.id,
      name: row.name || '',
      date: row.date,
      clockin: normalizeTime(row.clockin),
      clockout: normalizeTime(row.clockout),
      modified,
      reason: modified ? (row.reason || '') : '',
      editorName: null,
      editedAt: modified ? (row.edited_at || null) : null,
      workMinutes: Number(row.work_minutes) || 0,
      incompleteSegments: Number(row.incomplete) || 0,
    };
  }

}

export type ClockSegmentRow = Segment & { deleted: boolean };

export type ClockSegmentLogEntry = {
  seq: number;
  num: number;
  action: string;
  oldClockin: string | null;
  oldClockout: string | null;
  newClockin: string | null;
  newClockout: string | null;
  reason: string;
  editorId: string;
  editorName: string;
  editedAt: string;
};

export type SegmentEditInput = {
  id: string;
  name: string;
  date: string;
  clockin?: string | null;
  clockout?: string | null;
  reason: string;
  editorId: string;
  editorName: string;
};

export type SegmentEditResult =
  | { ok: true; status: 'saved' | 'unchanged'; num: number }
  | { ok: false; status: 400 | 404; message: string };

class SegmentRejected extends Error {
  constructor(public result: SegmentEditResult) {
    super('segment edit rejected');
  }
}

type ClockEditSqlRow = {
  id: string;
  date: string;
  name: string;
  clockin: string | null;
  clockout: string | null;
  reason: string | null;
  editor_id: string;
  editor_name: string;
  edited_at: string;
};

type ClockMasterSqlRow = {
  date: string;
  id: string;
  name: string;
  clockin: string | null;
  clockout: string | null;
  modified: number;
  reason: string | null;
  edited_at: string | null;
  work_minutes: number | null;
  incomplete: number | null;
};

function calculate(startDate: Date, endDate: Date): { m: number, d: number } {
  if (!(startDate instanceof Date) || isNaN(startDate.getTime())) {
    throw new Error("Invalid date. Please provide a valid startDate as a Date object.");
  }

  // const endDate = new Date();

  let months = (endDate.getFullYear() - startDate.getFullYear()) * 12;
  months += endDate.getMonth() - startDate.getMonth();
  let days = endDate.getDate() - startDate.getDate();

  if (days < 0) {
    months -= 1;
    const previousMonth = new Date(endDate.getFullYear(), endDate.getMonth(), 0); // Last day of previous month
    days += previousMonth.getDate(); // Add days from previous month
  }

  return { "m": months, "d": days };
}
