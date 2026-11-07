# Telegram-bot (Cloudflare Worker + Gemini)

Bot Telegram @Kyicbot chạy trên Cloudflare Workers: trò chuyện AI (Gemini), quản lý nhóm kiểu Rose,
kiểm tra chứng chỉ ký IPA Apple (`/checkcert`), XSMB có nguồn (`/xsmb`), tra web (`/tim`, Tavily),
và liên kết GitHub (`/gh`, webhook `/github`).

## Triển khai tự động từ GitHub (Workers Builds)
1. Sửa `wrangler.toml`: thay `DAN_ID_KV_THAT_VAO_DAY` bằng ID thật của KV namespace `USERS_KV`.
2. Cloudflare -> Workers & Pages -> `telegram-bot` -> Settings -> Builds -> Connect -> chọn repo này.
   Deploy command: `npx wrangler deploy`. Mỗi lần `git push` lên nhánh chính là tự deploy.
3. Secrets đặt trong Cloudflare (không commit vào repo): `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ADMIN_ID`,
   `TAVILY_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_TOKEN` (tuỳ chọn, repo private).
4. Kiểm tra bản đang chạy: mở `https://telegram-bot.<tài-khoản>.workers.dev/health` (có dòng `version`).

## Biến tuỳ chọn
`GEMINI_MODEL`, `MODEL_FAST`, `MODEL_SMART`, `SEARCH_MODEL`, `XSMB_URL`, `TAVILY_CAP`, `GITHUB_REPO`,
`NOTIFY_CHAT_ID`, `GITHUB_AI_SUMMARY=off`, `STATS=off`.
