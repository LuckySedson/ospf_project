import argparse
import json
import socket
import threading
import time
import logging
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from config_loader import load_config
from messages import build_hello, build_lsa, parse_message, HELLO, LSA
from neighbor_manager import NeighborManager, FULL
from lsdb import LSDB
from routing import build_graph, compute_routing_table

HELLO_INTERVAL = 2
NEIGHBOR_TIMEOUT = 8
LSA_INTERVAL = 10
LSA_MAX_AGE = 40
CHECK_INTERVAL = 1
HOST = "127.0.0.1"


class StatusHandler(BaseHTTPRequestHandler):
    router_ref = None

    def _send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/state":
            payload = {
                "router_id": self.router_ref.router_id,
                "neighbors": self.router_ref.neighbor_manager.snapshot(),
                "lsdb": self.router_ref.lsdb.snapshot(),
                "routing_table": self.router_ref.routing_table,
            }
            self._send_json(payload)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode())
        except ValueError:
            payload = {}

        if self.path == "/admin/add_link":
            self.router_ref.admin_add_link(payload["peer_port"], payload["cost"])
            self._send_json({"ok": True})
        elif self.path == "/admin/remove_link":
            self.router_ref.admin_remove_link(payload["peer_port"])
            self._send_json({"ok": True})
        elif self.path == "/admin/update_link":
            self.router_ref.admin_update_link(payload["peer_port"], payload["cost"])
            self._send_json({"ok": True})
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass


class Router:
    def __init__(self, config):
        self.router_id = config["router_id"]
        self.port = config["port"]
        self.status_port = config["status_port"]
        self.links_config = config["links"]

        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((HOST, self.port))

        if hasattr(socket, "SIO_UDP_CONNRESET"):
            try:
                self.sock.ioctl(socket.SIO_UDP_CONNRESET, False)
            except Exception:
                pass

        self.neighbor_manager = NeighborManager(self.links_config, NEIGHBOR_TIMEOUT)
        self.lsdb = LSDB(LSA_MAX_AGE)
        self.seq = 0
        self.routing_table = {}
        self.running = True

        logging.basicConfig(
            level=logging.INFO,
            format=f"[{self.router_id}] %(asctime)s %(message)s",
            datefmt="%H:%M:%S",
        )
        self.log = logging.getLogger(self.router_id)

    def start(self):
        threading.Thread(target=self.listen_loop, daemon=True).start()
        threading.Thread(target=self.hello_loop, daemon=True).start()
        threading.Thread(target=self.lsa_loop, daemon=True).start()
        threading.Thread(target=self.maintenance_loop, daemon=True).start()
        threading.Thread(target=self.start_status_server, daemon=True).start()

        self.log.info(f"Routeur demarre sur le port {self.port} (statut sur {self.status_port})")

        while self.running:
            time.sleep(1)

    def listen_loop(self):
        while self.running:
            try:
                data, addr = self.sock.recvfrom(4096)
                msg = parse_message(data)
                if msg is None:
                    continue

                peer_port = addr[1]
                if msg["type"] == HELLO:
                    self.handle_hello(peer_port, msg)
                elif msg["type"] == LSA:
                    self.handle_lsa(msg)

            except ConnectionResetError:
                continue
            except Exception as e:
                if self.running:
                    self.log.error(f"Erreur dans listen_loop: {e}")
                    time.sleep(0.1)

    def handle_hello(self, peer_port, msg):
        changed = self.neighbor_manager.process_hello(
            peer_port, msg["origin"], msg["seen_neighbors"], self.router_id
        )
        if changed:
            self.log.info(f"Voisin {msg['origin']} -> etat mis a jour")
            self.emit_lsa()

    def handle_lsa(self, msg):
        updated = self.lsdb.update(msg["origin"], msg["seq"], msg["links"])
        if updated:
            self.log.info(f"LSA recu de {msg['origin']} (seq={msg['seq']}), maj LSDB")
            self.flood_lsa(msg, exclude_origin=msg["origin"])
            self.recompute_routing_table()

    def flood_lsa(self, msg, exclude_origin=None):
        payload = build_lsa(msg["origin"], msg["seq"], msg["links"])
        for port, entry in self.neighbor_manager.snapshot().items():
            if entry["state"] == FULL and entry["peer_id"] != exclude_origin:
                self.sock.sendto(payload, (HOST, port))

    def hello_loop(self):
        while self.running:
            seen = self.neighbor_manager.get_seen_peer_ids()
            payload = build_hello(self.router_id, seen)
            for port in list(self.neighbor_manager.snapshot().keys()):
                self.sock.sendto(payload, (HOST, port))
            time.sleep(HELLO_INTERVAL)

    def lsa_loop(self):
        while self.running:
            time.sleep(LSA_INTERVAL)
            self.emit_lsa()

    def emit_lsa(self):
        links = self.neighbor_manager.get_full_links()
        self.seq += 1
        self.lsdb.update(self.router_id, self.seq, links)
        msg = {"origin": self.router_id, "seq": self.seq, "links": links}
        self.log.info(f"Emission LSA seq={self.seq} links={links}")
        self.flood_lsa(msg)
        self.recompute_routing_table()

    def maintenance_loop(self):
        while self.running:
            time.sleep(CHECK_INTERVAL)

            timed_out = self.neighbor_manager.check_timeouts()
            if timed_out:
                self.log.info("Timeout voisin detecte, regeneration LSA")
                self.emit_lsa()

            purged = self.lsdb.purge_stale()
            if purged:
                self.log.info("LSA obsolete purge de la LSDB")
                self.recompute_routing_table()

    def admin_add_link(self, peer_port, cost):
        self.neighbor_manager.add_neighbor(peer_port, cost)
        self.log.info(f"Lien ajoute/modifie dynamiquement vers le port {peer_port} (cout {cost})")

    def admin_remove_link(self, peer_port):
        self.neighbor_manager.remove_neighbor(peer_port)
        self.log.info(f"Lien retire dynamiquement (port {peer_port})")
        self.emit_lsa()

    def start_status_server(self):
        StatusHandler.router_ref = self
        server = ThreadingHTTPServer((HOST, self.status_port), StatusHandler)
        server.serve_forever()

    def recompute_routing_table(self):
        graph = build_graph(self.lsdb.snapshot())
        self.routing_table = compute_routing_table(graph, self.router_id)
        self.log.info(f"Table de routage: {self.routing_table}")
    
    def admin_update_link(self, peer_port, cost):
        for link in self.links_config:
            if link.get("peer_port") == peer_port:
                link["cost"] = cost
                break

        self.neighbor_manager.add_neighbor(peer_port, cost)
        self.log.info(f"Lien mis à jour dynamiquement vers le port {peer_port} (nouveau coût {cost})")

        self.emit_lsa()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    config = load_config(args.config)
    router = Router(config)
    
    try:
        router.start()
    except KeyboardInterrupt:
        print(f"\n[!] Routeur {router.router_id} arrêté.")
        sys.exit(0)


if __name__ == "__main__":
    main()