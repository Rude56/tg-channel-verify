# Telegram 频道私信人机验证 Bot

Cloudflare Workers + D1 + Cron。给「频道私信」做一次性人机验证,挡住广告号。

用户第一次给频道发私信时,Bot 发一条验证提示;对方在规定时间内原样回复验证语即通过。
通过的记进数据库,以后不再打扰;一直没通过的会被清空私信并永久封禁。

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
| 窗口结束仍未通过                   | 删除整个私信话题(所有消息)→ 封禁踢出                        |

## 环境变量

在 Cloudflare 的 **Settings → Variables and Secrets** 里配置:

| 名称                    | 类型   | 默认                   | 说明                                                         |
| ----------------------- | ------ | ---------------------- | ------------------------------------------------------------ |
| `BOT_TOKEN`             | Secret | —                      | @BotFather 给的 Bot Token                                    |
| `WEBHOOK_SECRET`        | Secret | —                      | 自定义字符串,用于校验 webhook 来源                           |
| `CHANNEL_IDS`           | Text   | 空                     | 允许的**频道 ID**(以 `-100` 开头),多个用逗号分隔。空 = 不处理任何频道;`*` = 全部允许 |
| `PASS_PHRASE`           | Text   | `我是真人，我不打广告` | 验证语,需原样回复                                            |
| `VERIFY_WINDOW_SECONDS` | Text   | `600`                  | 超时秒数(默认 10 分钟)                                       |

数据库绑定名必须是 **`DB`**。

## 部署

1. **建 D1**:Cloudflare → Storage & Databases → D1 → 创建 `tg_channel_verify`
2. **建 Worker**:Workers & Pages → Create Worker → 把 `worker.js` 全部粘贴进编辑器 → Deploy
3. **绑定 D1**:Worker → Settings → Bindings → 添加 D1,变量名填 `DB`,选上一步的库
4. **配置环境变量**:Settings → Variables and Secrets,按上表添加
5. **建表**:不用手动建 —— 代码第一次处理消息时会自动创建 `verified_users` 表
6. **加定时任务**:Worker → Settings → Triggers → Cron,填 `* * * * *`
7. **设置 webhook**:浏览器打开下面这个链接(把 `<>` 换成你的值)

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=<你的Worker网址>&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22my_chat_member%22%5D
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
  first_message_id     TEXT
);

CREATE INDEX IF NOT EXISTS idx_vu_pending
  ON verified_users(status, pending_at);
```

> 如果你想手动先建好,一次只执行一条语句(不要把两条一起粘)。
> **表结构改了怎么办?** 在 D1 控制台执行 `DROP TABLE verified_users;`,下次收到消息会自动重建。

## 数据结构

单表 `verified_users`,只记状态,**不存任何消息内容**:

| 字段                   | 说明                              |
| ---------------------- | --------------------------------- |
| `user_id`              | Telegram 用户 ID(主键)            |
| `topic_id`             | 频道私信话题 ID                   |
| `chat_id`              | 频道私信会话 ID(回消息用)         |
| `channel_id`           | 频道 ID(白名单 / 封禁用)          |
| `status`               | `pending` / `verified`            |
| `pending_at`           | 开始验证的时间戳                  |
| `created_at`           | 首次出现时间                      |
| `challenge_message_id` | Bot 验证提示的消息 ID(通过后删掉) |
| `first_message_id`     | 用户第一条消息 ID                 |

## 说明

- 频道私信消息里**不含频道 ID**,需要对私信会话调一次 `getChat` 取 `parent_chat.id`(结果缓存在 Worker 内存里)。
- Telegram 无法屏蔽私聊,但无关消息在入口就被丢弃,每条只花 1 次请求。
- 判定的是「Bot 首次见到该用户」,不是 Telegram 历史首条。
- 验证语用 HTML `<code>` 渲染成等宽,方便用户长按复制。
