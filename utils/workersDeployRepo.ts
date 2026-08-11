/**
 * 「装着打包好的 worker 代码的部署仓库」地址 —— 一份来源，三处引用。
 *
 * 用户自部署 amsg 后端时，代码不是从 SullyOS 主仓库拿的，而是从一个只装
 * `worker.bundle.js` + `wrangler.toml` 的小仓库（见 .github/workflows/sync-workers-repo.yml：
 * 主仓库每次推送会把新 bundle 同步过去）。这样用户在 Cloudflare 上连一次 Git，
 * 之后更新只要点 GitHub 的「Sync fork」，不用再复制粘贴 400KB 的文件。
 *
 * ⚠️ **这是一个 fork，这里指向的是本 fork 自己的部署仓库，不是上游的。**
 *
 * 原本三处（一键部署 / worker 自更新 / 设置页的 fork 链接）各写死一份上游地址，
 * 结果是：本仓库对 worker 源码做的任何修改，用户点「一键部署」或「更新 Worker」
 * 都拿不到——拉回来的永远是上游的成品包，本地改动被静默覆盖。
 * （踩过一次：worker 侧不认识 `[[SEND_IMAGE]]` / `[[SEND_SELFIE]]`，
 * 即时对话下角色发的图在云端就被整段丢掉，客户端连降级气泡的机会都没有。）
 *
 * 换回上游 / 换成别人的部署仓库，只改这一处；worker 侧还可以用环境变量
 * `AMSG_BUNDLE_URL` 覆盖，连重新打包都不用（见 worker/amsg/src/selfUpdate.ts）。
 */

/** 部署仓库的 owner/name。同步工作流的 TARGET_REPO 也该是它。 */
export const WORKERS_DEPLOY_REPO = 'raoyu2655-eng/sullyos-workers';

/** 部署仓库网页地址（设置页给用户点的 fork 链接）。 */
export const WORKERS_REPO_URL = `https://github.com/${WORKERS_DEPLOY_REPO}`;

/** amsg 成品包所在目录的 raw 地址（下面挂 worker.bundle.js / wrangler.toml）。 */
export const AMSG_BUNDLE_BASE =
  `https://raw.githubusercontent.com/${WORKERS_DEPLOY_REPO}/main/amsg`;

/** amsg 成品包本体。一键部署和 worker 自更新都取它。 */
export const AMSG_BUNDLE_URL = `${AMSG_BUNDLE_BASE}/worker.bundle.js`;
