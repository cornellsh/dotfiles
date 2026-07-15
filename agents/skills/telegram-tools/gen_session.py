#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.9"
# dependencies = ["telethon"]
# ///
"""Generate a TELEGRAM_SESSION_STRING for the tg CLI.

Run interactively:  ./gen_session.py
It will ask for your phone number and the login code Telegram sends you.
"""

import os
import sys
import asyncio
from telethon import TelegramClient
from telethon.sessions import StringSession

# Read your Telegram app credentials from the environment (get them at
# https://my.telegram.org > API development tools). Never hardcode them here.
try:
    API_ID = int(os.environ["TELEGRAM_API_ID"])
    API_HASH = os.environ["TELEGRAM_API_HASH"]
except KeyError as e:
    sys.exit(f"missing {e}. Set TELEGRAM_API_ID and TELEGRAM_API_HASH first.")


async def main():
    async with TelegramClient(StringSession(), API_ID, API_HASH) as client:
        s = client.session.save()
        me = await client.get_me()
        print(
            "\n=== Logged in as:",
            me.first_name,
            f"(@{me.username})" if me.username else "",
        )
        print("\nAdd these three lines to ~/.zsh_secrets:\n")
        print(f"export TELEGRAM_API_ID={API_ID}")
        print(f"export TELEGRAM_API_HASH={API_HASH}")
        print(f"export TELEGRAM_SESSION_STRING={s}")
        print()


if __name__ == "__main__":
    asyncio.run(main())
