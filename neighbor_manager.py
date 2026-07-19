import time
import threading

DOWN = "DOWN"
INIT = "INIT"
FULL = "FULL"


class NeighborManager:
    def __init__(self, links_config, neighbor_timeout):
        self.lock = threading.Lock()
        self.neighbor_timeout = neighbor_timeout
        self.neighbors = {}
        for link in links_config:
            self.neighbors[link["peer_port"]] = {
                "peer_id": None,
                "cost": link["cost"],
                "state": DOWN,
                "last_hello": 0,
            }

    def process_hello(self, peer_port, peer_id, seen_neighbors, my_id):
        with self.lock:
            entry = self.neighbors.get(peer_port)
            if entry is None:
                return False

            entry["peer_id"] = peer_id
            entry["last_hello"] = time.time()
            old_state = entry["state"]

            if my_id in seen_neighbors:
                entry["state"] = FULL
            elif entry["state"] == DOWN:
                entry["state"] = INIT

            return entry["state"] != old_state

    def check_timeouts(self):
        changed = False
        now = time.time()
        with self.lock:
            for entry in self.neighbors.values():
                if entry["state"] != DOWN and now - entry["last_hello"] > self.neighbor_timeout:
                    entry["state"] = DOWN
                    entry["peer_id"] = None
                    changed = True
        return changed

    def get_seen_peer_ids(self):
        with self.lock:
            return [
                e["peer_id"]
                for e in self.neighbors.values()
                if e["state"] in (INIT, FULL) and e["peer_id"]
            ]

    def get_full_links(self):
        with self.lock:
            return {
                e["peer_id"]: e["cost"]
                for e in self.neighbors.values()
                if e["state"] == FULL and e["peer_id"]
            }

    def add_neighbor(self, peer_port, cost):
        with self.lock:
            if peer_port in self.neighbors:
                self.neighbors[peer_port]["cost"] = cost
            else:
                self.neighbors[peer_port] = {
                    "peer_id": None,
                    "cost": cost,
                    "state": DOWN,
                    "last_hello": 0,
                }

    def remove_neighbor(self, peer_port):
        with self.lock:
            self.neighbors.pop(peer_port, None)
    
    def update_self(self, priority, cost):
        with self.lock:
            self.priority = priority
            self.cost = cost
            changed = self._elect()
            self._refresh_adjacency_states()
            return changed

    def snapshot(self):
        with self.lock:
            return {port: dict(entry) for port, entry in self.neighbors.items()}