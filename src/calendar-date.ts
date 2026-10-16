import { z } from 'zod';

declare const calendarDateBrand: unique symbol;

export type CalendarDate = string & {
  readonly [calendarDateBrand]: true;
};

const CALENDAR_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const COMMON_YEAR_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }

  return COMMON_YEAR_MONTH_DAYS[month - 1] ?? 0;
}

function daysBeforeYear(year: number): number {
  const completedYears = year - 1;
  return (
    completedYears * 365 +
    Math.floor(completedYears / 4) -
    Math.floor(completedYears / 100) +
    Math.floor(completedYears / 400)
  );
}

function toOrdinal(value: CalendarDate): number {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  let ordinal = daysBeforeYear(year) + day - 1;

  for (let currentMonth = 1; currentMonth < month; currentMonth += 1) {
    ordinal += daysInMonth(year, currentMonth);
  }

  return ordinal;
}

const MAX_ORDINAL = daysBeforeYear(10_000) - 1;

function fromOrdinal(ordinal: number): CalendarDate {
  let low = 1;
  let high = 9_999;

  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (daysBeforeYear(candidate) <= ordinal) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }

  const year = low;
  let remainingDays = ordinal - daysBeforeYear(year);
  let month = 1;

  while (remainingDays >= daysInMonth(year, month)) {
    remainingDays -= daysInMonth(year, month);
    month += 1;
  }

  const day = remainingDays + 1;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as CalendarDate;
}

export function isCalendarDate(value: string): value is CalendarDate {
  if (!CALENDAR_DATE_PATTERN.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export const calendarDateSchema = z.string().refine(isCalendarDate, {
  message: 'Expected a CalendarDate in YYYY-MM-DD format within 0001-01-01..9999-12-31',
});

export function assertCalendarDate(value: string): asserts value is CalendarDate {
  if (!isCalendarDate(value)) {
    throw new RangeError(`Invalid CalendarDate: ${value}`);
  }
}

export function parseCalendarDate(value: string): CalendarDate {
  assertCalendarDate(value);
  return value;
}

export function calendarDateToUtcDate(value: string): Date {
  const parsed = parseCalendarDate(value);
  const year = Number(parsed.slice(0, 4));
  const month = Number(parsed.slice(5, 7));
  const day = Number(parsed.slice(8, 10));
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year, month - 1, day);
  return result;
}

export function addCalendarDays(value: CalendarDate, days: number): CalendarDate {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError(`Calendar day delta must be a safe integer: ${days}`);
  }

  const result = toOrdinal(value) + days;
  if (result < 0 || result > MAX_ORDINAL) {
    throw new RangeError(
      `CalendarDate addition is outside 0001-01-01..9999-12-31: ${value} + ${days}`,
    );
  }

  return fromOrdinal(result);
}

export function compareCalendarDates(left: CalendarDate, right: CalendarDate): -1 | 0 | 1 {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
}

export function getCalendarYear(value: CalendarDate): number {
  return Number(value.slice(0, 4));
}
