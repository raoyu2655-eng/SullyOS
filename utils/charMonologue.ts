/**
 * 角色独白 —— 他自己写下的那一页。设计与取舍见 plans/char-monologue.md。
 *
 * 这个文件管两件事：**什么时候准写**（防刷闸，纯函数，好写测试）和**怎么存**。
 * 解析 tag、组 prompt、渲染各在自己的地方，别往这儿堆。
 *
 * 两条不变量（改之前先读 plans 里的理由）：
 *   1. 角色不知道这些被读过——`readAt` 只服务于界面上的未读点，任何 prompt 组装都不许读它。
 *   2. 不进每轮上下文，只进记忆宫殿。
 */

import type { CharacterProfile, CharMonologueEntry } from '../types';
import { DB } from './db';
import { getLocalDateKey } from './localDate';
import { nowInTimeZone, resolveCharTimeZone } from './timezone';

/**
 * 同一天最多一篇。
 *
 * 按**角色所在时区**的日期 key 判，不是滚动 24 小时：跨过角色那边的午夜之后再写一篇
 * 是合理的（他睡了一觉、又过了一天），而滚动窗口会把这种情况一起拦掉。
 */
export const MAX_MONOLOGUES_PER_DAY = 1;

/**
 * 距上一篇之间，跟这个角色至少要再聊这么多条。
 *
 * 只有日限的话，一天里说三句话就能触发一篇「最深的想法」——那不叫有感而发，叫例行公事。
 * 20 条是拍的：够一段有来有回的对话，又不至于要聊到天荒地老。
 */
export const MIN_MESSAGES_SINCE_LAST = 20;

/** 低于这个字数当模型误触发处理，直接丢。100 是设计下限，但 100 和 5 是两种错。 */
export const MIN_MONOLOGUE_CHARS = 20;

/** 设计里的字数区间。越界不截断（截断会把结尾切碎），只记一条 warn。 */
export const SOFT_MIN_CHARS = 100;
export const SOFT_MAX_CHARS = 800;

export type MonologueGateVerdict =
  | 'ok'
  | 'already-today'   // 今天写过了
  | 'too-soon'        // 距上一篇聊得还不够多
  | 'too-short';      // 短到不像一篇，当误触发

export interface MonologueGateInput {
  /** 该角色已有的独白，**新的在前**（DB.getMonologuesByCharId 就是这个顺序）。 */
  existing: CharMonologueEntry[];
  /** 角色时区下的今天（YYYY-MM-DD）。用 monologueDateKey 算，别传设备本地的。 */
  todayKey: string;
  /** 上一篇之后，跟这个角色又聊了多少条；没有上一篇时传该角色的消息总数。 */
  messagesSinceLast: number;
  /** 这次要写的正文（已 trim）。 */
  text: string;
}

/**
 * 准不准写。**纯函数**——不读库、不看时钟，判据全从入参来，好钉测试。
 *
 * 被拦下时调用方要**静默丢弃**：不留系统提示、不 toast。「他刚才想写但没写成」
 * 这件事连角色自己都不知道，界面上冒出来就穿帮了。
 */
export const judgeMonologueGate = (input: MonologueGateInput): MonologueGateVerdict => {
  if (input.text.length < MIN_MONOLOGUE_CHARS) return 'too-short';

  const todayCount = input.existing.filter((entry) => entry.date === input.todayKey).length;
  if (todayCount >= MAX_MONOLOGUES_PER_DAY) return 'already-today';

  // 一篇都还没有的时候不查这一条：新角色的第一篇不该被「距上一篇」拦住，
  // 而 messagesSinceLast 传的是消息总数，本来也够。
  if (input.existing.length > 0 && input.messagesSinceLast < MIN_MESSAGES_SINCE_LAST) {
    return 'too-soon';
  }

  return 'ok';
};

/** 角色时区下的今天。所有跟日期有关的判断都走这里，别自己手搓时差。 */
export const monologueDateKey = (char: CharacterProfile, base: Date = new Date()): string =>
  getLocalDateKey(nowInTimeZone(resolveCharTimeZone(char), base));

/**
 * 字数越界时的提示语；在区间内返回 null。
 *
 * 只警告不处理：截断会把结尾切碎，而结尾往往是一篇独白里最重的一句。
 */
export const describeLengthDrift = (text: string): string | null => {
  if (text.length < SOFT_MIN_CHARS) return `独白只有 ${text.length} 字（低于 ${SOFT_MIN_CHARS}），照存不截断`;
  if (text.length > SOFT_MAX_CHARS) return `独白有 ${text.length} 字（超过 ${SOFT_MAX_CHARS}），照存不截断`;
  return null;
};

export interface WriteMonologueInput {
  char: CharacterProfile;
  text: string;
  mood?: string;
  /** 当时最后一条消息的 id，用来回答「他因为什么写的」。 */
  triggerMessageId?: number;
  /** 上一篇之后跟这个角色又聊了多少条；调用方现算（见 countMessagesSinceLast）。 */
  messagesSinceLast: number;
}

export interface WriteMonologueResult {
  verdict: MonologueGateVerdict;
  /** 只有 verdict === 'ok' 时才有。 */
  entry?: CharMonologueEntry;
  /** 字数越界的提示；不影响是否落库。 */
  lengthWarning?: string | null;
}

/**
 * 过闸 → 落库。被拦下时**什么都不写、什么都不提示**，只把判定回给调用方记日志。
 */
export const writeMonologue = async (input: WriteMonologueInput): Promise<WriteMonologueResult> => {
  const text = input.text.trim();
  const todayKey = monologueDateKey(input.char);
  const existing = await DB.getMonologuesByCharId(input.char.id);

  const verdict = judgeMonologueGate({
    existing,
    todayKey,
    messagesSinceLast: input.messagesSinceLast,
    text,
  });
  if (verdict !== 'ok') return { verdict };

  const entry: CharMonologueEntry = {
    id: `mono-${input.char.id}-${Date.now()}`,
    charId: input.char.id,
    date: todayKey,
    text,
    // 模型没给心境就不给——替它编一个，等于把界面上那一栏变成永远有值的装饰。
    ...(input.mood?.trim() ? { mood: input.mood.trim() } : {}),
    ...(input.triggerMessageId != null ? { triggerMessageId: input.triggerMessageId } : {}),
    timestamp: Date.now(),
  };
  await DB.saveMonologue(entry);
  return { verdict: 'ok', entry, lengthWarning: describeLengthDrift(text) };
};

/**
 * 上一篇独白之后，跟这个角色又聊了多少条。没有上一篇就返回该角色的消息总数。
 *
 * 按时间戳数而不是按 id 差：消息 id 是全库自增的，中间跟别的角色聊过就会把差值撑大，
 * 闸会因此形同虚设。
 */
export const countMessagesSinceLast = (
  messages: { timestamp: number }[],
  existing: CharMonologueEntry[],
): number => {
  const last = existing[0]; // 新的在前
  if (!last) return messages.length;
  return messages.filter((message) => message.timestamp > last.timestamp).length;
};
