#!/usr/bin/env python3
"""
Робить скріншот сторінки /timeline/screenshot у web-app.

Використання:
    python scripts/render_timeline_screenshot.py \
        --json-file schedule.json \
        --output out/schedule.png \
        --base-url http://127.0.0.1:3000
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
from typing import Any
from urllib.parse import quote

DEFAULT_BASE_URL = os.environ.get("TIMELINE_SCREENSHOT_BASE_URL", "http://127.0.0.1:3000")
DEFAULT_SELECTOR = "[data-test=snake-day-timeline-ready]"
DEFAULT_VIEWPORT = (1080, 1440)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Робить скріншот SnakeDayTimeline через Playwright.")
    parser.add_argument("--json-file", type=Path, help="Файл із JSON графіком.")
    parser.add_argument("--json", dest="json_inline", help="JSON рядок (альтернатива --json-file).")
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
    return parser.parse_args()


def ensure_payload_source(args: argparse.Namespace) -> Any:
    provided = [args.json_file, args.json_inline]
    supplied_count = sum(1 for item in provided if item)
    if supplied_count == 0:
        raise SystemExit("Вкажіть один із параметрів: --json-file або --json.")
    if supplied_count > 1:
        raise SystemExit("Використайте лише один із параметрів: --json-file АБО --json.")

    if args.json_file:
        path = args.json_file
        if not path.exists():
            raise SystemExit(f"Файл {path} не існує.")
        text = path.read_text(encoding="utf-8")
        return json.loads(text)

    return json.loads(args.json_inline)  # type: ignore[arg-type]


def encode_payload(data: Any) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii")


def build_target_url(base_url: str, param_value: str) -> str:
    sanitized_base = base_url.rstrip("/")
    encoded_param = quote(param_value, safe="")
    return f"{sanitized_base}/timeline/screenshot?data={encoded_param}"


async def capture_screenshot(args: argparse.Namespace) -> Path:
    from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright

    payload = ensure_payload_source(args)
    encoded = encode_payload(payload)
    target_url = build_target_url(args.base_url, encoded)
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
