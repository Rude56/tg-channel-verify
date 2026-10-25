import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";

const SECRET = "test-secret";
const PASS = "我是真人，我不打广告";

// ---------- 极简 D1 模拟 ----------
class Stmt {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql.replace(/\s+/g, " ").trim();
    this.args = [];
  }
  bind(...args) {
    this.args = args;
    return this;
  }
  async _exec() {
    const s = this.sql;
    const db = this.db;
    if (/^CREATE /i.test(s)) return { success: true };

    if (/^INSERT OR REPLACE INTO verified_users/i.test(s)) {
      const [user_id, topic_id, chat_id, channel_id, pending_at, created_at, challenge, seen] = this.args;
      db.rows.set(user_id, {
        user_id, topic_id, chat_id, channel_id,
        status: "pending", pending_at, created_at,
        challenge_message_id: challenge, seen_message_ids: seen,
      });
      return { success: true };
    }
    if (/^UPDATE verified_users SET status = 'verified'/i.test(s)) {
      const row = db.rows.get(this.args[0]);
      if (row) Object.assign(row, { status: "verified", pending_at: null, challenge_message_id: null, seen_message_ids: null });
      return { success: true };
    }
    if (/^UPDATE verified_users SET seen_message_ids/i.test(s)) {
      const [seen, user_id] = this.args;
      const row = db.rows.get(user_id);
      if (row) row.seen_message_ids = seen;
      return { success: true };
    }
    if (/^DELETE FROM verified_users WHERE user_id/i.test(s)) {
      db.rows.delete(this.args[0]);
      return { success: true };
    }
    if (/^SELECT .* FROM verified_users WHERE user_id/i.test(s)) {
      return db.rows.get(this.args[0]) || null;
    }
    if (/^SELECT .* FROM verified_users WHERE status = 'pending'/i.test(s)) {
      const cutoff = this.args[0];
      return [...db.rows.values()]
        .filter((r) => r.status === "pending" && r.pending_at != null && r.pending_at <= cutoff)
        .sort((a, b) => a.pending_at - b.pending_at);
    }
    throw new Error("未模拟的 SQL: " + s);
  }
  async run() { return this._exec(); }
  async first() { return this._exec(); }
  async all() { return { results: await this._exec() }; }
}

class FakeDB {
  constructor() { this.rows = new Map(); }
  prepare(sql) { return new Stmt(this, sql); }
  async batch(list) { return Promise.all(list.map((s) => s.run())); }
}

// ---------- Telegram API 模拟 ----------
function installTelegramMock(calls) {
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    if (method === "getChat") {
      return new Response(JSON.stringify({ ok: true, result: { parent_chat: { id: -100777 } } }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), { headers: { "content-type": "application/json" } });
  };
}

// ---------- 测试主体 ----------
let env, calls;

beforeEach(() => {
  calls = [];
  installTelegramMock(calls);
  env = {
    BOT_TOKEN: "token",
    WEBHOOK_SECRET: SECRET,
    CHANNEL_IDS: "-100777",
    VERIFY_WINDOW_SECONDS: "60",
    DB: new FakeDB(),
  };
});

const post = (update, secret = SECRET) =>
  worker.fetch(
    new Request("https://example.com/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(update),
    }),
    env
  );

const dmUpdate = (userId, text) => ({
  update_id: 1,
  message: {
    message_id: 5,
    chat: { id: 12345, type: "private", parent_chat: { id: -100777 } },
    from: { id: userId },
    text,
    direct_messages_topic: { topic_id: 7, user: { id: userId } },
  },
});

test("GET / 返回版本号", async () => {
  const res = await worker.fetch(new Request("https://example.com/"), env);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /v1\.1\.0/);
});

test("GET / 支持 JSON", async () => {
  const res = await worker.fetch(
    new Request("https://example.com/", { headers: { accept: "application/json" } }),
    env
  );
  const body = await res.json();
  assert.equal(body.version, "1.1.0");
});

test("未配置 WEBHOOK_SECRET 时拒绝处理", async () => {
  env.WEBHOOK_SECRET = "";
  const res = await post(dmUpdate(1, "hi"));
  assert.equal(res.status, 500);
});

test("secret 不对返回 403", async () => {
  const res = await post(dmUpdate(1, "hi"), "wrong");
  assert.equal(res.status, 403);
});

test("白名单未配置时零成本丢弃", async () => {
  env.CHANNEL_IDS = "";
  const res = await post(dmUpdate(1, "hi"));
  assert.equal(res.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(env.DB.rows.size, 0);
});

test("新用户私信 -> 发验证提示并记 pending", async () => {
  await post(dmUpdate(42, "我想进频道"));
  const sent = calls.find((c) => c.method === "sendMessage");
  assert.ok(sent, "应该发送验证提示");
  assert.match(sent.body.text, /人机验证/);
  const row = env.DB.rows.get("42");
  assert.equal(row.status, "pending");
  assert.equal(row.challenge_message_id, "999");
});

test("回复正确 -> verified 并删除提示消息", async () => {
  await post(dmUpdate(42, "随便说点"));
  calls.length = 0;
  await post(dmUpdate(42, PASS));
  assert.equal(env.DB.rows.get("42").status, "verified");
  assert.ok(calls.some((c) => c.method === "setMessageReaction"), "应点表情");
  assert.ok(calls.some((c) => c.method === "deleteMessage"), "应删除验证提示");
});

test("已验证用户不再被打扰", async () => {
  await post(dmUpdate(42, "随便说点"));
  await post(dmUpdate(42, PASS));
  calls.length = 0;
  await post(dmUpdate(42, "再说一句"));
  assert.equal(calls.length, 0);
});

test("超时未验证 -> cron 封禁并清理消息", async () => {
  await post(dmUpdate(42, "广告广告"));
  const row = env.DB.rows.get("42");
  row.pending_at = Math.floor(Date.now() / 1000) - 120;
  row.seen_message_ids = "5,6,7";
  calls.length = 0;

  await worker.scheduled({}, env);

  const banned = calls.find((c) => c.method === "banChatMember");
  assert.ok(banned, "应该封禁");
  assert.equal(String(banned.body.chat_id), "-100777");
  assert.equal(calls.filter((c) => c.method === "deleteMessage").length, 4, "应删除 3 条用户消息 + 1 条验证提示");
  assert.equal(env.DB.rows.has("42"), false, "处理完应删除记录");
});

test("删除超过配额时保留记录等下一轮", async () => {
  await post(dmUpdate(42, "广告广告"));
  const row = env.DB.rows.get("42");
  row.pending_at = Math.floor(Date.now() / 1000) - 120;
  // 塞满 60 条消息，必然超出单次配额
  row.seen_message_ids = Array.from({ length: 60 }, (_, i) => String(100 + i)).join(",");
  calls.length = 0;

  await worker.scheduled({}, env);

  assert.ok(calls.some((c) => c.method === "banChatMember"), "先封禁");
  assert.ok(calls.length <= 40, `子请求应受配额限制，实际 ${calls.length}`);
  assert.equal(env.DB.rows.has("42"), true, "没删完就保留记录");
  assert.ok(env.DB.rows.get("42").seen_message_ids.length > 0, "剩余消息 id 要留到下一轮");
});
