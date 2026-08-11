import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { setImageGenConfig, DEFAULT_IMAGE_GEN_CONFIG } from './imageGenApi';
import type { CharacterProfile, UserProfile, ImageGenApiConfig } from '../types';

// 端到端锁死「生图标签到底有没有进 system prompt」这件事。
//
// 背景：功能上线后连续几轮排查都卡在同一个问题上——角色只演不发图，而现场没有任何
// 手段能回答「提示词里到底教没教它这个标签」。（那几轮的真凶是一台跑着旧代码的僵尸
// dev server，但正因为没有这层断言，才只能靠猜。）
//
// 这份测试直接调真正的 prompt 构建函数，把两道门的四种组合全钉住：
//   门1 = 设置里的生图 API 配全没有（模块级单例，OSContext 同步）
//   门2 = 这个角色填没填「生图外貌」（CharacterProfile.imageGen.appearance）

const configured: ImageGenApiConfig = {
  ...DEFAULT_IMAGE_GEN_CONFIG,
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-image-2',
};

const makeChar = (over: Partial<CharacterProfile> = {}): CharacterProfile => ({
  id: 'c1',
  name: '陈觉斐',
  avatar: '',
  description: '',
  systemPrompt: '一个嘴硬的人。',
  memories: [],
  ...over,
} as CharacterProfile);

const userProfile = { name: '裴老师', persona: '' } as unknown as UserProfile;

const buildStable = async (char: CharacterProfile): Promise<string> => {
  const parts = await ChatPrompts.buildSystemPromptParts(
    char, userProfile, [], [], [], [],
  );
  return parts.stable;
};

describe('生图标签注入 system prompt', () => {
  beforeEach(() => setImageGenConfig(null));
  afterEach(() => setImageGenConfig(null));

  it('门1 关（没配生图 API）→ 两个标签都不教', async () => {
    const prompt = await buildStable(makeChar({ imageGen: { appearance: '1boy, 黑色短发' } }));
    expect(prompt).not.toContain('SEND_IMAGE');
    expect(prompt).not.toContain('SEND_SELFIE');
  });

  it('门1 开 + 门2 关（没填外貌）→ 只教 SEND_IMAGE，不教自拍', async () => {
    setImageGenConfig(configured);
    const prompt = await buildStable(makeChar());
    expect(prompt).toContain('[[SEND_IMAGE:');
    expect(prompt).not.toContain('SEND_SELFIE');
    // 并且要告诉它「为什么不能拍自己」，否则它会自己编一段发图的戏
    expect(prompt).toContain('不要写你自己的长相');
  });

  it('门1 开 + 门2 开 → 两个标签都教（这就是用户要的状态）', async () => {
    setImageGenConfig(configured);
    const prompt = await buildStable(makeChar({
      imageGen: { appearance: '1boy, 黑色短发, 单眼皮, 白衬衫', seed: 12345 },
    }));
    expect(prompt).toContain('[[SEND_IMAGE:');
    expect(prompt).toContain('[[SEND_SELFIE:');
    // 自拍那段必须明确禁止它自己写长相 —— 写了就把固定外貌冲乱
    expect(prompt).toContain('绝对不要写你的长相');
  });

  it('外貌只有空白字符 → 视同没填', async () => {
    setImageGenConfig(configured);
    const prompt = await buildStable(makeChar({ imageGen: { appearance: '   ' } }));
    expect(prompt).not.toContain('SEND_SELFIE');
  });

  it('生图 API 配了但开关关着 → 两个都不教', async () => {
    setImageGenConfig({ ...configured, enabled: false });
    const prompt = await buildStable(makeChar({ imageGen: { appearance: '1boy' } }));
    expect(prompt).not.toContain('SEND_IMAGE');
    expect(prompt).not.toContain('SEND_SELFIE');
  });

  it('模型名没填 → 当没配（少一项都不算配全）', async () => {
    setImageGenConfig({ ...configured, model: '' });
    const prompt = await buildStable(makeChar({ imageGen: { appearance: '1boy' } }));
    expect(prompt).not.toContain('SEND_IMAGE');
  });
});
