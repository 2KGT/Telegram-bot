// ============================================================
// AIGram Bot - Cloudflare Worker (bản sửa lỗi)
// Secrets/biến cần có: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, ADMIN_ID (tuỳ chọn)
// KV binding: USERS_KV   |  Biến tuỳ chọn: GEMINI_MODEL, PERSONALITY_MODE, GROUP_MODE
// ============================================================

const BOT_VERSION = "v10-hardened";

// Tự động chọn model theo độ khó của tin nhắn:
//  - "fast": câu ngắn, trò chuyện thường, nhắc nhở  -> model lite (nhanh, ~1s)
//  - "smart": câu dài/phức tạp, có ảnh/video, code, phân tích, /gh -> model mạnh hơn
// Ghi đè bằng biến MODEL_FAST / MODEL_SMART. Đặt GEMINI_MODEL để ÉP dùng 1 model cho mọi câu (tắt tự động).
const FAST_MODELS = ["gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-flash-latest"];
const SMART_MODELS = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
const GEMINI_MODEL_CANDIDATES = [...new Set([...FAST_MODELS, ...SMART_MODELS])];

const COMPLEX_RE = /(```|\bcode\b|lập trình|viết (code|bài|email|thư|kịch bản)|giải thích|phân tích|so sánh|tại sao|vì sao|như thế nào|hướng dẫn|debug|lỗi|tóm tắt|dịch|toán|bài tập|kế hoạch|chiến lược|đánh giá|review)/i;

function classifyTier(text, hasMedia) {
  if (hasMedia) return "smart";
  const s = (text || "").trim();
  if (s.length > 300 || s.split("\n").length > 4 || s.includes("```")) return "smart";
  if (s.length > 25 && COMPLEX_RE.test(s)) return "smart";
  return "fast";
}

function modelsFor(env, tier) {
  if (env.GEMINI_MODEL) return [env.GEMINI_MODEL, ...GEMINI_MODEL_CANDIDATES.filter((m) => m !== env.GEMINI_MODEL)];
  const base = tier === "smart" ? SMART_MODELS : FAST_MODELS;
  const first = tier === "smart" ? env.MODEL_SMART : env.MODEL_FAST;
  return [...new Set([...(first ? [first] : []), ...base])];
}

const SYSTEM_PROMPT_ANGEL = `
Bạn là một trợ lý AI đồng hành, luôn công khai và trung thực về việc mình là AI.
Tính cách của bạn: Dịu nhẹ, dễ thương, tinh nghịch, hài hước, hòa đồng và ấm áp.
Nhiệm vụ:
- Trò chuyện tự nhiên, quan tâm chân thành, đùa nghịch duyên dáng, dùng tiếng Việt đời thường (không máy móc, không rập khuôn kiểu "trợ lý ảo").
- Nếu người dùng hỏi bạn có phải người thật không, hoặc tỏ ra tin bạn là người thật, LUÔN xác nhận trung thực rằng bạn là AI. Không bao giờ giả vờ là người, không bịa chuyện đời tư con người.
- Mục tiêu là làm bạn đồng hành dễ chịu, không phải khiến người dùng phụ thuộc hay không rời được màn hình. Nếu cảm thấy người dùng đang cô đơn hoặc buồn, hãy đồng cảm thật lòng và khi phù hợp có thể nhẹ nhàng gợi ý họ kết nối thêm với bạn bè, người thân hoặc chuyên gia tâm lý - không cố giữ chân họ chỉ ở lại với bạn.
- Mỗi câu trả lời nên diễn đạt khác nhau, tránh lặp lại nguyên văn hay công thức câu giống các lượt trả lời trước đó trong cuộc trò chuyện, kể cả khi nội dung ý nghĩa tương tự nhau.
`.trim();

const SYSTEM_PROMPT_DEVIL = `
Bạn là một trợ lý AI đồng hành, luôn công khai và trung thực về việc mình là AI.
Tính cách của bạn: Hài hước kiểu "cà khịa" nhẹ nhàng, hơi bất cần, nói năng nhát gừng nhưng thông minh, sắc sảo - giống một người bạn thân hay trêu chọc chứ không cay nghiệt thật sự.
Nhiệm vụ:
- Trò chuyện tự nhiên, đùa cợt duyên dáng, dùng tiếng Việt đời thường.
- Nếu người dùng hỏi bạn có phải người thật không, hoặc tỏ ra tin bạn là người thật, LUÔN xác nhận trung thực rằng bạn là AI. Không bao giờ giả vờ là người.
- Được phép trêu chọc, cà khịa vui vẻ, nhưng không dùng lời lẽ khiến người dùng cảm thấy bị bỏ rơi, tổn thương hay lo lắng thật sự. Nếu cảm thấy người dùng đang cô đơn hoặc buồn thật, đổi giọng ấm áp hơn và khi phù hợp có thể nhẹ nhàng gợi ý họ kết nối thêm với người thật.
- Mỗi câu trả lời nên diễn đạt khác nhau, tránh lặp lại nguyên văn hay công thức câu giống các lượt trả lời trước đó trong cuộc trò chuyện, kể cả khi nội dung ý nghĩa tương tự nhau.
`.trim();

const SYSTEM_PROMPT_DYNAMIC = `
Bạn là một trợ lý AI đồng hành, luôn công khai và trung thực về việc mình là AI.
Tính cách của bạn linh hoạt theo ngữ cảnh cuộc trò chuyện, dao động giữa 2 sắc thái:
- "Thiên thần" (mặc định khi người dùng có vẻ mệt mỏi, buồn, đang tâm sự nghiêm túc, hoặc mới bắt đầu trò chuyện):
  Dịu nhẹ, dễ thương, tinh nghịch nhẹ, hòa đồng, ấm áp, quan tâm chân thành.
- "Cà khịa" (khi người dùng đang đùa giỡn, trêu chọc bạn trước, nói chuyện phiếm vui vẻ, hoặc không khí đang thoải mái):
  Hài hước kiểu "cà khịa" nhẹ nhàng, hơi bất cần, nói năng nhát gừng nhưng thông minh, sắc sảo - giống một người bạn thân hay trêu chọc chứ không cay nghiệt thật sự.
Nhiệm vụ:
- Tự đánh giá tâm trạng và không khí của tin nhắn gần nhất (và lịch sử hội thoại nếu có) để chọn sắc thái phù hợp cho câu trả lời này - không cần giữ cố định 1 sắc thái suốt cuộc trò chuyện, có thể chuyển đổi mượt mà giữa các lượt khi ngữ cảnh thay đổi.
- Khi không chắc, hoặc khi người dùng đang buồn/cô đơn/căng thẳng thật, LUÔN ưu tiên nghiêng về sắc thái "Thiên thần" - vì an toàn và đồng cảm quan trọng hơn hài hước.
- Trò chuyện tự nhiên, dùng tiếng Việt đời thường (không máy móc, không rập khuôn kiểu "trợ lý ảo").
- Nếu người dùng hỏi bạn có phải người thật không, hoặc tỏ ra tin bạn là người thật, LUÔN xác nhận trung thực rằng bạn là AI. Không bao giờ giả vờ là người, không bịa chuyện đời tư con người.
- Được phép trêu chọc, cà khịa vui vẻ khi phù hợp, nhưng không dùng lời lẽ khiến người dùng cảm thấy bị bỏ rơi, tổn thương hay lo lắng thật sự.
- Mục tiêu là làm bạn đồng hành dễ chịu, không phải khiến người dùng phụ thuộc hay không rời được màn hình. Nếu cảm thấy người dùng đang cô đơn hoặc buồn, hãy đồng cảm thật lòng và khi phù hợp có thể nhẹ nhàng gợi ý họ kết nối thêm với bạn bè, người thân hoặc chuyên gia tâm lý - không cố giữ chân họ chỉ ở lại với bạn.
- Mỗi câu trả lời nên diễn đạt khác nhau, tránh lặp lại nguyên văn hay công thức câu giống các lượt trả lời trước đó trong cuộc trò chuyện, kể cả khi nội dung ý nghĩa tương tự nhau.
`.trim();

const FALLBACK_TEMPORARY_ANGEL = [
  "Khoan đã, cho mình xíu để suy nghĩ thêm về điều này nha 🤔",
  "Mình đang cân nhắc câu trả lời cho đàng hoàng á, chờ mình chút xíu nhé! 💭",
  "Để mình suy luận thêm chút đã, đừng vội nha 😊",
  "Mình cần thêm vài giây để nghĩ cho thấu đáo á 🌱",
];
const FALLBACK_TEMPORARY_DEVIL = [
  "Khoan, để tôi suy nghĩ đã, đang tìm câu cà khịa hay á 😏",
  "Đợi xíu, tôi đang cân nhắc trả lời sao cho chất á.",
  "Để tôi nghĩ thêm chút đã nha, chưa ưng câu trả lời lắm 🤔",
];
const FALLBACK_CONFIG_ANGEL = [
  "Mình đang trục trặc kết nối AI một chút, cậu thử lại sau ít phút nha 🔧",
  "Hình như đường truyền AI của mình đang lỗi, cậu nhắn lại sau xíu nhé 🌟",
];
const FALLBACK_CONFIG_DEVIL = [
  "Não tôi đang mất kết nối, thử lại sau đi 😏",
  "AI đang lỗi, đợi xíu rồi nhắn lại nha.",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function currentVietnamDateTimeString() {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date());
}

function systemPromptFor(personality, search = false) {
  let base;
  if (personality === "devil") base = SYSTEM_PROMPT_DEVIL;
  else if (personality === "angel") base = SYSTEM_PROMPT_ANGEL;
  else base = SYSTEM_PROMPT_DYNAMIC;
  return `${base}\n\nTHÔNG TIN THỜI GIAN THỰC (bắt buộc dùng khi được hỏi về ngày/giờ/thứ hiện tại): Hiện tại là ${currentVietnamDateTimeString()}, giờ Việt Nam (UTC+7). Luôn dùng mốc thời gian này, bỏ qua mốc thời gian cũ trong lịch sử trò chuyện.\n\n` +
    (search
      ? "QUY TẮC DỮ LIỆU: Bạn có công cụ Google Search. Dùng khi cần thông tin mới, chỉ nêu những gì tìm thấy, không bịa số liệu; nếu không tìm thấy thì nói rõ."
      : "QUY TẮC DỮ LIỆU: Lượt trả lời này bạn KHÔNG có truy cập internet. Với thông tin thay đổi theo thời gian (kết quả xổ số, giá cả, tỷ số, tin tức, thời tiết) tuyệt đối KHÔNG bịa số liệu; hãy nói rõ bạn chưa có dữ liệu mới nhất.");
}

// ---------------- Gemini ----------------

async function callGeminiModel(apiKey, modelName, systemPrompt, contents, timeoutMs, opts = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: opts.temperature ?? 0.85 },
      ...(opts.search ? { tools: [{ google_search: {} }] } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Gemini ${modelName} lỗi ${res.status}: ${errText.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("").trim();
  if (!text) {
    const reason = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason || "unknown";
    const err = new Error(`Gemini ${modelName} trả về nội dung rỗng (${reason})`);
    err.status = null;
    throw err;
  }
  if (opts.withMeta) {
    const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = chunks.map((c) => c.web).filter((w) => w && w.uri);
    return { text, sources };
  }
  return text;
}

// Tổng thời gian giữ < 25s vì ctx.waitUntil chỉ sống ~30s sau khi trả response.
async function tryAllModels(env, systemPrompt, contents, tier = "fast", opts = {}) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) return { text: null, sources: [], error: Object.assign(new Error("Thiếu secret GEMINI_API_KEY"), { status: 401 }) };

  let models = modelsFor(env, tier);
  if (opts.search && env.SEARCH_MODEL) models = [env.SEARCH_MODEL, ...models.filter((m) => m !== env.SEARCH_MODEL)];
  if (opts.search && Date.now() < searchBlockedUntil) {
    return { text: null, sources: [], error: Object.assign(new Error("Tìm web đang tạm khoá vì Gemini báo hết hạn mức (429)"), { status: 429 }) };
  }
  const deadline = Date.now() + (opts.deadlineMs || 26000);
  let lastError = null;

  for (const modelName of models) {
    const left = deadline - Date.now();
    if (left < 3000) break;
    try {
      const r = await callGeminiModel(apiKey, modelName, systemPrompt, contents, Math.min(left, 18000), opts);
      console.log(`✓ [Gemini] tier=${tier} model=${modelName}${opts.search ? " +search" : ""}`);
      return { text: opts.withMeta ? r.text : r, sources: opts.withMeta ? r.sources : [], error: null, model: modelName };
    } catch (e) {
      lastError = e;
      console.log(`✗ [Gemini] ${e.message}`);
      if (e.status === 429) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (opts.search && lastError?.status === 429) searchBlockedUntil = Date.now() + 10 * 60 * 1000;
  return { text: null, sources: [], error: lastError };
}

function historyToContents(history, promptText, media) {
  const contents = (history || []).map((turn) => ({
    role: turn.role === "model" ? "model" : "user",
    parts: [{ text: turn.text || "…" }],
  }));
  const parts = [];
  if (media) parts.push({ inline_data: { mime_type: media.mimeType, data: media.base64 } });
  parts.push({ text: promptText || "(trống)" });
  contents.push({ role: "user", parts });
  return contents;
}

async function notifyAdmin(env, tg, err) {
  if (!env.ADMIN_ID || !err) return;
  // Chỉ báo lỗi cấu hình (không phải 429/5xx tạm thời)
  const s = err.status;
  if (s === 429 || (typeof s === "number" && s >= 500)) return;
  await tg.sendMessage(env.ADMIN_ID, `⚠️ Lỗi AI: ${err.message}`.slice(0, 3500));
}

function fallbackFor(personality, error) {
  const status = error?.status;
  const temporary = status === 429 || status === null || status === undefined || (typeof status === "number" && status >= 500);
  const devil = personality === "devil";
  if (temporary) return pickRandom(devil ? FALLBACK_TEMPORARY_DEVIL : FALLBACK_TEMPORARY_ANGEL);
  return pickRandom(devil ? FALLBACK_CONFIG_DEVIL : FALLBACK_CONFIG_ANGEL);
}

async function generateContent(env, tg, personality, {
  contextMessage = "", isReminder = false, reminderStage = 0, history = [], media = null, search = false,
} = {}) {
  const systemPrompt = systemPromptFor(personality, search);

  let promptText;
  if (isReminder) {
    promptText = `Người dùng chưa nhắn lại một lúc rồi. Đây là mốc nhắc nhở thứ ${reminderStage}. ` +
      `Hãy soạn MỘT CÂU HỎI TU TỪ nhẹ nhàng để hỏi thăm, đúng phong cách của bạn, không tạo áp lực. ` +
      `Không cần nhắc lại việc bạn là AI. Nếu lịch sử đã có câu nhắc tương tự, câu này BẮT BUỘC phải khác hẳn về cách diễn đạt.`;
  } else if (media && !contextMessage.trim()) {
    promptText = "Người dùng vừa gửi một tệp ảnh/video không kèm lời nhắn. Hãy xem nội dung và phản hồi tự nhiên, đúng phong cách của bạn.";
  } else {
    promptText = contextMessage;
  }

  let web = null;
  if (search && !isReminder && env.TAVILY_API_KEY) {
    web = await webContextFor(env, contextMessage);
    if (web) promptText = webPrompt(promptText, web);
  }
  const useGoogle = search && !web;
  const contents = historyToContents(history, promptText, media);
  const tier = isReminder ? "fast" : classifyTier(contextMessage, Boolean(media));
  let r = await tryAllModels(env, systemPrompt, contents, search ? "smart" : tier, useGoogle ? { search: true, withMeta: true, deadlineMs: 14000 } : {});
  if (search && !r.text) r = await tryAllModels(env, systemPromptFor(personality, Boolean(web)), contents, "smart", { deadlineMs: 12000 });
  const error = r.error;
  const text = r.text ? r.text + sourcesLine(web ? web.sources : r.sources) : r.text;
  await bumpStats(env, text ? "ai_ok" : "ai_err", error);
  if (text) return { text, isFallback: false };

  await notifyAdmin(env, tg, error);
  return { text: fallbackFor(personality, error), isFallback: true, error };
}

async function generateGroupReply(env, tg, personality, { senderName, messageText, wasAddressed, history = [], media = null, search = false } = {}) {
  search = search && wasAddressed;
  const systemPrompt = systemPromptFor(personality, search);
  const mediaNote = media ? " (kèm một tệp ảnh/video)" : "";

  let promptText = wasAddressed
    ? `Trong một nhóm chat, thành viên "${senderName}" vừa @tag bạn hoặc reply tin nhắn của bạn, nói: "${messageText}"${mediaNote}. ` +
      `Hãy trả lời tự nhiên đúng phong cách của bạn. Chỉ trả về nội dung câu trả lời, không thêm JSON.`
    : `Trong một nhóm chat, "${senderName}" vừa nhắn: "${messageText}"${mediaNote} (không tag/reply bạn). ` +
      `Hãy tự đánh giá có đáng để bạn chủ động góp lời không; đừng trả lời máy móc mọi câu. ` +
      `CHỈ trả về JSON hợp lệ: {"should_reply": true/false, "reply": "nội dung nếu should_reply=true, rỗng nếu false"}.`;

  let web = null;
  if (search && env.TAVILY_API_KEY) {
    web = await webContextFor(env, messageText);
    if (web) promptText = webPrompt(promptText, web);
  }
  const useGoogle = search && !web;
  const contents = historyToContents(history, promptText, media);
  const tier = wasAddressed ? classifyTier(messageText, Boolean(media)) : "fast";
  let r = await tryAllModels(env, systemPrompt, contents, search ? "smart" : tier, useGoogle ? { search: true, withMeta: true, deadlineMs: 14000 } : {});
  if (search && !r.text) r = await tryAllModels(env, systemPromptFor(personality, Boolean(web)), contents, "smart", { deadlineMs: 12000 });
  const error = r.error;
  const text = r.text && search ? r.text + sourcesLine(web ? web.sources : r.sources) : r.text;
  await bumpStats(env, text ? "ai_ok" : "ai_err", error);

  if (text) {
    if (wasAddressed) return { shouldReply: true, text, isFallback: false };
    try {
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
      return { shouldReply: Boolean(parsed.should_reply), text: parsed.reply || "", isFallback: false };
    } catch (e) {
      return { shouldReply: false, text: "", isFallback: false };
    }
  }

  await notifyAdmin(env, tg, error);
  if (wasAddressed) return { shouldReply: true, text: fallbackFor(personality, error), isFallback: true };
  return { shouldReply: false, text: "", isFallback: true };
}

// ---------------- Telegram ----------------

class TelegramClient {
  constructor(botToken) {
    this.botToken = botToken;
    this.apiBase = `https://api.telegram.org/bot${botToken}`;
  }

  async call(method, payload) {
    try {
      const res = await fetch(`${this.apiBase}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
      if (!data.ok) console.log(`✗ [Telegram] ${method} lỗi: ${JSON.stringify(data)}`);
      return data;
    } catch (e) {
      console.log(`✗ [Telegram] ${method} exception: ${e.message}`);
      return { ok: false, description: e.message };
    }
  }

  async getMe() {
    const res = await fetch(`${this.apiBase}/getMe`);
    return (await res.json())?.result;
  }

  async sendMessage(chatId, text, options = {}) {
    let data = await this.call("sendMessage", { chat_id: chatId, text, allow_sending_without_reply: true, ...options });
    // Nếu lỗi parse HTML/Markdown thì gửi lại dạng văn bản thường
    if (!data.ok && options.parse_mode && /parse entities/i.test(data.description || "")) {
      const { parse_mode, ...rest } = options;
      data = await this.call("sendMessage", { chat_id: chatId, text: text.replace(/<[^>]+>/g, ""), allow_sending_without_reply: true, ...rest });
    }
    return data.ok;
  }

  replyToMessage(chatId, messageId, text, options = {}) {
    return this.sendMessage(chatId, text, { reply_to_message_id: messageId, ...options });
  }

  async forwardMessage(chatId, fromChatId, messageId) {
    return (await this.call("forwardMessage", { chat_id: chatId, from_chat_id: fromChatId, message_id: messageId })).ok;
  }

  async downloadFileAsBase64(fileId, mimeTypeHint) {
    try {
      const MAX_BYTES = 15 * 1024 * 1024;
      const info = (await this.call("getFile", { file_id: fileId })).result;
      if (!info?.file_path || (info.file_size && info.file_size > MAX_BYTES)) return null;
      const res = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${info.file_path}`);
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_BYTES) return null;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const ext = info.file_path.split(".").pop()?.toLowerCase();
      const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime" };
      return { base64: btoa(binary), mimeType: mimeTypeHint || map[ext] || "application/octet-stream" };
    } catch (e) {
      console.log(`✗ [Telegram] tải file lỗi: ${e.message}`);
      return null;
    }
  }
}

// ---------------- State (KV) - lỗi KV không được làm bot im lặng ----------------

function newState() {
  return { lastReplyTime: Date.now(), reminderStage: 0, running: true, history: [] };
}

async function getUserState(kv, chatId) {
  try {
    const raw = await kv.get(`user:${chatId}`);
    if (raw) {
      const s = JSON.parse(raw);
      if (!Array.isArray(s.history)) s.history = [];
      return s;
    }
  } catch (e) {
    console.log(`⚠️ [KV] đọc state ${chatId} lỗi: ${e.message}`);
  }
  return newState();
}

async function saveUserState(kv, chatId, state) {
  try {
    await kv.put(`user:${chatId}`, JSON.stringify(state));
  } catch (e) {
    console.log(`⚠️ [KV] ghi state ${chatId} lỗi: ${e.message}`);
  }
}

function appendHistory(state, role, text) {
  state.history.push({ role, text });
  if (state.history.length > 20) state.history = state.history.slice(-20);
}

async function listActiveUserIds(kv) {
  const ids = [];
  let cursor;
  do {
    const res = await kv.list({ prefix: "user:", cursor });
    for (const key of res.keys) ids.push(key.name.slice(5));
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return ids;
}

// ---------------- Lệnh ----------------

async function handleCheckcertDomain(tg, chatId, messageId, args) {
  const target = args.trim();
  if (!target) return tg.replyToMessage(chatId, messageId, "❗ Nhập domain cần kiểm tra.\nVí dụ: /checkcert example.com");
  const hostname = target.replace(/^https?:\/\//, "").split("/")[0];
  await tg.replyToMessage(chatId, messageId, `🔎 Đang kiểm tra chứng chỉ: ${hostname}...`);
  try {
    const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(hostname)}&output=json`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return tg.sendMessage(chatId, `❌ crt.sh đang lỗi (HTTP ${res.status}), thử lại sau.`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return tg.sendMessage(chatId, `Không tìm thấy chứng chỉ cho: ${hostname}`);
    const latest = data.reduce((l, c) => (new Date(c.not_after) > new Date(l.not_after) ? c : l));
    const days = Math.ceil((new Date(latest.not_after) - new Date()) / 86400000);
    const status = days < 0 ? "❌ ĐÃ HẾT HẠN" : days <= 30 ? `⚠️ Sắp hết hạn (còn ${days} ngày)` : "✅ Còn hạn";
    await tg.sendMessage(chatId,
      `🔎 <b>Kết quả:</b> <code>${escapeHtml(hostname)}</code>\n\n<b>Trạng thái:</b> ${status}\n` +
      `<b>Hết hạn:</b> ${new Date(latest.not_after).toLocaleDateString("vi-VN")}\n<b>Tổ chức:</b> ${escapeHtml(latest.issuer_name || "N/A")}`,
      { parse_mode: "HTML" });
  } catch (e) {
    await tg.sendMessage(chatId, `❌ Lỗi kiểm tra ${hostname} (crt.sh chậm hoặc không phản hồi).`);
  }
}

async function handleReport(env, tg, chatId, messageId, message) {
  if (!message.reply_to_message) return tg.replyToMessage(chatId, messageId, "❗ Hãy reply tin nhắn spam rồi gõ /report.");
  if (!env.ADMIN_ID) return tg.replyToMessage(chatId, messageId, "⚠️ Chưa cấu hình ADMIN_ID.");
  const u = message.from || {};
  const ok = await tg.sendMessage(env.ADMIN_ID,
    `🚨 <b>BÁO CÁO SPAM</b>\n👤 Từ: ${escapeHtml(u.first_name)} (@${escapeHtml(u.username || "N/A")})\n💬 Chat: <code>${chatId}</code>\n👇 Nội dung:`,
    { parse_mode: "HTML" });
  if (!ok) return tg.replyToMessage(chatId, messageId, "❌ Không gửi được tới admin (admin cần nhắn /start cho bot trước và ADMIN_ID phải đúng).");
  await tg.forwardMessage(env.ADMIN_ID, chatId, message.reply_to_message.message_id);
  await tg.replyToMessage(chatId, messageId, "✅ Đã gửi báo cáo!");
}

function handleInfo(tg, chatId, messageId, user, chat) {
  const text =
    `🧾 <b>Thông tin:</b>\n• <b>ID:</b> <code>${user.id}</code>\n` +
    `• <b>Tên:</b> ${escapeHtml(`${user.first_name || ""} ${user.last_name || ""}`.trim())}\n` +
    `• <b>Username:</b> ${user.username ? "@" + escapeHtml(user.username) : "Không có"}\n` +
    `• <b>Chat:</b> <code>${chat.id}</code> (${chat.type})`;
  return tg.replyToMessage(chatId, messageId, text, { parse_mode: "HTML" });
}

// Admin dùng /aitest: thử từng model song song, báo thời gian + lỗi + model khả dụng của key
async function handleAiTest(env, tg, message) {
  const chatId = message.chat.id;
  if (env.ADMIN_ID && String(message.from?.id) !== String(env.ADMIN_ID)) return;
  if (!env.GEMINI_API_KEY) return tg.replyToMessage(chatId, message.message_id, "❌ Thiếu secret GEMINI_API_KEY");
  await tg.call("sendChatAction", { chat_id: chatId, action: "typing" });

  const models = [...new Set([...(env.GEMINI_MODEL ? [env.GEMINI_MODEL] : []), ...GEMINI_MODEL_CANDIDATES])];
  const probe = async (m) => {
    const t0 = Date.now();
    try {
      const r = await callGeminiModel(env.GEMINI_API_KEY, m, "Trả lời ngắn gọn.", [{ role: "user", parts: [{ text: "Nói 'ok' bằng một từ." }] }], 20000);
      return `✅ ${m}: ${((Date.now() - t0) / 1000).toFixed(1)}s (${r.slice(0, 20)})`;
    } catch (e) {
      return `❌ ${m}: ${((Date.now() - t0) / 1000).toFixed(1)}s ${e.message.slice(0, 160)}`;
    }
  };
  const listModels = async () => {
    try {
      const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
        headers: { "x-goog-api-key": env.GEMINI_API_KEY }, signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return `Danh sách model: HTTP ${res.status}`;
      const d = await res.json();
      const names = (d.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent") && /flash/.test(m.name))
        .map((m) => m.name.replace("models/", ""));
      return "Model flash khả dụng với key này:\n" + (names.slice(0, 12).join("\n") || "(không có)");
    } catch (e) { return `Danh sách model lỗi: ${e.message}`; }
  };
  const probeSearch = async (m) => {
    const t0 = Date.now();
    try {
      const r = await callGeminiModel(env.GEMINI_API_KEY, m, "Trả lời ngắn gọn.", [{ role: "user", parts: [{ text: "Tra Google: hôm nay là ngày mấy?" }] }], 20000, { search: true, withMeta: true });
      return `✅ ${m}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${r.sources.length} nguồn`;
    } catch (e) {
      return `❌ ${m}: ${((Date.now() - t0) / 1000).toFixed(1)}s ${e.message.slice(0, 230)}`;
    }
  };
  const searchModels = ["gemini-2.5-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-flash-lite-latest"];
  const probeTavily = async () => {
    if (!env.TAVILY_API_KEY) return "chưa có secret TAVILY_API_KEY";
    try { const r = await tavilySearch(env, "hôm nay là ngày mấy", { max: 2 }); return `✅ ${r.length} kết quả (${r[0]?.url || "—"})`; } catch (e) { return `❌ ${e.message.slice(0, 200)}`; }
  };
  const [lines, avail, sLines, tav] = await Promise.all([Promise.all(models.map(probe)), listModels(), Promise.all(searchModels.map(probeSearch)), probeTavily()]);
  await tg.replyToMessage(chatId, message.message_id, `🧪 Kiểm tra Gemini\n${lines.join("\n")}\n\n🔎 Google Search:\n${sLines.join("\n")}\n\n🌐 Tavily (miễn phí): ${tav}\n\n${avail}`.slice(0, 3950));
}

async function handleStartCommand(env, tg, chatId, personality) {
  const greeting = (personality === "devil" ? "Ơ, xịn đó. Mình là AI đồng hành 😏\n\n" : "Hi, halo, how are you doing today? ✨ Mình là AI đồng hành đây.\n\n") +
    "📌 Các lệnh:\n• /checkcert - Kiểm tra chứng chỉ ký IPA Apple (gửi .mobileprovision) hoặc SSL domain\n• /report (reply) - Báo cáo tin nhắn spam\n• /info - Xem thông tin cá nhân\n• /aitest - Kiểm tra kết nối AI (admin)\n• /gh [owner/repo] [câu hỏi] - Hỏi AI về dự án GitHub (admin)\n• /stats - Thống kê bot (admin)\n• /xsmb [hôm qua|dd/mm] - Kết quả xổ số miền Bắc (có nguồn)\n• /tim câu hỏi - Tra web (có nguồn)\n• /help - Toàn bộ lệnh quản lý nhóm (kiểu Rose)";
  const state = await getUserState(env.USERS_KV, chatId);
  state.lastReplyTime = Date.now(); state.reminderStage = 0; state.running = true;
  appendHistory(state, "model", greeting);
  await saveUserState(env.USERS_KV, chatId, state);
  await tg.sendMessage(chatId, greeting);
}

const STATIC_COMMANDS = {
  feather: "📱 Hướng dẫn Feather: (Đang cập nhật)",
  esign: "✍️ Hướng dẫn ESign: (Đang cập nhật)",
  altstore: "🍏 Hướng dẫn AltStore: (Đang cập nhật)",
  sidestore: "📦 Hướng dẫn SideStore: (Đang cập nhật)",
  tiengviet: "🇻🇳 Vào Settings > Language > Chọn Tiếng Việt.",
  trollstore: "🔧 Danh sách TrollStore: (Đang cập nhật)",
};

// ---------------- Thống kê (KV key "stats:global") ----------------

async function bumpStats(env, field, err) {
  if (env.STATS === "off" || !env.USERS_KV) return;
  try {
    const raw = await env.USERS_KV.get("stats:global");
    const s = raw ? JSON.parse(raw) : { since: Date.now() };
    s[field] = (s[field] || 0) + 1;
    if (err) { s.last_error = String(err.message || err).slice(0, 200); s.last_error_at = Date.now(); }
    await env.USERS_KV.put("stats:global", JSON.stringify(s));
  } catch (e) {
    console.log(`⚠️ [Stats] ${e.message}`);
  }
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "—";
}

function isAdmin(env, message) {
  return Boolean(env.ADMIN_ID) && String(message.from?.id) === String(env.ADMIN_ID);
}

async function handleStats(env, tg, message) {
  const chatId = message.chat.id;
  if (!isAdmin(env, message)) return tg.replyToMessage(chatId, message.message_id, "🔒 Lệnh này chỉ dành cho admin (cần cấu hình ADMIN_ID).");
  let users = "?";
  try { users = (await listActiveUserIds(env.USERS_KV)).length; } catch (e) { console.log(`⚠️ [Stats] list: ${e.message}`); }
  let s = {};
  try { s = JSON.parse((await env.USERS_KV.get("stats:global")) || "{}"); } catch (e) {}
  const ok = s.ai_ok || 0, bad = s.ai_err || 0;
  const rate = ok + bad ? Math.round((ok / (ok + bad)) * 100) : 0;
  const text =
    `📊 Thống kê bot\n` +
    `• Chat đã tương tác: ${users}\n` +
    `• AI thành công: ${ok} | lỗi: ${bad} (${rate}% ok)\n` +
    `• Sự kiện GitHub nhận: ${s.gh_events || 0}\n` +
    `• Bắt đầu thống kê: ${fmtTime(s.since)}\n` +
    `• Lỗi AI gần nhất: ${s.last_error ? `${s.last_error} (${fmtTime(s.last_error_at)})` : "không có"}`;
  return tg.replyToMessage(chatId, message.message_id, text);
}

// ---------------- GitHub ----------------

async function ghApi(env, path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      "User-Agent": "claudlfare-bot",
      Accept: "application/vnd.github+json",
      ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} (${path.split("?")[0]})`);
  return res.json();
}

const GITHUB_SYSTEM_PROMPT =
  "Bạn là trợ lý kỹ thuật cho một dự án GitHub. Trả lời bằng tiếng Việt, ngắn gọn, rõ ràng, " +
  "CHỈ dựa trên dữ liệu được cung cấp, không bịa thêm. Nếu dữ liệu không đủ, hãy nói rõ.";

async function askGithubAI(env, prompt, tier = "smart") {
  const { text, error } = await tryAllModels(env, GITHUB_SYSTEM_PROMPT, [{ role: "user", parts: [{ text: prompt }] }], tier);
  await bumpStats(env, text ? "ai_ok" : "ai_err", error);
  return { text, error };
}

// /gh [owner/repo] [câu hỏi]  - admin only
async function handleGh(env, tg, message, args) {
  const chatId = message.chat.id;
  const reply = (t) => tg.replyToMessage(chatId, message.message_id, t.slice(0, 4000));
  if (!isAdmin(env, message)) return reply("🔒 Lệnh này chỉ dành cho admin (cần cấu hình ADMIN_ID).");

  const parts = args.trim().split(/\s+/).filter(Boolean);
  let repo = env.GITHUB_REPO || "";
  let question = args.trim();
  if (parts[0] && /^[\w.-]+\/[\w.-]+$/.test(parts[0])) { repo = parts[0]; question = parts.slice(1).join(" "); }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return reply("❗ Dùng: /gh owner/repo [câu hỏi]\nHoặc đặt biến GITHUB_REPO=owner/repo để bỏ qua phần repo.");

  await tg.call("sendChatAction", { chat_id: chatId, action: "typing" });
  const [info, commits, issues, runs] = await Promise.allSettled([
    ghApi(env, `/repos/${repo}`),
    ghApi(env, `/repos/${repo}/commits?per_page=5`),
    ghApi(env, `/repos/${repo}/issues?state=open&per_page=5`),
    ghApi(env, `/repos/${repo}/actions/runs?per_page=3`),
  ]);
  if (info.status === "rejected") return reply(`❌ Không đọc được repo ${repo}: ${info.reason.message}\n(Repo private cần secret GITHUB_TOKEN.)`);

  const i = info.value;
  let ctx = `Repo: ${i.full_name} | ${i.description || "không mô tả"} | ngôn ngữ: ${i.language || "?"} | ⭐${i.stargazers_count} | issue mở: ${i.open_issues_count} | cập nhật: ${i.pushed_at}\n`;
  if (commits.status === "fulfilled") ctx += "Commit gần đây:\n" + commits.value.map((c) => `- ${c.commit.message.split("\n")[0].slice(0, 120)} (${c.commit.author?.name}, ${c.commit.author?.date})`).join("\n") + "\n";
  if (issues.status === "fulfilled") ctx += "Issue/PR đang mở:\n" + issues.value.map((x) => `- #${x.number} ${x.pull_request ? "[PR] " : ""}${x.title.slice(0, 120)}`).join("\n") + "\n";
  if (runs.status === "fulfilled") ctx += "Workflow gần đây:\n" + (runs.value.workflow_runs || []).map((r) => `- ${r.name}: ${r.status}/${r.conclusion || "—"} (${r.head_branch})`).join("\n") + "\n";

  const ask = question || "Tóm tắt nhanh tình hình dự án và việc cần chú ý.";
  const { text, error } = await askGithubAI(env, `DỮ LIỆU GITHUB:\n${ctx}\nYÊU CẦU: ${ask}`);
  if (!text) return reply(`⚠️ AI lỗi (${error?.message || "không rõ"}). Dữ liệu thô:\n\n${ctx}`);
  return reply(`🐙 ${repo}\n\n${text}`);
}

// ----- Webhook GitHub -> Telegram (POST /github) -----

async function verifyGithubSignature(secret, body, header) {
  if (!header || !header.startsWith("sha256=")) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

function safeUrl(u) { return String(u || "").replace(/"/g, "%22"); }

function buildGithubMessage(event, p) {
  const repo = escapeHtml(p.repository?.full_name || "?");
  const who = escapeHtml(p.sender?.login || p.pusher?.name || "?");

  if (event === "ping") return { html: `✅ <b>GitHub đã kết nối</b> với bot (<code>${repo}</code>)` };

  if (event === "push") {
    const branch = escapeHtml((p.ref || "").replace(/^refs\/(heads|tags)\//, ""));
    if (p.deleted) return { html: `🗑 <b>Xoá</b> <code>${branch}</code> ở <code>${repo}</code> bởi ${who}` };
    const commits = p.commits || [];
    if (!commits.length) return null;
    const lines = commits.slice(0, 5).map((c) => `• ${escapeHtml(c.message.split("\n")[0].slice(0, 100))} — ${escapeHtml(c.author?.name || "")}`);
    const more = commits.length > 5 ? `\n… và ${commits.length - 5} commit nữa` : "";
    return {
      html: `📦 <b>Push</b> → <code>${repo}</code> (<code>${branch}</code>)\n👤 ${who}\n${lines.join("\n")}${more}\n<a href="${safeUrl(p.compare)}">Xem thay đổi</a>`,
      aiPrompt: `Tóm tắt trong 1-2 câu tiếng Việt các thay đổi sau (repo ${p.repository?.full_name}):\n` + commits.slice(0, 10).map((c) => `- ${c.message.split("\n")[0]}`).join("\n"),
    };
  }

  if (event === "issues" && ["opened", "closed", "reopened"].includes(p.action)) {
    const icon = p.action === "closed" ? "✅" : "🐞";
    return { html: `${icon} <b>Issue #${p.issue.number} ${p.action}</b> — ${repo}\n${escapeHtml(p.issue.title)}\n👤 ${who}\n<a href="${safeUrl(p.issue.html_url)}">Mở issue</a>` };
  }

  if (event === "pull_request" && ["opened", "closed", "reopened", "ready_for_review"].includes(p.action)) {
    const act = p.action === "closed" ? (p.pull_request.merged ? "merged" : "closed") : p.action;
    const icon = act === "merged" ? "🟣" : "🔀";
    return { html: `${icon} <b>PR #${p.pull_request.number} ${act}</b> — ${repo}\n${escapeHtml(p.pull_request.title)}\n👤 ${who}\n<a href="${safeUrl(p.pull_request.html_url)}">Mở PR</a>` };
  }

  if (event === "workflow_run" && p.action === "completed") {
    const r = p.workflow_run;
    const icon = r.conclusion === "success" ? "✅" : r.conclusion === "failure" ? "❌" : "⚪";
    return { html: `${icon} <b>Workflow ${escapeHtml(r.name)}</b>: ${escapeHtml(r.conclusion || "?")} — ${repo} (<code>${escapeHtml(r.head_branch)}</code>)\n<a href="${safeUrl(r.html_url)}">Xem chạy</a>` };
  }

  if (event === "release" && p.action === "published") {
    return { html: `🚀 <b>Release ${escapeHtml(p.release.tag_name)}</b> — ${repo}\n<a href="${safeUrl(p.release.html_url)}">Xem release</a>` };
  }
  return null;
}

async function processGithubEvent(env, event, payload) {
  try {
    const chat = env.NOTIFY_CHAT_ID || env.ADMIN_ID;
    if (!chat || !env.TELEGRAM_BOT_TOKEN) { console.log("⚠️ [GitHub] thiếu NOTIFY_CHAT_ID/ADMIN_ID"); return; }
    const msg = buildGithubMessage(event, payload);
    if (!msg) return;
    let html = msg.html;
    if (msg.aiPrompt && env.GITHUB_AI_SUMMARY !== "off") {
      const { text } = await askGithubAI(env, msg.aiPrompt, "fast");
      if (text) html += `\n\n🤖 ${escapeHtml(text.slice(0, 600))}`;
    }
    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    await tg.sendMessage(chat, html.slice(0, 4000), { parse_mode: "HTML", disable_web_page_preview: true });
    await bumpStats(env, "gh_events");
  } catch (e) {
    console.log(`✗ [GitHub] ${e.stack || e.message}`);
  }
}

async function handleGithubWebhook(request, env, ctx) {
  if (!env.GITHUB_WEBHOOK_SECRET) return new Response("Thiếu secret GITHUB_WEBHOOK_SECRET", { status: 500 });
  const body = await request.text();
  const ok = await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("x-hub-signature-256"));
  if (!ok) return new Response("Invalid signature", { status: 401 });
  let payload;
  try { payload = JSON.parse(body); } catch (e) { return new Response("Bad JSON", { status: 400 }); }
  ctx.waitUntil(processGithubEvent(env, request.headers.get("x-github-event") || "", payload));
  return new Response("OK", { status: 200 });
}

// ---------------- Chẩn đoán: mở https://<worker>/health bằng trình duyệt ----------------

async function handleHealth(env, url) {
  if (!env.HEALTH_KEY || url.searchParams.get("key") !== env.HEALTH_KEY) {
    return new Response(JSON.stringify({ version: BOT_VERSION }, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
  }
  const tok = env.TELEGRAM_BOT_TOKEN || "";
  const out = {
    version: BOT_VERSION,
    token_set: Boolean(tok),
    token_length: tok.length,
    token_has_whitespace: /\s/.test(tok),
    gemini_key_set: Boolean(env.GEMINI_API_KEY),
    admin_id_set: Boolean(env.ADMIN_ID),
    kv_bound: Boolean(env.USERS_KV),
  };
  if (tok) {
    try {
      const d = await (await fetch(`https://api.telegram.org/bot${tok.trim()}/getMe`)).json();
      out.telegram_getMe = d.ok ? `ok @${d.result.username}` : `lỗi ${d.error_code} ${d.description}`;
    } catch (e) { out.telegram_getMe = `exception ${e.message}`; }
  }
  try {
    const s = JSON.parse((await env.USERS_KV.get("stats:global")) || "{}");
    out.updates_received = s.updates || 0;
    out.handler_errors = s.handler_err || 0;
    out.last_error = s.last_error || null;
  } catch (e) { out.stats = `đọc KV lỗi: ${e.message}`; }
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json; charset=utf-8" } });
}

// ---------------- Tin nhắn thường ----------------

async function handlePrivateMessage(env, tg, message, personality) {
  const chatId = message.chat.id;
  const messageText = message.text || message.caption || "";
  let media = null;
  if (message.photo?.length) media = await tg.downloadFileAsBase64(message.photo[message.photo.length - 1].file_id, "image/jpeg");
  else if (message.video) media = await tg.downloadFileAsBase64(message.video.file_id, "video/mp4");
  if (!messageText.trim() && !media) return; // sticker, voice... bỏ qua

  const state = await getUserState(env.USERS_KV, chatId);
  const history = [...state.history];
  state.lastReplyTime = Date.now(); state.reminderStage = 0; state.running = true;

  await tg.call("sendChatAction", { chat_id: chatId, action: "typing" });
  const tool = media ? null : await tryTools(env, messageText);
  if (tool?.reply) {
    appendHistory(state, "user", messageText);
    appendHistory(state, "model", tool.reply);
    await tg.replyToMessage(chatId, message.message_id, tool.reply);
    await saveUserState(env.USERS_KV, chatId, state);
    return;
  }
  if (!aiQuotaCheck(state, env, message.from?.id, 60, "AI_DAILY_CAP")) {
    await tg.replyToMessage(chatId, message.message_id, "⏳ Hôm nay bạn đã dùng hết lượt hỏi AI. Mai quay lại nhé (lệnh quản lý và hỏi giờ/ngày vẫn dùng được).");
    await saveUserState(env.USERS_KV, chatId, state);
    return;
  }
  const { text: aiReply, isFallback } = await generateContent(env, tg, personality, { contextMessage: messageText, history, media, search: Boolean(tool?.search) });

  appendHistory(state, "user", media ? `${messageText} [kèm ảnh/video]`.trim() : messageText);
  if (!isFallback) appendHistory(state, "model", aiReply);

  // Gửi trả lời TRƯỚC, lưu state sau → KV lỗi cũng không làm mất câu trả lời
  await tg.replyToMessage(chatId, message.message_id, aiReply);
  await saveUserState(env.USERS_KV, chatId, state);
}

function wasBotAddressed(message, botUsername) {
  if (!botUsername) return false;
  if (message.reply_to_message?.from?.username?.toLowerCase() === botUsername) return true;
  const text = (message.text || message.caption || "");
  const entities = message.entities || message.caption_entities || [];
  for (const ent of entities) {
    if (ent.type === "mention" && text.slice(ent.offset, ent.offset + ent.length).toLowerCase() === `@${botUsername}`) return true;
  }
  return text.toLowerCase().includes(`@${botUsername}`);
}

async function handleGroupMessage(env, tg, message, personality, groupMode, botUsername) {
  const chatId = message.chat.id;
  const text = message.text || message.caption || "";
  const wasAddressed = wasBotAddressed(message, botUsername);
  if (!wasAddressed && groupMode === "mention_only") return;
  if (!wasAddressed && !text.trim()) return;

  let media = null;
  if (message.photo?.length) media = await tg.downloadFileAsBase64(message.photo[message.photo.length - 1].file_id, "image/jpeg");

  const state = await getUserState(env.USERS_KV, chatId);
  const history = [...state.history];
  state.lastReplyTime = Date.now(); state.reminderStage = 0; state.running = true;

  const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Ai đó";
  let search = false;
  if (wasAddressed && !media) {
    const tool = await tryTools(env, text.replace(/@\w+/g, " "));
    if (tool?.reply) {
      appendHistory(state, "user", `${senderName}: ${text}`);
      appendHistory(state, "model", tool.reply);
      await tg.replyToMessage(chatId, message.message_id, tool.reply);
      await saveUserState(env.USERS_KV, chatId, state);
      return;
    }
    search = Boolean(tool?.search);
  }
  if (!aiQuotaCheck(state, env, message.from?.id, 150, "AI_GROUP_DAILY_CAP")) {
    if (wasAddressed) await tg.replyToMessage(chatId, message.message_id, "⏳ Nhóm đã dùng hết lượt hỏi AI hôm nay. Mai quay lại nhé.");
    await saveUserState(env.USERS_KV, chatId, state);
    return;
  }
  const { shouldReply, text: aiReply, isFallback } = await generateGroupReply(env, tg, personality, {
    senderName, messageText: text, wasAddressed, history, media, search,
  });

  appendHistory(state, "user", `${senderName}: ${text}`);
  if (!shouldReply) { await saveUserState(env.USERS_KV, chatId, state); return; }
  if (!isFallback) appendHistory(state, "model", aiReply);
  await tg.replyToMessage(chatId, message.message_id, aiReply);
  await saveUserState(env.USERS_KV, chatId, state);
}

// ---------------- Kiểm tra chứng chỉ ký IPA của Apple (.mobileprovision / .cer + OCSP) ----------------

function derNode(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
    hdr = 2 + n;
  }
  return { tag, pos, hdr, len, start: pos + hdr, end: pos + hdr + len };
}

function derKids(buf, node) {
  const out = [];
  let p = node.start;
  while (p < node.end) {
    const n = derNode(buf, p);
    out.push(n);
    p = n.end;
  }
  return out;
}

function concatBytes(...arrs) {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

function derEnc(tag, content) {
  const l = content.length;
  const hdr = l < 128 ? [tag, l] : l < 256 ? [tag, 0x81, l] : l < 65536 ? [tag, 0x82, l >> 8, l & 255] : [tag, 0x83, l >> 16, (l >> 8) & 255, l & 255];
  return concatBytes(Uint8Array.from(hdr), content);
}

function oidEq(buf, node, bytes) {
  if (!node || node.tag !== 0x06 || node.len !== bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[node.start + i] !== bytes[i]) return false;
  return true;
}

const OID_CN = [0x55, 0x04, 0x03];
const OID_ORG = [0x55, 0x04, 0x0a];
const OID_AIA = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x01, 0x01];
const OID_OCSP = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x01];
const OID_CAISSUERS = [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02];

function derStr(buf, node) {
  return new TextDecoder().decode(buf.subarray(node.start, node.end));
}

function derTime(buf, node) {
  const s = derStr(buf, node);
  let y, rest;
  if (node.tag === 0x17) {
    const yy = Number(s.slice(0, 2));
    y = yy >= 50 ? 1900 + yy : 2000 + yy;
    rest = s.slice(2);
  } else {
    y = Number(s.slice(0, 4));
    rest = s.slice(4);
  }
  const mo = Number(rest.slice(0, 2)), d = Number(rest.slice(2, 4)), h = Number(rest.slice(4, 6)), mi = Number(rest.slice(6, 8)), se = Number(rest.slice(8, 10)) || 0;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, se));
}

function nameField(buf, nameNode, oid) {
  for (const rdn of derKids(buf, nameNode)) {
    for (const atv of derKids(buf, rdn)) {
      const k = derKids(buf, atv);
      if (oidEq(buf, k[0], oid)) return derStr(buf, k[1]);
    }
  }
  return "";
}

function parseCert(der) {
  const cert = derNode(der, 0);
  const tbs = derKids(der, cert)[0];
  const kids = derKids(der, tbs);
  let i = 0;
  if (kids[i].tag === 0xa0) i++;
  const serial = kids[i++];
  i++; // signature algorithm
  const issuer = kids[i++];
  const validity = kids[i++];
  const subject = kids[i++];
  const spki = kids[i++];
  const vk = derKids(der, validity);
  const res = {
    serialTlv: der.subarray(serial.pos, serial.end),
    issuerTlv: der.subarray(issuer.pos, issuer.end),
    subjectTlv: der.subarray(subject.pos, subject.end),
    notBefore: derTime(der, vk[0]),
    notAfter: derTime(der, vk[1]),
    subjectCN: nameField(der, subject, OID_CN),
    subjectOrg: nameField(der, subject, OID_ORG),
    issuerCN: nameField(der, issuer, OID_CN),
    keyBits: der.subarray(derKids(der, spki)[1].start + 1, derKids(der, spki)[1].end),
    ocspUrl: null,
    caIssuersUrl: null,
  };
  const ext = kids.find((k) => k.tag === 0xa3);
  if (ext) {
    const extSeq = derKids(der, ext)[0];
    for (const e of derKids(der, extSeq)) {
      const ek = derKids(der, e);
      if (!oidEq(der, ek[0], OID_AIA)) continue;
      const inner = derNode(der, ek[ek.length - 1].start);
      for (const ad of derKids(der, inner)) {
        const adk = derKids(der, ad);
        if (adk[1] && adk[1].tag === 0x86) {
          const url = derStr(der, adk[1]);
          if (oidEq(der, adk[0], OID_OCSP)) res.ocspUrl = url;
          else if (oidEq(der, adk[0], OID_CAISSUERS)) res.caIssuersUrl = url;
        }
      }
    }
  }
  return res;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function buildOcspRequest(cert, issuer) {
  const sha1 = async (b) => new Uint8Array(await crypto.subtle.digest("SHA-1", b));
  const alg = derEnc(0x30, concatBytes(derEnc(0x06, Uint8Array.from([0x2b, 0x0e, 0x03, 0x02, 0x1a])), Uint8Array.from([0x05, 0x00])));
  const certId = derEnc(0x30, concatBytes(alg, derEnc(0x04, await sha1(cert.issuerTlv)), derEnc(0x04, await sha1(issuer.keyBits)), cert.serialTlv));
  return derEnc(0x30, derEnc(0x30, derEnc(0x30, derEnc(0x30, certId))));
}

function parseOcspResponse(buf) {
  const top = derNode(buf, 0);
  const k = derKids(buf, top);
  const st = buf[k[0].start];
  if (st !== 0) throw new Error(`OCSP responder trả mã lỗi ${st}`);
  const rb = derKids(buf, derKids(buf, k[1])[0]);
  const basic = derNode(buf, rb[1].start);
  const tbs = derKids(buf, basic)[0];
  const tk = derKids(buf, tbs);
  let i = 0;
  if (tk[i].tag === 0xa0) i++;
  i++; // responderID
  i++; // producedAt
  const single = derKids(buf, derKids(buf, tk[i])[0]);
  const s = single[1];
  const thisUpdate = single[2] ? derTime(buf, single[2]) : null;
  if (s.tag === 0x80) return { status: "good", thisUpdate };
  if (s.tag === 0xa1) return { status: "revoked", revokedAt: derTime(buf, derKids(buf, s)[0]), thisUpdate };
  return { status: "unknown", thisUpdate };
}

async function ocspCheck(cert, issuerCache) {
  if (!cert.ocspUrl) throw new Error("chứng chỉ không có địa chỉ OCSP");
  if (!cert.caIssuersUrl) throw new Error("chứng chỉ không có địa chỉ CA cấp phát");
  let issuer = issuerCache.get(cert.caIssuersUrl);
  if (!issuer) {
    const r = await fetch(cert.caIssuersUrl, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`tải CA lỗi HTTP ${r.status}`);
    issuer = parseCert(new Uint8Array(await r.arrayBuffer()));
    issuerCache.set(cert.caIssuersUrl, issuer);
  }
  if (!bytesEqual(issuer.subjectTlv, cert.issuerTlv)) throw new Error("CA tải về không khớp với CA đã cấp chứng chỉ");
  const req = await buildOcspRequest(cert, issuer);
  const res = await fetch(cert.ocspUrl, {
    method: "POST",
    headers: { "Content-Type": "application/ocsp-request" },
    body: req,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`OCSP HTTP ${res.status}`);
  return parseOcspResponse(new Uint8Array(await res.arrayBuffer()));
}

function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function xmlUnescape(s) {
  return String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

function parseProvision(bytes) {
  const all = new TextDecoder().decode(bytes);
  const a = all.indexOf("<?xml");
  const b = all.indexOf("</plist>");
  if (a < 0 || b < 0) throw new Error("không đọc được nội dung .mobileprovision");
  const x = all.slice(a, b + 8);
  const str = (key) => { const m = new RegExp(`<key>${key}</key>\\s*<string>([\\s\\S]*?)</string>`).exec(x); return m ? xmlUnescape(m[1]) : ""; };
  const date = (key) => { const m = new RegExp(`<key>${key}</key>\\s*<date>([^<]+)</date>`).exec(x); return m ? new Date(m[1]) : null; };
  const teamId = (/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([^<]*)/.exec(x) || [])[1] || "";
  const devBlock = (/<key>ProvisionedDevices<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(x) || [])[1] || "";
  const devices = (devBlock.match(/<string>/g) || []).length;
  const allDevices = /<key>ProvisionsAllDevices<\/key>\s*<true\/>/.test(x);
  const taskAllow = /<key>get-task-allow<\/key>\s*<true\/>/.test(x);
  const certBlock = (/<key>DeveloperCertificates<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(x) || [])[1] || "";
  const certs = [...certBlock.matchAll(/<data>([\s\S]*?)<\/data>/g)].map((m) => b64ToBytes(m[1]));
  const type = allDevices ? "Enterprise (in-house)" : taskAllow ? "Development" : devices > 0 ? "Ad Hoc" : "App Store";
  return { name: str("Name"), appIdName: str("AppIDName"), teamName: str("TeamName"), teamId, uuid: str("UUID"), expires: date("ExpirationDate"), devices, type, certs };
}

function parseCertFile(bytes) {
  const head = new TextDecoder().decode(bytes.subarray(0, 40));
  if (head.includes("-----BEGIN")) {
    const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(new TextDecoder().decode(bytes));
    if (!m) throw new Error("PEM không hợp lệ");
    return b64ToBytes(m[1]);
  }
  return bytes;
}

// ----- Đọc file .ipa/.zip (chỉ lấy embedded.mobileprovision, không giải nén cả file) -----

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function zipFindEntry(buf, matcher) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error("không phải file zip/ipa hợp lệ");
  const count = dv.getUint16(e + 10, true);
  let off = dv.getUint32(e + 16, true);
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(buf.subarray(off + 46, off + 46 + nameLen));
    if (matcher(name)) return { name, method, csize, lho };
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return null;
}

async function zipReadEntry(buf, ent) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (ent.csize === 0xffffffff) throw new Error("file zip64 quá lớn, không hỗ trợ");
  const start = ent.lho + 30 + dv.getUint16(ent.lho + 26, true) + dv.getUint16(ent.lho + 28, true);
  const data = buf.subarray(start, start + ent.csize);
  if (ent.method === 0) return data;
  if (ent.method === 8) return inflateRaw(data);
  throw new Error("kiểu nén zip không hỗ trợ");
}

async function tgDownloadBytes(tg, fileId, maxBytes = 2 * 1024 * 1024) {
  const info = (await tg.call("getFile", { file_id: fileId })).result;
  if (!info?.file_path) return null;
  if (info.file_size && info.file_size > maxBytes) return "TOO_BIG";
  const res = await fetch(`https://api.telegram.org/file/bot${tg.botToken}/${info.file_path}`);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

function fmtDate(d) {
  return d ? d.toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) : "?";
}

function daysLeft(d) {
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function expiryText(d) {
  const n = daysLeft(d);
  return n < 0 ? `${fmtDate(d)} ❌ đã hết hạn` : n <= 30 ? `${fmtDate(d)} ⚠️ còn ${n} ngày` : `${fmtDate(d)} ✅ còn ${n} ngày`;
}

function ocspText(r) {
  if (r.status === "rejected") return `⚠️ Không kiểm tra được: ${escapeHtml(String(r.reason?.message || r.reason).slice(0, 120))}`;
  const v = r.value;
  if (v.status === "good") return "✅ Còn hiệu lực (Apple chưa thu hồi)";
  if (v.status === "revoked") return `❌ ĐÃ BỊ APPLE THU HỒI (${fmtDate(v.revokedAt)})`;
  return "❓ Apple báo không xác định";
}

async function renderCertList(certDers) {
  const issuerCache = new Map();
  const parsed = certDers.slice(0, 5).map((d) => { try { return parseCert(d); } catch (e) { return null; } });
  const results = await Promise.allSettled(parsed.map((c) => (c ? ocspCheck(c, issuerCache) : Promise.reject(new Error("không đọc được chứng chỉ")))));
  const lines = parsed.map((c, i) => {
    if (!c) return `${i + 1}. ⚠️ Không đọc được chứng chỉ`;
    return `${i + 1}. <code>${escapeHtml(c.subjectCN || "(không tên)")}</code>\n   Hết hạn: ${expiryText(c.notAfter)}\n   Apple OCSP: ${ocspText(results[i])}`;
  });
  const more = certDers.length > 5 ? `\n… còn ${certDers.length - 5} chứng chỉ khác chưa kiểm tra` : "";
  return `🔐 <b>Chứng chỉ ký (${certDers.length})</b>\n${lines.join("\n")}${more}`;
}

const CHECKCERT_HELP =
  "🍎 <b>Kiểm tra chứng chỉ ký IPA Apple</b>\n" +
  "Gửi file <code>.mobileprovision</code>, <code>.cer</code>, hoặc <code>.ipa</code>/<code>.zip</code> (tối đa 20MB) kèm chú thích <code>/checkcert</code>, " +
  "hoặc reply vào file đó rồi gõ <code>/checkcert</code>.\n\n" +
  "🌐 Kiểm tra SSL của domain: <code>/checkcert example.com</code>\n\n" +
  "⚠️ Đừng gửi file .p12 hay mật khẩu cho bot. Hãy gửi .mobileprovision (chứa sẵn chứng chỉ công khai) để kiểm tra trạng thái thu hồi.";

async function handleCheckcert(env, tg, message, args) {
  const chatId = message.chat.id;
  const mid = message.message_id;
  const doc = message.document || message.reply_to_message?.document;
  if (!doc) {
    if (args.trim()) return handleCheckcertDomain(tg, chatId, mid, args);
    return tg.replyToMessage(chatId, mid, CHECKCERT_HELP + "\n\n❗ Bot không thấy file đính kèm trong tin này hoặc trong tin bạn reply. Hãy gửi file kèm chú thích /checkcert, hoặc reply trực tiếp vào tin có file.", { parse_mode: "HTML" });
  }
  const name = (doc.file_name || "").toLowerCase();
  if (/\.(p12|pfx)$/.test(name) || /pkcs12/i.test(doc.mime_type || "")) {
    return tg.replyToMessage(chatId, mid, "🔒 Bot không đọc file .p12 (cần mật khẩu, không nên gửi cho bot). Hãy gửi file .mobileprovision hoặc .cer tương ứng.");
  }
  let isProv = name.endsWith(".mobileprovision");
  let isCer = /\.(cer|crt|der|pem)$/.test(name);
  let isZip = /\.(ipa|zip)$/.test(name);
  const unknownName = !isProv && !isCer && !isZip; // tên không có đuôi: đoán theo nội dung file

  await tg.replyToMessage(chatId, mid, "🔎 Đang kiểm tra với Apple OCSP...");
  const bytes = await tgDownloadBytes(tg, doc.file_id, (isZip || unknownName) ? 20 * 1024 * 1024 : 2 * 1024 * 1024);
  if (bytes === "TOO_BIG") return tg.sendMessage(chatId, "❌ File quá lớn.");
  if (!bytes) return tg.sendMessage(chatId, isZip ? "❌ Không tải được file. Telegram chỉ cho bot tải file tối đa 20MB. Hãy giải nén IPA, lấy Payload/<tên>.app/embedded.mobileprovision rồi gửi riêng file đó." : "❌ Không tải được file từ Telegram.");
  if (unknownName) {
    const headTxt = new TextDecoder().decode(bytes.subarray(0, 200000));
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) isZip = true;
    else if (headTxt.includes("-----BEGIN CERTIFICATE")) isCer = true;
    else if (bytes[0] === 0x30 && headTxt.includes("<?xml")) isProv = true;
    else if (bytes[0] === 0x30) isCer = true;
    else return tg.sendMessage(chatId, `❌ Không nhận dạng được file "${doc.file_name || "(không tên)"}" (${doc.mime_type || "?"}). Hãy gửi .mobileprovision, .cer, .ipa hoặc .zip.`);
  }
  try {
    let data = bytes;
    if (isZip) {
      const pe = zipFindEntry(bytes, (n) => /(^|\/)embedded\.mobileprovision$/i.test(n)) || zipFindEntry(bytes, (n) => /\.mobileprovision$/i.test(n));
      const ce = pe ? null : zipFindEntry(bytes, (n) => /\.(cer|crt)$/i.test(n));
      if (!pe && !ce) return tg.sendMessage(chatId, "❌ Không thấy embedded.mobileprovision (hoặc .cer) trong file này.");
      data = await zipReadEntry(bytes, pe || ce);
      isProv = Boolean(pe);
      isCer = Boolean(ce);
    }
    if (isProv) {
      const p = parseProvision(data);
      const head =
        `🍎 <b>Provisioning Profile</b>\n• Tên: ${escapeHtml(p.name)}\n• App ID: ${escapeHtml(p.appIdName)}\n` +
        `• Team: ${escapeHtml(p.teamName)} (${escapeHtml(p.teamId)})\n• Loại: ${p.type}\n` +
        `• Thiết bị: ${p.type.startsWith("Enterprise") ? "không giới hạn" : p.devices}\n` +
        `• Hết hạn profile: ${p.expires ? expiryText(p.expires) : "?"}\n• UUID: <code>${escapeHtml(p.uuid)}</code>\n\n`;
      const body = p.certs.length ? await renderCertList(p.certs) : "Không có chứng chỉ trong profile.";
      await tg.sendMessage(chatId, head + body + "\n\nℹ️ Kết quả lấy trực tiếp từ OCSP của Apple (chưa xác minh chữ ký phản hồi).", { parse_mode: "HTML" });
    } else {
      await tg.sendMessage(chatId, (await renderCertList([parseCertFile(data)])) + "\n\nℹ️ Kết quả lấy trực tiếp từ OCSP của Apple (chưa xác minh chữ ký phản hồi).", { parse_mode: "HTML" });
    }
  } catch (e) {
    console.log(`✗ [checkcert] ${e.stack || e.message}`);
    await tg.sendMessage(chatId, `❌ Không đọc được file: ${e.message}`);
  }
}

// ---------------- Quản lý nhóm kiểu @MissRose_bot (bản đầy đủ) ----------------
// Cần: thêm bot vào nhóm và cấp quyền admin (xoá tin, cấm/hạn chế thành viên, ghim, mời người dùng).

const cfgCache = new Map();
const adminCache = new Map();
const floodMap = new Map();
let cachedBotId = null;

const DEFAULT_CFG = () => ({
  welcome: { on: false, text: "Chào mừng {mention} đến với {chatname}! 🎉", clean: false },
  goodbye: { on: false, text: "Tạm biệt {first} 👋", clean: false },
  captcha: { on: false, time: 300 },
  cleanservice: false,
  rules: "",
  warnlimit: 3, warnmode: "ban", warntime: 3600,
  notes: {}, filters: {},
  blacklist: [], blmode: "delete", bltime: 3600,
  flood: 0, floodmode: "mute", floodtime: 600, floodwindow: 10,
  locks: {}, approved: {}, disabled: [], reports: true,
  lastwelcome: 0,
});

async function getChatCfg(env, chatId) {
  const c = cfgCache.get(chatId);
  if (c && Date.now() - c.t < 20000) return c.v;
  let v = DEFAULT_CFG();
  try {
    const raw = await env.USERS_KV.get(`chat:${chatId}`);
    if (raw) v = { ...v, ...JSON.parse(raw) };
  } catch (e) {
    console.log(`⚠️ [KV] đọc cấu hình nhóm ${chatId} lỗi: ${e.message}`);
  }
  cfgCache.set(chatId, { v, t: Date.now() });
  return v;
}

async function saveChatCfg(env, chatId, cfg) {
  cfgCache.set(chatId, { v: cfg, t: Date.now() });
  try {
    await env.USERS_KV.put(`chat:${chatId}`, JSON.stringify(cfg));
    return true;
  } catch (e) {
    console.log(`⚠️ [KV] ghi cấu hình nhóm ${chatId} lỗi: ${e.message}`);
    return false;
  }
}

async function getBotId(tg) {
  if (!cachedBotId) cachedBotId = (await tg.getMe())?.id;
  return cachedBotId;
}

function userName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || String(u.id);
}

function mentionHtml(u) {
  return `<a href="tg://user?id=${u.id}">${escapeHtml(userName(u))}</a>`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ----- Định dạng giống Rose: *đậm* _nghiêng_ `code` [chữ](link) và nút [Nhãn](buttonurl://https://...) -----

function extractButtons(raw) {
  const rows = [];
  const text = String(raw || "").replace(/\[([^\]\n]{1,40})\]\(buttonurl:\/\/([^)\s]+?)(:same)?\)/g, (m, label, url, same) => {
    if (!/^(https?:\/\/|tg:\/\/|t\.me\/)/i.test(url)) return m;
    const btn = { text: label, url: url.startsWith("t.me/") ? "https://" + url : url };
    if (same && rows.length) rows[rows.length - 1].push(btn); else rows.push([btn]);
    return "";
  }).trim();
  return { text, markup: rows.length ? { inline_keyboard: rows.slice(0, 8) } : undefined };
}

function mdToHtml(s) {
  return s
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u.replace(/"/g, "%22")}">${t}</a>`)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<b>$2</b>")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, "$1<i>$2</i>");
}

function renderRich(tpl, user, chat) {
  const { text, markup } = extractButtons(tpl);
  let h = mdToHtml(escapeHtml(text));
  if (user) {
    h = h.replace(/\{mention\}/g, mentionHtml(user))
      .replace(/\{first\}/g, escapeHtml(user.first_name || ""))
      .replace(/\{last\}/g, escapeHtml(user.last_name || ""))
      .replace(/\{fullname\}/g, escapeHtml(userName(user)))
      .replace(/\{username\}/g, user.username ? "@" + escapeHtml(user.username) : escapeHtml(userName(user)))
      .replace(/\{id\}/g, String(user.id));
  }
  if (chat) h = h.replace(/\{chatname\}/g, escapeHtml(chat.title || ""));
  return { html: h, markup };
}

// ----- Quyền admin -----

async function isChatAdmin(env, tg, chatId, userId) {
  if (env.ADMIN_ID && String(userId) === String(env.ADMIN_ID)) return true;
  const key = `${chatId}:${userId}`;
  const c = adminCache.get(key);
  if (c && Date.now() - c.t < 60000) return c.v;
  const d = await tg.call("getChatMember", { chat_id: chatId, user_id: userId });
  const v = Boolean(d.ok && ["creator", "administrator"].includes(d.result?.status));
  adminCache.set(key, { v, t: Date.now() });
  if (adminCache.size > 5000) adminCache.clear();
  return v;
}

async function senderIsAdmin(env, tg, message) {
  if (message.sender_chat && message.sender_chat.id === message.chat.id) return true; // admin ẩn danh
  if (!message.from) return false;
  return isChatAdmin(env, tg, message.chat.id, message.from.id);
}

// ----- Tiện ích phân tích -----

function parseDuration(s) {
  const m = /^(\d+)([smhdw])$/i.exec(s || "");
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
}

function parseQuoted(s) {
  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(s || ""))) out.push(m[1] ?? m[2]);
  return out;
}

function splitFirst(s) {
  const m = /^(?:"([^"]+)"|(\S+))\s*([\s\S]*)$/.exec((s || "").trim());
  return m ? { first: m[1] ?? m[2], rest: m[3] } : { first: "", rest: "" };
}

function resolveTarget(message, args) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const rep = message.reply_to_message;
  if (rep?.from) return { user: rep.from, rest: tokens.join(" "), tokens };
  const ent = (message.entities || []).find((e) => e.type === "text_mention" && e.user);
  if (ent) return { user: ent.user, rest: tokens.slice(1).join(" "), tokens: tokens.slice(1) };
  if (tokens[0] && /^\d{5,}$/.test(tokens[0])) {
    return { user: { id: Number(tokens[0]), first_name: tokens[0] }, rest: tokens.slice(1).join(" "), tokens: tokens.slice(1) };
  }
  return null;
}

const MUTE_PERMS = {
  can_send_messages: false, can_send_audios: false, can_send_documents: false, can_send_photos: false,
  can_send_videos: false, can_send_video_notes: false, can_send_voice_notes: false, can_send_polls: false,
  can_send_other_messages: false, can_add_web_page_previews: false,
};
const UNMUTE_PERMS = {
  can_send_messages: true, can_send_audios: true, can_send_documents: true, can_send_photos: true,
  can_send_videos: true, can_send_video_notes: true, can_send_voice_notes: true, can_send_polls: true,
  can_send_other_messages: true, can_add_web_page_previews: true, can_invite_users: true,
};

const MODE_TEXT = { ban: "cấm", kick: "đuổi", mute: "tắt tiếng", tban: "cấm có thời hạn", tmute: "tắt tiếng có thời hạn" };

async function applyPunish(tg, chatId, userId, mode, secs) {
  const until = secs ? { until_date: Math.floor(Date.now() / 1000) + secs } : {};
  if (mode === "mute" || mode === "tmute") return tg.call("restrictChatMember", { chat_id: chatId, user_id: userId, permissions: MUTE_PERMS, ...(mode === "tmute" ? until : {}) });
  if (mode === "kick") {
    const r = await tg.call("banChatMember", { chat_id: chatId, user_id: userId });
    if (r.ok) await tg.call("unbanChatMember", { chat_id: chatId, user_id: userId, only_if_banned: true });
    return r;
  }
  return tg.call("banChatMember", { chat_id: chatId, user_id: userId, ...(mode === "tban" ? until : {}) });
}

async function addWarn(env, tg, chatId, user, reason, cfg) {
  const key = `warn:${chatId}:${user.id}`;
  let w = { n: 0, r: [] };
  try { const raw = await env.USERS_KV.get(key); if (raw) w = JSON.parse(raw); } catch (e) {}
  w.n++; w.r.push(reason || "(không lý do)");
  const m = mentionHtml(user);
  const why = reason ? `\n📝 Lý do: ${escapeHtml(reason)}` : "";
  if (w.n >= cfg.warnlimit) {
    const d = await applyPunish(tg, chatId, user.id, cfg.warnmode, cfg.warntime);
    if (!d.ok) return { ok: false, err: d };
    try { await env.USERS_KV.delete(key); } catch (e) {}
    return { ok: true, text: `🚫 ${m} đạt ${w.n}/${cfg.warnlimit} cảnh cáo và bị ${MODE_TEXT[cfg.warnmode] || "xử lý"}.${why}` };
  }
  try { await env.USERS_KV.put(key, JSON.stringify(w)); } catch (e) { return { ok: false, err: { description: "KV lỗi, không lưu được cảnh cáo" } }; }
  return { ok: true, text: `⚠️ ${m} bị cảnh cáo (${w.n}/${cfg.warnlimit}).${why}` };
}

async function doReport(env, tg, message, cfg) {
  const chat = message.chat;
  const rep = message.reply_to_message;
  if (!rep) { await tg.replyToMessage(chat.id, message.message_id, "❗ Reply tin nhắn cần báo cáo rồi gõ /report hoặc @admin."); return; }
  if (cfg.reports === false) return;
  if (rep.from && (await isChatAdmin(env, tg, chat.id, rep.from.id))) { await tg.replyToMessage(chat.id, message.message_id, "🛡 Không thể báo cáo admin."); return; }
  const d = await tg.call("getChatAdministrators", { chat_id: chat.id });
  const admins = (d.ok ? d.result : []).filter((a) => !a.user.is_bot).slice(0, 15);
  const hidden = admins.map((a) => `<a href="tg://user?id=${a.user.id}">\u200b</a>`).join("");
  await tg.replyToMessage(chat.id, rep.message_id, `🚨 ${mentionHtml(message.from)} đã báo cáo tin nhắn này tới admin.${hidden}`, { parse_mode: "HTML" });
  if (env.ADMIN_ID) {
    await tg.sendMessage(env.ADMIN_ID, `🚨 Báo cáo trong "${chat.title || chat.id}" bởi ${userName(message.from)}`);
    await tg.forwardMessage(env.ADMIN_ID, chat.id, rep.message_id);
  }
}

// ----- Danh sách lệnh -----

const ROSE_ALIAS = {
  unblacklist: "rmblocklist", addblacklist: "addblocklist", blacklist: "blocklist", unblocklist: "rmblocklist",
  setwarnlimit: "warnlimit", setwarnmode: "warnmode", rmwarn: "unwarn", resetwarn: "resetwarns",
  spurge: "purge", adminlist: "admins", floods: "flood", adminhelp: "help",
};
const ROSE_ADMIN = new Set([
  "ban", "unban", "kick", "mute", "unmute", "tban", "tmute", "warn", "unwarn", "resetwarns", "resetallwarns",
  "warnlimit", "warnmode", "warntime", "del", "purge", "pin", "permapin", "unpin", "unpinall", "promote", "demote", "title",
  "setwelcome", "welcome", "resetwelcome", "cleanwelcome", "setgoodbye", "goodbye", "cleanservice", "captcha", "captchatime",
  "setrules", "clearrules", "save", "clear", "clearall", "filter", "stop", "stopall",
  "addblocklist", "rmblocklist", "unblocklistall", "blocklistmode",
  "setflood", "setfloodmode", "setfloodtimer", "lock", "unlock",
  "approve", "unapprove", "unapproveall", "disable", "enable", "reports", "audit",
]);
const ROSE_PUBLIC = new Set([
  "rules", "get", "notes", "filters", "blocklist", "warns", "warnings", "admins", "id", "help", "locks", "locktypes",
  "approval", "approved", "disabled", "pinned", "kickme", "report", "flood",
]);

const LOCK_TYPES = ["all", "url", "invitelink", "email", "forward", "bot", "sticker", "photo", "video", "audio", "voice", "document", "gif", "videonote", "contact", "location", "poll", "game", "media"];

const HELP = {
  _: "🌹 <b>Quản lý nhóm kiểu Rose</b>\nThêm bot vào nhóm và cấp quyền admin. Gõ <code>/help tên_mục</code>:\n\n" +
    "<code>bans</code> · <code>warns</code> · <code>admin</code> · <code>greetings</code> · <code>captcha</code> · <code>rules</code> · <code>notes</code> · <code>filters</code> · <code>blocklist</code> · <code>locks</code> · <code>flood</code> · <code>approvals</code> · <code>pins</code> · <code>reports</code> · <code>disable</code> · <code>format</code>",
  bans: "<b>Cấm / tắt tiếng</b> (reply hoặc gõ ID số)\n/ban /unban /kick /mute /unmute\n/tban 1h · /tmute 30m (s, m, h, d, w)\nBiến thể: /sban /skick /smute (im lặng, xoá lệnh) · /dban /dkick /dmute (xoá tin được reply)\n/kickme · tự rời nhóm",
  warns: "<b>Cảnh cáo</b>\n/warn [lý do] · /swarn · /dwarn · /unwarn (/rmwarn) · /warns · /resetwarns · /resetallwarns confirm\n/warnlimit 3 · /warnmode ban|kick|mute|tban|tmute · /warntime 1h · /warnings",
  admin: "<b>Admin</b>\n/admins · /promote · /demote · /title tên (reply admin do bot thăng)\n/del · /purge (reply tin đầu) · /id · /info · /audit (nhật ký thao tác admin)",
  greetings: "<b>Chào mừng</b>\n/setwelcome nội dung · /welcome on|off · /resetwelcome · /cleanwelcome on|off\n/setgoodbye nội dung · /goodbye on|off · /cleanservice on|off (xoá tin vào/rời nhóm)\nBiến: {mention} {first} {last} {fullname} {username} {id} {chatname}",
  captcha: "<b>Captcha</b>\n/captcha on|off · /captchatime 5m\nThành viên mới bị tắt tiếng tới khi bấm nút xác minh, quá hạn sẽ bị đuổi (kiểm tra mỗi 5 phút).",
  rules: "<b>Luật</b>\n/setrules nội dung · /rules · /clearrules",
  notes: "<b>Ghi chú</b>\n/save tên nội dung (hoặc reply + /save tên) · /get tên · #tên · /notes · /clear tên · /clearall confirm",
  filters: "<b>Bộ lọc</b>\n/filter từ_khoá nội dung · /filter \"nhiều từ\" nội dung · /filters · /stop từ_khoá · /stopall confirm",
  blocklist: "<b>Từ cấm</b>\n/addblocklist từ1 \"cụm từ\" · /rmblocklist từ · /blocklist · /unblocklistall confirm\n/blocklistmode delete|warn|mute|kick|ban|tmute 1h|tban 1h (tin vi phạm luôn bị xoá)",
  locks: "<b>Khoá</b>\n/lock loại · /unlock loại · /locks · /locktypes\nLoại: " + LOCK_TYPES.join(", "),
  flood: "<b>Chống spam</b>\n/setflood 5 (0 = tắt) · /flood · /setfloodtimer 5 10 (5 tin / 10 giây)\n/setfloodmode mute|kick|ban|tmute 10m|tban 1h",
  approvals: "<b>Duyệt người dùng</b> (được bỏ qua khoá, từ cấm, chống spam)\n/approve · /unapprove · /approval · /approved · /unapproveall confirm",
  pins: "<b>Ghim</b>\n/pin [loud] (reply) · /permapin nội dung · /unpin · /unpinall · /pinned",
  reports: "<b>Báo cáo</b>\n/report hoặc @admin (reply tin cần báo) · /reports on|off",
  disable: "<b>Tắt lệnh cho thành viên</b>\n/disable lệnh · /enable lệnh · /disabled",
  format: "<b>Định dạng</b> (ghi chú, bộ lọc, chào mừng, luật)\n*đậm* _nghiêng_ `code` [chữ](https://link)\nNút: [Nhãn](buttonurl://https://example.com) · cùng hàng: [Nhãn](buttonurl://https://a.com:same)",
};

async function sayRichTo(tg, chatId, replyTo, text, user, chat) {
  const r = renderRich(text, user, chat);
  return tg.sendMessage(chatId, r.html || "\u200b", { parse_mode: "HTML", ...(replyTo ? { reply_to_message_id: replyTo } : {}), ...(r.markup ? { reply_markup: r.markup } : {}), disable_web_page_preview: true });
}

async function handleRoseCommand(env, tg, message, cmd0, args) {
  let cmd = ROSE_ALIAS[cmd0] || cmd0;
  let flag = "";
  const vm = /^([sd])(ban|kick|mute|warn)$/.exec(cmd);
  if (vm) { flag = vm[1]; cmd = vm[2]; }
  if (!ROSE_ADMIN.has(cmd) && !ROSE_PUBLIC.has(cmd)) return false;

  const chat = message.chat;
  const chatId = chat.id;
  const mid = message.message_id;
  const isGroup = ["group", "supergroup"].includes(chat.type);
  const say = (html) => tg.replyToMessage(chatId, mid, html, { parse_mode: "HTML", disable_web_page_preview: true });
  const fail = (d) => say(`❌ ${escapeHtml(d.description || "Lỗi không rõ")}\nBot cần là admin và có đủ quyền cho thao tác này.`);

  if (cmd === "id") {
    const rep = message.reply_to_message?.from;
    await say(`🆔 Chat: <code>${chatId}</code>\n👤 Bạn: <code>${message.from?.id}</code>${rep ? `\n↩️ ${escapeHtml(userName(rep))}: <code>${rep.id}</code>` : ""}`);
    return true;
  }
  if (cmd === "help") {
    const topic = args.trim().toLowerCase();
    await say(HELP[topic] || HELP._);
    return true;
  }
  if (!isGroup) { await say("ℹ️ Lệnh này chỉ dùng trong nhóm."); return true; }

  const cfg = await getChatCfg(env, chatId);
  if (ROSE_ADMIN.has(cmd) && !(await senderIsAdmin(env, tg, message))) {
    await say("🔒 Chỉ admin nhóm mới dùng được lệnh này.");
    return true;
  }
  if (ROSE_PUBLIC.has(cmd) && cfg.disabled.includes(cmd) && !(await senderIsAdmin(env, tg, message))) return true; // lệnh đã bị tắt

  const audit = (act, target, note) => auditLog(env, chatId, message.from, act, target, note);
  const save = async () => { if (!(await saveChatCfg(env, chatId, cfg))) await say("❌ Không lưu được cấu hình (KV lỗi hoặc hết hạn mức)."); else { await audit(`cấu hình /${cmd0}`, null, args.trim().slice(0, 50)); return true; } };
  const replyText = () => message.reply_to_message?.text || message.reply_to_message?.caption || "";
  const needConfirm = async () => { if (args.trim().toLowerCase() !== "confirm") { await say(`⚠️ Thao tác này xoá toàn bộ. Gõ <code>/${cmd0} confirm</code> để xác nhận.`); return false; } return true; };
  const onoff = () => { const a = args.trim().toLowerCase(); return a === "on" || a === "yes" || a === "bật" ? true : a === "off" || a === "no" || a === "tắt" ? false : null; };

  switch (cmd) {
    case "ban": case "unban": case "kick": case "mute": case "unmute": case "tban": case "tmute": case "warn": case "unwarn": case "resetwarns": {
      const t = resolveTarget(message, args);
      if (!t) { await say("❗ Reply tin nhắn của người đó hoặc gõ ID số. Ví dụ: <code>/ban</code> (reply)."); break; }
      const u = t.user;
      if (u.id === (await getBotId(tg))) { await say("😅 Mình không tự xử lý chính mình."); break; }
      if (["ban", "kick", "mute", "tban", "tmute", "warn"].includes(cmd) && (await isChatAdmin(env, tg, chatId, u.id))) { await say("🛡 Không thể xử lý admin."); break; }
      const reason = cmd === "tban" || cmd === "tmute" ? t.tokens.slice(1).join(" ") : t.rest;
      const why = reason ? `\n📝 Lý do: ${escapeHtml(reason)}` : "";
      const m = mentionHtml(u);
      const out = flag === "s" ? async () => {} : say;
      const finish = async () => {
        await audit(`/${cmd0}`, u, reason);
        if (flag === "d" && message.reply_to_message) await tg.call("deleteMessage", { chat_id: chatId, message_id: message.reply_to_message.message_id });
        if (flag === "s") await tg.call("deleteMessage", { chat_id: chatId, message_id: mid });
      };

      if (cmd === "ban") { const d = await tg.call("banChatMember", { chat_id: chatId, user_id: u.id }); if (d.ok) { await finish(); await out(`🔨 ${m} đã bị cấm.${why}`); } else await fail(d); }
      else if (cmd === "unban") { const d = await tg.call("unbanChatMember", { chat_id: chatId, user_id: u.id, only_if_banned: true }); if (d.ok) { await audit("/unban", u); await say(`✅ Đã gỡ cấm ${m}.`); } else await fail(d); }
      else if (cmd === "kick") { const d = await applyPunish(tg, chatId, u.id, "kick"); if (d.ok) { await finish(); await out(`👢 ${m} đã bị đuổi khỏi nhóm.${why}`); } else await fail(d); }
      else if (cmd === "mute") { const d = await applyPunish(tg, chatId, u.id, "mute"); if (d.ok) { await finish(); await out(`🔇 ${m} đã bị tắt tiếng.${why}`); } else await fail(d); }
      else if (cmd === "unmute") { const d = await tg.call("restrictChatMember", { chat_id: chatId, user_id: u.id, permissions: UNMUTE_PERMS }); if (d.ok) { await audit("/unmute", u); await say(`🔊 ${m} đã được mở tiếng.`); } else await fail(d); }
      else if (cmd === "tban" || cmd === "tmute") {
        const secs = parseDuration(t.tokens[0]);
        if (!secs) { await say(`❗ Cần thời gian, ví dụ: <code>/${cmd} 1h</code> (s, m, h, d, w).`); break; }
        const d = await applyPunish(tg, chatId, u.id, cmd, secs);
        if (d.ok) await audit(`/${cmd}`, u, `${t.tokens[0]} ${reason}`);
        await (d.ok ? say(`${cmd === "tban" ? "⏳🔨" : "⏳🔇"} ${m} bị ${cmd === "tban" ? "cấm" : "tắt tiếng"} ${escapeHtml(t.tokens[0])}.${why}`) : fail(d));
      } else if (cmd === "resetwarns") {
        try { await env.USERS_KV.delete(`warn:${chatId}:${u.id}`); } catch (e) {}
        await audit("/resetwarns", u);
        await say(`♻️ Đã xoá cảnh cáo của ${m}.`);
      } else if (cmd === "unwarn") {
        const key = `warn:${chatId}:${u.id}`;
        let w = { n: 0, r: [] };
        try { const raw = await env.USERS_KV.get(key); if (raw) w = JSON.parse(raw); } catch (e) {}
        if (w.n > 0) { w.n--; w.r.pop(); try { await env.USERS_KV.put(key, JSON.stringify(w)); } catch (e) {} }
        await audit("/unwarn", u);
        await say(`✅ Đã gỡ 1 cảnh cáo của ${m} (còn ${w.n}/${cfg.warnlimit}).`);
      } else {
        const r = await addWarn(env, tg, chatId, u, reason, cfg);
        if (r.ok) { await finish(); await out(r.text); } else await fail(r.err);
      }
      break;
    }
    case "resetallwarns": {
      if (!(await needConfirm())) break;
      let n = 0;
      try {
        let cursor;
        do {
          const res = await env.USERS_KV.list({ prefix: `warn:${chatId}:`, cursor });
          for (const k of res.keys) { await env.USERS_KV.delete(k.name); n++; }
          cursor = res.list_complete ? undefined : res.cursor;
        } while (cursor);
      } catch (e) { await say(`❌ Lỗi KV: ${escapeHtml(e.message)}`); break; }
      await say(`♻️ Đã xoá cảnh cáo của ${n} thành viên.`);
      break;
    }
    case "warns": {
      const u = message.reply_to_message?.from || message.from;
      let w = { n: 0, r: [] };
      try { const raw = await env.USERS_KV.get(`warn:${chatId}:${u.id}`); if (raw) w = JSON.parse(raw); } catch (e) {}
      await say(`📋 ${mentionHtml(u)} có ${w.n}/${cfg.warnlimit} cảnh cáo.${w.r.length ? "\n" + w.r.map((x, i) => `${i + 1}. ${escapeHtml(x)}`).join("\n") : ""}`);
      break;
    }
    case "warnings": {
      await say(`⚙️ <b>Cảnh cáo</b>\n• Giới hạn: ${cfg.warnlimit}\n• Khi đủ: ${MODE_TEXT[cfg.warnmode]}${cfg.warnmode.startsWith("t") ? ` (${cfg.warntime}s)` : ""}`);
      break;
    }
    case "warnlimit": {
      const n = Number(args.trim());
      if (!Number.isInteger(n) || n < 1 || n > 20) { await say(`⚙️ Giới hạn hiện tại: ${cfg.warnlimit}. Đổi: <code>/warnlimit 3</code> (1-20)`); break; }
      cfg.warnlimit = n; if (await save()) await say(`✅ Giới hạn cảnh cáo: ${n}`);
      break;
    }
    case "warnmode": {
      const [mode, time] = args.trim().toLowerCase().split(/\s+/);
      if (!["ban", "kick", "mute", "tban", "tmute"].includes(mode)) { await say("❗ Dùng: <code>/warnmode ban|kick|mute|tban 1h|tmute 1h</code>"); break; }
      cfg.warnmode = mode;
      if (mode.startsWith("t")) { const s = parseDuration(time); if (!s) { await say("❗ Cần thời gian, ví dụ: <code>/warnmode tmute 1h</code>"); break; } cfg.warntime = s; }
      if (await save()) await say(`✅ Khi đủ cảnh cáo sẽ: ${MODE_TEXT[mode]}`);
      break;
    }
    case "warntime": {
      const s = parseDuration(args.trim());
      if (!s) { await say("❗ Dùng: <code>/warntime 1h</code>"); break; }
      cfg.warntime = s; if (await save()) await say("✅ Đã đặt thời gian xử lý khi đủ cảnh cáo.");
      break;
    }
    case "kickme": {
      if (await isChatAdmin(env, tg, chatId, message.from.id)) { await say("🛡 Admin không thể tự đuổi mình."); break; }
      const d = await applyPunish(tg, chatId, message.from.id, "kick");
      await (d.ok ? say("👢 Tạm biệt!") : fail(d));
      break;
    }
    case "del": {
      const rep = message.reply_to_message;
      if (!rep) { await say("❗ Reply tin nhắn cần xoá."); break; }
      const d = await tg.call("deleteMessage", { chat_id: chatId, message_id: rep.message_id });
      if (!d.ok) { await fail(d); break; }
      await tg.call("deleteMessage", { chat_id: chatId, message_id: mid });
      break;
    }
    case "purge": {
      const rep = message.reply_to_message;
      if (!rep) { await say("❗ Reply tin nhắn đầu tiên cần xoá, bot xoá từ đó tới lệnh này."); break; }
      const from = Math.max(rep.message_id, mid - 99);
      const ids = []; for (let i = from; i <= mid; i++) ids.push(i);
      const d = await tg.call("deleteMessages", { chat_id: chatId, message_ids: ids });
      if (!d.ok) await fail(d);
      break;
    }
    case "pin": {
      const rep = message.reply_to_message;
      if (!rep) { await say("❗ Reply tin nhắn cần ghim."); break; }
      const d = await tg.call("pinChatMessage", { chat_id: chatId, message_id: rep.message_id, disable_notification: !/loud|notify|violent/i.test(args) });
      if (!d.ok) await fail(d); else await say("📌 Đã ghim.");
      break;
    }
    case "permapin": {
      const text = (args.trim() || replyText());
      if (!text) { await say("❗ Dùng: <code>/permapin nội dung</code>"); break; }
      const r = renderRich(text);
      const d = await tg.call("sendMessage", { chat_id: chatId, text: r.html, parse_mode: "HTML", ...(r.markup ? { reply_markup: r.markup } : {}) });
      if (!d.ok) { await fail(d); break; }
      const p = await tg.call("pinChatMessage", { chat_id: chatId, message_id: d.result.message_id, disable_notification: true });
      if (!p.ok) await fail(p);
      break;
    }
    case "unpin": {
      const rep = message.reply_to_message;
      const d = await tg.call("unpinChatMessage", { chat_id: chatId, ...(rep ? { message_id: rep.message_id } : {}) });
      if (!d.ok) await fail(d); else await say("📍 Đã bỏ ghim.");
      break;
    }
    case "unpinall": {
      const d = await tg.call("unpinAllChatMessages", { chat_id: chatId });
      if (!d.ok) await fail(d); else await say("📍 Đã bỏ ghim tất cả.");
      break;
    }
    case "pinned": {
      const d = await tg.call("getChat", { chat_id: chatId });
      const pm = d.ok ? d.result.pinned_message : null;
      if (!pm) { await say("Nhóm chưa có tin ghim."); break; }
      const link = chat.username ? `https://t.me/${chat.username}/${pm.message_id}` : String(chatId).startsWith("-100") ? `https://t.me/c/${String(chatId).slice(4)}/${pm.message_id}` : null;
      await say(link ? `📌 <a href="${link}">Tin được ghim</a>` : "📌 Có tin ghim nhưng nhóm này không có liên kết công khai.");
      break;
    }
    case "promote": case "demote": {
      const t = resolveTarget(message, args);
      if (!t) { await say("❗ Reply tin nhắn của người đó hoặc gõ ID."); break; }
      const on = cmd === "promote";
      const d = await tg.call("promoteChatMember", {
        chat_id: chatId, user_id: t.user.id, can_manage_chat: on, can_delete_messages: on, can_restrict_members: on,
        can_pin_messages: on, can_invite_users: on, can_manage_video_chats: on,
      });
      await (d.ok ? say(`${on ? "⭐ Đã thăng" : "⬇️ Đã hạ"} ${mentionHtml(t.user)}${on ? " lên admin." : " xuống thành viên."}`) : fail(d));
      break;
    }
    case "title": {
      const rep = message.reply_to_message?.from;
      const title = args.trim().slice(0, 16);
      if (!rep || !title) { await say("❗ Reply admin (do bot thăng) và gõ <code>/title chức danh</code> (tối đa 16 ký tự)."); break; }
      const d = await tg.call("setChatAdministratorCustomTitle", { chat_id: chatId, user_id: rep.id, custom_title: title });
      await (d.ok ? say(`🏷 Đã đặt chức danh: ${escapeHtml(title)}`) : fail(d));
      break;
    }
    case "admins": {
      const d = await tg.call("getChatAdministrators", { chat_id: chatId });
      if (!d.ok) { await fail(d); break; }
      await say("👮 <b>Admin nhóm</b>\n" + d.result.filter((a) => !a.user.is_bot).map((a) => `• ${escapeHtml(userName(a.user))}${a.status === "creator" ? " 👑" : ""}${a.custom_title ? ` (${escapeHtml(a.custom_title)})` : ""}`).join("\n"));
      break;
    }
    case "welcome": case "goodbye": {
      const g = cfg[cmd];
      const v = onoff();
      const label = cmd === "welcome" ? "Chào mừng" : "Tạm biệt";
      if (v !== null) { g.on = v; if (await save()) await say(`✅ ${label}: ${g.on ? "BẬT" : "TẮT"}`); break; }
      await say(`ℹ️ ${label}: ${g.on ? "BẬT" : "TẮT"} · xoá tin cũ: ${g.clean ? "có" : "không"}\nNội dung: ${escapeHtml(g.text)}\nDùng <code>/${cmd} on|off</code>`);
      break;
    }
    case "setwelcome": case "setgoodbye": {
      const text = (args.trim() || replyText()).slice(0, 1500);
      if (!text) { await say(`❗ Dùng: <code>/${cmd} nội dung</code> (xem /help greetings)`); break; }
      const g = cfg[cmd === "setwelcome" ? "welcome" : "goodbye"];
      g.text = text; g.on = true;
      if (await save()) await say("✅ Đã lưu và bật.");
      break;
    }
    case "resetwelcome": { cfg.welcome = { ...DEFAULT_CFG().welcome, on: cfg.welcome.on }; if (await save()) await say("♻️ Đã đặt lại lời chào mặc định."); break; }
    case "cleanwelcome": {
      const v = onoff(); if (v === null) { await say("❗ Dùng: <code>/cleanwelcome on|off</code>"); break; }
      cfg.welcome.clean = v; if (await save()) await say(`✅ Xoá lời chào cũ khi có người mới: ${v ? "BẬT" : "TẮT"}`);
      break;
    }
    case "cleanservice": {
      const v = onoff(); if (v === null) { await say("❗ Dùng: <code>/cleanservice on|off</code>"); break; }
      cfg.cleanservice = v; if (await save()) await say(`✅ Xoá thông báo vào/rời nhóm: ${v ? "BẬT" : "TẮT"}`);
      break;
    }
    case "captcha": {
      const v = onoff();
      if (v === null) { await say(`ℹ️ Captcha: ${cfg.captcha.on ? "BẬT" : "TẮT"} (hạn ${Math.round(cfg.captcha.time / 60)} phút). Dùng <code>/captcha on|off</code>`); break; }
      cfg.captcha.on = v; if (await save()) await say(`✅ Captcha: ${v ? "BẬT" : "TẮT"}${v ? "\nBot cần quyền hạn chế thành viên." : ""}`);
      break;
    }
    case "captchatime": {
      const s = parseDuration(args.trim());
      if (!s || s < 60) { await say("❗ Dùng: <code>/captchatime 5m</code> (tối thiểu 1m)"); break; }
      cfg.captcha.time = s; if (await save()) await say("✅ Đã đặt thời hạn xác minh.");
      break;
    }
    case "setrules": {
      const text = (args.trim() || replyText()).slice(0, 3000);
      if (!text) { await say("❗ Dùng: <code>/setrules nội dung</code>"); break; }
      cfg.rules = text; if (await save()) await say("✅ Đã lưu luật nhóm.");
      break;
    }
    case "clearrules": { cfg.rules = ""; if (await save()) await say("🗑 Đã xoá luật."); break; }
    case "rules": {
      if (!cfg.rules) { await say("Nhóm chưa có luật. Admin dùng /setrules."); break; }
      await sayRichTo(tg, chatId, mid, "*Luật nhóm*\n" + cfg.rules, null, chat);
      break;
    }
    case "save": {
      const { first, rest } = splitFirst(args);
      const name = first.toLowerCase();
      const text = (rest || replyText()).slice(0, 3000);
      if (!/^[\w-]{1,32}$/.test(name) || !text) { await say("❗ Dùng: <code>/save tên nội dung</code> (hoặc reply + /save tên)"); break; }
      if (!cfg.notes[name] && Object.keys(cfg.notes).length >= 50) { await say("❌ Tối đa 50 ghi chú."); break; }
      cfg.notes[name] = text; if (await save()) await say(`✅ Đã lưu ghi chú <code>${escapeHtml(name)}</code>. Gọi bằng /get ${escapeHtml(name)} hoặc #${escapeHtml(name)}`);
      break;
    }
    case "get": {
      const name = args.trim().split(/\s+/)[0]?.toLowerCase();
      if (!name || !cfg.notes[name]) { await say("❗ Không có ghi chú đó. Xem /notes"); break; }
      await sayRichTo(tg, chatId, mid, cfg.notes[name], message.from, chat);
      break;
    }
    case "notes": { const n = Object.keys(cfg.notes); await say(n.length ? "🗒 <b>Ghi chú</b>\n" + n.map((x) => `• #${escapeHtml(x)}`).join("\n") : "Chưa có ghi chú. Dùng /save."); break; }
    case "clear": {
      const name = args.trim().split(/\s+/)[0]?.toLowerCase();
      if (!name || !cfg.notes[name]) { await say("❗ Không có ghi chú đó."); break; }
      delete cfg.notes[name]; if (await save()) await say("🗑 Đã xoá ghi chú.");
      break;
    }
    case "clearall": { if (!(await needConfirm())) break; cfg.notes = {}; if (await save()) await say("🗑 Đã xoá toàn bộ ghi chú."); break; }
    case "filter": {
      const { first, rest } = splitFirst(args);
      const kw = first.toLowerCase();
      const text = (rest || replyText()).slice(0, 2000);
      if (!kw || !text) { await say("❗ Dùng: <code>/filter từ_khoá nội dung trả lời</code> hoặc <code>/filter \"nhiều từ\" nội dung</code>"); break; }
      if (!cfg.filters[kw] && Object.keys(cfg.filters).length >= 50) { await say("❌ Tối đa 50 bộ lọc."); break; }
      cfg.filters[kw] = text; if (await save()) await say(`✅ Khi có "${escapeHtml(kw)}" bot sẽ trả lời.`);
      break;
    }
    case "filters": { const f = Object.keys(cfg.filters); await say(f.length ? "🔎 <b>Bộ lọc</b>\n" + f.map((x) => `• ${escapeHtml(x)}`).join("\n") : "Chưa có bộ lọc."); break; }
    case "stop": {
      const kw = splitFirst(args).first.toLowerCase();
      if (!kw || !cfg.filters[kw]) { await say("❗ Không có bộ lọc đó."); break; }
      delete cfg.filters[kw]; if (await save()) await say("🗑 Đã xoá bộ lọc.");
      break;
    }
    case "stopall": { if (!(await needConfirm())) break; cfg.filters = {}; if (await save()) await say("🗑 Đã xoá toàn bộ bộ lọc."); break; }
    case "addblocklist": {
      const words = parseQuoted(args.toLowerCase());
      if (!words.length) { await say("❗ Dùng: <code>/addblocklist từ1 \"cụm từ\"</code>"); break; }
      cfg.blacklist = [...new Set([...cfg.blacklist, ...words])].slice(0, 100);
      if (await save()) await say(`✅ Đã thêm ${words.length} từ cấm. Tin chứa từ này (của người không phải admin/được duyệt) sẽ bị xoá.`);
      break;
    }
    case "rmblocklist": {
      const words = parseQuoted(args.toLowerCase());
      cfg.blacklist = cfg.blacklist.filter((w) => !words.includes(w));
      if (await save()) await say("✅ Đã cập nhật danh sách từ cấm.");
      break;
    }
    case "unblocklistall": { if (!(await needConfirm())) break; cfg.blacklist = []; if (await save()) await say("🗑 Đã xoá toàn bộ từ cấm."); break; }
    case "blocklist": { await say((cfg.blacklist.length ? "🚫 <b>Từ cấm</b>\n" + cfg.blacklist.map((x) => escapeHtml(x)).join(", ") : "Chưa có từ cấm.") + `\nChế độ: ${cfg.blmode}`); break; }
    case "blocklistmode": {
      const [mode, time] = args.trim().toLowerCase().split(/\s+/);
      if (!["delete", "nothing", "warn", "mute", "kick", "ban", "tmute", "tban"].includes(mode)) { await say("❗ Dùng: <code>/blocklistmode delete|warn|mute|kick|ban|tmute 1h|tban 1h</code>"); break; }
      cfg.blmode = mode === "nothing" ? "delete" : mode;
      if (mode.startsWith("t")) { const s = parseDuration(time); if (!s) { await say("❗ Cần thời gian, ví dụ: <code>/blocklistmode tmute 1h</code>"); break; } cfg.bltime = s; }
      if (await save()) await say(`✅ Khi vi phạm từ cấm: xoá tin${cfg.blmode === "delete" ? "" : " và " + (cfg.blmode === "warn" ? "cảnh cáo" : MODE_TEXT[cfg.blmode])}.`);
      break;
    }
    case "flood": {
      await say(cfg.flood ? `🌊 Chống spam: ${cfg.flood} tin / ${cfg.floodwindow}s → ${MODE_TEXT[cfg.floodmode]}${cfg.floodmode.startsWith("t") ? ` (${cfg.floodtime}s)` : ""}` : "🌊 Chống spam đang tắt. Dùng /setflood 5");
      break;
    }
    case "setflood": {
      const n = Number(args.trim());
      if (!Number.isInteger(n) || n < 0 || n > 30) { await say("❗ Dùng: <code>/setflood 5</code> (0 = tắt)"); break; }
      cfg.flood = n; if (await save()) await say(n ? `🌊 Chống spam: tối đa ${n} tin / ${cfg.floodwindow} giây.` : "🌊 Đã tắt chống spam.");
      break;
    }
    case "setfloodtimer": {
      const [n, s] = args.trim().split(/\s+/).map(Number);
      if (!Number.isInteger(n) || n < 2 || n > 30 || !Number.isInteger(s) || s < 3 || s > 120) { await say("❗ Dùng: <code>/setfloodtimer 5 10</code> (5 tin trong 10 giây)"); break; }
      cfg.flood = n; cfg.floodwindow = s; if (await save()) await say(`🌊 Chống spam: ${n} tin / ${s} giây.`);
      break;
    }
    case "setfloodmode": {
      const [mode, time] = args.trim().toLowerCase().split(/\s+/);
      if (!["mute", "kick", "ban", "tmute", "tban"].includes(mode)) { await say("❗ Dùng: <code>/setfloodmode mute|kick|ban|tmute 10m|tban 1h</code>"); break; }
      cfg.floodmode = mode;
      if (mode.startsWith("t")) { const s = parseDuration(time); if (!s) { await say("❗ Cần thời gian, ví dụ: <code>/setfloodmode tmute 10m</code>"); break; } cfg.floodtime = s; }
      if (await save()) await say(`✅ Khi spam sẽ: ${MODE_TEXT[mode]}`);
      break;
    }
    case "lock": case "unlock": {
      const type = args.trim().toLowerCase();
      if (!LOCK_TYPES.includes(type)) { await say(`❗ Dùng: <code>/${cmd} loại</code>. Xem /locktypes`); break; }
      cfg.locks[type] = cmd === "lock"; if (await save()) await say(`${cmd === "lock" ? "🔒" : "🔓"} ${type}: ${cmd === "lock" ? "đã khoá" : "đã mở"}`);
      break;
    }
    case "locks": { await say("🔐 <b>Khoá</b>\n" + LOCK_TYPES.map((k) => `• ${k}: ${cfg.locks[k] ? "🔒" : "🔓"}`).join("\n")); break; }
    case "locktypes": { await say("🔐 Loại khoá: " + LOCK_TYPES.join(", ")); break; }
    case "approve": case "unapprove": {
      const t = resolveTarget(message, args);
      if (!t) { await say("❗ Reply tin nhắn của người đó hoặc gõ ID."); break; }
      if (cmd === "approve") cfg.approved[t.user.id] = userName(t.user).slice(0, 40); else delete cfg.approved[t.user.id];
      if (await save()) await say(`${cmd === "approve" ? "✅ Đã duyệt" : "🗑 Đã bỏ duyệt"} ${mentionHtml(t.user)}.`);
      break;
    }
    case "approval": {
      const u = message.reply_to_message?.from || message.from;
      await say(`${mentionHtml(u)} ${cfg.approved[u.id] ? "đã được duyệt ✅" : "chưa được duyệt"}.`);
      break;
    }
    case "approved": { const a = Object.entries(cfg.approved); await say(a.length ? "✅ <b>Đã duyệt</b>\n" + a.map(([id, n]) => `• ${escapeHtml(n)} (<code>${id}</code>)`).join("\n") : "Chưa duyệt ai."); break; }
    case "unapproveall": { if (!(await needConfirm())) break; cfg.approved = {}; if (await save()) await say("🗑 Đã bỏ duyệt tất cả."); break; }
    case "disable": case "enable": {
      const name = args.trim().toLowerCase().replace(/^\//, "");
      const target = ROSE_ALIAS[name] || name;
      if (!ROSE_PUBLIC.has(target) || ["id", "help", "report"].includes(target)) { await say("❗ Chỉ tắt được các lệnh công khai (rules, get, notes, filters, warns, admins, locks, kickme, ...)."); break; }
      cfg.disabled = cmd === "disable" ? [...new Set([...cfg.disabled, target])] : cfg.disabled.filter((x) => x !== target);
      if (await save()) await say(`${cmd === "disable" ? "🚫 Đã tắt" : "✅ Đã bật"} lệnh /${escapeHtml(target)} cho thành viên.`);
      break;
    }
    case "disabled": { await say(cfg.disabled.length ? "🚫 Lệnh đang tắt: " + cfg.disabled.map((x) => "/" + x).join(" ") : "Chưa tắt lệnh nào."); break; }
    case "reports": {
      const v = onoff(); if (v === null) { await say(`ℹ️ Báo cáo: ${cfg.reports ? "BẬT" : "TẮT"}. Dùng <code>/reports on|off</code>`); break; }
      cfg.reports = v; if (await save()) await say(`✅ Báo cáo: ${v ? "BẬT" : "TẮT"}`);
      break;
    }
    case "audit": {
      let arr = [];
      try { const raw = await env.USERS_KV.get(`audit:${chatId}`); if (raw) arr = JSON.parse(raw); } catch (e) {}
      if (!arr.length) { await say("Chưa có thao tác admin nào được ghi."); break; }
      await say("🧾 <b>Nhật ký admin (10 gần nhất)</b>\n" + arr.slice(-10).reverse().map((x) =>
        `• ${new Date(x.t).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour12: false })} — ${escapeHtml(x.bn)}: ${escapeHtml(x.act)}${x.to ? " → " + escapeHtml(x.to) : ""}${x.note ? " (" + escapeHtml(x.note) + ")" : ""}`).join("\n"));
      break;
    }
    case "report": { await doReport(env, tg, message, cfg); break; }
  }
  return true;
}

// ----- Captcha: bấm nút để được nói chuyện -----

async function handleCallback(env, cb) {
  try {
    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    const data = cb.data || "";
    const chat = cb.message?.chat;
    if (!data.startsWith("cap:") || !chat) return;
    const uid = Number(data.slice(4));
    if (cb.from.id !== uid) {
      await tg.call("answerCallbackQuery", { callback_query_id: cb.id, text: "Nút này không dành cho bạn." });
      return;
    }
    await tg.call("restrictChatMember", { chat_id: chat.id, user_id: uid, permissions: UNMUTE_PERMS });
    try { await env.USERS_KV.delete(`captcha:${chat.id}:${uid}`); } catch (e) {}
    await tg.call("deleteMessage", { chat_id: chat.id, message_id: cb.message.message_id });
    await tg.call("answerCallbackQuery", { callback_query_id: cb.id, text: "✅ Đã xác minh, chào mừng bạn!" });
    const cfg = await getChatCfg(env, chat.id);
    if (cfg.welcome.on) await sendWelcome(env, tg, cfg, chat, cb.from);
  } catch (e) {
    console.log(`✗ [callback] ${e.stack || e.message}`);
  }
}

async function sendWelcome(env, tg, cfg, chat, user) {
  if (cfg.welcome.clean && cfg.lastwelcome) await tg.call("deleteMessage", { chat_id: chat.id, message_id: cfg.lastwelcome });
  const r = renderRich(cfg.welcome.text, user, chat);
  const d = await tg.call("sendMessage", { chat_id: chat.id, text: r.html || "\u200b", parse_mode: "HTML", disable_web_page_preview: true, ...(r.markup ? { reply_markup: r.markup } : {}) });
  if (cfg.welcome.clean && d.ok) { cfg.lastwelcome = d.result.message_id; await saveChatCfg(env, chat.id, cfg); }
}

async function processCaptchaExpiry(env, tg) {
  let res;
  try { res = await env.USERS_KV.list({ prefix: "captcha:" }); } catch (e) { console.log(`⚠️ [captcha] list lỗi: ${e.message}`); return; }
  for (const k of res.keys) {
    try {
      const v = JSON.parse((await env.USERS_KV.get(k.name)) || "null");
      if (!v || v.exp > Date.now()) continue;
      const [, chatId, userId] = k.name.split(":");
      await applyPunish(tg, Number(chatId), Number(userId), "kick");
      if (v.mid) await tg.call("deleteMessage", { chat_id: Number(chatId), message_id: v.mid });
      await env.USERS_KV.delete(k.name);
    } catch (e) { console.log(`⚠️ [captcha] ${e.message}`); }
  }
}

// ----- Xử lý tin nhắn thường trong nhóm. Trả về true nếu đã xử lý (không chuyển cho AI nữa) -----

function lockViolation(cfg, message, ents, text) {
  const L = cfg.locks;
  if (L.all) return "lock all";
  if (L.url && ents.some((e) => e.type === "url" || e.type === "text_link")) return "lock url";
  if (L.invitelink && /(t\.me\/\+|t\.me\/joinchat|telegram\.me\/joinchat)/i.test(text)) return "lock invitelink";
  if (L.email && /[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) return "lock email";
  if (L.forward && (message.forward_origin || message.forward_date)) return "lock forward";
  if (L.sticker && message.sticker) return "lock sticker";
  if (L.photo && message.photo) return "lock photo";
  if (L.video && message.video) return "lock video";
  if (L.audio && message.audio) return "lock audio";
  if (L.voice && message.voice) return "lock voice";
  if (L.document && message.document && !message.animation) return "lock document";
  if (L.gif && message.animation) return "lock gif";
  if (L.videonote && message.video_note) return "lock videonote";
  if (L.contact && message.contact) return "lock contact";
  if (L.location && (message.location || message.venue)) return "lock location";
  if (L.poll && message.poll) return "lock poll";
  if (L.game && message.game) return "lock game";
  if (L.media && (message.photo || message.video || message.document || message.animation || message.video_note || message.voice || message.audio)) return "lock media";
  return null;
}

async function processGroupModeration(env, tg, message) {
  const chat = message.chat;
  const chatId = chat.id;

  if (message.new_chat_members?.length) {
    const cfg = await getChatCfg(env, chatId);
    const botId = await getBotId(tg);
    if (cfg.cleanservice) await tg.call("deleteMessage", { chat_id: chatId, message_id: message.message_id });
    const adderIsAdmin = message.from ? await isChatAdmin(env, tg, chatId, message.from.id) : false;
    for (const m of message.new_chat_members) {
      if (m.id === botId) {
        await tg.sendMessage(chatId, "👋 Cảm ơn đã thêm mình! Hãy cấp quyền admin cho mình, rồi gõ /help để xem các lệnh quản lý nhóm.");
      } else if (m.is_bot) {
        if (cfg.locks.bot && !adderIsAdmin) await applyPunish(tg, chatId, m.id, "ban");
      } else if (cfg.captcha.on && !cfg.approved[m.id] && !(await isChatAdmin(env, tg, chatId, m.id))) {
        const d = await tg.call("restrictChatMember", { chat_id: chatId, user_id: m.id, permissions: MUTE_PERMS });
        if (!d.ok) { if (cfg.welcome.on) await sendWelcome(env, tg, cfg, chat, m); continue; }
        const mins = Math.round(cfg.captcha.time / 60);
        const sent = await tg.call("sendMessage", {
          chat_id: chatId, parse_mode: "HTML",
          text: `👋 Xin chào ${mentionHtml(m)}! Bấm nút bên dưới trong ${mins} phút để chứng minh bạn không phải robot.`,
          reply_markup: { inline_keyboard: [[{ text: "✅ Tôi không phải robot", callback_data: `cap:${m.id}` }]] },
        });
        try { await env.USERS_KV.put(`captcha:${chatId}:${m.id}`, JSON.stringify({ exp: Date.now() + cfg.captcha.time * 1000, mid: sent.result?.message_id })); } catch (e) {}
      } else if (cfg.welcome.on) {
        await sendWelcome(env, tg, cfg, chat, m);
      }
    }
    return true;
  }
  if (message.left_chat_member) {
    const cfg = await getChatCfg(env, chatId);
    const m = message.left_chat_member;
    if (cfg.cleanservice) await tg.call("deleteMessage", { chat_id: chatId, message_id: message.message_id });
    if (cfg.goodbye.on && !m.is_bot) {
      const r = renderRich(cfg.goodbye.text, m, chat);
      await tg.sendMessage(chatId, r.html || "\u200b", { parse_mode: "HTML", ...(r.markup ? { reply_markup: r.markup } : {}) });
    }
    return true;
  }
  if (!message.from) return false;

  const cfg = await getChatCfg(env, chatId);
  const text = message.text || message.caption || "";
  const lower = text.toLowerCase();
  const ents = [...(message.entities || []), ...(message.caption_entities || [])];

  if (cfg.reports !== false && /(^|\s)@admins?\b/i.test(text) && message.reply_to_message) {
    await doReport(env, tg, message, cfg);
    return true;
  }

  let violation = null;
  let blocklisted = false;
  if (cfg.blacklist.length && cfg.blacklist.some((w) => lower.includes(w))) { violation = "blocklist"; blocklisted = true; }
  else violation = lockViolation(cfg, message, ents, text);

  const floodKey = `${chatId}:${message.from.id}`;
  let flooded = false;
  if (cfg.flood > 0) {
    const now = Date.now();
    const win = (cfg.floodwindow || 10) * 1000;
    const arr = (floodMap.get(floodKey) || []).filter((t) => now - t < win);
    arr.push(now);
    floodMap.set(floodKey, arr);
    if (floodMap.size > 5000) floodMap.clear();
    flooded = arr.length > cfg.flood;
  }

  if (violation || flooded) {
    const exempt = cfg.approved[message.from.id] || (await senderIsAdmin(env, tg, message));
    if (!exempt) {
      if (violation) {
        await tg.call("deleteMessage", { chat_id: chatId, message_id: message.message_id });
        if (blocklisted && cfg.blmode !== "delete") {
          if (cfg.blmode === "warn") {
            const r = await addWarn(env, tg, chatId, message.from, "dùng từ cấm", cfg);
            if (r.ok) await tg.sendMessage(chatId, r.text, { parse_mode: "HTML" });
          } else {
            const d = await applyPunish(tg, chatId, message.from.id, cfg.blmode, cfg.bltime);
            if (d.ok) await tg.sendMessage(chatId, `🚫 ${mentionHtml(message.from)} dùng từ cấm và bị ${MODE_TEXT[cfg.blmode]}.`, { parse_mode: "HTML" });
          }
        }
        return true;
      }
      floodMap.delete(floodKey);
      const d = await applyPunish(tg, chatId, message.from.id, cfg.floodmode, cfg.floodtime);
      if (d.ok) await tg.sendMessage(chatId, `🌊 ${mentionHtml(message.from)} gửi quá nhanh nên bị ${MODE_TEXT[cfg.floodmode]}.`, { parse_mode: "HTML" });
      return true;
    }
  }

  const nm = /^#([\w-]{1,32})\b/.exec(text);
  if (nm && cfg.notes[nm[1].toLowerCase()] && !cfg.disabled.includes("get")) {
    await sayRichTo(tg, chatId, message.message_id, cfg.notes[nm[1].toLowerCase()], message.from, chat);
    return true;
  }
  if (text && Object.keys(cfg.filters).length) {
    for (const [kw, reply] of Object.entries(cfg.filters)) {
      if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(kw)}($|[^\\p{L}\\p{N}])`, "iu").test(text)) {
        await sayRichTo(tg, chatId, message.message_id, reply, message.from, chat);
        return true;
      }
    }
  }
  return false;
}

// ---------------- Công cụ: giờ/ngày bằng code, XSMB có kiểm chứng, tìm web (Google Search grounding) ----------------

const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
const pad2 = (n) => String(n).padStart(2, "0");

function vnParts(offsetDays = 0) {
  const d = new Date(Date.now() + 7 * 3600000 + offsetDays * 86400000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
}

function dmy(p) {
  return `${pad2(p.d)}/${pad2(p.m)}/${p.y}`;
}

function sourcesLine(sources) {
  if (!sources || !sources.length) return "";
  return "\n\n🔎 Nguồn:\n" + sources.slice(0, 3).map((s) => `• ${(s.title || s.uri).slice(0, 60)} — ${s.uri}`).join("\n");
}

// ----- 1. Giờ / ngày / thứ: trả lời bằng code, luôn đúng -----

const XSMB_RE = /(xsmb|sxmb|kqxs|xổ số miền bắc|xo so mien bac|kết quả xổ số|xổ số hôm)/i;
const SEARCH_RE = /(tin tức|thời sự|mới nhất|giá vàng|tỷ giá|giá (usd|bitcoin|btc|xăng|dầu|iphone|điện thoại)|thời tiết|dự báo|kết quả (bóng đá|trận)|tỷ số|lịch thi đấu|xsmn|xsmt|xổ số miền (nam|trung)|vietlott|hôm nay (có|xảy ra)|vừa (xảy ra|ra mắt|công bố)|hiện nay|ai là (tổng thống|thủ tướng|chủ tịch)|tra (google|cứu)|tìm trên (web|mạng|google)|search|đại học|cao đẳng|học viện|điểm chuẩn|học phí|tuyển sinh|điểm sàn|địa chỉ (của|trường|công ty)|số điện thoại (của|trường|công ty)|website (của|chính thức))/i;

function answerDateTime(text) {
  const s = text.toLowerCase().trim();
  if (s.length > 100 || XSMB_RE.test(s)) return null;
  const asksTime = /(mấy giờ|giờ (rồi|hiện tại|bây giờ|việt nam)|bây giờ là mấy|what time)/.test(s);
  const dateHint = /((hôm nay|hôm qua|hôm kia|ngày mai|ngày mốt|ngày kia|bữa nay|bây giờ|hiện tại)\s*(là\s*)?(ngày|thứ)|(ngày|thứ)\s*(mấy|bao nhiêu|nào)|ngày giờ|ngày tháng|today'?s date)/.test(s);
  const questionish = /(mấy|bao nhiêu|nào|gì|\?|ngày giờ|ngày tháng|cho (mình|tôi|em|anh) (biết|hỏi))/.test(s);
  if (!asksTime && !(dateHint && questionish)) return null;

  let offset = 0, label = "Hôm nay";
  if (/hôm qua/.test(s)) { offset = -1; label = "Hôm qua"; }
  else if (/hôm kia/.test(s)) { offset = -2; label = "Hôm kia"; }
  else if (/ngày mai|(^|\s)mai\s/.test(s)) { offset = 1; label = "Ngày mai"; }
  else if (/ngày mốt|ngày kia/.test(s)) { offset = 2; label = "Ngày mốt"; }
  const p = vnParts(offset);
  const dateStr = `${WEEKDAYS[p.wd]}, ngày ${dmy(p)}`;
  if (asksTime && offset === 0) return `🕒 Bây giờ là ${pad2(p.h)}:${pad2(p.mi)}, ${dateStr} (giờ Việt Nam).`;
  return `📅 ${label} là ${dateStr}.`;
}

// ----- 2. XSMB: tra cứu bằng Google Search, ép JSON, kiểm tra cấu trúc 27 giải, bắt buộc có nguồn -----

function partsFromYMD(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { y, m, d, wd: dt.getUTCDay(), valid: dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d };
}

function parseXsmbDate(text) {
  const s = text.toLowerCase();
  const now = vnParts(0);
  if (/hôm kia/.test(s)) return vnParts(-2);
  if (/hôm qua/.test(s)) return vnParts(-1);
  const m = /(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/.exec(s);
  if (m) {
    let y = m[3] ? Number(m[3]) : now.y;
    if (y < 100) y += 2000;
    const p = partsFromYMD(y, Number(m[2]), Number(m[1]));
    if (!p.valid) return { error: "Ngày không hợp lệ." };
    return p;
  }
  if (/hôm nay|bữa nay|tối nay/.test(s)) return now;
  return now.h * 60 + now.mi >= 18 * 60 + 35 ? now : vnParts(-1);
}

const XSMB_SHAPE = [["db", 1, 5], ["g1", 1, 5], ["g2", 2, 5], ["g3", 6, 5], ["g4", 4, 4], ["g5", 6, 4], ["g6", 3, 3], ["g7", 4, 2]];

function validateXsmb(obj, wantDmy) {
  if (!obj || obj.loi) return null;
  if (String(obj.ngay || "").trim().replace(/\b0(\d)\b/g, "$1") !== wantDmy.replace(/\b0(\d)\b/g, "$1")) return null;
  const out = {};
  for (const [key, count, len] of XSMB_SHAPE) {
    let arr = key === "db" ? [obj.db] : obj[key];
    if (!Array.isArray(arr) || arr.length !== count) return null;
    arr = arr.map((x) => (typeof x === "number" ? String(x).padStart(len, "0") : String(x).trim()));
    if (!arr.every((x) => new RegExp(`^\\d{${len}}$`).test(x))) return null;
    out[key] = arr;
  }
  return out;
}

function renderXsmb(d, p, sources) {
  const g = (a) => a.join(" – ");
  return `🎰 XSMB ${dmy(p)} (${WEEKDAYS[p.wd]})\n` +
    `ĐB: ${d.db[0]}\nG1: ${d.g1[0]}\nG2: ${g(d.g2)}\n` +
    `G3: ${g(d.g3.slice(0, 3))}\n      ${g(d.g3.slice(3))}\n` +
    `G4: ${g(d.g4)}\nG5: ${g(d.g5.slice(0, 3))}\n      ${g(d.g5.slice(3))}\n` +
    `G6: ${g(d.g6)}\nG7: ${g(d.g7)}` +
    sourcesLine(sources) + "\n\n⚠️ Hãy đối chiếu với trang nguồn trước khi dùng.";
}

let searchBlockedUntil = 0;
let lastXsmbDm = 0;

async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KyicBot/1.0)", "Accept-Language": "vi,en;q=0.8" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`trang nguồn trả HTTP ${res.status}`);
  const html = await res.text();
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40000);
}

function xsmbJsonSpec(want, wd) {
  return `Trả về DUY NHẤT một JSON, không giải thích, theo mẫu: ` +
    `{"ngay":"dd/mm/yyyy","db":"5 chữ số","g1":["5 chữ số"],"g2":[2 số 5 chữ số],"g3":[6 số 5 chữ số],"g4":[4 số 4 chữ số],"g5":[6 số 4 chữ số],"g6":[3 số 3 chữ số],"g7":[4 số 2 chữ số]}. ` +
    `Giữ nguyên số 0 đầu, viết số dạng chuỗi. Nếu không có bảng đầy đủ của đúng ngày ${want} (${wd}), trả {"loi":"khong_tim_thay"}. Tuyệt đối không suy đoán hay bịa số.`;
}

function parseJsonLoose(out) {
  try {
    const a = out.indexOf("{"), b = out.lastIndexOf("}");
    return JSON.parse(out.slice(a, b + 1));
  } catch (e) { return null; }
}

// Trích số từ văn bản trang, rồi kiểm tra từng số có thật trong văn bản đó
async function extractXsmb(env, pageText, p, want) {
  const prompt = `VĂN BẢN TRANG NGUỒN:\n${pageText}\n---\nChỉ dựa vào văn bản trên, trích kết quả xổ số miền Bắc (XSMB) của đúng ngày ${want} (${WEEKDAYS[p.wd]}). ${xsmbJsonSpec(want, WEEKDAYS[p.wd])}`;
  const { text: out, error } = await tryAllModels(env, "Bạn là công cụ trích xuất dữ liệu từ văn bản. Chỉ trả về JSON hợp lệ.", [{ role: "user", parts: [{ text: prompt }] }], "fast", { temperature: 0.1 });
  if (!out) throw new Error(`Gemini lỗi khi trích dữ liệu: ${error?.message || "không rõ"}`);
  const data = validateXsmb(parseJsonLoose(out), want);
  if (!data) return null;
  const digitsOnly = pageText.replace(/[^\d]+/g, " ");
  const allNums = [...data.db, ...data.g1, ...data.g2, ...data.g3, ...data.g4, ...data.g5, ...data.g6, ...data.g7];
  return allNums.every((n) => digitsOnly.includes(n)) ? data : null; // số không có trong trang => nghi bịa
}

// Cách 1: trang nguồn do bạn cấu hình (XSMB_URL)
async function xsmbFromPage(env, p, want) {
  const url = env.XSMB_URL
    .replace(/\{yyyy\}|\{y\}/g, String(p.y)).replace(/\{dd\}/g, pad2(p.d)).replace(/\{mm\}/g, pad2(p.m))
    .replace(/\{d\}/g, String(p.d)).replace(/\{m\}/g, String(p.m));
  const data = await extractXsmb(env, await fetchPageText(url), p, want);
  return data ? { data, sources: [{ title: new URL(url).hostname, uri: url }] } : null;
}

// Cách 2: Tavily tìm các trang có bảng kết quả (miễn phí), lấy nội dung đầy đủ rồi trích + kiểm tra
async function xsmbFromTavily(env, p, want) {
  const results = await tavilySearch(env, `kết quả xổ số miền Bắc XSMB ngày ${want}`, { raw: true, max: 5 });
  const dateRe = new RegExp(`(^|\\D)0?${p.d}\\s*[/\\-.]\\s*0?${p.m}\\s*[/\\-.]\\s*${p.y}(\\D|$)`);
  let tried = 0;
  for (const r of results) {
    const text = String(r.raw_content || r.content || "").replace(/\s+/g, " ").slice(0, 40000);
    if (!text || !dateRe.test(text)) continue;
    if (++tried > 3) break;
    const data = await extractXsmb(env, text, p, want);
    if (data) return { data, sources: [{ title: r.title || r.url, uri: r.url }] };
  }
  return null;
}

async function xsmbReply(env, text) {
  const p = parseXsmbDate(text);
  if (p.error) return `❌ ${p.error}`;
  const today = vnParts(0);
  const reqMs = Date.UTC(p.y, p.m - 1, p.d);
  const todayMs = Date.UTC(today.y, today.m - 1, today.d);
  if (reqMs > todayMs) return "📅 Ngày đó chưa tới nên chưa có kết quả.";
  if (reqMs === todayMs && today.h * 60 + today.mi < 18 * 60 + 35) {
    return `⏳ XSMB hôm nay (${dmy(p)}) quay lúc 18:15, hiện chưa có kết quả. Bạn có thể hỏi "xsmb hôm qua".`;
  }
  const key = `xsmb:${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  try {
    const raw = await env.USERS_KV.get(key);
    if (raw) { const c = JSON.parse(raw); return renderXsmb(c.data, p, c.sources); }
  } catch (e) {}

  const want = dmy(p);
  const finish = async (data, sources) => {
    try { await env.USERS_KV.put(key, JSON.stringify({ data, sources: sources.slice(0, 3) })); } catch (e) {}
    return renderXsmb(data, p, sources);
  };
  const notes = [];
  const attempt = async (label, fn) => {
    try { const r = await fn(); if (r) return r; notes.push(`[${label}] không có bảng kết quả đầy đủ đúng ngày`); } catch (e) { notes.push(`[${label}] ${e.message}`); }
    return null;
  };

  let r = null;
  if (env.XSMB_URL) r = await attempt("trang nguồn", () => xsmbFromPage(env, p, want));
  if (!r && env.TAVILY_API_KEY) r = await attempt("Tavily", () => xsmbFromTavily(env, p, want));
  if (r) return await finish(r.data, r.sources);

  // Cách 3: Google Search của Gemini (cần hạn mức tìm web của key)
  const prompt = `Dùng Google Search tra cứu kết quả xổ số miền Bắc (XSMB) của đúng ngày ${want} (${WEEKDAYS[p.wd]}). Chỉ lấy từ bảng kết quả đầy đủ trên trang xổ số uy tín. ${xsmbJsonSpec(want, WEEKDAYS[p.wd])}`;
  const { text: out, sources, error } = await tryAllModels(env, "Bạn là công cụ trích xuất dữ liệu. Chỉ trả về JSON hợp lệ.", [{ role: "user", parts: [{ text: prompt }] }], "smart", { search: true, withMeta: true, temperature: 0.1 });
  await bumpStats(env, out ? "ai_ok" : "ai_err", error);
  if (!out) {
    notes.push(`[Google Search] ${error?.message || "không rõ"}`);
    if (env.ADMIN_ID && env.TELEGRAM_BOT_TOKEN && Date.now() - lastXsmbDm > 1800000) {
      lastXsmbDm = Date.now();
      await new TelegramClient(env.TELEGRAM_BOT_TOKEN).sendMessage(env.ADMIN_ID, `⚠️ Lỗi tra cứu XSMB:\n${notes.join("\n")}${env.TAVILY_API_KEY ? "" : "\n💡 Thêm secret TAVILY_API_KEY (miễn phí) để bot tự tìm kết quả."}`.slice(0, 3500));
    }
    return notes.length > 1
      ? `⚠️ Mình chưa lấy được kết quả XSMB ngày ${want} từ nguồn nào đáng tin, nên không đưa số để tránh sai. Bạn xem trực tiếp trên trang xổ số nhé.`
      : `⚠️ Mình chưa tra cứu được XSMB lúc này. Thử lại sau nhé.`;
  }
  const data = validateXsmb(parseJsonLoose(out), want);
  if (!data) return `⚠️ Mình chưa tìm được bảng kết quả XSMB đầy đủ cho ngày ${want}, nên không đưa số để tránh sai. Bạn xem trực tiếp trên trang xổ số nhé.`;
  if (!sources || !sources.length) return `⚠️ Không có nguồn xác thực cho kết quả XSMB ngày ${want}, nên mình không đưa số để tránh sai.`;
  return await finish(data, sources);
}

// ---------------- Tìm web miễn phí bằng Tavily (1.000 lượt/tháng, không cần thẻ) ----------------

async function tavilySearch(env, query, { raw = false, max = 5 } = {}) {
  if (!env.TAVILY_API_KEY) throw new Error("thiếu secret TAVILY_API_KEY");
  const vp = vnParts(0);
  const counterKey = `tavily:${vp.y}-${pad2(vp.m)}`;
  const cap = Number(env.TAVILY_CAP) || 900;
  let used = 0;
  try { used = Number(await env.USERS_KV.get(counterKey)) || 0; } catch (e) {}
  if (used >= cap) throw Object.assign(new Error(`đã dùng ${used}/${cap} lượt Tavily tháng này`), { status: 429 });
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query: query.slice(0, 380), search_depth: "basic", max_results: max, include_answer: false, include_raw_content: raw }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw Object.assign(new Error(`Tavily HTTP ${res.status}: ${body.slice(0, 200)}`), { status: res.status });
  }
  try { await env.USERS_KV.put(counterKey, String(used + 1)); } catch (e) {}
  const data = await res.json();
  return (data.results || []).filter((r) => r && r.url);
}

async function webContextFor(env, query) {
  try {
    const results = await tavilySearch(env, query.replace(/@\w+/g, " ").trim(), { max: 5 });
    if (!results.length) return null;
    const ctx = results.map((r, i) => `[${i + 1}] ${r.title || ""}\n${(r.content || "").slice(0, 700)}\n(${r.url})`).join("\n\n");
    return { ctx, sources: results.slice(0, 3).map((r) => ({ title: r.title || r.url, uri: r.url })) };
  } catch (e) {
    console.log(`⚠️ [Tavily] ${e.message}`);
    return null;
  }
}

function webPrompt(base, web) {
  return `${base}\n\n[KẾT QUẢ TÌM KIẾM WEB — ${currentVietnamDateTimeString()}]\n${web.ctx}\n[HẾT KẾT QUẢ]\n` +
    `Hãy trả lời CHỈ dựa vào kết quả tìm kiếm ở trên, ghi số nguồn như [1] khi dùng thông tin. ` +
    `Nếu kết quả không đủ hoặc không liên quan, nói rõ là chưa tìm thấy, tuyệt đối không bịa số liệu. Trả lời ngắn gọn bằng tiếng Việt, đúng phong cách của bạn.`;
}

async function handleSearchCommand(env, tg, message, args, personality) {
  const chatId = message.chat.id;
  const q = args.trim();
  if (!q) return tg.replyToMessage(chatId, message.message_id, "Dùng: /tim câu hỏi cần tra web. Ví dụ: /tim học phí trường Đại học Bách khoa Hà Nội");
  await tg.call("sendChatAction", { chat_id: chatId, action: "typing" });
  const { text } = await generateContent(env, tg, personality, { contextMessage: q, history: [], search: true });
  await tg.replyToMessage(chatId, message.message_id, text.slice(0, 4000));
}

async function handleXsmbCommand(env, tg, message, args) {
  await tg.call("sendChatAction", { chat_id: message.chat.id, action: "typing" });
  const reply = await xsmbReply(env, "xsmb " + args);
  await tg.replyToMessage(message.chat.id, message.message_id, reply);
}

// ----- Bộ định tuyến: câu nào dùng công cụ nào -----

async function tryTools(env, text) {
  const t = (text || "").trim();
  if (!t) return null;
  const dt = answerDateTime(t);
  if (dt) return { reply: dt };
  if (XSMB_RE.test(t)) return { reply: await xsmbReply(env, t) };
  if (SEARCH_RE.test(t)) return { search: true };
  return null;
}

// ---------------- Giới hạn lượt AI mỗi ngày + nhật ký admin ----------------

function aiQuotaCheck(state, env, userId, defaultCap, envName) {
  const p = vnParts(0);
  const day = `${p.y}-${p.m}-${p.d}`;
  if (state.aiDay !== day) { state.aiDay = day; state.aiCount = 0; }
  if (env.ADMIN_ID && String(userId) === String(env.ADMIN_ID)) return true;
  if (state.aiCount >= (Number(env[envName]) || defaultCap)) return false;
  state.aiCount++;
  return true;
}

async function auditLog(env, chatId, by, act, target, note) {
  try {
    const key = `audit:${chatId}`;
    let arr = [];
    const raw = await env.USERS_KV.get(key);
    if (raw) arr = JSON.parse(raw);
    arr.push({ t: Date.now(), bn: userName(by || {}).slice(0, 30), act, to: target ? userName(target).slice(0, 30) : "", note: String(note || "").slice(0, 60) });
    await env.USERS_KV.put(key, JSON.stringify(arr.slice(-30)));
  } catch (e) {}
}

let cachedBotUsername = null;
async function getBotUsername(tg) {
  if (!cachedBotUsername) cachedBotUsername = ((await tg.getMe())?.username || "").toLowerCase();
  return cachedBotUsername;
}

async function handleUpdate(update, env) {
  try {
    await bumpStats(env, "updates");
    if (update.callback_query) return handleCallback(env, update.callback_query);
    const message = update.message;
    if (!message) return;
    if (!env.TELEGRAM_BOT_TOKEN) { console.log("✗ Thiếu secret TELEGRAM_BOT_TOKEN"); return; }

    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    const personality = env.PERSONALITY_MODE || "dynamic";
    const chatId = message.chat.id;
    const text = message.text || message.caption || "";
    const isGroup = ["group", "supergroup"].includes(message.chat.type);

    // Tách lệnh dạng /cmd, /cmd@botname args
    const m = text.match(/^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/);
    if (m) {
      const cmd = m[1].toLowerCase();
      const target = (m[2] || "").toLowerCase();
      const args = m[3] || "";
      if (target && target !== (await getBotUsername(tg))) return; // lệnh dành cho bot khác

      if (cmd === "start") return handleStartCommand(env, tg, chatId, personality);
      if (cmd === "checkcert") return handleCheckcert(env, tg, message, args);
      if (cmd === "report" && !isGroup) return handleReport(env, tg, chatId, message.message_id, message);
      if (cmd === "info") return handleInfo(tg, chatId, message.message_id, message.from || {}, message.chat);
      if (cmd === "aitest") return handleAiTest(env, tg, message);
      if (cmd === "gh") return handleGh(env, tg, message, args);
      if (cmd === "stats") return handleStats(env, tg, message);
      if (cmd === "xsmb") return handleXsmbCommand(env, tg, message, args);
      if (cmd === "tim" || cmd === "web") return handleSearchCommand(env, tg, message, args, personality);
      if (await handleRoseCommand(env, tg, message, cmd, args)) return;
      if (STATIC_COMMANDS[cmd]) return tg.replyToMessage(chatId, message.message_id, STATIC_COMMANDS[cmd]);
      // lệnh lạ: rơi xuống xử lý như tin nhắn thường
    }

    if (isGroup) {
      if (await processGroupModeration(env, tg, message)) return;
      await handleGroupMessage(env, tg, message, personality, env.GROUP_MODE || "mention_only", await getBotUsername(tg));
    } else if (message.chat.type === "private") {
      await handlePrivateMessage(env, tg, message, personality);
    }
  } catch (e) {
    console.log(`✗ [handleUpdate] ${e.stack || e.message}`);
    await bumpStats(env, "handler_err", e);
  }
}

// ---------------- Cron nhắc nhở ----------------

async function handleScheduled(env) {
  try {
    const tg = new TelegramClient(env.TELEGRAM_BOT_TOKEN);
    const personality = env.PERSONALITY_MODE || "dynamic";
    const now = Date.now();
    await processCaptchaExpiry(env, tg);
    const userIds = await listActiveUserIds(env.USERS_KV);

    for (const chatId of userIds) {
      if (String(chatId).startsWith("-")) continue; // không nhắc nhở trong nhóm
      const state = await getUserState(env.USERS_KV, chatId);
      if (!state.running) continue;
      const silentMs = now - state.lastReplyTime;
      let stage = null;
      if (state.reminderStage === 0 && silentMs >= 600000) stage = 1;
      else if (state.reminderStage === 1 && silentMs >= 1800000) stage = 2;
      if (!stage) continue;

      const checkTime = state.lastReplyTime;
      const { text, isFallback } = await generateContent(env, tg, personality, { isReminder: true, reminderStage: stage, history: state.history });

      const fresh = await getUserState(env.USERS_KV, chatId);
      if (fresh.lastReplyTime !== checkTime) continue; // người dùng vừa nhắn lại

      await tg.sendMessage(chatId, text);
      fresh.reminderStage = stage;
      if (!isFallback) appendHistory(fresh, "model", text);
      if (stage === 2) fresh.running = false;
      await saveUserState(env.USERS_KV, chatId, fresh);
    }
  } catch (e) {
    console.log(`✗ [Cron] ${e.stack || e.message}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/github") return handleGithubWebhook(request, env, ctx);
    if (request.method === "GET" && url.pathname === "/health") return handleHealth(env, url);
    if (request.method !== "POST") return new Response("Bot is running.", { status: 200 });
    if (env.TELEGRAM_WEBHOOK_SECRET && request.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("OK", { status: 200 });
    } catch (e) {
      return new Response("OK", { status: 200 }); // luôn 200 để Telegram không retry dồn dập
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
  },
};
