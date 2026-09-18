# AGENTS.md

本项目为"人格测试社区版"：GitHub Pages 前端 + Cloudflare Worker 后端 + PayPal 自动收款解锁。

开始工作前**必读**：
1. `DEPLOY_PLAYBOOK.md` —— 全部架构、ID/凭据位置、部署顺序铁律、踩过的坑、上线 Checklist。
2. `wrangler.toml`、`schema.sql`、`README.md` —— 线上配置与文档。

纪律（详见 playbook，勿违反）：
- 部署顺序：先上传脚本 → 再逐条重绑 4 个 secrets；每次上传后必须重绑。
- 密钥（ADMIN_SECRET / PAYPAL_*）不写入仓库、不贴进聊天。
- 改前端：commit+push main 即可（GitHub Pages 约 10~60s 生效）。
- 改后端：worker.js 用 JXA 校验（ESM 先 replace `export default {`），再走上线流程。
- 线上配置 = Cloudflare 上的 secrets+vars（metadata），以 Playbook §5 为准。