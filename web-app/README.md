This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

Environment variables (server):

- NOTIFY_BOT_TOKEN — shared secret for /api/notify
- VAPID_SUBJECT — contact, e.g. mailto:admin@example.com
- VAPID_PUBLIC_KEY — VAPID public key (base64url)
- VAPID_PRIVATE_KEY — VAPID private key
- PUSH_SUBS_DB_PATH — path to push_subs.db (default: ../data/push_subs.db)

Environment variables (client):

- NEXT_PUBLIC_VAPID_PUBLIC_KEY — same as VAPID_PUBLIC_KEY (exposed to browser)

Bot side:

- WEB_NOTIFY_URL — e.g. http://127.0.0.1:3000/api/notify
- NOTIFY_BOT_TOKEN — same as server NOTIFY_BOT_TOKEN
- TIMELINE_SCREENSHOT_SCRIPT — optional override for `scripts/render_timeline_screenshot.py`
- TIMELINE_SCREENSHOT_BASE_URL — base URL of the Next.js app (default http://127.0.0.1:3000)
- TIMELINE_SCREENSHOT_ENABLED — set to `0`/`false` to disable screenshot generation
- TIMELINE_SCREENSHOT_PYTHON — повний шлях до Python-інтерпретатора (наприклад `./venv/Scripts/python.exe`)

## Timeline screenshot workflow

- `app/timeline/screenshot/page.tsx` рендерить компонент `SnakeDayTimeline` без додаткового оточення. Сторінка очікує query-параметр `data`, який містить base64 (URL-safe) рядок із JSON у форматі `SnakeTimelineData`.
- JSON можна зібрати на стороні бота та передати напряму через URL: `/timeline/screenshot?data=<base64>`.
- Для ручного тесту:

  ```bash
  python - <<'EOF'
  import base64, json
  payload = json.dumps({"slots": []}).encode()
  encoded = base64.urlsafe_b64encode(payload).decode()
  print(encoded)
  EOF

  # відкрийте http://127.0.0.1:3000/timeline/screenshot?data=<encoded>
  ```

- Скрипт `scripts/render_timeline_screenshot.py` запускає Playwright (Chromium headless), відкриває сторінку і робить скріншот контейнера `[data-test=snake-day-timeline-ready]`.
  - Вимоги: `pip install playwright`, далі `playwright install chromium`.
  - Використання:

    ```bash
    python scripts/render_timeline_screenshot.py \
      --json-file schedule.json \
      --output out/schedule.png \
      --base-url http://127.0.0.1:3000
    ```

  - Доступні також параметри `--json "<inline JSON>"`, `--viewport-width`, `--viewport-height`, `--full-page` тощо.
- `bot.py` викликає скрипт автоматично при оновленні графіка (сьогодні/завтра), передає свіжий JSON та публікує скріншот разом із Telegram-повідомленням. Шляхи/URL можна перевизначити змінними середовища (див. вище).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
