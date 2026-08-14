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
import { getCalendarDayDifference, getLocalDateKey } from './localDate';
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

export type MonologueEligibility =
  | 'ok'
  | 'already-today'   // 今天写过了
  | 'too-soon';       // 距上一篇聊得还不够多

/** 'too-short' 只有拿到正文之后才判得出来，所以它不在资格那一层。 */
export type MonologueGateVerdict = MonologueEligibility | 'too-short';

/** 与正文无关的那半边判据。组 prompt 时手上还没有正文，只能问到这一层。 */
export interface MonologueEligibilityInput {
  /** 该角色已有的独白，**新的在前**（DB.getMonologuesByCharId 就是这个顺序）。 */
  existing: CharMonologueEntry[];
  /** 角色时区下的今天（YYYY-MM-DD）。用 monologueDateKey 算，别传设备本地的。 */
  todayKey: string;
  /** 上一篇之后，跟这个角色又聊了多少条；没有上一篇时传该角色的消息总数。 */
  messagesSinceLast: number;
}

export interface MonologueGateInput extends MonologueEligibilityInput {
  /** 这次要写的正文（已 trim）。 */
  text: string;
}

/**
 * 这一轮**有没有资格**写。跟正文无关，所以组 prompt 时也问得出来。
 *
 * 拆出来是为了「闸关着就根本不告诉模型有这个功能」那条：不给机会比事后拦更管用，
 * 顺便省掉那三百多字每轮都带的开销。
 */
export const judgeMonologueEligibility = (input: MonologueEligibilityInput): MonologueEligibility => {
  const todayCount = input.existing.filter((entry) => entry.date === input.todayKey).length;
  if (todayCount >= MAX_MONOLOGUES_PER_DAY) return 'already-today';

  // 一篇都还没有的时候不查这一条：新角色的第一篇不该被「距上一篇」拦住，
  // 而 messagesSinceLast 传的是消息总数，本来也够。
  if (input.existing.length > 0 && input.messagesSinceLast < MIN_MESSAGES_SINCE_LAST) {
    return 'too-soon';
  }

  return 'ok';
};

/**
 * 准不准写（资格 + 正文）。**纯函数**——不读库、不看时钟，判据全从入参来，好钉测试。
 *
 * 正文长度排在资格之前：反过来的话，今天已经写过时会先报 already-today，把「模型
 * 这一轮吐了个空标记」这件事盖住，排查时看到的是一条误导性的判定。
 *
 * 被拦下时调用方要**静默丢弃**：不留系统提示、不 toast。「他刚才想写但没写成」
 * 这件事连角色自己都不知道，界面上冒出来就穿帮了。
 */
export const judgeMonologueGate = (input: MonologueGateInput): MonologueGateVerdict => {
  if (input.text.length < MIN_MONOLOGUE_CHARS) return 'too-short';
  return judgeMonologueEligibility(input);
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

/** 时段词。凌晨两点写的和下午三点写的是两种东西，这个词就是给角色标出那个差别的。 */
const dayPartLabel = (hour: number): string => {
  if (hour < 5) return '凌晨';
  if (hour < 11) return '早上';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
};

/**
 * 把上一篇的时刻写成角色能对上的样子：`8月10日 凌晨2:14（4 天前）`。
 *
 * **绝对时间和相对天数都要给。** 相对的那半截负责情绪重量——「才隔了一天」和
 * 「隔了半个月」对角色的意义完全不同，绝对日期给不了这个；绝对的那半截负责锚点——
 * 他是盲写的（看不到上一篇正文），只给「4 天前」的话，对不上具体哪天就容易写出
 * 跟上次矛盾的时间线。
 *
 * 墙上时间按**角色所在时区**算（docs/character-timezone.md：别用设备本地时间）。
 */
export const describeLastMonologueMoment = (
  entry: CharMonologueEntry,
  char: CharacterProfile,
  todayKey: string,
): string => {
  const wall = nowInTimeZone(resolveCharTimeZone(char), new Date(entry.timestamp));
  const clock = `${dayPartLabel(wall.getHours())}${wall.getHours()}:${String(wall.getMinutes()).padStart(2, '0')}`;
  const absolute = `${wall.getMonth() + 1}月${wall.getDate()}日 ${clock}`;

  const dayGap = getCalendarDayDifference(entry.date, todayKey);
  const relative = dayGap === null ? null
    : dayGap <= 0 ? '就在今天'
      : dayGap === 1 ? '昨天'
        : `${dayGap} 天前`;

  return relative ? `${absolute}（${relative}）` : absolute;
};

/**
 * 这一轮要注入的「私人记录」说明；**没资格写就返回 null，一个字都不注入**。
 *
 * 闸关着时根本不告诉模型有这个功能——不给机会比事后拦更管用，顺便省掉这三百多字
 * 每轮都带的开销。事后那道闸（judgeMonologueGate）照旧兜底，两层都在。
 *
 * 为什么这么写（每条都在治一种「今天也想你了呢」）：
 *   - **通篇不出现「日记」二字**。一说日记，模型就滑进「今天……我觉得……」的流水账语域。
 *   - **告诉它没人会读**。它不信这一点就会讨好、圆场、在结尾把负面情绪收回去。
 *     （user 其实读得到，但那是 user 的越界，不是角色的表达前提——见 plans 的第一条不变量。）
 *   - **正文里禁用「你」**。从语法上堵死「写成一封信」这条路，比任何形容词都管用。
 *   - **明说不用把话圆回来**。专治模型的收尾强迫症，那句「但我还是很珍惜」一加，
 *     前面的黑暗就全废了。
 *   - **给一把它自己能用的尺子**：能原样说出口的就不算。
 */
export const buildMonologuePromptBlock = (input: {
  char: CharacterProfile;
  userName: string;
  existing: CharMonologueEntry[];
  messagesSinceLast: number;
  now?: Date;
}): string | null => {
  const todayKey = monologueDateKey(input.char, input.now);
  const eligibility = judgeMonologueEligibility({
    existing: input.existing,
    todayKey,
    messagesSinceLast: input.messagesSinceLast,
  });
  if (eligibility !== 'ok') return null;

  const last = input.existing[0];
  // 只给心境词和时刻，**不给正文**：独白不回流上下文（plans 第二条不变量），但完全
  // 盲写会让他反复写同一个念头。一个词够他避开重复，又不至于把黑暗内容拖进日常对话。
  const lastLine = last
    ? `\n上一次这样写是 ${describeLastMonologueMoment(last, input.char, todayKey)}`
      + `${last.mood ? `，那次的心境是「${last.mood}」` : ''}。别重复那次已经说完的话。\n`
    : '';

  return `[私人记录]

你现在可以写下一段只属于你自己的东西。没有人会读到它——这不是写给谁看的，是你自己在心里过一遍。
${lastLine}
写不写你自己决定。**大多数时候都不该写。** 只有真的被什么戳到了、心里有一句非说不可、又绝不能说出口的话时才写。没有那句话就一个字都不要写，这很正常。

要写就用这个格式，放在你全部回复的最后：
[[MONOLOGUE_START: 一个词的心境]]
正文
[[MONOLOGUE_END]]

怎么写：
- ${SOFT_MIN_CHARS} 到 ${SOFT_MAX_CHARS} 字。
- 写最深的那一层：你怎么看${input.userName}、怎么看你们之间、怎么看你身边的其他人。
- **允许难看。** 自私、嫉妒、厌倦、算计、居高临下、不甘心——心里有什么就是什么。不用为它辩解，也不用在结尾把它圆回来。可以就那样停在难受的地方。
- **正文里不许出现「你」。** 这里没有听众。提到${input.userName}就用名字，或者你心里真正怎么称呼 ta。
- 不要复述今天发生了什么。事情不重要，你对它的看法才重要。
- 不要用「今天」开头。
- 检验标准只有一条：**这段话如果你能原样说给 ta 听，那它就不该写在这里。**`;
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
