$(function () {
    const sessionKey = readCookie("session");
    const userId = readCookie("id");

    if (!sessionKey || !userId) {
        alert("請重新登入！");
        window.location.href = window.location.origin;
        return;
    }

    $("#navbar-container").load("../admin/navbar.html");

    const apiBase = `${window.location.protocol}//${window.location.hostname}:3000`;
    const editModal = new bootstrap.Modal(document.getElementById("clockinEditModal"));
    let viewToken = 0;
    let directoryToken = 0;
    let periodToken = 0;
    let editSession = 0;
    let editingTarget = null;
    let savingEdit = false;

    async function fetchAvailableYears() {
        const url = `${apiBase}/api/clockin/years?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin years", resp.status);
                return [];
            }
            const data = await resp.json();
            return Array.isArray(data?.years) ? data.years.map((year) => parseInt(year, 10)).filter((year) => !Number.isNaN(year)) : [];
        } catch (error) {
            console.error(error);
            return [];
        }
    }

    function populateYearOptions(years) {
        const select = $("#year");
        const uniqueYears = Array.from(new Set(years)).sort((a, b) => a - b);
        const nowYear = new Date().getFullYear();
        const fallbackYear = uniqueYears.includes(nowYear) ? nowYear : (uniqueYears[uniqueYears.length - 1] || nowYear);

        select.empty();
        uniqueYears.forEach((year) => {
            select.append($("<option>").val(String(year)).text(`${year}年`));
        });

        if (uniqueYears.length === 0) {
            select.append($("<option>").val(String(fallbackYear)).text(`${fallbackYear}年`));
        }

        select.val(String(fallbackYear));
    }

    function updateDayOptions() {
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);
        const totalDays = new Date(year, month, 0).getDate();
        const currentDay = String($("#day").val() || new Date().getDate());
        let options = "";
        for (let day = 1; day <= totalDays; day++) {
            options += `<option value="${day}">${day}日</option>`;
        }
        $("#day").html(options);
        const maxDay = Math.min(parseInt(currentDay, 10), totalDays);
        $("#day").val(String(maxDay));
    }

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function attr(value) {
        if (value == null) return "";
        return escapeHtml(value);
    }

    function displayValue(value) {
        if (value == null || String(value).trim() === "") return "無";
        return escapeHtml(value);
    }

    function missingTime(value) {
        return value == null || String(value).trim() === "";
    }

    function formatDate(year, month, day) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }

    function toTimeInput(value) {
        if (value == null) return "";
        const match = String(value).trim().match(/(?:^|\s)(\d{1,2}):(\d{2})(?::\d{2})?$/);
        if (!match) return "";
        const hour = Number(match[1]);
        const minute = Number(match[2]);
        if (hour > 23 || minute > 59) return "";
        return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }

    function selectedEmployeeId() {
        return $("#employee").val() || "";
    }

    function downloadTitle(downloadable, masterReady) {
        if (downloadable === true) return "";
        return masterReady === true ? "總表沒有這位員工的紀錄" : "請先重新載入，產生該月總表";
    }

    function editButton(id, name, date, clockin, clockout) {
        return `<button type="button" class="btn btn-sm btn-outline-primary record-edit-btn" data-id="${attr(id)}" data-name="${attr(name)}" data-date="${attr(date)}" data-clockin="${attr(clockin)}" data-clockout="${attr(clockout)}">補正</button>`;
    }

    function downloadButton(id, name, downloadable, masterReady) {
        const title = downloadTitle(downloadable, masterReady);
        const disabled = downloadable === true ? "" : " disabled";
        const titleAttr = title ? ` title="${attr(title)}"` : "";
        const button = `<button type="button" class="btn btn-sm btn-outline-secondary record-download-btn" data-id="${attr(id)}" data-name="${attr(name)}"${disabled}${titleAttr}>下載該月紀錄</button>`;
        if (!title) return button;
        return `<span class="record-download-wrap" title="${attr(title)}">${button}</span>`;
    }

    async function fetchDayView(year, month, day) {
        const url = `${apiBase}/api/clockin/view?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}&day=${day}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin data", resp.status);
                return null;
            }
            return await resp.json();
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    async function fetchDirectory(year, month) {
        const url = `${apiBase}/api/clockin/directory?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch clockin directory", resp.status);
                return null;
            }
            const data = await resp.json();
            return Array.isArray(data?.employees) ? data.employees : [];
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    async function fetchEmployee(year, month, id) {
        const url = `${apiBase}/api/clockin/employee?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${year}&month=${month}&id=${encodeURIComponent(id)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                console.warn("Failed to fetch employee clockin", resp.status);
                return null;
            }
            return await resp.json();
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    function renderDay(data, year, month, day) {
        if (!data || !Array.isArray(data.records)) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得打卡資料。</div>');
            return;
        }

        const targetDate = formatDate(year, month, day);
        const masterReady = data.masterReady === true;
        setMasterDownload(masterReady);
        const sortedRecords = data.records.slice().sort((a, b) => {
            const aId = String(a.id || "");
            const bId = String(b.id || "");
            return aId.localeCompare(bId, "zh-Hant", { numeric: true, sensitivity: "base" });
        });
        let html = `<div class="record-summary">${targetDate}</div><div class="record-grid">`;

        for (const record of sortedRecords) {
            const modified = Boolean(record.modified);
            const modifiedRows = modified
                ? `<div class="record-card-row"><span>修改原因</span><span>${displayValue(record.reason)}</span></div>
                    <div class="record-card-row"><span>修改的管理員</span><span>${displayValue(record.editorName)}</span></div>
                    <div class="record-card-row"><span>修改時間</span><span>${displayValue(record.editedAt)}</span></div>`
                : "";
            const displayName = `${escapeHtml(record.name == null ? "" : record.name)}${record.onLeave === true ? "*" : ""}`;
            const clockinRow = missingTime(record.clockin) ? "record-card-row record-card-row-missing" : "record-card-row";
            const clockoutRow = missingTime(record.clockout) ? "record-card-row record-card-row-missing" : "record-card-row";
            html += `
                <div class="record-card">
                    <div class="record-card-name">${displayName}</div>
                    <div class="${clockinRow}"><span>上班</span><span>${displayValue(record.clockin)}</span></div>
                    <div class="${clockoutRow}"><span>下班</span><span>${displayValue(record.clockout)}</span></div>
                    <div class="record-card-row"><span>當日工時</span><span>${escapeHtml(workHoursText(record))}</span></div>
                    <div class="record-card-row"><span>修改紀錄</span><span>${modified ? "是" : "否"}</span></div>
                    ${modifiedRows}
                    <div class="record-card-actions">
                        ${editButton(record.id, record.name, targetDate, record.clockin, record.clockout)}
                        ${segmentsButton(record.id, record.name, targetDate)}
                        ${downloadButton(record.id, record.name, record.downloadable, masterReady)}
                    </div>
                </div>
            `;
        }

        html += "</div>";
        $("#calendarGrid").html(html);
    }

    function renderEmployee(data, year, month) {
        if (!data || !data.employee || !Array.isArray(data.days)) {
            $("#calendarGrid").html('<div class="calendar-empty">無法取得這位員工的打卡資料。</div>');
            return;
        }

        setMasterDownload(data.masterReady === true);
        const name = data.employee.name == null ? "" : String(data.employee.name);
        const id = data.employee.id == null ? "" : String(data.employee.id);
        const days = data.days.slice().sort((a, b) => Number(a.day) - Number(b.day));
        let rows = "";
        for (const day of days) {
            const date = /^\d{4}-\d{2}-\d{2}$/.test(String(day.date || ""))
                ? String(day.date)
                : formatDate(year, month, day.day);
            const modified = Boolean(day.modified);
            rows += `
                <tr>
                    <td>${escapeHtml(date)}</td>
                    <td>${displayValue(day.clockin)}</td>
                    <td>${displayValue(day.clockout)}</td>
                    <td>${escapeHtml(workHoursText(day))}</td>
                    <td>${modified ? "是" : "否"}</td>
                    <td class="record-cell-reason">${modified ? displayValue(day.reason) : ""}</td>
                    <td>${modified ? displayValue(day.editorName) : ""}</td>
                    <td>${modified ? displayValue(day.editedAt) : ""}</td>
                    <td>${editButton(id, name, date, day.clockin, day.clockout)} ${segmentsButton(id, name, date)}</td>
                </tr>
            `;
        }

        $("#calendarGrid").html(`
            <div class="record-summary">${escapeHtml(name)} ${year}-${String(month).padStart(2, "0")}</div>
            <div class="record-month-bar">
                ${downloadButton(id, name, data.downloadable, data.masterReady === true)}
            </div>
            <div class="record-table-wrap">
                <table class="table table-sm table-bordered record-month-table">
                    <thead>
                        <tr>
                            <th>日期</th>
                            <th>第一次上班</th>
                            <th>最後一次下班</th>
                            <th>當日工時</th>
                            <th>修改紀錄</th>
                            <th>修改原因</th>
                            <th>修改的管理員</th>
                            <th>修改時間</th>
                            <th>補正</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `);
    }

    async function renderCurrent() {
        const token = ++viewToken;
        const employeeId = selectedEmployeeId();
        $("#day").prop("disabled", Boolean(employeeId));
        $("#calendarGrid").html('<div class="calendar-empty">載入中...</div>');
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);

        if (employeeId) {
            const data = await fetchEmployee(year, month, employeeId);
            if (token !== viewToken) return;
            renderEmployee(data, year, month);
            return;
        }

        const day = parseInt($("#day").val(), 10);
        const data = await fetchDayView(year, month, day);
        if (token !== viewToken) return;
        renderDay(data, year, month, day);
    }

    function fillEmployeeSelect(employees, previous) {
        const select = $("#employee");
        select.empty();
        select.append($("<option>").val("").text("全部"));
        if (Array.isArray(employees)) {
            employees.forEach((employee) => {
                if (!employee || employee.id == null || String(employee.id) === "") return;
                const id = String(employee.id);
                const name = employee.name == null ? "" : String(employee.name);
                const label = employee.status === 1 ? name : `${name}（離職）`;
                select.append($("<option>").val(id).text(label));
            });
        }
        const hasPrevious = previous && select.find("option").toArray().some((option) => option.value === previous);
        select.val(hasPrevious ? previous : "");
    }

    async function loadDirectory() {
        const token = ++directoryToken;
        const previous = selectedEmployeeId();
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);
        const employees = await fetchDirectory(year, month);
        if (token !== directoryToken) return;
        fillEmployeeSelect(employees, previous);
    }

    async function writeClockinArchive() {
        const year = parseInt($("#year").val(), 10);
        const month = parseInt($("#month").val(), 10);
        try {
            const resp = await fetch(`${apiBase}/clrecord`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                    account: userId,
                    cookie: sessionKey,
                    year,
                    month,
                }),
            });
            return resp.status === 200;
        } catch (error) {
            console.error(error);
            return false;
        }
    }

    async function reloadClockin() {
        const wrote = await writeClockinArchive();
        alert(wrote ? "備查檔已寫入" : "備查檔寫入失敗");
        await loadDirectory();
        await renderCurrent();
    }

    function setMasterDownload(masterReady) {
        const ready = masterReady === true;
        const button = $("#downloadMaster");
        button.prop("disabled", !ready);
        if (ready) {
            button.removeAttr("title");
        } else {
            button.attr("title", "請先重新載入，產生該月總表");
        }
    }

    function masterFileName(year, month) {
        return `${year}-${String(month).padStart(2, "0")}_打卡紀錄.pdf`;
    }

    async function downloadMaster() {
        const button = $("#downloadMaster");
        if (button.prop("disabled")) return;
        const year = $("#year").val();
        const month = $("#month").val();
        const url = `${apiBase}/api/clockin/master?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}`;
        button.prop("disabled", true);
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                await alertDownloadError(resp);
                return;
            }
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = masterFileName(year, month);
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (error) {
            console.error(error);
            alert("下載失敗");
        } finally {
            button.prop("disabled", false);
        }
    }

    function personalFileName(year, month, name) {
        const safeName = String(name).replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_").trim() || "員工";
        return `${year}-${String(month).padStart(2, "0")}_${safeName}_打卡紀錄.pdf`;
    }

    async function alertDownloadError(resp) {
        let message = "";
        try {
            const data = await resp.json();
            if (data && typeof data.message === "string") message = data.message;
        } catch (error) {
            message = "";
        }
        if (!message && (resp.status === 401 || resp.status === 403)) {
            alert("下載失敗");
            return;
        }
        alert(message || "下載失敗");
    }

    async function downloadPersonal(id, name) {
        const year = $("#year").val();
        const month = $("#month").val();
        const url = `${apiBase}/api/clockin/personal?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&year=${encodeURIComponent(year)}&month=${encodeURIComponent(month)}&id=${encodeURIComponent(id)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) {
                await alertDownloadError(resp);
                return;
            }
            const blob = await resp.blob();
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = objectUrl;
            link.download = personalFileName(year, month, name);
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        } catch (error) {
            console.error(error);
            alert("下載失敗");
        }
    }

    function openEdit(target) {
        editSession += 1;
        editingTarget = {
            session: editSession,
            id: target.id,
            name: target.name,
            date: target.date,
        };
        $("#clockinEditTitle").text(`補正 ${target.name} ${target.date}`);
        $("#clockinEditClockin").val(toTimeInput(target.clockin));
        $("#clockinEditClockout").val(toTimeInput(target.clockout));
        $("#clockinEditReason").val("");
        editModal.show();
    }

    async function saveEdit() {
        if (savingEdit || !editingTarget) return;
        const session = editingTarget.session;
        const payload = {
            account: userId,
            cookie: sessionKey,
            id: editingTarget.id,
            date: editingTarget.date,
            clockin: toTimeInput($("#clockinEditClockin").val()) || null,
            clockout: toTimeInput($("#clockinEditClockout").val()) || null,
            reason: String($("#clockinEditReason").val() || ""),
        };
        savingEdit = true;
        $("#clockinEditSave").prop("disabled", true);
        try {
            const resp = await fetch(`${apiBase}/api/clockin/edit`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(payload),
            });
            let data = {};
            try {
                data = await resp.json();
            } catch (error) {
                data = {};
            }
            const sameSession = Boolean(editingTarget && editingTarget.session === session);
            if (resp.ok && data.status === "saved") {
                if (sameSession) editModal.hide();
                await renderCurrent();
                return;
            }
            if (!sameSession) return;
            if (resp.ok && data.status === "unchanged") {
                alert(data.message || "時間沒有變更");
                return;
            }
            alert(data.message || "補正失敗");
        } catch (error) {
            console.error(error);
            if (editingTarget && editingTarget.session === session) alert("補正失敗");
        } finally {
            savingEdit = false;
            $("#clockinEditSave").prop("disabled", false);
        }
    }

    // ---- 多段補打卡（展開各段） ----
    const segmentsModal = new bootstrap.Modal(document.getElementById("clockinSegmentsModal"));
    let segmentsTarget = null;
    let segmentsBusy = false;

    function workHoursText(record) {
        if (record && typeof record.workHours === "string" && record.workHours) return record.workHours;
        return "0:00";
    }

    function segmentsButton(id, name, date) {
        return `<button type="button" class="btn btn-sm btn-outline-dark record-segments-btn" data-id="${attr(id)}" data-name="${attr(name)}" data-date="${attr(date)}">展開各段</button>`;
    }

    async function fetchSegments(id, date) {
        const url = `${apiBase}/api/clockin/segments?account=${encodeURIComponent(userId)}&cookie=${encodeURIComponent(sessionKey)}&id=${encodeURIComponent(id)}&date=${encodeURIComponent(date)}`;
        try {
            const resp = await fetch(url, { method: "GET", credentials: "include" });
            if (!resp.ok) return null;
            return await resp.json();
        } catch (error) {
            console.error(error);
            return null;
        }
    }

    const ACTION_LABELS = { add: "新增", update: "修改", delete: "刪除", "legacy-merge": "沿用舊補正" };

    function renderSegments(data) {
        if (!data || !Array.isArray(data.segments)) {
            $("#clockinSegmentsBody").html('<div class="calendar-empty">無法取得各段資料。</div>');
            return;
        }
        let rows = "";
        for (const seg of data.segments) {
            if (seg.deleted) {
                rows += `<tr class="table-secondary text-decoration-line-through"><td>${Number(seg.num)}</td><td>${displayValue(seg.clockin)}</td><td>${displayValue(seg.clockout)}</td><td>已刪除</td></tr>`;
                continue;
            }
            rows += `
                <tr data-num="${Number(seg.num)}">
                    <td>${Number(seg.num)}</td>
                    <td><input type="time" class="form-control form-control-sm seg-in" value="${attr(toTimeInput(seg.clockin))}"></td>
                    <td><input type="time" class="form-control form-control-sm seg-out" value="${attr(toTimeInput(seg.clockout))}"></td>
                    <td>
                        <button type="button" class="btn btn-sm btn-primary seg-save">儲存</button>
                        <button type="button" class="btn btn-sm btn-outline-danger seg-delete">刪除</button>
                    </td>
                </tr>`;
        }
        rows += `
            <tr class="table-light">
                <td>新增</td>
                <td><input type="time" class="form-control form-control-sm seg-new-in"></td>
                <td><input type="time" class="form-control form-control-sm seg-new-out"></td>
                <td><button type="button" class="btn btn-sm btn-success seg-add">新增一段</button></td>
            </tr>`;

        let notes = "";
        if (data.legacyPreview && data.legacyEdit) {
            notes += `<div class="alert alert-info py-2">這天原本有整天補正（${escapeHtml(data.legacyEdit.editorName || "")}：${escapeHtml(data.legacyEdit.reason || "")}）。第一次在這裡修改時，補正的上班／下班時間會併入各段（下表已是併入後的樣子），原補正資料仍保留。</div>`;
        }
        const incompleteNote = data.incompleteSegments > 0 ? `（有 ${Number(data.incompleteSegments)} 段不完整，未計入工時）` : "";
        let logRows = "";
        for (const entry of (data.log || [])) {
            logRows += `<tr>
                <td>${escapeHtml(entry.editedAt || "")}</td>
                <td>${escapeHtml(entry.editorName || "")}</td>
                <td>${escapeHtml(ACTION_LABELS[entry.action] || entry.action)} 第${Number(entry.num)}段</td>
                <td>${displayValue(entry.oldClockin)} / ${displayValue(entry.oldClockout)}</td>
                <td>${displayValue(entry.newClockin)} / ${displayValue(entry.newClockout)}</td>
                <td>${escapeHtml(entry.reason || "")}</td>
            </tr>`;
        }
        const logHtml = logRows
            ? `<details class="mt-3"><summary>異動紀錄（${data.log.length}）</summary>
                <table class="table table-sm table-bordered mt-2"><thead><tr><th>時間</th><th>管理員</th><th>動作</th><th>原（上班/下班）</th><th>新（上班/下班）</th><th>原因</th></tr></thead><tbody>${logRows}</tbody></table></details>`
            : "";
        $("#clockinSegmentsBody").html(`
            ${notes}
            <div class="mb-2">當日工時：<strong>${escapeHtml(data.workHours || "0:00")}</strong> ${escapeHtml(incompleteNote)}</div>
            <table class="table table-sm table-bordered align-middle">
                <thead><tr><th>段</th><th>上班</th><th>下班</th><th>操作</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
            ${logHtml}
        `);
    }

    async function openSegments(target) {
        segmentsTarget = target;
        $("#clockinSegmentsTitle").text(`各段打卡 ${target.name} ${target.date}`);
        $("#clockinSegmentsReason").val("");
        $("#clockinSegmentsBody").text("載入中...");
        segmentsModal.show();
        renderSegments(await fetchSegments(target.id, target.date));
    }

    async function segmentAction(action, extra) {
        if (segmentsBusy || !segmentsTarget) return;
        const target = segmentsTarget;
        const reason = String($("#clockinSegmentsReason").val() || "").trim();
        if (!reason) {
            alert("請填寫修改原因");
            return;
        }
        if (action === "delete" && !confirm("確定要刪除這一段？（資料會保留，只是不再列入報表）")) return;
        segmentsBusy = true;
        $("#clockinSegmentsBody button").prop("disabled", true);
        try {
            const resp = await fetch(`${apiBase}/api/clockin/segment/${action}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(Object.assign({ account: userId, cookie: sessionKey, id: target.id, date: target.date, reason }, extra)),
            });
            let data = {};
            try { data = await resp.json(); } catch (error) { data = {}; }
            if (resp.ok && data.status === "saved") {
                $("#clockinSegmentsReason").val("");
                await renderCurrent();
            } else if (resp.ok && data.status === "unchanged") {
                alert(data.message || "時間沒有變更");
            } else {
                alert(data.message || "修改失敗");
            }
        } catch (error) {
            console.error(error);
            alert("修改失敗");
        } finally {
            segmentsBusy = false;
            if (segmentsTarget === target) renderSegments(await fetchSegments(target.id, target.date));
        }
    }

    $("#calendarGrid").on("click", ".record-segments-btn", function () {
        openSegments({
            id: $(this).attr("data-id") || "",
            name: $(this).attr("data-name") || "",
            date: $(this).attr("data-date") || "",
        });
    });
    $("#clockinSegmentsBody").on("click", ".seg-save", function () {
        const row = $(this).closest("tr");
        segmentAction("edit", {
            num: Number(row.attr("data-num")),
            clockin: toTimeInput(row.find(".seg-in").val()) || null,
            clockout: toTimeInput(row.find(".seg-out").val()) || null,
        });
    });
    $("#clockinSegmentsBody").on("click", ".seg-delete", function () {
        segmentAction("delete", { num: Number($(this).closest("tr").attr("data-num")) });
    });
    $("#clockinSegmentsBody").on("click", ".seg-add", function () {
        const row = $(this).closest("tr");
        segmentAction("add", {
            clockin: toTimeInput(row.find(".seg-new-in").val()) || null,
            clockout: toTimeInput(row.find(".seg-new-out").val()) || null,
        });
    });
    document.getElementById("clockinSegmentsModal").addEventListener("hidden.bs.modal", () => {
        segmentsTarget = null;
    });

    async function onPeriodChange() {
        const token = ++periodToken;
        updateDayOptions();
        await loadDirectory();
        if (token !== periodToken) return;
        await renderCurrent();
    }

    async function initializeClockin() {
        const years = await fetchAvailableYears();
        populateYearOptions(years);

        const currentMonth = String(new Date().getMonth() + 1);
        $("#month").val(currentMonth);
        if ($("#month").val() !== currentMonth) {
            $("#month").find(`option[value="${currentMonth}"]`).prop("selected", true);
        }

        updateDayOptions();
        const currentDay = String(new Date().getDate());
        $("#day").val(currentDay);

        await loadDirectory();
        await renderCurrent();
    }

    $("#upData").on("click", reloadClockin);
    $("#downloadMaster").on("click", downloadMaster);
    $("#month, #year").on("change", onPeriodChange);
    $("#day").on("change", () => {
        if (!selectedEmployeeId()) renderCurrent();
    });
    $("#employee").on("change", renderCurrent);
    $("#calendarGrid").on("click", ".record-edit-btn", function () {
        const button = $(this);
        openEdit({
            id: button.attr("data-id") || "",
            name: button.attr("data-name") || "",
            date: button.attr("data-date") || "",
            clockin: button.attr("data-clockin") || "",
            clockout: button.attr("data-clockout") || "",
        });
    });
    $("#calendarGrid").on("click", ".record-download-btn", function () {
        if (this.disabled) return;
        downloadPersonal($(this).attr("data-id") || "", $(this).attr("data-name") || "");
    });
    $("#clockinEditForm").on("submit", (event) => {
        event.preventDefault();
        saveEdit();
    });
    initializeClockin();
});
