import { describe, expect, it } from 'vitest';
import { isIsoCalendarDate } from '../../platform/calendarDate';

describe('YYYY-MM-DD 真日历日期校验', () => {
  it('接受普通日期与正确闰年', () => {
    expect(isIsoCalendarDate('2026-07-21')).toBe(true);
    expect(isIsoCalendarDate('2024-02-29')).toBe(true);
    expect(isIsoCalendarDate('2000-02-29')).toBe(true);
  });

  it('拒绝不存在的月日、非闰年和宽松格式', () => {
    for (const value of [
      '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01',
      '2026-01-00', '0000-01-01', '2026-7-21', '20260721', '', null,
    ]) expect(isIsoCalendarDate(value)).toBe(false);
  });
});
