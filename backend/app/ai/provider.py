"""Provider boundary. Document services never construct gateway requests."""

from typing import Protocol


class AIUnavailable(Exception):
    def __init__(self, code="AI_UNAVAILABLE"):
        self.code = code
        super().__init__(code)


class AIProvider(Protocol):
    def generate(self, messages: list[dict]) -> str: ...
    def embed(self, texts: list[str]) -> list[list[float]]: ...
