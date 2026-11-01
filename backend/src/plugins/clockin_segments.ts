// Pure helpers for multi-segment clock-in handling (no database access).

export const DUPLICATE_PUNCH_MINUTES = 5;

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type Segment = {
  num: number;
  clockin: string | null;
  clockout: string | null;
  deleted?: boolean;
};

export type DayHours = {
  /** Total minutes of complete (in + out) segments, soft-deleted segments excluded. */
  minutes: number;
  /** Count of live segments that cannot be paired (only in, only out, or out before in). */
  incomplete: number;
};

export function toMinutes(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
  if (!match) {
    return null;
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

/**
 * True when a new punch at `nowTime` (HH:MM) is closer than `threshold` minutes to any
 * existing punch of the same kind (pass the clockin OR the clockout values of the live segments).
 */
export function isDuplicatePunch(existingTimes: Array<string | null>, nowTime: string, threshold: number = DUPLICATE_PUNCH_MINUTES): boolean {
  const now = toMinutes(nowTime);
  if (now === null) {
    return false;
  }
  for (const time of existingTimes) {
    const previous = toMinutes(time);
    if (previous !== null && Math.abs(now - previous) < threshold) {
      return true;
    }
  }
  return false;
}

export function computeDayHours(segments: Segment[]): DayHours {
  let minutes = 0;
  let incomplete = 0;
  for (const segment of segments) {
    if (segment.deleted) {
      continue;
    }
    const start = toMinutes(segment.clockin);
    const end = toMinutes(segment.clockout);
    if (start !== null && end !== null && end >= start) {
      minutes += end - start;
    } else if (start !== null || end !== null) {
      incomplete += 1;
    }
  }
  return { minutes, incomplete };
}

/** Work hours of a day that only has a legacy clockin_edit (one first-in / last-out pair). */
export function legacyEditHours(clockin: string | null, clockout: string | null): DayHours {
  return computeDayHours([{ num: 1, clockin, clockout }]);
}

export function formatWorkMinutes(minutes: number): string {
  const safe = Math.max(0, Math.floor(minutes));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function displayWorkHours(hours: DayHours): string {
  const base = formatWorkMinutes(hours.minutes);
  return hours.incomplete > 0 ? `${base}（${hours.incomplete}段不完整）` : base;
}

export type SegmentDecision =
  | { ok: true; kind: 'unchanged' }
  | { ok: true; kind: 'save'; clockin: string | null; clockout: string | null; reason: string }
  | { ok: false; message: string };

export function validateReason(raw: string | null | undefined): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = (raw == null ? '' : String(raw)).trim();
  if (!reason) {
    return { ok: false, message: '請填寫修改原因' };
  }
  if (Array.from(reason).length > 200) {
    return { ok: false, message: '修改原因最多 200 字' };
  }
  if (/[\u0000-\u001F]/.test(reason)) {
    return { ok: false, message: '修改原因不能包含控制字元' };
  }
  return { ok: true, reason };
}

function cleanTime(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

/**
 * Validate editing one segment (current = existing values) or adding one (current = null/null).
 */
export function decideSegmentEdit(
  current: { clockin: string | null; clockout: string | null },
  input: { clockin?: string | null; clockout?: string | null; reason?: string | null }
): SegmentDecision {
  const clockin = cleanTime(input.clockin);
  const clockout = cleanTime(input.clockout);
  if (clockin && !TIME_PATTERN.test(clockin)) {
    return { ok: false, message: '上班時間須為 HH:MM' };
  }
  if (clockout && !TIME_PATTERN.test(clockout)) {
    return { ok: false, message: '下班時間須為 HH:MM' };
  }
  if (!clockin && !clockout) {
    return { ok: false, message: '上班與下班至少填一個；要移除這一段請用刪除' };
  }
  if (clockin && clockout && clockout < clockin) {
    return { ok: false, message: '下班時間不得早於上班時間' };
  }
  if (clockin === current.clockin && clockout === current.clockout) {
    return { ok: true, kind: 'unchanged' };
  }
  const reason = validateReason(input.reason);
  if (!reason.ok) {
    return reason;
  }
  return { ok: true, kind: 'save', clockin, clockout, reason: reason.reason };
}

export type LegacyMergeChange = {
  num: number;
  created: boolean;
  before: { clockin: string | null; clockout: string | null };
  after: { clockin: string | null; clockout: string | null };
};

/**
 * Fold a legacy per-day correction (first clock-in / last clock-out) into live segments, so
 * switching a day to segment editing does not change what the reports already showed.
 * Returns the changes to apply (empty when the segments already match the legacy values).
 */
export function mergeLegacyEdit(
  live: Segment[],
  legacy: { clockin: string | null; clockout: string | null },
  nextNum: number
): LegacyMergeChange[] {
  const sorted = live.filter((s) => !s.deleted).slice().sort((a, b) => a.num - b.num);
  if (sorted.length === 0) {
    if (!legacy.clockin && !legacy.clockout) {
      return [];
    }
    return [{
      num: nextNum,
      created: true,
      before: { clockin: null, clockout: null },
      after: { clockin: legacy.clockin, clockout: legacy.clockout },
    }];
  }

  const changes = new Map<number, LegacyMergeChange>();
  const touch = (segment: Segment): LegacyMergeChange => {
    let change = changes.get(segment.num);
    if (!change) {
      change = {
        num: segment.num,
        created: false,
        before: { clockin: segment.clockin, clockout: segment.clockout },
        after: { clockin: segment.clockin, clockout: segment.clockout },
      };
      changes.set(segment.num, change);
    }
    return change;
  };

  if (legacy.clockin) {
    let first: Segment | null = null;
    let firstMinutes = Infinity;
    for (const segment of sorted) {
      const minutes = toMinutes(segment.clockin);
      if (minutes !== null && minutes < firstMinutes) {
        first = segment;
        firstMinutes = minutes;
      }
    }
    const legacyMinutes = toMinutes(legacy.clockin);
    if (first === null) {
      touch(sorted[0]).after.clockin = legacy.clockin;
    } else if (legacyMinutes !== null && legacyMinutes !== firstMinutes) {
      touch(first).after.clockin = legacy.clockin;
    }
  }
  if (legacy.clockout) {
    let last: Segment | null = null;
    let lastMinutes = -Infinity;
    for (const segment of sorted) {
      const minutes = toMinutes(segment.clockout);
      if (minutes !== null && minutes > lastMinutes) {
        last = segment;
        lastMinutes = minutes;
      }
    }
    const legacyMinutes = toMinutes(legacy.clockout);
    if (last === null) {
      touch(sorted[sorted.length - 1]).after.clockout = legacy.clockout;
    } else if (legacyMinutes !== null && legacyMinutes !== lastMinutes) {
      touch(last).after.clockout = legacy.clockout;
    }
  }
  return Array.from(changes.values());
}
