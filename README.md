# Telegram 频道私信人机验证 Bot

> Cloudflare Workers + D1 + Cron · 零依赖 · 免费部署

当前版本 **v1.1.0** · 访问 Worker 根地址可直接查看版本号：
`https://<你的 Worker 域名>/` → `tg-channel-verify v1.1.0`
（请求头带 `Accept: application/json` 时返回 `{"name":"tg-channel-verify","version":"1.1.0"}`）

一个给 Telegram **频道私信(Channel Direct Messages)** 做人机验证的机器人。

用户第一次给频道发私信时,Bot 会要求他在规定时间内**原样回复一句指定的话**:

- ✅ **回对了** → 以后他发消息完全不受打扰
- ❌ **一直没回对** → **删掉他发过的所有消息**,并**永久封禁**踢出频道 —— 像从未来过一样

适合**频道开了私信、但被广告号骚扰**的频道主。

## 行为

| 收到什么                           | 怎么处理                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| 普通私聊 / 频道帖子 / 编辑消息     | 忽略(不查库、不调 API)                                      |
| 白名单以外频道的私信               | 忽略                                                        |
| Bot 被拉进普通群组                 | 自己退出                                                    |
| Bot 被拉进白名单以外的频道         | 自己退出                                                    |
| 频道私信 · 已验证用户              | 不处理                                                      |
| 频道私信 · 新用户                  | 发验证提示,记 `pending`                                     |
| 窗口内回复正确                     | 给那条消息点 💯;删掉验证提示;记为 `verified`(用户消息都保留) |
| 窗口内发别的(转发 / 图片 / 打错字) | 不算失败,继续等                                             |
| 窗口结束仍未通过                   | 删除该用户发过的**所有消息** + Bot 的提示 → 封禁踢出        |

> 封禁只看**时间窗口**,不看消息条数 —— 窗口内发多少条都不会被封。

## 环境变量

在 Cloudflare 的 **Settings → Variables and Secrets** 里配置:

| 名称                    | 是否必须                        | 示例值                 | 说明                                                         |
| ----------------------- | ------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `BOT_TOKEN`             | ✅ **必须**                      | `12345:AAH...`                      | @BotFather 给的 Bot Token                                    |
| `CHANNEL_IDS`           | ✅ **必须填**,否则不处理任何消息 | `-100123456789`                     | 允许的**频道 ID**，多个用`,`分隔。`*` = 全部允许 |
| `WEBHOOK_SECRET`        | ✅ **必须**                      | `abc-ABC_123`                      | 自定义字符串，用于校验 Telegram 请求。**未配置时 Worker 会拒绝处理所有请求**（fail closed）。只能使用`a-z` `A-Z` `0-9` `-` `_`（1~256位） |
| `PASS_PHRASE`           | ⬜ 可选                          | `我是真人，我不打广告` | 验证语,用户需原样回复                                        |
| `VERIFY_WINDOW_SECONDS` | ⬜ 可选                          | `600`                  | 超时秒数(默认 10 分钟)                                       |

**最小可运行配置**:`BOT_TOKEN` + `CHANNEL_IDS` + `WEBHOOK_SECRET` + 数据库绑定 **`DB`**。
其余变量都可以不填,代码里有默认值。

## 部署

### 方式 A：wrangler（推荐，可用 git 管理）

```bash
npm install
npx wrangler login
npx wrangler d1 create tg-channel-verify        # 把打印出的 database_id 填进 wrangler.toml
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```

`CHANNEL_IDS` 等普通变量写在 `wrangler.toml` 的 `[vars]` 里，改完重新 `wrangler deploy` 即可。

### 方式 B：网页控制台（不装任何东西）

1. **建 D1**:Cloudflare → Storage & Databases → D1 → 创建数据库
2. **建 Worker**:Workers & Pages → Create Worker → 把 [worker.js](https://github.com/Rude56/tg-channel-verify/blob/main/worker.js) 全部粘贴进编辑器 → Deploy
3. **绑定 D1**:Worker → Settings → Bindings → 添加 D1,变量名填 **`DB`**,选上一步的库
4. **配置环境变量**:Settings → Variables and Secrets,按上表添加
5. **建表**:不用手动建 —— 代码第一次处理消息时会自动创建 `verified_users` 表
6. **加定时任务**:Worker → Settings → Triggers → Cron,填 `* * * * *`
7. **设置 webhook**:浏览器打开下面这个链接(把 `<>` 换成你的值)

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<你的Worker网址>&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22my_chat_member%22%5D
```

8. **给 Bot 权限**:频道 → 管理 → 管理员 → 添加 Bot,勾选 **删除消息**(Delete Messages)和 **限制成员**(Restrict Members)
9. **填频道 ID**:给频道发一条私信 → 看 Worker 的 Logs,找到 `channelId=` 那串 → 填进 `CHANNEL_IDS` → 重新 Deploy

### 表结构(仅参考,代码会自动创建)

```sql
CREATE TABLE IF NOT EXISTS verified_users (
  user_id    TEXT PRIMARY KEY,
  topic_id   TEXT NOT NULL,
  chat_id    TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  pending_at INTEGER,
  created_at INTEGER NOT NULL,
  challenge_message_id TEXT,
  seen_message_ids     TEXT
);

CREATE INDEX IF NOT EXISTS idx_vu_pending
  ON verified_users(status, pending_at);
```

> 一次只执行一条语句(不要把两条一起粘)。
> **表结构改了怎么办?** D1 控制台执行 `DROP TABLE verified_users;`,下次收到消息会自动重建。

## 数据结构

单表 `verified_users`,只记状态,**不存任何消息内容**:

| 字段                   | 说明                                           |
| ---------------------- | ---------------------------------------------- |
| `user_id`              | Telegram 用户 ID(主键)                         |
| `topic_id`             | 频道私信话题 ID                                |
| `chat_id`              | 频道私信会话 ID(回消息用)                      |
| `channel_id`           | 频道 ID(白名单 / 封禁用)                       |
| `status`               | `pending` / `verified`                         |
| `pending_at`           | 开始验证的时间戳                               |
| `created_at`           | 首次出现时间                                   |
| `challenge_message_id` | Bot 验证提示的消息 ID(通过后删掉)              |
| `seen_message_ids`     | 用户发过的所有消息 ID(逗号分隔),失败时全部删掉 |

## 常用命令

**删除已验证用户**(在 D1 控制台执行):

| 目的                             | 命令                                                     |
| -------------------------------- | -------------------------------------------------------- |
| **只删"已验证"的**(最常用)       | `DELETE FROM verified_users WHERE status = 'verified';`  |
| 删某个用户                       | `DELETE FROM verified_users WHERE user_id = 1234567890;` |
| 清空全部(含待验证的)             | `DELETE FROM verified_users;`                            |
| 删表重建(**只在改了表结构时用**) | `DROP TABLE verified_users;`                             |

> 删记录 **≠ 解封**。被封禁的人数据库里本来就没记录,要让他能重新发消息,
> 得去 频道 → 管理 → 已封禁用户 → 解除封禁。

## 说明

- 频道私信消息里**不含频道 ID**,需要对私信会话调一次 `getChat` 取 `parent_chat.id`(结果缓存在 Worker 内存里)。
- Telegram 无法屏蔽私聊,但无关消息在入口就被丢弃,每条只花 1 次请求。
- 判定的是「Bot 首次见到该用户」,不是 Telegram 历史首条。
- 验证语用 HTML `<code>` 渲染成等宽,方便用户长按复制。
- 建议**不要公开 Bot 的用户名** —— 用户私信的是频道,不需要知道 Bot 是谁;公开了只会招来私聊消耗额度。

## 更新日志

### v1.1.0

- **`WEBHOOK_SECRET` 改为必填**：未配置时 Worker 返回 500 并记录日志，不再敞开接收任意 POST。升级后请务必在设置里补上，然后重新 setWebhook。
- **新增版本号**：`GET /` 返回 `tg-channel-verify v<版本>`，带 `Accept: application/json` 时返回 JSON。
- **删除消息受配额约束**：Cloudflare 免费版单次调用子请求上限 50，原先一次性串行删除全部消息会撞上限并静默失败。现在单轮最多 40 次调用，删不完的部分保留在数据库里，交给下一轮 cron 继续。
- **失败处理顺序调整**：先封禁再删消息；封禁未确认或消息没删完时**不再删除数据库记录**，避免"人没封上、记录也没了"的不一致状态。
- **sweep 增加 `ORDER BY pending_at ASC`**：按过期时间先后处理，旧记录不会被新记录挤掉。
- **表被外部 DROP 后自动重建**：命中 `no such table` 时重置内部 schema 标志，不必等 isolate 重启（改表结构仍建议 Redeploy）。
- **白名单判空提前**：`CHANNEL_IDS` 未配置时在调用 `getChat` 和查询数据库之前就返回，真正做到入口丢弃。
- **频道 ID 缓存加上限**（500 条，FIFO 淘汰），避免 isolate 内无限增长。
- **文案标点修正**：验证提示改用全角标点。
- 新增 `wrangler.toml`、`package.json`、`test/` 单元测试（`npm test`，10 个用例覆盖版本号、鉴权、验证流程、超时封禁、配额截断）。

## 开源协议

本项目采用 [MIT License](https://github.com/Rude56/tg-channel-verify/blob/main/LICENSE) 开源,可自由使用、修改、分发(含商用),只需保留版权声明。
