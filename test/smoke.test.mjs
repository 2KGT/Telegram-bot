// Kiểm thử nhanh (không cần mạng): giả lập Telegram, Gemini và KV.
// Chạy: npm test
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

function setup(envExtra = {}) {
  const sent = [];
  const calls = [];
  const store = {};
  let gemini = 0;
  globalThis.fetch = async (url, opt) => {
    url = String(url);
    const method = url.match(/bot[^/]+\/(\w+)/)?.[1];
    let body = {};
    try { body = JSON.parse(opt?.body || "{}"); } catch {}
    if (url.includes("generativelanguage")) {
      gemini++;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "Xin chào!" }] } }] }));
    }
    if (method === "getChatMember") {
      return new Response(JSON.stringify({ ok: true, result: { status: [1].includes(body.user_id) ? "administrator" : "member" } }));
    }
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 99, username: "Kyicbot" } }));
    if (method) calls.push([method, body]);
    if (method === "sendMessage") sent.push(body.text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 777 } }));
  };
  const env = {
    TELEGRAM_BOT_TOKEN: "1:a", GEMINI_API_KEY: "k", ADMIN_ID: "1", STATS: "off", ...envExtra,
    USERS_KV: {
      get: async (k) => store[k] ?? null,
      put: async (k, v) => { store[k] = v; },
      delete: async (k) => { delete store[k]; },
      list: async ({ prefix }) => ({ keys: Object.keys(store).filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
    },
  };
  const send = async (message, headers = {}) => {
    const pend = [];
    sent.length = 0; calls.length = 0;
    const res = await worker.fetch(new Request("https://x/", { method: "POST", headers, body: JSON.stringify({ message }) }), env, { waitUntil: (p) => pend.push(p) });
    await Promise.all(pend);
    return res;
  };
  return { env, sent, calls, send, geminiCalls: () => gemini };
}

const priv = (text, from = 1) => ({ message_id: 5, text, chat: { id: from, type: "private" }, from: { id: from, first_name: "A" } });
const group = (text, from, extra = {}) => ({ message_id: 9, text, chat: { id: -100, type: "supergroup", title: "G" }, from: { id: from, first_name: "U" + from }, ...extra });

test("/info trả lời trong chat riêng", async () => {
  const t = setup();
  await t.send(priv("/info"));
  assert.match(t.sent[0], /Thông tin/);
});

test("hỏi giờ được trả lời bằng code, không gọi Gemini", async () => {
  const t = setup();
  await t.send(priv("mấy giờ rồi"));
  assert.match(t.sent[0], /Bây giờ là \d\d:\d\d/);
  assert.equal(t.geminiCalls(), 0);
});

test("thành viên thường không dùng được /ban", async () => {
  const t = setup();
  await t.send(group("/ban", 7, { reply_to_message: { message_id: 3, from: { id: 8, first_name: "V" } } }));
  assert.match(t.sent[0], /Chỉ admin/);
  assert.equal(t.calls.some(([m]) => m === "banChatMember"), false);
});

test("admin /ban gọi banChatMember và được ghi vào /audit", async () => {
  const t = setup();
  await t.send(group("/ban spam", 1, { reply_to_message: { message_id: 3, from: { id: 8, first_name: "V" } } }));
  assert.equal(t.calls.some(([m]) => m === "banChatMember"), true);
  await t.send(group("/audit", 1));
  assert.match(t.sent[0], /\/ban/);
});

test("webhook có secret: thiếu header bị 403, đúng header được 200", async () => {
  const t = setup({ TELEGRAM_WEBHOOK_SECRET: "s3cret" });
  assert.equal((await t.send(priv("/info"))).status, 403);
  assert.equal((await t.send(priv("/info"), { "x-telegram-bot-api-secret-token": "s3cret" })).status, 200);
});

test("giới hạn lượt AI mỗi ngày (không áp cho admin)", async () => {
  const t = setup({ AI_DAILY_CAP: "2" });
  for (let i = 0; i < 2; i++) await t.send(priv("kể chuyện cười", 42));
  assert.equal(t.geminiCalls(), 2);
  await t.send(priv("kể chuyện cười nữa", 42));
  assert.match(t.sent[0], /hết lượt/);
  assert.equal(t.geminiCalls(), 2);
  await t.send(priv("kể chuyện cười", 1)); // admin
  assert.equal(t.geminiCalls(), 3);
});

test("/xsmb cho ngày chưa tới thì không bịa số", async () => {
  const t = setup();
  await t.send(priv("/xsmb 31/12/2099"));
  assert.match(t.sent[0], /chưa tới/);
  assert.equal(t.geminiCalls(), 0);
});

test("/health công khai chỉ lộ phiên bản", async () => {
  const t = setup();
  const res = await worker.fetch(new Request("https://x/health"), t.env, { waitUntil() {} });
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["version"]);
});
