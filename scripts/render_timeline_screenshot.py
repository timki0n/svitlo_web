#!/usr/bin/env python3
"""
Знімає скріншот основної сторінки web-app (/) та витягує компонент SnakeDayTimeline.

Бот попередньо записує актуальні дані в БД, після чого цей скрипт відкриває /?botToken=...
і робить скріншот елемента з розкладом напряму з головної сторінки.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
from pathlib import Path
from urllib.parse import urlencode

DEFAULT_BASE_URL = os.environ.get("TIMELINE_SCREENSHOT_BASE_URL", "http://127.0.0.1:3000")
DEFAULT_SELECTOR = "[data-testid=snake-day-timeline]"
DEFAULT_VIEWPORT = (760, 1440)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Робить скріншот SnakeDayTimeline через Playwright.")
    parser.add_argument("--output", required=True, type=Path, help="Шлях до PNG, куди зберегти скріншот.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="Базовий URL web-app (за замовчуванням http://127.0.0.1:3000).")
    parser.add_argument("--timeout", type=float, default=15.0, help="Таймаут завантаження сторінки (сек).")
    parser.add_argument("--selector", default=DEFAULT_SELECTOR, help="CSS-селектор контейнера для скріншоту.")
    parser.add_argument("--viewport-width", type=int, default=DEFAULT_VIEWPORT[0], help="Ширина вікна браузера.")
    parser.add_argument("--viewport-height", type=int, default=DEFAULT_VIEWPORT[1], help="Висота вікна браузера.")
    parser.add_argument("--device-scale", type=float, default=2.0, help="deviceScaleFactor (щільність пікселів).")
    parser.add_argument("--wait-ms", type=int, default=400, help="Додаткова пауза перед скріншотом (мс).")
    parser.add_argument("--full-page", action="store_true", help="Знімати всю сторінку замість селектора.")
    parser.add_argument("--headed", action="store_true", help="Запустити браузер у видимому режимі (debug).")
    parser.add_argument(
        "--bot-token",
        dest="bot_token",
        help="Токен, який додається в query (?botToken=...) для відключення кешу та проходу білих списків.",
    )
    parser.add_argument(
        "--scope",
        choices=("today", "tomorrow"),
        default="today",
        help="Який день показати у SnakeDayTimeline (через параметр ?scope=...).",
    )
    return parser.parse_args()


def build_target_url(base_url: str, bot_token: str | None, scope: str) -> str:
    sanitized_base = base_url.rstrip("/")
    query: dict[str, str] = {}
    if bot_token:
        query["botToken"] = bot_token
    if scope and scope != "today":
        query["scope"] = scope
    query_string = urlencode(query)
    if query_string:
        return f"{sanitized_base}/?{query_string}"
    return f"{sanitized_base}/"


async def capture_screenshot(args: argparse.Namespace) -> Path:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright

    target_url = build_target_url(args.base_url, args.bot_token, args.scope)
    viewport = {"width": args.viewport_width, "height": args.viewport_height, "device_scale_factor": args.device_scale}
    args.output.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(
            headless=not args.headed,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        page = await browser.new_page(viewport=viewport)
        try:
            await page.goto(target_url, wait_until="networkidle", timeout=int(args.timeout * 1000))
            await page.wait_for_selector(args.selector, timeout=int(args.timeout * 1000))
            if args.wait_ms > 0:
                await page.wait_for_timeout(args.wait_ms)

            if args.full_page:
                await page.screenshot(path=str(args.output), full_page=True)
            else:
                element = await page.query_selector(args.selector)
                if element is None:
                    raise RuntimeError(f"Не знайдено селектор {args.selector}")
                await element.screenshot(path=str(args.output))
        except PlaywrightTimeoutError as error:
            raise SystemExit(f"⏱️ Таймаут під час рендеру: {error}") from error
        finally:
            with contextlib.suppress(Exception):
                await browser.close()

    return args.output


async def run() -> int:
    args = parse_args()
    output = await capture_screenshot(args)
    print(f"✅ Скріншот збережено у {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
