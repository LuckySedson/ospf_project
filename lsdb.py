import time
import threading


class LSDB:
    def __init__(self, max_age):
        self.lock = threading.Lock()
        self.max_age = max_age
        self.entries = {}

    def update(self, origin, seq, links):
        with self.lock:
            current = self.entries.get(origin)
            if current is None or seq > current["seq"]:
                self.entries[origin] = {
                    "seq": seq,
                    "links": links,
                    "last_seen": time.time(),
                }
                return True
            return False

    def purge_stale(self):
        now = time.time()
        removed = False
        with self.lock:
            stale = [
                origin
                for origin, e in self.entries.items()
                if now - e["last_seen"] > self.max_age
            ]
            for origin in stale:
                del self.entries[origin]
                removed = True
        return removed

    def snapshot(self):
        with self.lock:
            return {origin: dict(e) for origin, e in self.entries.items()}