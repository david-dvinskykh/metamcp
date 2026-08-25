# Патч `better-telegram-mcp`: inline-кнопки и чтение нажатий

MCP-сервер `telegram-bot` в этом MetaMCP — это пакет
[`better-telegram-mcp`](https://github.com/n24q02m/better-telegram-mcp)
(STDIO, команда `better-telegram-mcp`, версия базы патча — `v4.18.0-beta.6`,
коммит `0cbb5b9`). Патч добавляет то, чего в нём не было: inline-кнопки под
сообщением и чтение нажатий, чтобы карточка из 📮 Очереди решений отвечалась
одним тапом вместо текста «12 да».

Патч лежит здесь, а не в форке, потому что у этой сессии нет прав создавать
репозитории в GitHub (`POST /user/repos` → 403). Форк создаётся вручную одной
командой (ниже), после чего патч применяется как обычный коммит.

## Что добавляет патч

### 1. `message(action="send"|"edit", buttons=...)`

```jsonc
{
  "action": "send",
  "chat_id": 375465077,
  "text": "DEC-12 — перенести «оплатить КАСКО» на 24.10",
  "buttons": [[{"text": "✅ Да",    "data": "DEC-12:yes"},
               {"text": "✖️ Нет",   "data": "DEC-12:no"},
               {"text": "🕓 Потом", "data": "DEC-12:later"}]]
}
```

`data` → `callback_data` Bot API. Проверяется до запроса в Telegram:
`callback_data` 1–64 байта (UTF-8), не больше 8 кнопок в ряду и 100 рядов.
Плоский список кнопок принимается как один ряд. У `edit` `buttons: []` снимает
клавиатуру — так вопрос закрывается («… — ✅ да» без кнопок).

Кнопки доступны только в bot-режиме: user-backend (MTProto) отвечает `ModeError`.

### 2. `message(action="callbacks")`

```jsonc
{"action": "callbacks", "since_id": 123456789, "limit": 50}
```

```jsonc
{
  "callbacks": [{"update_id": 123456790,
                 "data": "DEC-12:yes",
                 "from_id": 375465077,
                 "chat_id": 375465077,
                 "message_id": 4711,
                 "date": "2026-08-25T14:03:11Z",
                 "callback_query_id": "...",
                 "answered": true}],
  "count": 1,
  "ignored": [],
  "cursor": 123456790
}
```

Под капотом — `getUpdates(offset=since_id+1, allowed_updates=["callback_query"],
timeout=0)`. Каждое возвращённое нажатие подтверждается `answerCallbackQuery`
(иначе у кнопки в клиенте висят «часики»); текст тоста задаётся `ack_text`.
С `strip_buttons: true` после ответа вызывается `editMessageReplyMarkup` и
кнопки снимаются — ответить дважды уже нельзя.

`date` — дата сообщения с кнопками: момент нажатия Bot API не отдаёт.

### 3. Курсор на стороне сервера

Последний обработанный `update_id` хранится в
`TELEGRAM_DATA_DIR/callback_cursor.json` (ключ — id бота), поэтому повторный
вызов `callbacks` не проигрывает нажатие второй раз и перезапуск сервера курсор
не отматывает. `since_id` в запросе перекрывает сохранённый курсор, если
вызывающая сторона ведёт позицию сама.

### 4. Безопасность

| Переменная | Назначение |
|:---|:---|
| `TELEGRAM_ALLOWED_CALLBACK_SENDERS` | Список Telegram user id через запятую, кому разрешено жать кнопки этого бота. Пусто = принимаются все, поэтому для очереди решений задать обязательно: `375465077` |
| `TELEGRAM_CALLBACK_DATA_PATTERN` | Регулярка, которой должен целиком соответствовать `callback_data`, например `^DEC-\d+:(yes\|no\|later)$` |

Нажатия, не прошедшие проверку, логируются, попадают в `ignored` и **не**
подтверждаются; курсор при этом всё равно сдвигается, так что чужое нажатие не
вернётся при следующем вызове. Номер карточки всё равно стоит сверять с Notion
и проверять `Статус` перед исполнением — курсор защищает от повторного чтения,
а не от гонки с ночным обслуживанием.

## Как применить

```bash
# 1. Форк (один раз, из своего аккаунта)
gh repo fork n24q02m/better-telegram-mcp --clone --remote
cd better-telegram-mcp

# 2. Ветка + патч
git checkout -b claude/telegram-bot-inline-buttons-ji7iif v4.18.0-beta.6
git am /path/to/metamcp/patches/better-telegram-mcp/0001-inline-buttons-and-callbacks.patch
git push -u origin claude/telegram-bot-inline-buttons-ji7iif

# 3. Проверка (то же, что гоняет CI апстрима)
uv sync
uv run ruff check . && uv run ruff format --check .
uv run ty check
uv run pytest tests/ --cov=better_telegram_mcp --cov-fail-under=95
```

Патч накладывается на `v4.18.0-beta.6`; если апстрим ушёл вперёд — `git am -3`.

## Как выкатить в MetaMCP

Сервер `telegram-bot` (uuid `4ae183ec-1dad-4800-8133-9b453b6e9764`) запускается
командой `better-telegram-mcp` из образа all-in-one, поэтому в образ нужно
поставить пропатченную версию вместо PyPI-релиза:

```dockerfile
RUN uv tool install "git+https://github.com/<owner>/better-telegram-mcp@claude/telegram-bot-inline-buttons-ji7iif"
```

Либо, без пересборки образа, поменять у сервера команду на
`uvx --from git+https://github.com/<owner>/better-telegram-mcp@claude/telegram-bot-inline-buttons-ji7iif better-telegram-mcp`.

К существующим env этого сервера добавить:

```
TELEGRAM_ALLOWED_CALLBACK_SENDERS=375465077
TELEGRAM_CALLBACK_DATA_PATTERN=^DEC-\d+:(yes|no|later)$
```

После рестарта — обновить инструменты неймспейса (`Refresh tools`), чтобы у
`message` появились параметры `buttons` / `since_id` / `ack_text` /
`strip_buttons` и действие `callbacks`.

**Важно:** `getUpdates` не работает, пока у бота установлен вебхук. Проверить —
`getWebhookInfo` должен вернуть пустой `url`; если вебхук есть, снять его
(`deleteWebhook`) или оставить текстовый разбор истории как основной путь.

## Что меняется в инструкциях после выката

* Дайджест, STEP 2.10 D: вместо строки «Ответь в чат: 12 да / 12 нет» — три
  кнопки под каждым вопросом (`buttons` в `message(action="send")`).
* Дайджест, STEP 2.10 A и ночной блок З п.1: вместо разбора текста истории —
  `message(action="callbacks")` без `since_id` (курсор ведёт сервер).
* Текстовый разбор («12 да») остаётся резервом: если `callbacks` вернул ошибку
  (`bot mode`, вебхук, старая версия сервера) — читать историю как сейчас.
