"""Structured logging.

Console output stays human-readable; the optional log file gets one JSON
object per line so runs can be shipped to a log store.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

LOGGER_NAME = "lead_pipeline"

_RESERVED = set(
    logging.LogRecord("", 0, "", 0, "", (), None).__dict__
) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                try:
                    json.dumps(value)
                    payload[key] = value
                except (TypeError, ValueError):
                    payload[key] = str(value)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


class ConsoleFormatter(logging.Formatter):
    COLORS = {
        "DEBUG": "\033[38;5;244m",
        "INFO": "\033[38;5;39m",
        "WARNING": "\033[38;5;214m",
        "ERROR": "\033[38;5;203m",
        "CRITICAL": "\033[38;5;201m",
    }
    RESET = "\033[0m"

    def __init__(self, use_color: bool = True) -> None:
        super().__init__("%(message)s")
        self.use_color = use_color

    def format(self, record: logging.LogRecord) -> str:
        timestamp = self.formatTime(record, "%H:%M:%S")
        level = record.levelname
        message = record.getMessage()
        extras = {
            k: v
            for k, v in record.__dict__.items()
            if k not in _RESERVED and not k.startswith("_") and k not in {"run_id"}
        }
        suffix = ""
        if extras:
            rendered = " ".join(f"{k}={v}" for k, v in list(extras.items())[:6])
            suffix = f"  \033[38;5;244m{rendered}\033[0m" if self.use_color else f"  {rendered}"
        if self.use_color:
            color = self.COLORS.get(level, "")
            return f"\033[38;5;244m{timestamp}\033[0m {color}{level:<7}\033[0m {message}{suffix}"
        return f"{timestamp} {level:<7} {message}{suffix}"


def setup_logging(
    level: str = "INFO",
    log_file: str | Path | None = None,
    *,
    quiet: bool = False,
    use_color: bool | None = None,
) -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(getattr(logging, str(level).upper(), logging.INFO))
    logger.handlers.clear()
    logger.propagate = False

    if not quiet:
        stream = logging.StreamHandler(sys.stderr)
        if use_color is None:
            use_color = hasattr(sys.stderr, "isatty") and sys.stderr.isatty()
        stream.setFormatter(ConsoleFormatter(use_color=bool(use_color)))
        stream.setLevel(logger.level)
        logger.addHandler(stream)

    if log_file:
        path = Path(log_file)
        path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(path, encoding="utf-8")
        file_handler.setFormatter(JsonFormatter())
        file_handler.setLevel(logging.DEBUG)
        logger.addHandler(file_handler)

    return logger


def get_logger(name: str | None = None) -> logging.Logger:
    return logging.getLogger(LOGGER_NAME if not name else f"{LOGGER_NAME}.{name}")
