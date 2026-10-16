import { describe, expect, it } from 'vitest';
import * as calendar from '../src/calendar-date';
import {
  addCalendarDays,
  assertCalendarDate,
  calendarDateSchema,
  compareCalendarDates,
  getCalendarYear,
  isCalendarDate,
  parseCalendarDate,
  type CalendarDate,
} from '../src/calendar-date';

describe('CalendarDate', () => {
  it.each(['0001-01-01', '0099-12-31', '2026-07-21'])(
    'converts %s to a UTC Date only after strict CalendarDate validation',
    (value) => {
      const converter = (calendar as { calendarDateToUtcDate?: (input: string) => Date })
        .calendarDateToUtcDate;

      expect(converter?.(value).toISOString().slice(0, 10)).toBe(value);
    },
  );

  it.each([
    '0001-01-01',
    '0099-12-31',
    '0100-01-01',
    '1600-02-29',
    '1900-02-28',
    '2000-02-29',
    '2100-02-28',
    '9999-12-31',
  ])('accepts the canonical proleptic Gregorian date %s', (value) => {
    expect(parseCalendarDate(value)).toBe(value);
    expect(isCalendarDate(value)).toBe(true);
  });

  it.each([
    '0000-01-01',
    '10000-01-01',
    '1900-02-29',
    '2000-02-30',
    '2100-02-29',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-04-31',
    '2026-7-21',
    '26-07-21',
    '２０２６-０７-２１',
    ' 2026-07-21',
    '2026-07-21 ',
    '2026-07-21T00:00:00Z',
    '2026-07-21+08:00',
    '2026/07/21',
    '',
  ])('rejects non-canonical or invalid input %j without normalization', (value) => {
    expect(isCalendarDate(value)).toBe(false);
    expect(() => parseCalendarDate(value)).toThrow(RangeError);
  });

  it('asserts the branded CalendarDate type at runtime', () => {
    const value: string = '2026-07-21';

    assertCalendarDate(value);

    const branded: CalendarDate = value;
    expect(branded).toBe('2026-07-21');
  });

  it('exports a strict schema whose parsed output is a branded CalendarDate', () => {
    const parsed: CalendarDate = calendarDateSchema.parse('0001-01-01');

    expect(parsed).toBe('0001-01-01');
  });

  it.each([
    42,
    {},
    null,
    undefined,
    '0000-01-01',
    ' 2026-07-21',
    '2026-07-21 ',
    '2026-07-21T00:00:00Z',
    '2026-07-21+08:00',
  ])('rejects non-string and non-canonical schema input %j', (value) => {
    expect(calendarDateSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ['0001-01-01', 1, '0001-01-02'],
    ['0099-12-31', 1, '0100-01-01'],
    ['1599-12-31', 1, '1600-01-01'],
    ['1600-02-28', 1, '1600-02-29'],
    ['1600-02-29', 1, '1600-03-01'],
    ['1900-02-28', 1, '1900-03-01'],
    ['1999-12-31', 1, '2000-01-01'],
    ['2000-02-28', 2, '2000-03-01'],
    ['2099-12-31', 1, '2100-01-01'],
    ['2100-03-01', -1, '2100-02-28'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-01-01', -365, '2025-01-01'],
    ['2026-07-21', 0, '2026-07-21'],
    ['0001-01-01', 0, '0001-01-01'],
    ['9999-12-31', 0, '9999-12-31'],
  ] as const)('%s plus %i days is %s', (input, days, expected) => {
    expect(addCalendarDays(parseCalendarDate(input), days)).toBe(expected);
  });

  it.each([
    ['0001-01-01', -1],
    ['9999-12-31', 1],
    ['9999-12-01', 31],
  ] as const)('rejects an addition that overflows the supported range from %s', (input, days) => {
    expect(() => addCalendarDays(parseCalendarDate(input), days)).toThrow(RangeError);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5])(
    'rejects a non-integer day delta %s',
    (days) => {
      expect(() => addCalendarDays(parseCalendarDate('2026-07-21'), days)).toThrow(RangeError);
    },
  );

  it('compares canonical dates chronologically', () => {
    const early = parseCalendarDate('0099-12-31');
    const same = parseCalendarDate('0099-12-31');
    const late = parseCalendarDate('0100-01-01');

    expect(compareCalendarDates(early, late)).toBe(-1);
    expect(compareCalendarDates(late, early)).toBe(1);
    expect(compareCalendarDates(early, same)).toBe(0);
  });

  it.each([
    ['0001-01-01', 1],
    ['0099-12-31', 99],
    ['0100-01-01', 100],
    ['9999-12-31', 9999],
  ] as const)('extracts year from %s as %i', (input, expected) => {
    expect(getCalendarYear(parseCalendarDate(input))).toBe(expected);
  });
});
