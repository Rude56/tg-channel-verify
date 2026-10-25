/**
 * Telegram 频道私信人机验证 Bot
 * Cloudflare Workers + D1 + Cron
 *
 * v1.1.0
 */

const VERSION = "1.1.0";
const TG_API = "https://api.telegram.org";
const DEFAULT_PASS_PHRASE = "我是真人，我不打广告";
const DEFAULT_WINDOW_SECONDS = 600;
const REACTION = "💯";
const SWEEP_LIMIT = 10;
// 免费版 Workers 单次调用子请求上限为 50，留出余量给 DB 与其它调用
const MAX_API_CALLS_PER_RUN = 40;
// 频道私信会话 -> 频道 ID 的缓存上限
const DM_CACHE_LIMIT = 500;

const ok = () => new Response("ok");
const nowSec = () => Math.floor(Date.now() / 1000);

function versionResponse(request) {
  const accept = request?.headers?.get?.("accept") || "";
  if (accept.includes("application/json")) {
    return new Response(
      JSON.stringify({ name: "tg-channel-verify", version: VERSION }),
      { headers: { "content-type": "application/json; charset=utf-8" } }
    );
  }
  return new Response(`tg-channel-verify v${VERSION}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// 单次调用内可用的 Telegram 子请求配额
function makeBudget(limit = MAX_API_CALLS_PER_RUN) {
  let left = limit;
  return {
    get left() {
      return left;
    },
    take() {
      if (left <= 0) return false;
      left -= 1;
      return true;
    },
  };
}

function getPassPhrase(env) {
  return String(env.PASS_PHRASE ?? "").trim() || DEFAULT_PASS_PHRASE;
}

function getWindowSeconds(env) {
  const n = Number(env.VERIFY_WINDOW_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WINDOW_SECONDS;
}

// 把 message id 追加进一个逗号分隔的字符串(最多留 1000 个,避免无限增长)
function appendMessageId(csv, id) {
  const list = String(csv || "").split(",").map((s) => s.trim()).filter(Boolean);
  const v = String(id || "").trim();
  if (!v || list.includes(v)) return list.join(",");
  list.push(v);
  return list.slice(-1000).join(",");
}

function splitMessageIds(csv) {
  return String(csv || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function humanizeSeconds(sec) {
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} 分钟`;
  if (sec > 60) return `${Math.round(sec / 60)} 分钟`;
  return `${sec} 秒`;
}

// 频道白名单。空 = 不处理任何频道;* = 全部允许;其余按逗号分隔
function getWhitelist(env) {
  const raw = String(env.CHANNEL_IDS ?? "").trim();
  if (!raw) return { mode: "none", ids: [] };
  if (raw === "*") return { mode: "all", ids: [] };
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.length ? { mode: "list", ids } : { mode: "none", ids: [] };
}

async function telegram(env, method, payload) {
  try {
    const res = await fetch(`${TG_API}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.ok !== true) {
      console.log(`[telegram] ${method} 失败: ` + JSON.stringify(data));
    }
    return data;
  } catch (err) {
    console.log(`[telegram] ${method} 异常: ` + (err?.message || String(err)));
    return null;
  }
}

function sendToTopic(env, chatId, topicId, text, extra = {}) {
  return telegram(env, "sendMessage", {
    chat_id: chatId,
    direct_messages_topic_id: Number(topicId),
    text,
    ...extra,
  });
}

async function reactToMessage(env, chatId, messageId) {
  const res = await telegram(env, "setMessageReaction", {
    chat_id: chatId,
    message_id: Number(messageId),
    reaction: [{ type: "emoji", emoji: REACTION }],
  });
  return res?.ok === true;
}

// 逐条删除,但受配额约束。返回没删完的 id 列表(交给下一轮 cron 继续)
async function deleteMessages(env, chatId, ids, budget) {
  const list = [
    ...new Set((ids || []).map((x) => (x == null ? "" : String(x).trim())).filter(Boolean)),
  ];
  const remaining = [];
  for (let i = 0; i < list.length; i++) {
    if (!budget.take()) {
      remaining.push(...list.slice(i));
      break;
    }
    await telegram(env, "deleteMessage", { chat_id: chatId, message_id: Number(list[i]) });
  }
  return remaining;
}

let schemaReady = false;

// 首次运行时自动建表(表结构变了就直接删表让它重建)
async function ensureSchema(env) {
  if (schemaReady) return;

  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS verified_users (
         user_id    TEXT PRIMARY KEY,
         topic_id   TEXT NOT NULL,
         chat_id    TEXT NOT NULL,
         channel_id TEXT NOT NULL,
         status     TEXT NOT NULL DEFAULT 'pending',
         pending_at INTEGER,
         created_at INTEGER NOT NULL,
         challenge_message_id TEXT,
         seen_message_ids     TEXT
       )`
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_vu_pending ON verified_users(status, pending_at)`
    ),
  ]);

  schemaReady = true;
}

// 表被外部 DROP 后 isolate 里的 schemaReady 会失效,这里做一次自愈
function handleDbError(err) {
  const msg = String(err?.message || err || "");
  if (/no such table/i.test(msg)) schemaReady = false;
  return msg;
}

const dmChatChannelCache = new Map();

function cacheSet(map, key, value) {
  if (map.size >= DM_CACHE_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

// 私信消息里的 chat 是「频道私信会话」,对它的 id 调 getChat 才能拿到真正的频道 id
async function resolveChannelId(message, env) {
  const chat = message?.chat;
  if (!chat || chat.id == null) return "";

  if (chat.parent_chat?.id != null) return String(chat.parent_chat.id);
  if (chat.type === "channel") return String(chat.id);

  const dmChatId = String(chat.id);
  if (dmChatChannelCache.has(dmChatId)) return dmChatChannelCache.get(dmChatId);

  const res = await telegram(env, "getChat", { chat_id: dmChatId });
  const channelId = res?.ok === true ? res.result?.parent_chat?.id : null;
  if (channelId == null) {
    console.log(`[getChat] 取不到频道 id,dmChatId=${dmChatId}`);
    return "";
  }

  const value = String(channelId);
  cacheSet(dmChatChannelCache, dmChatId, value);
  return value;
}

function isForwarded(message) {
  return (
    message?.forward_origin != null ||
    message?.forward_from != null ||
    message?.forward_from_chat != null ||
    message?.forward_sender_name != null ||
    message?.forward_date != null
  );
}

// Bot 被加入会话时:普通群组一律退出;频道不在白名单也退出
async function handleMyChatMember(update, env) {
  const chat = update.my_chat_member?.chat;
  const status = update.my_chat_member?.new_chat_member?.status;
  if (!chat || !status) return;
  if (status !== "member" && status !== "administrator" && status !== "restricted") return;
  if (chat.type === "private") return;
  if (chat.is_direct_messages === true) return;

  const chatId = String(chat.id);

  if (chat.type === "group" || chat.type === "supergroup") {
    await telegram(env, "leaveChat", { chat_id: chatId });
    return;
  }

  if (chat.type === "channel") {
    const wl = getWhitelist(env);
    if (wl.mode !== "list" || wl.ids.includes(chatId)) return;
    await telegram(env, "leaveChat", { chat_id: chatId });
  }
}

/**
 * 封禁 + 删除该用户的消息。
 * 顺序:先封禁(即使后续删除失败也不会漏封),再删消息。
 * 删不完 / 封禁未确认时保留记录,交给下一轮 cron 继续 —— 不会静默丢数据。
 */
async function failAndBan(env, { userId, channelId, chatId, messageIds }, budget) {
  let banned = true;
  if (channelId) {
    if (budget.take()) {
      const res = await telegram(env, "banChatMember", {
        chat_id: channelId,
        user_id: Number(userId),
        revoke_messages: true,
      });
      banned = res?.ok === true;
      if (!banned) console.log(`[ban] 封禁未确认 user=${userId} channel=${channelId}`);
    } else {
      banned = false;
    }
  }

  const remaining = await deleteMessages(env, chatId, messageIds || [], budget);

  if (banned && remaining.length === 0) {
    await env.DB.prepare("DELETE FROM verified_users WHERE user_id = ?").bind(userId).run();
    return true;
  }

  // 没做完:留下记录和未删的消息 id,下一轮 sweep / 下一条消息继续处理
  await env.DB.prepare("UPDATE verified_users SET seen_message_ids = ? WHERE user_id = ?")
    .bind(remaining.join(","), userId)
    .run();
  console.log(
    `[failAndBan] 未完成 user=${userId} banned=${banned} remaining=${remaining.length}`
  );
  return false;
}

async function handleUpdate(update, env) {
  if (update?.my_chat_member) {
    await handleMyChatMember(update, env);
    return;
  }

  const message = update?.message;
  const topic = message?.direct_messages_topic;
  if (!message || !topic?.topic_id) return;

  // 先判白名单再花钱:未配置时零成本丢弃
  const wl = getWhitelist(env);
  if (wl.mode === "none") return;

  const userId = String(topic.user?.id ?? message.from?.id ?? "");
  if (!userId) return;

  const topicId = String(topic.topic_id);
  const chatId = String(message.chat?.id ?? "");
  const messageId = message.message_id != null ? String(message.message_id) : "";

  const channelId = await resolveChannelId(message, env);
  if (wl.mode === "list" && (!channelId || !wl.ids.includes(channelId))) return;

  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT status, pending_at, challenge_message_id, seen_message_ids FROM verified_users WHERE user_id = ?"
  )
    .bind(userId)
    .first();

  const text = typeof message.text === "string" ? message.text.trim() : "";
  const passPhrase = getPassPhrase(env);
  const windowSec = getWindowSeconds(env);
  const ts = nowSec();

  if (row?.status === "verified") return;

  if (row?.status === "pending") {
    const expired = row.pending_at != null && ts - row.pending_at > windowSec;
    const hasOwnText = text.length > 0 && !isForwarded(message);

    if (hasOwnText && text === passPhrase && !expired) {
      const reacted = await reactToMessage(env, chatId, messageId);
      if (!reacted) console.log(`[react] 点表情失败 messageId=${messageId}`);

      await deleteMessages(env, chatId, [row.challenge_message_id], makeBudget(2));
      await env.DB.prepare(
        `UPDATE verified_users
            SET status = 'verified', pending_at = NULL,
                challenge_message_id = NULL, seen_message_ids = NULL
          WHERE user_id = ?`
      )
        .bind(userId)
        .run();
      return;
    }

    // 把这条消息记下来,验证失败时一并删除
    const seen = appendMessageId(row.seen_message_ids, messageId);
    if (seen !== String(row.seen_message_ids || "")) {
      await env.DB.prepare("UPDATE verified_users SET seen_message_ids = ? WHERE user_id = ?")
        .bind(seen, userId)
        .run();
    }

    if (!expired) return;

    await failAndBan(
      env,
      {
        userId,
        channelId,
        chatId,
        messageIds: [row.challenge_message_id, ...splitMessageIds(seen)],
      },
      makeBudget()
    );
    return;
  }

  const sent = await sendToTopic(
    env,
    chatId,
    topicId,
    `⭕ 正在进行人机验证，请在 ${humanizeSeconds(windowSec)}内，把下面这句话原样发给我，否则将会被永久封禁：\n\n` +
      `<code>${escapeHtml(passPhrase)}</code>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        force_reply: true,
        input_field_placeholder: passPhrase,
      },
    }
  );

  if (!sent || sent.ok !== true) return;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO verified_users
       (user_id, topic_id, chat_id, channel_id, status, pending_at, created_at,
        challenge_message_id, seen_message_ids)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  )
    .bind(
      userId,
      topicId,
      chatId,
      channelId,
      ts,
      ts,
      sent.result?.message_id != null ? String(sent.result.message_id) : null,
      messageId || null
    )
    .run();
}

async function sweepExpired(env) {
  if (getWhitelist(env).mode === "none") return;

  await ensureSchema(env);

  const cutoff = nowSec() - getWindowSeconds(env);
  // ORDER BY:先处理最早过期的,避免旧记录被新记录挤掉永远轮不到
  const rows = await env.DB.prepare(
    `SELECT user_id, channel_id, chat_id, challenge_message_id, seen_message_ids
       FROM verified_users
      WHERE status = 'pending' AND pending_at IS NOT NULL AND pending_at <= ?
      ORDER BY pending_at ASC
      LIMIT ${SWEEP_LIMIT}`
  )
    .bind(cutoff)
    .all();

  const budget = makeBudget();
  for (const r of rows.results || []) {
    if (budget.left <= 0) break;
    await failAndBan(
      env,
      {
        userId: String(r.user_id),
        channelId: String(r.channel_id || ""),
        chatId: String(r.chat_id || ""),
        messageIds: [r.challenge_message_id, ...splitMessageIds(r.seen_message_ids)],
      },
      budget
    );
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return versionResponse(request);

    const secret = String(env.WEBHOOK_SECRET ?? "").trim();
    if (!secret) {
      console.log("[config] WEBHOOK_SECRET 未配置，拒绝处理请求(fail closed)");
      return new Response("webhook secret not configured", { status: 500 });
    }
    const token = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (token !== secret) return new Response("forbidden", { status: 403 });

    let update;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    try {
      await handleUpdate(update, env);
    } catch (err) {
      const msg = handleDbError(err);
      console.log("[handleUpdate] 出错: " + msg);
    }

    return ok();
  },

  async scheduled(event, env) {
    try {
      await sweepExpired(env);
    } catch (err) {
      const msg = handleDbError(err);
      console.log("[sweepExpired] 出错: " + msg);
    }
  },
};
