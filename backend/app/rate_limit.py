from collections import defaultdict, deque
from threading import Lock
from time import monotonic

from fastapi import HTTPException


class FixedWindowRateLimiter:
    """Process-local limiter for the demo; production multi-instance needs shared storage."""

    def __init__(self, window_seconds: int = 60):
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str, limit: int) -> None:
        now = monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            hits = self._hits[key]
            while hits and hits[0] <= cutoff:
                hits.popleft()
            if len(hits) >= limit:
                retry_after = max(1, int(self.window_seconds - (now - hits[0])))
                raise HTTPException(
                    status_code=429,
                    detail="Rate limit exceeded",
                    headers={"Retry-After": str(retry_after)},
                )
            hits.append(now)


rate_limiter = FixedWindowRateLimiter()
