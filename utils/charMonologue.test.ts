// utils/charMonologue.test.ts
// 回归守卫（plans/char-monologue.md 末节）：
//   1. 防刷闸——同日第二篇被拦、跨日放行、聊得不够多被拦、第一篇不受「距上一篇」约束。
//   2. 字数越界不截断：照存，只给一句提示。
//   3. 「距上一篇聊了多少」按时间戳数，不按消息 id 差——id 是全库自增的，
//      中间跟别的角色聊过就会把差值撑大，闸会形同虚设。
import { describe, it, expect } from 'vitest';
import {
  MIN_MESSAGES_SINCE_LAST, SOFT_MAX_CHARS, SOFT_MIN_CHARS,
  buildMonologuePromptBlock, countMessagesSinceLast, describeLastMonologueMoment,
  describeLengthDrift, judgeMonologueGate,
} from './charMonologue';
import type { CharacterProfile, CharMonologueEntry } from '../types';

/**
 * 只用到 id / 自定义时区，其余不构造。
 *
 * 时区那两个字段必须成对（`customTimezoneEnabled` + `customTimezone`），
 * 只填后者的话 resolveCharTimeZone 会回落到设备本地——这个夹具最早就写错在这儿。
 */
const makeChar = (customTimezone?: string): CharacterProfile => ({
  id: 'char-1',
  name: '季明熠',
  customTimezoneEnabled: !!customTimezone,
  customTimezone,
} as unknown as CharacterProfile);

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

describe('buildMonologuePromptBlock（闸关着就一个字都不注入）', () => {
  const openArgs = { char: makeChar('Asia/Shanghai'), userName: '裴娆', messagesSinceLast: 999 };

  it('今天已经写过 → null，模型根本不知道有这个功能', () => {
    const block = buildMonologuePromptBlock({
      ...openArgs,
      existing: [entry({ date: '2026-08-14' })],
      now: new Date('2026-08-14T06:00:00Z'), // 上海 14:00
    });
    expect(block).toBeNull();
  });

  it('有资格 → 给出成对标记的格式和用户名', () => {
    const block = buildMonologuePromptBlock({ ...openArgs, existing: [] })!;
    expect(block).toContain('[[MONOLOGUE_START:');
    expect(block).toContain('[[MONOLOGUE_END]]');
    expect(block).toContain('裴娆');
    expect(block).not.toContain('上一次这样写是');
  });

  // 设计守卫：通篇不许出现「日记」二字。一说日记，模型就滑进「今天……我觉得……」
  // 的流水账语域，写出来的正是这个功能要避开的东西。
  it('措辞里不含「日记」', () => {
    const block = buildMonologuePromptBlock({ ...openArgs, existing: [] })!;
    expect(block).not.toContain('日记');
  });

  it('有上一篇 → 绝对时刻 + 相对天数 + 心境词都在', () => {
    const block = buildMonologuePromptBlock({
      ...openArgs,
      existing: [entry({
        date: '2026-08-10',
        // 上海 2026-08-10 02:14
        timestamp: Date.parse('2026-08-09T18:14:00Z'),
        mood: '厌倦',
      })],
      now: new Date('2026-08-14T06:00:00Z'),
    })!;
    expect(block).toContain('8月10日');
    expect(block).toContain('凌晨2:14');
    expect(block).toContain('4 天前');
    expect(block).toContain('「厌倦」');
  });

  // ⚠ 全套设计里最重要的一条不变量（plans/char-monologue.md）：角色不知道这些被读过。
  // readAt 只服务于界面上的未读点，一旦漏进 prompt，角色就开始为读者写作，
  // 写出来的就不再是最深的想法——这个功能的全部价值就没了。
  it('上一篇读过没读过，注入的内容一模一样', () => {
    const base = { ...openArgs, now: new Date('2026-08-14T06:00:00Z') };
    const unread = buildMonologuePromptBlock({
      ...base,
      existing: [entry({ date: '2026-08-10', timestamp: 1_000, mood: '厌倦' })],
    });
    const read = buildMonologuePromptBlock({
      ...base,
      existing: [entry({ date: '2026-08-10', timestamp: 1_000, mood: '厌倦', readAt: Date.now() })],
    });
    expect(read).toBe(unread);
  });
});

describe('describeLastMonologueMoment', () => {
  it('同一天 → 就在今天', () => {
    const moment = describeLastMonologueMoment(
      entry({ date: '2026-08-14', timestamp: Date.parse('2026-08-14T06:00:00Z') }),
      makeChar('Asia/Shanghai'),
      '2026-08-14',
    );
    expect(moment).toContain('就在今天');
  });

  it('角色时区决定墙上时间，不是设备本地时间', () => {
    // 同一个绝对时刻：上海是 14:00（下午），伦敦是 07:00（早上）。
    const at = entry({ date: '2026-08-14', timestamp: Date.parse('2026-08-14T06:00:00Z') });
    expect(describeLastMonologueMoment(at, makeChar('Asia/Shanghai'), '2026-08-14')).toContain('下午14:00');
    expect(describeLastMonologueMoment(at, makeChar('Europe/London'), '2026-08-14')).toContain('早上7:00');
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
