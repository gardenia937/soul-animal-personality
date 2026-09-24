# Peekiva《What Are We, Really?》暧昧关系测试 — 中文部署教程

品牌 Peekiva · 测试名 What Are We, Really? · 独立站 https://peekiva.com · 邮箱 gardennia973@gmail.com
前端: 单个 `index.html` (GitHub Pages 或 Cloudflare Pages 均可) · 后端: Cloudflare Worker (`worker/index.js`)
数据库: Cloudflare D1 · 付款: PayPal Orders API · ** single 价格 $0.38 USD, 单次付款, 无订阅**

> 密钥绝不进仓库、不贴进聊天。价格以 Worker 环境变量 `PRICE_USD` 为准, 前端金额一律忽略。

---

## 0. 文件一览 (`peekiva-relationship-test/`)

| 文件 | 说明 |
|---|---|
| `index.html` | 完整前端(单文件)。先把 `CONFIG.apiBase` 换成你的 Worker 地址 |
| `worker/index.js` | 完整后端。计分/六种结果文案/验单/鉴权全在服务端 |
| `schema.sql` | D1 表结构 (`test_sessions` 私人会话 + `payments` 付款记录 + `share_cards` 永久分享卡) |
| `wrangler.toml` | Worker 配置模板, `database_id` / Pages 域名部署时替换 |
| `package.json` / `.gitignore` | 辅助文件 |
| `README.md` | 本文件 |

## 1. 需要你手动填写的配置清单 (全部集中在这里)

| 位置 | 填什么 | 去哪找 |
|---|---|---|
| `index.html` → `CONFIG.apiBase` | Worker 地址, 如 `https://what-are-we-really-api.xxx.workers.dev` | 部署 Worker 后得到 |
| `wrangler.toml` → `database_id` | D1 数据库 ID | `wrangler d1 create` 返回 |
| `wrangler.toml` → `ALLOWED_ORIGIN` / `PUBLIC_BASE_URL` | 前端正式地址 (结尾不带 `/`) | Pages 地址或自定义域名 |
| `wrangler secret put PAYPAL_CLIENT_ID` | PayPal REST App 的 Client ID | PayPal Developer 面板 |
| `wrangler secret put PAYPAL_CLIENT_SECRET` | PayPal REST App 的 Secret | 同上 (只显示一次, 妥善保存) |
| `wrangler secret put PAYPAL_WEBHOOK_ID` | Webhook ID | 建完 Webhook 后返回 |
| `wrangler secret put ADMIN_SECRET` | ≥16 位随机字符串, 人工兜底解锁用 | 自己生成, 存密码管理器 |

## 2. 从零开始部署 (跟着做就行, 不用写代码)

1. **Cloudflare 账号**: 打开 https://dash.cloudflare.com/sign-up 注册并验证邮箱。
2. **前端**: 本仓库推送到 GitHub 后, GitHub Pages 自动发布,
   新测试地址形如 `https://<你的用户名>.github.io/<仓库>/peekiva-relationship-test/`。
   也可以用 Cloudflare Pages → Upload assets 直接拖入 `index.html`。
3. **D1 数据库**: `npm i -g wrangler && wrangler login`, 然后
   `wrangler d1 create what-are-we-really`, 把返回的 id 填进 `wrangler.toml`。
4. **初始化表**: `wrangler d1 execute what-are-we-really --remote --file=schema.sql`。
5. **部署 Worker**: `cd peekiva-relationship-test && wrangler deploy`, 得到 WORKER_URL。
6. **回填前端**: 把 WORKER_URL 填进 `index.html` 的 `CONFIG.apiBase`, 重新推送/上传。
7. **Secrets**: 用上面表格里的 4 条 `wrangler secret put` 逐条设置。
   **部署铁律: 每次 `wrangler deploy` 上传脚本后, 4 个 secrets 必须逐条重绑** (上传会剥离 secrets)。
8. **PayPal 应用**: https://developer.paypal.com → REST App → 拿 Client ID / Secret。
   先用 Sandbox 测试, 正式时换 Live (两套凭据完全不同, Webhook 也要各建一个)。
9. **Webhook**: PayPal 面板 → Webhooks → URL 填 `https://你的WORKER/api/verify-webhook`,
   勾选 `CHECKOUT.ORDER.APPROVED`、`PAYMENT.CAPTURE.COMPLETED`、`PAYMENT.CAPTURE.DENIED`,
   返回的 id 写入 `PAYPAL_WEBHOOK_ID`。
10. **切换正式**: `PAYPAL_MODE=live` → redeploy → 重绑 4 secrets →
    下单看 approvalUrl 主域是 `www.paypal.com` 即正式。第一笔正式款请用**他人账号**付 $0.38。

## 3. 完整付款与解锁流程 (中文)

1. 前端开始测试 → `POST /api/session` 拿 sessionId + token (token 存 localStorage, 只是会话凭证)。
2. 答完 24 题 → `POST /api/answers` 存答案, 服务端计分 (A=100/B=66/C=33/D=0, 每维度6题平均, 一位小数) 并判定六种结果, **但不返回结果**。
3. 付款页显示服务端定价 $0.38 → `POST /api/payment/create`: Worker 按服务端价格向 PayPal 建单 (`custom_id`=会话ID), 回 approvalUrl。
4. 用户去 PayPal 批准 → 跳回 `?paid=1` → 前端 `POST /api/payment/verify`。
5. Worker 向 PayPal 查单: APPROVED 则 capture; 必须 `COMPLETED` + 金额 0.38 + 币种 USD + custom_id=本会话 + capture 去重 → 标记 paid, 写 `payments` 表 (幂等)。
6. 前端 `GET /api/result?sessionId=&token=` : Worker 验 token + paid 后才返回完整三段分析。
7. Webhook (`/api/verify-webhook`) 作为第二路保险, 同样条件解锁 (幂等)。
8. 全程不信任前端金额/按钮/localStorage; 生产环境无模拟解锁入口。

PayPal.me (`https://paypal.me/gardenia2099`) 只是备用收款地址, 不能自动验单;
如需人工兜底, 用 `POST /api/admin/unlock` (ADMIN_SECRET)。

## 4. 永久分享卡片 vs 私人付费报告

| | 私人付费报告 | 永久分享卡片 |
|---|---|---|
| 存哪 | `test_sessions` | `share_cards` (独立记录) |
| 内容 | 完整三段分析, 需 token + paid 鉴权 | 仅结果类型 + 一句话描述 + 四维分数 |
| 有效期 | 以会话为准 | **永久**, 不自动过期 |
| 访问 | 需会话 token | 需不可预测分享ID (`/s/ID`), 无需付款 |
| 泄露 | — | 不含答题/付款/邮箱/订单号/token |
| 撤销 | — | `POST /api/revoke-share` 后立即失效 |

社交预览: Worker `/s/:id` 返回带 OG meta 的 HTML。
注意各 App 爬虫抓取差异大 (纯客户端无法保证 100%, 以实测为准)。

## 5. 本地预览 (双击 `index.html`)

- [ ] 顶部出现 DEMO MODE 横幅; 封面全英文
- [ ] 24 题、每题 4 选项、进度条、Previous 保留答案、刷新续答、Exit 保留进度、重开有确认框
- [ ] 最后一题后进付款页, 显示 $0.38 USD + One-time payment. No subscription.
- [ ] Preview My Result 显示类型 + 四维分数 (演示, 非正式付费报告)
- [ ] Share My Results 生成 `?s=DEMO_...` 预览卡 (演示, 非永久链接)
- [ ] Retake 弹窗含重新付费 $0.38 说明; Discover More 跳 peekiva.com; 页脚邮箱 mailto 正确
- [ ] 断网/未配置 Worker 时付款页明确报错, **绝不伪造解锁**

## 6. 验收清单 (对照打勾)

- [ ] 24 道英文题, 每题 4 选项, 无占位符
- [ ] A=100/B=66/C=33/D=0, 四维度平均一位小数
- [ ] 六种结果各有完整英文三段分析 (Worker 内)
- [ ] 分类严格按优先级 (one-sided > dependence > short-term > real > potential > gray)
- [ ] 未支付调 `/api/result` 返回 LOCKED
- [ ] 金额/币种/归属任一不对都拒绝解锁; 重复 capture 幂等
- [ ] 分享链接永久有效, 有 Take the Test + Discover More (→https://peekiva.com)
- [ ] Retake 提示重付 $0.38, 新会话, 旧结果和旧分享链接保留
- [ ] Web Share + Copy Link, 复制成功提示 Link copied!
- [ ] 手机 + 桌面无横向滚动, 雷达图不溢出, 按钮 ≥48px
- [ ] 页脚邮箱链接全站一致
- [ ] 仓库无密钥 (`grep -ri secret` 只命中占位符/教程文字)

## 7. 常见问题排查

- **付款后不解锁**: 先查 `/api/admin/status` 看状态; 再看 approvalUrl 主域确认 sandbox/live 是否切对;
  沙箱必须用 Personal(买家)号付, 不能用卖家号给自己付。
- **上传 Worker 后 PayPal 调不通**: 99% 是 secrets 被剥离 → 4 条逐条重绑 (部署铁律)。
- **分享链接打不开**: 确认用的是 `/s/ID` 完整链接; 被撤销的卡会显示 Link unavailable。
- **跨域错误**: `ALLOWED_ORIGIN` 必须与前端地址完全一致 (含子路径域名、结尾不带 `/`)。
- **看到旧版页面**: 无痕窗口 / Cmd+Shift+R 硬刷新; Pages 约 10–60 秒生效。
- **API Token 出现在聊天/历史**: 立刻删除并新建 (最小权限: Workers Scripts / D1 Edit)。
