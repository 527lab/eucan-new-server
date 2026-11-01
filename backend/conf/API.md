## API Documentation

---

### 1. Check Server Status

**Endpoint:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/session`

**Description:**  
Check if the server is online.

**Request:**
```http
GET /session
```

**Response:**
- **200 OK**: Server is online.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 2. Login

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/login`

**Description:**  
Login to the system.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "pwd": "string",       // User password.
  "twoFA": "string"      // Optional two-factor authentication (only for root account).
}
```

**Response:**
- **200 OK**: Successful login.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission or invalid credentials.

---

### 3. Register a New User

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/register`

**Description:**  
Register a new user.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "user": "string",      // New user's ID.
  "pwd": "string",       // New user's password.
  "mail": "string",      // New user's email.
  "name": "string",      // New user's name.
  "date": "YYYY-MM-DD",  // Join date (optional).
  "type": "string",      // Account type (optional, defaults to "employee").
  "mgroup": "0 or 1",    // Manager group.
  "permit": true           // Permission to take a day off (optional).
}
```

**Response:**
- **200 OK**: User registered successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 4. Retrieve All Users

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/users`

**Description:**  
Retrieve a list of all users (admin-only).

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string"     // Session cookie.
}
```

**Response:**
- **200 OK**: Returns the list of users.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 5. Delete a User

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/delete`

**Description:**  
Delete a user account.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "user": "string"       // User ID to delete.
}
```

**Response:**
- **200 OK**: User deleted successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 6. Add a New Dayoff Request

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/request`

**Description:**  
Submit a new dayoff request.

**Request Body:**
```json
{
  "account": "string",        // User account.
  "cookie": "string",         // Session cookie.
  "type": "string",           // Dayoff type.
  "reason": "string",         // Reason for dayoff.
  "start": "YYYY-MM-DD HH:mm",// Start datetime.
  "end": "YYYY-MM-DD HH:mm"   // End datetime.
}
```

**Response:**
- **200 OK**: Dayoff request submitted successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 7. View Approved Dayoff Requests

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/approved`

**Description:**  
View all approved dayoff requests.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "cookie": "string",    // Session cookie.
  "user":"string",       // The employee to lookup.(optional)
  "year":"string",       // The year to lookup.(optional)
  "limit":"integer"      // The limit of the amount to retrive.(optional)
}
```

**Response:**
- **200 OK**: Returns approved requests.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 8. View Employee Dayoff Records

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/dayoff`

**Description:**  
View an employee's dayoff record.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "cookie": "string",    // Session cookie.
  "user": "string",      // Target user ID (optional).
  "year": "YYYY"         // Year to search for.
}
```

**Response:**
- **200 OK**: Returns dayoff records.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 9. Permit or Deny Dayoff Requests

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/permit`

**Description:**  
Approve or deny a dayoff request.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "num": "integer",      // Request ID.
  "permit": 1             // 1 to approve, 0 to deny.
}
```

**Response:**
- **200 OK**: Request updated successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 10. Query Pending Requests

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/query`

**Description:**  
Retrieve all unreviewed requests.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string"     // Session cookie.
}
```

**Response:**
- **200 OK**: Returns pending requests.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 11. Fetch Non-Working Days

**Endpoint:**
![GET](https://img.shields.io/badge/GET-0052CC?style=flat-square&logo=appveyor&logoColor=white) `/api/{YEAR}`

**Description:**  
Retrieve non-working and working days for the specified year.

**Request Body:**
```json
{
  "account": "string",   // User account.
  "cookie": "string"     // Session cookie.
}
```

**Response:**
- **200 OK**: Returns non-working day data.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 12. Modify User Data

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/modify`

**Description:**  
Modify an existing user’s data.

**Request Body:**
```json
{
  "account": "string",   // Admin account.
  "cookie": "string",    // Session cookie.
  "user": "string",      // User ID to modify.
  "year": "string",      // Year of modification.
  "data": "object"       // Data to update.
}
```

**Response:**
- **200 OK**: User data updated successfully.
- **400 Bad Request**: Invalid input data.
- **403 Forbidden**: No permission.

---

### 13. Clock In / Clock Out / Today's Punches

**Endpoint:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/clockin`

**Description:**  
`type` 0 returns today's (or `day`'s) live segments of the account, `1` records a clock-in, `-1` a clock-out. A clock-in fills the first live segment without a clock-in, otherwise opens a new segment (same for clock-out). Soft-deleted segments are ignored.

**Duplicate guard:** a punch of the same kind (clock-in or clock-out) less than **5 minutes** after another live punch of that kind on the same day is **not recorded** and returns `409`.

**Request Body:**
```json
{
  "account": "string",
  "cookie": "string",
  "type": 1              // 0 = list, 1 = clock-in, -1 = clock-out
}
```

**Response:**
- **200 OK**: `{"status": 200}` recorded (or the segment list for `type` 0).
- **409 Conflict**: `{"status": 409, "message": "已打過上班卡" | "已打過下班卡"}`, nothing recorded.
- **400 Bad Request** / **403 Forbidden**: invalid input / not allowed.

---

### 14. Clock-In Day / Month Views (admin)

**Endpoints:**
![GET](https://img.shields.io/badge/GET-2ECC40?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/view?account&cookie&year&month&day`  
![GET](https://img.shields.io/badge/GET-2ECC40?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/day?account&cookie&year&month&day`  
![GET](https://img.shields.io/badge/GET-2ECC40?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/employee?account&cookie&year&month&id`

**Per person/day fields:** `clockin` (first clock-in), `clockout` (last clock-out), `workHours` (e.g. `"8:00"` or `"8:00（1段不完整）"`), `workMinutes`, `incompleteSegments`, `modified`, `reason`, `editorName`, `editedAt`.

`workHours` is the sum of every live segment that has both a clock-in and a clock-out (clock-out not earlier than clock-in). Segments with only one side are not counted and are reported in `incompleteSegments`. Soft-deleted segments never count. A day that only has a legacy whole-day correction (`/api/clockin/edit`) uses that correction's clock-in/clock-out as one pair.

The monthly master PDF (`/api/clockin/master`), the personal PDF (`/api/clockin/personal`) and the Excel helper carry the same columns: 首次上班, 末次下班, 當日工時.

**Response:** 200 / 400 / 403 (employees are rejected).

---

### 15. List Segments of One Day (admin)

**Endpoint:**
![GET](https://img.shields.io/badge/GET-2ECC40?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/segments?account&cookie&id&date=YYYY-MM-DD`

**Response (200):**
```json
{
  "employee": {"id": "string", "name": "string"},
  "date": "2026-02-02",
  "segments": [{"num": 1, "clockin": "09:00", "clockout": "12:00", "deleted": false}],
  "workHours": "8:00", "workMinutes": 480, "incompleteSegments": 0,
  "segmentMode": true,        // the day has segment-level corrections
  "legacyPreview": false,     // true: only a legacy correction exists; segments shown are what editing will start from
  "legacyEdit": null,         // legacy clockin_edit row, if any
  "log": [{"seq": 1, "num": 1, "action": "update", "oldClockin": "...", "newClockin": "...", "reason": "...", "editorId": "...", "editorName": "...", "editedAt": "..."}]
}
```
Soft-deleted segments are included here (`deleted: true`) but never in reports. 404 when the employee does not exist.

---

### 16. Edit / Add / Delete a Segment (admin only)

**Endpoints:**
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/segment/edit`  
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/segment/add`  
![POST](https://img.shields.io/badge/POST-FF4136?style=flat-square&logo=appveyor&logoColor=white) `/api/clockin/segment/delete`

**Request Body:**
```json
{
  "account": "string", "cookie": "string",   // admin
  "id": "string",                            // employee id
  "date": "YYYY-MM-DD",                      // not in the future
  "num": 2,                                  // edit / delete only
  "clockin": "HH:MM or null",                // edit / add (at least one of clockin/clockout)
  "clockout": "HH:MM or null",
  "reason": "string"                         // required, max 200 chars, every call
}
```

- Every call needs a `reason`; editor and time are recorded in `clockin_segment_log`.
- `delete` is a **soft delete** (`clockinrecord.deleted = 1`); the row and its values stay in the database.
- The first segment edit of a day that has a legacy `clockin_edit` row folds its first clock-in / last clock-out into the segments (logged as `legacy-merge`). The `clockin_edit` row itself is kept; from then on the day is in segment mode and `/api/clockin/edit` returns 409 for it.
- No-op requests, rejected requests and failed validation change nothing.

**Response:**
- **200 OK**: `{"status": "saved", "num": 2}` or `{"status": "unchanged"}`.
- **400 Bad Request**: `{"message": "..."}` (bad time, missing reason, future date, ...).
- **403 Forbidden**: not an admin / bad session.
- **404 Not Found**: unknown employee or segment.
