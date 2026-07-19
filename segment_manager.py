import time
import threading

DOWN = "DOWN"
TWOWAY = "TWOWAY"
FULL = "FULL"


def ip_to_int(ip):
    try:
        parts = [int(p) for p in ip.split(".")]
        if len(parts) != 4:
            return 0
        return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
    except (ValueError, AttributeError):
        return 0


class Segment:
    def __init__(self, segment_id, my_id, my_ip, priority, cost, peer_ports, neighbor_timeout):
        self.segment_id = segment_id
        self.my_id = my_id
        self.my_ip = my_ip
        self.priority = priority
        self.cost = cost
        self.neighbor_timeout = neighbor_timeout
        self.lock = threading.Lock()
        self.peers = {
            port: {"peer_id": None, "ip": None, "priority": 0, "state": DOWN, "last_hello": 0}
            for port in peer_ports
        }
        self.dr = None
        self.bdr = None
        self._locked = False

    def _eligible(self):
        eligible = {}
        if self.priority > 0:
            eligible[self.my_id] = (self.priority, self.my_ip)
        for entry in self.peers.values():
            if entry["state"] != DOWN and entry["peer_id"] and entry["priority"] > 0:
                eligible[entry["peer_id"]] = (entry["priority"], entry["ip"] or "0.0.0.0")
        return eligible

    def _pick_best(self, candidates):
        if not candidates:
            return None
        return max(candidates.items(), key=lambda kv: (kv[1][0], ip_to_int(kv[1][1])))[0]

    def _elect(self):
        eligible = self._eligible()
        old = (self.dr, self.bdr)
        all_heard = all(e["state"] != DOWN for e in self.peers.values())

        if not self._locked:
            self.dr = self._pick_best(eligible)
            remaining = {k: v for k, v in eligible.items() if k != self.dr}
            self.bdr = self._pick_best(remaining)
            if all_heard:
                self._locked = True
        else:
            if self.dr not in eligible:
                self.dr = self._pick_best(eligible)
            remaining = {k: v for k, v in eligible.items() if k != self.dr}
            if self.bdr not in remaining:
                self.bdr = self._pick_best(remaining)

        return (self.dr, self.bdr) != old

    def _refresh_adjacency_states(self):
        for entry in self.peers.values():
            if entry["state"] == DOWN:
                continue
            peer_id = entry["peer_id"]
            if peer_id and (peer_id in (self.dr, self.bdr) or self.my_id in (self.dr, self.bdr)):
                entry["state"] = FULL
            else:
                entry["state"] = TWOWAY

    def process_hello(self, peer_port, peer_id, peer_priority, peer_ip):
        with self.lock:
            entry = self.peers.get(peer_port)
            if entry is None:
                return False
            entry["peer_id"] = peer_id
            entry["ip"] = peer_ip
            entry["priority"] = peer_priority
            entry["last_hello"] = time.time()
            if entry["state"] == DOWN:
                entry["state"] = TWOWAY
            changed = self._elect()
            self._refresh_adjacency_states()
            return changed

    def update_self(self, priority, cost):
        with self.lock:
            self.priority = priority
            self.cost = cost
            changed = self._elect()
            self._refresh_adjacency_states()
            return changed

    def check_timeouts(self):
        now = time.time()
        state_changed = False
        with self.lock:
            for entry in self.peers.values():
                if entry["state"] != DOWN and now - entry["last_hello"] > self.neighbor_timeout:
                    entry["state"] = DOWN
                    entry["peer_id"] = None
                    entry["ip"] = None
                    state_changed = True
            if state_changed:
                self._elect()
                self._refresh_adjacency_states()
        return state_changed

    def get_full_peer_ids(self):
        with self.lock:
            return [e["peer_id"] for e in self.peers.values() if e["state"] == FULL and e["peer_id"]]

    def is_attached(self):
        with self.lock:
            return self.dr is not None

    def snapshot(self):
        with self.lock:
            return {
                "segment_id": self.segment_id,
                "priority": self.priority,
                "cost": self.cost,
                "dr": self.dr,
                "bdr": self.bdr,
                "peers": {port: dict(e) for port, e in self.peers.items()},
            }