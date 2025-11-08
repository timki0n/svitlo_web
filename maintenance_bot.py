import asyncio
import contextlib
import logging
import os

from aiogram import Bot, Dispatcher, Router, types
from aiogram.filters import Command
from aiogram.types import Message
from dotenv import load_dotenv


MAINTENANCE_MESSAGE = os.getenv(
    "MAINTENANCE_MESSAGE",
    "🤖 Бот тимчасово недоступний, проводяться технічні роботи.\n"
    "Спробуйте, будь ласка, пізніше.",
)
# ⚠️ Не рекомендується тримати продакшн-токен у коді.
# Заповніть значенням лише якщо усвідомлюєте ризики.
STATIC_BOT_TOKEN = os.getenv("BOT_TOKEN_STATIC", "8284770210:AAFSTHPyzSUO_VjcaDii8lIW5ze645ruPTg")


async def main() -> None:
    logging.basicConfig(level=logging.INFO)
    load_dotenv()

    bot_token = STATIC_BOT_TOKEN
    if not bot_token:
        raise SystemExit("⚠️ Не знайдено BOT_TOKEN. Додайте його у .env або змінну середовища.")

    bot = Bot(bot_token)
    dp = Dispatcher()

    router = Router()

    @router.message(Command("start"))
    @router.message(Command("status"))
    @router.message(Command("today"))
    @router.message(Command("tomorrow"))
    async def maintenance_response(message: Message) -> None:
        await message.answer(MAINTENANCE_MESSAGE)

    @router.callback_query()
    async def answer_callback(callback: types.CallbackQuery) -> None:
        with contextlib.suppress(Exception):
            await callback.answer()
        if callback.message:
            await callback.message.answer(MAINTENANCE_MESSAGE)

    dp.include_router(router)

    async with bot:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        logging.info("Maintenance bot stopped.")

