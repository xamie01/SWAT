"""Shared sourcing plumbing: rate limiting, retries, resumable paging.

Every source pulls potentially hundreds of thousands of rows per KOL, so the
two things that matter are (a) not getting rate-limited into a ban and (b)
being able to resume after a crash without re-reading everything.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)


class SourceError(RuntimeError):
    """A source failed in a way that isn't worth retrying."""


class RateLimiter:
    """Token-bucket limiter shared across concurrent workers.

    A plain ``asyncio.sleep(1/rps)`` per call doesn't work once several workers
    run concurrently — they'd each pace themselves and collectively exceed the
    budget. This serializes the pacing decision across all callers.
    """

    def __init__(self, max_rps: float) -> None:
        self._min_interval = 1.0 / max_rps if max_rps > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next_slot = 0.0

    async def acquire(self) -> None:
        if self._min_interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            wait_for = self._next_slot - now
            if wait_for > 0:
                await asyncio.sleep(wait_for)
                now = time.monotonic()
            self._next_slot = max(now, self._next_slot) + self._min_interval


@dataclass
class PullStats:
    """What a single KOL pull actually did — surfaced in the CLI progress line."""

    kol_key: str
    requests: int = 0
    rows: int = 0
    pages: int = 0
    windows: int = 0
    errors: list[str] = field(default_factory=list)
    stopped_early: bool = False

    def merge(self, other: "PullStats") -> None:
        self.requests += other.requests
        self.rows += other.rows
        self.pages += other.pages
        self.windows += other.windows
        self.errors.extend(other.errors)


class HttpSource:
    """An HTTP client with a shared rate limiter and sane retry policy."""

    def __init__(
        self,
        *,
        max_rps: float,
        timeout: float = 30.0,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._limiter = RateLimiter(max_rps)
        self._client = httpx.AsyncClient(
            timeout=httpx.Timeout(timeout),
            headers=headers or {},
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            follow_redirects=True,
        )

    async def __aenter__(self) -> "HttpSource":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    @retry(
        retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
        wait=wait_exponential(multiplier=1, min=1, max=30),
        stop=stop_after_attempt(5),
        reraise=True,
    )
    async def _request(self, url: str, params: dict[str, Any]) -> Any:
        await self._limiter.acquire()
        response = await self._client.get(url, params=params)

        # 429 carries a server-specified backoff often enough to honour it.
        if response.status_code == 429:
            retry_after = response.headers.get("retry-after")
            delay = float(retry_after) if retry_after and retry_after.isdigit() else 5.0
            await asyncio.sleep(delay)
            response.raise_for_status()

        # A 400 means we asked for something impossible (e.g. an offset past the
        # cap). Retrying is pointless and masks the real bug, so surface it.
        if response.status_code == 400:
            raise SourceError(f"{url} rejected the request (400): {response.text[:300]}")

        response.raise_for_status()
        return response.json()

    async def get_json(self, url: str, params: dict[str, Any]) -> Any:
        return await self._request(url, params)
