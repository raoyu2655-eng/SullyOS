// utils/charMonologue.test.ts
// 回归守卫（plans/char-monologue.md 末节）：
//   1. 防刷闸——同日第二篇被拦、跨日放行、聊得不够多被拦、第一篇不受「距上一篇」约束。
//   2. 字数越界不截断：照存，只给一句提示。
//   3. 「距上一篇聊了多少」按时间戳数，不按消息 id 差——id 是全库自增的，
//      中间跟别的角色聊过就会把差值撑大，闸会形同虚设。
import { describe, it, expect } from 'vitest';
import {
  MIN_MESSAGES_SINCE_LAST, SOFT_MAX_CHARS, SOFT_MIN_CHARS,
  countMessagesSinceLast, describeLengthDrift, judgeMonologueGate,
} from './charMonologue';
import type { CharMonologueEntry } from '../types';

const entry = (over: Partial<CharMonologueEntry> = {}): CharMonologueEntry => ({
  id: 'mono-1',
  charId: 'char-1',
  date: '2026-08-14',
  text: '正'.repeat(200),
  timestamp: 1_000,
  ...over,
});

/** 够长、不会被 too-short 拦下的正文。 */
const LONG_TEXT = '深'.repeat(200);

describe('judgeMonologueGate（防刷闸）', () => {
  it('今天已经写过 → already-today', () => {
    expect(judgeMonologueGate({
      existing: [entry({ date: '2026-08-14' })],
      todayKey: '2026-08-14',
      messagesSinceLast: 999,
      text: LONG_TEXT,
    })).toBe('already-today');
  });

  it('上一篇是昨天、又聊够了 → ok（跨过角色那边的午夜就该放行）', () => {
    expect(judgeMonologueGate({
      existing: [entry({ date: '2026-08-13' })],
      todayKey: '2026-08-14',
      messagesSinceLast: MIN_MESSAGES_SINCE_LAST,
      text: LONG_TEXT,
    })).toBe('ok');
  });

  it('上一篇是昨天、但只聊了两句 → too-soon（一天说三句话不叫有感而发）', () => {
    expect(judgeMonologueGate({
      existing: [entry({ date: '2026-08-13' })],
      todayKey: '2026-08-14',
      messagesSinceLast: MIN_MESSAGES_SINCE_LAST - 1,
      text: LONG_TEXT,
    })).toBe('too-soon');
  });

  it('一篇都还没有 → 不受「距上一篇」约束，第一篇照写', () => {
    expect(judgeMonologueGate({
      existing: [],
      todayKey: '2026-08-14',
      messagesSinceLast: 1,
      text: LONG_TEXT,
    })).toBe('ok');
  });

  it('短到不像一篇 → too-short，当模型误触发丢掉', () => {
    expect(judgeMonologueGate({
      existing: [],
      todayKey: '2026-08-14',
      messagesSinceLast: 999,
      text: '嗯。',
    })).toBe('too-short');
  });

  // 顺序守卫：太短要在日限之前判掉。反过来的话，今天已经写过时会先报 already-today，
  // 把「模型这一轮吐了个空标记」这件事盖住，排查时看到的是一条误导性的判定。
  it('又短又超日限 → 报 too-short（先判内容，再判额度）', () => {
    expect(judgeMonologueGate({
      existing: [entry({ date: '2026-08-14' })],
      todayKey: '2026-08-14',
      messagesSinceLast: 999,
      text: '。',
    })).toBe('too-short');
  });
});

describe('describeLengthDrift（越界只警告，不截断）', () => {
  it('区间内 → null', () => {
    expect(describeLengthDrift('字'.repeat(SOFT_MIN_CHARS))).toBeNull();
    expect(describeLengthDrift('字'.repeat(SOFT_MAX_CHARS))).toBeNull();
  });

  it('偏短 / 偏长 → 各给一句话，正文一个字都不动', () => {
    expect(describeLengthDrift('字'.repeat(SOFT_MIN_CHARS - 1))).toContain('低于');
    expect(describeLengthDrift('字'.repeat(SOFT_MAX_CHARS + 1))).toContain('超过');
  });
});

describe('countMessagesSinceLast', () => {
  it('没有上一篇 → 该角色的消息总数', () => {
    expect(countMessagesSinceLast([{ timestamp: 1 }, { timestamp: 2 }], [])).toBe(2);
  });

  it('有上一篇 → 只数它之后的那些', () => {
    const messages = [{ timestamp: 500 }, { timestamp: 1_000 }, { timestamp: 1_500 }];
    expect(countMessagesSinceLast(messages, [entry({ timestamp: 1_000 })])).toBe(1);
  });

  it('认最新那一篇（列表新的在前），不是数组最后一个', () => {
    const messages = [{ timestamp: 1_200 }, { timestamp: 2_200 }];
    const existing = [entry({ id: 'new', timestamp: 2_000 }), entry({ id: 'old', timestamp: 100 })];
    expect(countMessagesSinceLast(messages, existing)).toBe(1);
  });
});
