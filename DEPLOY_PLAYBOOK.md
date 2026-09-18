# Soul Animal — 可复用部署手册 (DEPLOY PLAYBOOK)

> 本手册汇总结构、路径、已验证的正确操作与**所有踩过的坑**。
> 下次做新测试题 / 新站点时，照着这里做，可避免重复出错。

---

## 1. 架构总览

```
[用户浏览器]
   │  打开 GitHub Pages 静态页
   │  index.html（单页含全部前端 JS）
   ▼
GitHub Pages (免费静态托管)
   https://gardenia937.github.io/soul-animal-personality/
   ▼  通过 fetch 调用（同源限制已由 CORS 处理）
Cloudflare Worker (免费后端/云函数)
   worker.js  soul-animal-api
   https://soul-animal-api.soul-animal.workers.dev
   ├── D1 数据库   soul-animal   → 存 sessions（答题/付款状态）
   └── KV 命名空间 SESSIONS     → 存会话会话变量
   ▼
PayPal Orders API (v2) —— 正式收款 $0.38，自动解锁
```

- 前端与后端分离。前端只是静态文件；所有逻辑在 Worker。
- 收款链路：网页下单 → PayPal 支付页 → 买家批准 → **商家必须 CAPTURE 收款码回收** → 解锁 → 用户自动看到结果。
- 自动解锁依赖 **Webhook**（PayPal 付款后回调 Worker）+ 前端轮询 `/api/payment/verify` 双保险。

---

## 2. 关键 ID / 凭据清单（非密钥部分可写在这里，密钥绝不入库）

### 基础设施
| 项 | 值 |
|---|---|
| Cloudflare Account ID | `ea23212085cc132af5d5182c3d7e0865` |
| Worker 名称 | `soul-animal-api` |
| Worker 地址 | `https://soul-animal-api.soul-animal.workers.dev` |
| D1 数据库 id | `soul-animal` / `68bc3b1d-650b-4398-85ae-9e45fc464538` |
| KV 命名空间 | `SESSIONS` / `55d635a0171b459eb64b741a7febd8cd` |
| GitHub 仓库 | `gardenia937/soul-animal-personality`（分支 main） |
| Pages 地址 | `https://gardenia937.github.io/soul-animal-personality/` |
| PayPal.Me 收款账号 | `gardenia2099`（企业收款） |

### Worker 环境变量（bindings/vars，部署 metadata 中）
| 变量 | 线上值 |
|---|---|
| `PAYMENT_PRICE_USD` | `0.38` |
| `SESSION_TTL_MINUTES` | `1440` |
| `PAYPAL_ME_USER` | `gardenia2099` |
| `PAYPAL_MODE` | `live`（测试时才用 `sandbox`） |
| `ALLOWED_ORIGIN` | `https://gardenia937.github.io` |
| `DEVELOPMENT_MODE` | `false` |
| `PUBLIC_BASE_URL` | `https://gardenia937.github.io/soul-animal-personality` |

### Worker Secrets（密钥——存放位置：Cloudflare 面板 + 本地文件，**绝不提交 git、不贴聊天**）
| 密钥 | 说明 | 当前来源 |
|---|---|---|
| `ADMIN_SECRET` | 管理员手动解锁用 | `~/soul-animal-admin-secret.txt` |
| `PAYPAL_CLIENT_ID` | 收款 App 凭据 | Live 应用面板 |
| `PAYPAL_CLIENT_SECRET` | 收款 App 凭据 | Live 应用面板 |
| `PAYPAL_WEBHOOK_ID` | 用于校验回调签名 | API 自动创建 |

> ⚠️ 密钥值不要在仓库里出现。README 只写占位符。

---

## 3. ⛔ 踩过的坑 —— 必须遵守的规则（最重要的一节）

### R1. Cloudflare secrets API 的字段名是 `text`，不是 `value`
```json
{"name":"PAYPAL_CLIENT_ID","type":"secret_text","text":"..."}
```
用错字段名会静默不生效，线上一直看不到该密钥。**排查密钥是否生效**看 `/api/debug-env` —— 但上线前必须删除该临时接口。

### R2. 部署顺序铁律：先上传脚本 → 再逐条写 4 个 secrets
- 上传脚本会**剥离全部 secrets** → 每次上传后必须重绑全部 4 个 secrets。
- 反例（曾消耗数小时）：先 PUT secrets 再上传脚本 → secrets 全丢，PayPal 首次调不通 `AUTH_FAILED`。
- 步骤永远是这样：
  1. `PUT /accounts/{acct}/workers/scripts/soul-animal-api`（带 metadata）
  2. 依次 `PUT .../scripts/.../secrets` × 4 条
- 改 vars（metadata）也走同样流程。

### R3. PayPal 是“两步”：APPROVED ≠ 已收款
- 买家在 PayPal 点“同意”后订单只是 `APPROVED`，钱没进你账户。
- 必须 `POST /v2/checkout/orders/{orderId}/capture` 执行收款，再重新 `GET` 确认 `COMPLETED` 才解锁。
- Webhook 也要注册三事件：`CHECKOUT.ORDER.APPROVED`、`PAYMENT.CAPTURE.COMPLETED`、`PAYMENT.CAPTURE.DENIED`。

### R4. Webhook 的 body 只能读一次
- `/api/verify-webhook` 必须在 `readBody()` 之前处理（它在 POST 分支的最前面，`else { const body = readBody...`之前），否则读不到流/验签失败。

### R5. return_url / cancel_url 必须用 `PUBLIC_BASE_URL`（完整子路径）
- 否则 PayPal 跳回 `https://gardenia937.github.io/`（根 404：`There isn't a GitHub Pages site here`）。
- 正确：`https://gardenia937.github.io/soul-animal-personality`。

### R6. verify 接口要返回“平铺结构”，前端才解析对
- 期望前端解析：`{ success, locked, result, code }`。
- 若用 `ok({success, locked:false, result})` 包一层 → 前端永远走“无法确认付款”兜底（曾因此以为支付失败，实际已收款）。

### R7. 分享链接（`?r=sessionId`）的公共视图
- `/api/result` 不需要鉴权；**paid 状态要豁免过期**（把 paid 判断放在 expires 判断之前）——否则分享链接 24 小时后失效。
- 前端共享模式：`state.shared=true` 时 **跳过 `save()`/`touchStorage()`**，否则会把分享者的会话写进访客本地存储，污染访客自己的答题。
- “自己测”按钮：先 `history.replaceState(null,"",location.pathname)` 去掉 `?r=`，再 `resetLocal(); boot()`，避免死循环。

### R8. 前端付款恢复逻辑
- 把 `paymentAttempt`（mode/orderId）写进 localStorage（key `sap_payment_attempt`），`boot()` 恢复 + `pageshow` 续轮询。
- 轮询上限调大到 450 次（PayPal 沙箱/跳转会超过原 15 次）。

### R9. Sandbox 与 Live 是两个世界
- API base：沙箱 `https://api-m.sandbox.paypal.com`，正式 `https://api-m.paypal.com`。
- 凭据完全不同；Webhook ID 也按环境各自创建。
- 沙箱测试必须用 **Personal（买家）** 沙箱账号，用 BUSINESS（卖家/facilitator）登录会报“您正在登录卖家的账户进行此次购物”。
- 判断切到 live 是否生效：创建订单，看 `approvalUrl` —— live 是 `www.paypal.com/checkoutnow`，sandbox 是 `www.sandbox.paypal.com/checkoutnow`。

### R10. 收款账号注意事项
- 收款人 = 企业账号 `gardenia2099`。测试真实收款不能用自己的号给自己付，要另一个人/个人号完成第一笔。
- 页面底部 PayPal 链接用企业 handle。

### R11. 前端部署缓存
- 改前端：commit + push 到 main，GitHub Pages 约 10~60 秒生效；验证用 `curl | grep` 新代码特征字符串。
- 用户看到旧版一般是缓存 → 让用户**无痕窗口 / Cmd+Shift+R** 验证。

### R12. 语法自检命令（改完立刻跑）
- worker.js 是 ESM：先用 `replace('export default {', 'const defaultExport = {')` 再 `new Function()` 校验（JXA osascript，见 §6）。

### R13. 安全底线
- **绝不把密钥/API Token 贴进聊天**。
- 出现在聊天里的 Cloudflare API Token **必须立刻删除并新建**（不会自动轮换；泄露者可读代码、读练库、删 Worker）。
- 临时调试接口（如 `/api/debug-env`）上线前彻底删除。
- 支持邮箱占位符（`support@soulnimal.co`）换真邮箱：`CONFIG.supportEmail` 与页脚 `mailto:` 两处。
- 权限最小化：新 Token 只给 Workers Scripts / D1 / KV 的 Edit（Custom token）。

### R14. CORS 收紧
- 只给 `ALLOWED_ORIGIN` 返回 `Access-Control-Allow-Origin`；非法来源不返回该头，OPTIONS 预检返回 403。
- 域名变化时，改 `ALLOWED_ORIGIN` + `PUBLIC_BASE_URL` 两处即可。

---

## 4. 路由总览（worker.js，100 行路由核心）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/info` | 产品/价格/模式/autoVerify（无需会话） |
| GET | `/api/questions?sessionId=` | 按会话洗牌后的 16 题 |
| GET | `/api/result?sessionId=` | 未付 `locked:true`；paid 永久返回结果 |
| POST | `/api/session` | 创建匿名会话，每 IP 限流 |
| POST | `/api/answers` | 提交 16 个答案，判分得 `result_type` |
| POST | `/api/payment/create` | 创建 PayPal 订单，返回 `orderId`+`approvalUrl` |
| POST | `/api/payment/verify` | 轮询/验单：未付 `PAYMENT_PENDING`；APPROVED→capture→解锁 |
| POST | `/api/verify-webhook` | PayPal 回调（**必须在 readBody 之前处理**） |
| POST | `/api/admin/manual-unlock` | `{adminToken, sessionId}` 手动解锁 |
| POST | `/api/admin/status` | `{adminToken, sessionId}` 查状态 |

D1 表 `sessions` 关键列：`payment_status`（none/awaiting_payment/awaiting_manual_verification/paid）、`result_type`、`order_id`、`payment_id`、`unlocked_at`、`expires_at`。

---

## 5. 标准部署流程

### A. 只改前端（index.html / 文案 / 样式）
```bash
cd "/Users/katerina/Documents/Default Project"
git add -A
git -c user.name="gardenia937" -c user.email="gardenia937@users.noreply.github.com" commit -m "描述"
git push origin main
# 等 10~60s，验证：
curl -s https://gardenia937.github.io/soul-animal-personality/ | grep "新代码特征字符串"
```

### B. 改后端 worker.js —— 完整序列（顺序不能乱）
```bash
# 1) 上传脚本 + metadata（vars 在这里面）
curl -s -X PUT -H "Authorization: Bearer $CF_TOKEN" \
  -F 'metadata=@/tmp/sap-metadata.json;type=application/json' \
  -F 'worker.js=@worker.js;type=application/javascript+module' \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/soul-animal-api"
# 2) 重绑 4 个 secrets（每个单独 PUT，字段名 text）
#    PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID / ADMIN_SECRET
# 3) 验证（等 ~40s 传播）：
curl -s -H "Origin: https://gardenia937.github.io" \
  https://soul-animal-api.soul-animal.workers.dev/api/info
#    期望 mode=checkout, autoVerify=true
```

### C. 切换 Sandbox ↔ Live
1. 改 vars：`PAYPAL_MODE` 值（metadata 文件里改，重新上传）。
2. 换 secrets：对应环境的 Client ID / Secret / Webhook ID（webhook 按环境单独创建）。
3. 重上传 + 重绑（同 B）。
4. 验证 approvalUrl 主域是 `www.sandbox.paypal.com`（沙箱）还是 `www.paypal.com`（live）。

### D. 创建正式 Webhook（用 Live 凭据调 PayPal API）
```bash
# 1) 拿 token
curl -s -u "$CLIENT_ID:$SECRET" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" https://api-m.paypal.com/v1/oauth2/token
# 2) 建 webhook
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://soul-animal-api.soul-animal.workers.dev/api/verify-webhook",
       "event_types":[{"name":"CHECKOUT.ORDER.APPROVED"},
                      {"name":"PAYMENT.CAPTURE.COMPLETED"},
                      {"name":"PAYMENT.CAPTURE.DENIED"}]}' \
  https://api-m.paypal.com/v1/notifications/webhooks
#    返回的 id 作为 PAYPAL_WEBHOOK_ID
```

---

## 6. 快速命令 & 自检

后端语法检查（macOS，JXA）：
```bash
osascript -l JavaScript -e "
ObjC.import('Foundation')
const p = '$PWD/worker.js'
let s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null).js
s = s.replace('export default {', 'const defaultExport = {')
new Function(s + '; defaultExport;')
'worker.js OK'
"
```
前端 JS 检查：取 index.html 里 `<script>` 块内容后 `new Function(...)`。

创建会话 + 下单验证（live/sandbox 均可）：
```bash
API=https://soul-animal-api.soul-animal.workers.dev
SID=$(curl -s -X POST -H "Content-Type: application/json" -d '{}' $API/api/session | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['sessionId'])")
curl -s -X POST -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"answers\":[0,1,2,3,0,1,2,3,0,1,2,3,0,1,2,3]}" $API/api/answers >/dev/null
curl -s -X POST -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}" $API/api/payment/create
# 看 approvalUrl 主域判断环境
```

ADMIN 手动解锁：
```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"adminToken":"<ADMIN_SECRET>","sessionId":"<SSID>"}' \
  https://soul-animal-api.soul-animal.workers.dev/api/admin/manual-unlock
```

查数据库（读，安全）：
```bash
curl -s -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"sql":"SELECT id,payment_status,result_type,payment_id FROM sessions ORDER BY created_at DESC"}' \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/d1/database/$DB/query"
```
面板查询路径：dash.cloudflare.com → Worker → D1（Console 标签）→ SQL → Run。
（注：新版面板直接 URL `/d1` 可能 404，改从 Worker 详情页进入。）

---

## 7. 新测试题 / 新站点上线 Checklist

- [ ] 前端：改题目、动物文案、颜色、产品名、价格文案、`CONFIG.supportEmail`（两处）、PayPal.Me 链接
- [ ] vars：`PAYMENT_PRICE_USD`、`PAYPAL_ME_USER`、`PUBLIC_BASE_URL`、`ALLOWED_ORIGIN`
- [ ] 用收款账号创建 **Live** REST App，取 Client ID / Secret
- [ ] 正式 Webhook：创建并把 id 作为 `PAYPAL_WEBHOOK_ID`
- [ ] `PAYPAL_MODE=live`；`DEVELOPMENT_MODE=false`
- [ ] 上传顺序：脚本 → 4 个 secrets（重绑）
- [ ] 删除所有临时调试接口
- [ ] 后端起 /api/info 验证：`mode=checkout`、`autoVerify=true`
- [ ] 下单验证 approvalUrl 主域 = `www.paypal.com`
- [ ] 前端 push 后 curl 验证新特征串
- [ ] 真实第一笔收款用他人账号付 $0.38，验证自动解锁 + 到账
- [ ] 检查入账：`SELECT * FROM sessions WHERE payment_status='paid'`
- [ ] 若 API Token 出现在聊天/历史 → 立即删除并新建（不贴新值）；只给最小权限
- [ ] 上线后用无痕窗口测一遍分享链接 `?r=<付费sessoinId>`

---

## 8. 联系方式 / 备份
- 密钥与 Token 建议集中存密码管理器；ADMIN_SECRET 存在于 `~/soul-animal-admin-secret.txt`。
- 本手册随仓库走，新项目复制本文件改对应值即可。