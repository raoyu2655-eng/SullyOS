import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { WORKERS_DEPLOY_REPO, WORKERS_REPO_URL, AMSG_BUNDLE_BASE, AMSG_BUNDLE_URL } from './workersDeployRepo';

// 部署仓库地址有两个独立的消费方，指到不同仓库时**不会报任何错**：
//   - utils/workersDeployRepo.ts  → 一键部署 / worker 自更新「去哪儿取代码」
//   - sync-workers-repo.yml       → CI「把新 bundle 推到哪儿」
// 错位的表现是「同步成功了、部署也成功了，但装上去的是另一份代码」——
// 本仓库对 worker 源码的改动静默丢失。踩过一次（worker 不认识生图标签，
// 即时对话下角色发的图在云端被整段丢掉），所以这里钉死。
describe('部署仓库地址一致性', () => {
  it('同步工作流的 TARGET_REPO 与 WORKERS_DEPLOY_REPO 一致', () => {
    const yml = readFileSync(new URL('../.github/workflows/sync-workers-repo.yml', import.meta.url), 'utf8');
    const m = yml.match(/^\s*TARGET_REPO:\s*(\S+)\s*$/m);
    expect(m, '在 sync-workers-repo.yml 里没找到 TARGET_REPO').toBeTruthy();
    expect(m![1]).toBe(WORKERS_DEPLOY_REPO);
  });

  it('派生出来的三个地址都基于同一个仓库', () => {
    expect(WORKERS_REPO_URL).toBe(`https://github.com/${WORKERS_DEPLOY_REPO}`);
    expect(AMSG_BUNDLE_BASE).toContain(WORKERS_DEPLOY_REPO);
    expect(AMSG_BUNDLE_URL.startsWith(AMSG_BUNDLE_BASE)).toBe(true);
    expect(AMSG_BUNDLE_URL.endsWith('/worker.bundle.js')).toBe(true);
  });

  it('全是 https（自更新会照着它覆盖自己，明文源不能要）', () => {
    for (const u of [WORKERS_REPO_URL, AMSG_BUNDLE_BASE, AMSG_BUNDLE_URL]) {
      expect(u.startsWith('https://')).toBe(true);
    }
  });

  it('客户端与 worker 两侧都不再写死上游地址（改一处要真的处处生效）', () => {
    for (const f of ['./cfProvision.ts', '../worker/amsg/src/selfUpdate.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      const hardcoded = src.match(/['"`]https:\/\/raw\.githubusercontent\.com\/[^'"`]+/g) || [];
      expect(hardcoded, `${f} 里还有写死的 raw 地址：${hardcoded.join(', ')}`).toHaveLength(0);
    }
  });
});
