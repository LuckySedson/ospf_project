import json
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

BASE_DIR = Path(__file__).parent
CONFIGS_DIR = BASE_DIR / "configs"
STATIC_DIR = BASE_DIR / "static"
PYTHON = sys.executable
HOST = "127.0.0.1"

REFERENCE_BANDWIDTH_MBPS = 100000  # 100 Gbps : cout OSPF = reference / bande_passante_du_lien


def compute_cost(bandwidth_mbps):
    return max(1, REFERENCE_BANDWIDTH_MBPS // bandwidth_mbps)

app = Flask(__name__, static_folder=None)

processes = {}
router_configs = {}

SEGMENTS_DIR = CONFIGS_DIR / "segments"
SEGMENTS_DIR.mkdir(parents=True, exist_ok=True)
segment_configs = {}

def load_router_configs():
    router_configs.clear()
    for path in sorted(CONFIGS_DIR.glob("*.json")):
        with open(path) as f:
            config = json.load(f)
        router_configs[config["router_id"]] = config

def load_segment_configs():
    segment_configs.clear()
    for path in sorted(SEGMENTS_DIR.glob("*.json")):
        with open(path) as f:
            config = json.load(f)
        segment_configs[config["segment_id"]] = config


def save_segment_config(config):
    path = SEGMENTS_DIR / f"{config['segment_id']}.json"
    with open(path, "w") as f:
        json.dump(config, f, indent=2)

def save_config(config):
    path = CONFIGS_DIR / f"{config['router_id']}.json"
    with open(path, "w") as f:
        json.dump(config, f, indent=2)


def is_running(router_id):
    proc = processes.get(router_id)
    return proc is not None and proc.poll() is None


def fetch_router_state(status_port):
    try:
        url = f"http://{HOST}:{status_port}/state"
        with urllib.request.urlopen(url, timeout=0.5) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, TimeoutError, ConnectionRefusedError, OSError):
        return None


def post_admin(status_port, path, payload):
    try:
        req = urllib.request.Request(
            f"http://{HOST}:{status_port}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=0.5) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/routers")
def list_routers():
    load_router_configs()
    result = []
    for router_id, config in router_configs.items():
        result.append({
            "router_id": router_id,
            "port": config["port"],
            "status_port": config["status_port"],
            "links": config["links"],
            "running": is_running(router_id),
        })
    return jsonify(result)


@app.route("/api/start/<router_id>", methods=["POST"])
def start_router(router_id):
    if is_running(router_id):
        return jsonify({"ok": False, "error": "deja demarre"}), 400

    config_path = CONFIGS_DIR / f"{router_id}.json"
    if not config_path.exists():
        return jsonify({"ok": False, "error": "config introuvable"}), 404

    proc = subprocess.Popen([PYTHON, str(BASE_DIR / "router.py"), "--config", str(config_path)])
    processes[router_id] = proc
    return jsonify({"ok": True})


@app.route("/api/stop/<router_id>", methods=["POST"])
def stop_router(router_id):
    if not is_running(router_id):
        return jsonify({"ok": False, "error": "pas demarre"}), 400

    processes[router_id].terminate()
    return jsonify({"ok": True})


@app.route("/api/start_all", methods=["POST"])
def start_all():
    load_router_configs()
    for router_id in router_configs:
        if not is_running(router_id):
            config_path = CONFIGS_DIR / f"{router_id}.json"
            proc = subprocess.Popen([PYTHON, str(BASE_DIR / "router.py"), "--config", str(config_path)])
            processes[router_id] = proc
    return jsonify({"ok": True})


@app.route("/api/stop_all", methods=["POST"])
def stop_all():
    for router_id in list(processes.keys()):
        if is_running(router_id):
            processes[router_id].terminate()
    return jsonify({"ok": True})


@app.route("/api/state")
def get_state():
    load_router_configs()
    state = {}
    for router_id, config in router_configs.items():
        running = is_running(router_id)
        entry = {"running": running, "port": config["port"]}
        if running:
            data = fetch_router_state(config["status_port"])
            if data:
                entry.update(data)
            else:
                entry["error"] = "pas de reponse"
        state[router_id] = entry
    return jsonify(state)


@app.route("/api/routers/add", methods=["POST"])
def add_router():
    load_router_configs()
    data = request.get_json(force=True)

    router_id = (data.get("router_id") or "").strip()
    port = data.get("port")
    status_port = data.get("status_port")
    peer_links = data.get("links", [])

    if not router_id or not port or not status_port:
        return jsonify({"ok": False, "error": "champs manquants"}), 400
    if router_id in router_configs:
        return jsonify({"ok": False, "error": "router_id deja utilise"}), 400

    used_ports = set()
    for c in router_configs.values():
        used_ports.add(c["port"])
        used_ports.add(c["status_port"])
    if port in used_ports or status_port in used_ports or port == status_port:
        return jsonify({"ok": False, "error": "port deja utilise"}), 400

    resolved_links = []
    for link in peer_links:
        peer_id = link.get("peer_id")
        bandwidth = link.get("bandwidth")
        if peer_id not in router_configs:
            return jsonify({"ok": False, "error": f"routeur inconnu: {peer_id}"}), 400
        if not isinstance(bandwidth, int) or bandwidth <= 0:
            return jsonify({"ok": False, "error": "bande passante invalide"}), 400
        cost = compute_cost(bandwidth)
        resolved_links.append({
            "peer_port": router_configs[peer_id]["port"],
            "cost": cost,
            "bandwidth": bandwidth,
            "peer_id": peer_id,
        })

    new_config = {
        "router_id": router_id,
        "port": port,
        "status_port": status_port,
        "links": [{"peer_port": l["peer_port"], "cost": l["cost"], "bandwidth": l["bandwidth"]} for l in resolved_links],
    }
    save_config(new_config)

    for link in resolved_links:
        peer_config = router_configs[link["peer_id"]]
        already = any(l["peer_port"] == port for l in peer_config["links"])
        if not already:
            peer_config["links"].append({"peer_port": port, "cost": link["cost"], "bandwidth": link["bandwidth"]})
            save_config(peer_config)

        if is_running(link["peer_id"]):
            post_admin(peer_config["status_port"], "/admin/add_link", {"peer_port": port, "cost": link["cost"]})

    load_router_configs()
    return jsonify({"ok": True})


@app.route("/api/routers/remove/<router_id>", methods=["POST"])
def remove_router(router_id):
    load_router_configs()
    if router_id not in router_configs:
        return jsonify({"ok": False, "error": "routeur introuvable"}), 404

    target_port = router_configs[router_id]["port"]

    if is_running(router_id):
        processes[router_id].terminate()

    # 1) retirer le lien direct chez les voisins concernes (recalcule leur propre LSA)
    for other_id, config in router_configs.items():
        if other_id == router_id:
            continue
        new_links = [l for l in config["links"] if l["peer_port"] != target_port]
        if len(new_links) != len(config["links"]):
            config["links"] = new_links
            save_config(config)
            if is_running(other_id):
                post_admin(config["status_port"], "/admin/remove_link", {"peer_port": target_port})

    for other_id, config in router_configs.items():
        if other_id == router_id:
            continue
        if is_running(other_id):
            post_admin(config["status_port"], "/admin/purge_origin", {"origin": router_id})

    config_path = CONFIGS_DIR / f"{router_id}.json"
    if config_path.exists():
        config_path.unlink()
    processes.pop(router_id, None)

    load_router_configs()
    return jsonify({"ok": True})

@app.route("/api/update_link_bandwidth", methods=["POST"])
def update_link_bandwidth():
    load_router_configs()

    data = request.json
    r1_id = (data.get("r1") or "").strip()
    r2_id = (data.get("r2") or "").strip()

    try:
        bandwidth = int(data.get("bandwidth"))
        if bandwidth <= 0:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"ok": False, "error": "La bande passante doit être un nombre entier positif"}), 400

    new_cost = compute_cost(bandwidth)

    r1_cfg = next((cfg for rid, cfg in router_configs.items() if rid.lower() == r1_id.lower()), None)
    r2_cfg = next((cfg for rid, cfg in router_configs.items() if rid.lower() == r2_id.lower()), None)

    if not r1_cfg or not r2_cfg:
        return jsonify({"ok": False, "error": "Routeur(s) introuvable(s)"}), 404

    updated_r1 = False
    updated_r2 = False

    for link in r1_cfg.get("links", []):
        if link.get("peer_port") == r2_cfg.get("port"):
            link["cost"] = new_cost
            link["bandwidth"] = bandwidth
            updated_r1 = True

    for link in r2_cfg.get("links", []):
        if link.get("peer_port") == r1_cfg.get("port"):
            link["cost"] = new_cost
            link["bandwidth"] = bandwidth
            updated_r2 = True

    if updated_r1:
        save_config(r1_cfg)
    if updated_r2:
        save_config(r2_cfg)

    load_router_configs()

    if is_running(r1_id):
        post_admin(r1_cfg["status_port"], "/admin/update_link", {"peer_port": r2_cfg["port"], "cost": new_cost})
    if is_running(r2_id):
        post_admin(r2_cfg["status_port"], "/admin/update_link", {"peer_port": r1_cfg["port"], "cost": new_cost})

    return jsonify({"ok": True, "cost": new_cost})

@app.route("/api/routers/edit/<old_id>", methods=["POST"])
def edit_router(old_id):
    load_router_configs()
    if old_id not in router_configs:
        return jsonify({"ok": False, "error": "routeur introuvable"}), 404

    data = request.get_json(force=True)
    new_id = (data.get("router_id") or "").strip()
    new_port = data.get("port")
    new_status_port = data.get("status_port")

    if not new_id or not new_port or not new_status_port:
        return jsonify({"ok": False, "error": "champs manquants"}), 400
    if new_port == new_status_port:
        return jsonify({"ok": False, "error": "port deja utilise"}), 400

    old_config = router_configs[old_id]
    old_port = old_config["port"]

    for rid, cfg in router_configs.items():
        if rid == old_id:
            continue
        if rid == new_id:
            return jsonify({"ok": False, "error": "router_id deja utilise"}), 400
        if new_port in (cfg["port"], cfg["status_port"]) or new_status_port in (cfg["port"], cfg["status_port"]):
            return jsonify({"ok": False, "error": "port deja utilise"}), 400

    was_running = is_running(old_id)
    if was_running:
        processes[old_id].terminate()

    for other_id, cfg in router_configs.items():
        if other_id == old_id:
            continue
        if is_running(other_id):
            post_admin(cfg["status_port"], "/admin/purge_origin", {"origin": old_id})

    if new_port != old_port:
        for other_id, cfg in router_configs.items():
            if other_id == old_id:
                continue
            changed = False
            matching_cost = 1
            for link in cfg["links"]:
                if link["peer_port"] == old_port:
                    matching_cost = link["cost"]
                    link["peer_port"] = new_port
                    changed = True
            if changed:
                save_config(cfg)
                if is_running(other_id):
                    post_admin(cfg["status_port"], "/admin/remove_link", {"peer_port": old_port})
                    post_admin(cfg["status_port"], "/admin/add_link", {"peer_port": new_port, "cost": matching_cost})

    old_path = CONFIGS_DIR / f"{old_id}.json"
    if old_path.exists():
        old_path.unlink()

    new_config = {
        "router_id": new_id,
        "port": new_port,
        "status_port": new_status_port,
        "links": old_config["links"],
    }
    save_config(new_config)

    processes.pop(old_id, None)
    load_router_configs()

    if was_running:
        config_path = CONFIGS_DIR / f"{new_id}.json"
        proc = subprocess.Popen([PYTHON, str(BASE_DIR / "router.py"), "--config", str(config_path)])
        processes[new_id] = proc

    return jsonify({"ok": True, "router_id": new_id})

@app.route("/api/segments")
def list_segments():
    load_segment_configs()
    return jsonify(list(segment_configs.values()))


@app.route("/api/segments/add", methods=["POST"])
def add_segment():
    load_router_configs()
    load_segment_configs()
    data = request.get_json(force=True)

    segment_id = (data.get("segment_id") or "").strip()
    members = data.get("members", [])

    if not segment_id:
        return jsonify({"ok": False, "error": "champs manquants"}), 400
    if segment_id in segment_configs:
        return jsonify({"ok": False, "error": "segment_id deja utilise"}), 400
    if len(members) < 2:
        return jsonify({"ok": False, "error": "un segment necessite au moins 2 routeurs"}), 400

    for m in members:
        if m.get("router_id") not in router_configs:
            return jsonify({"ok": False, "error": f"routeur inconnu: {m.get('router_id')}"}), 400
        if not isinstance(m.get("priority"), int) or m["priority"] < 0:
            return jsonify({"ok": False, "error": "priorite invalide"}), 400
        if not isinstance(m.get("cost"), int) or m["cost"] <= 0:
            return jsonify({"ok": False, "error": "cout invalide"}), 400

    save_segment_config({"segment_id": segment_id, "members": members})

    for m in members:
        rid = m["router_id"]
        cfg = router_configs[rid]
        peer_ports = [router_configs[o["router_id"]]["port"] for o in members if o["router_id"] != rid]

        cfg.setdefault("segments", [])
        cfg["segments"] = [s for s in cfg["segments"] if s["segment_id"] != segment_id]
        cfg["segments"].append({
            "segment_id": segment_id,
            "priority": m["priority"],
            "cost": m["cost"],
            "peer_ports": peer_ports,
        })
        save_config(cfg)

        if is_running(rid):
            post_admin(cfg["status_port"], "/admin/add_segment", {
                "segment_id": segment_id, "priority": m["priority"], "cost": m["cost"], "peer_ports": peer_ports,
            })

    load_router_configs()
    return jsonify({"ok": True})


@app.route("/api/segments/remove/<segment_id>", methods=["POST"])
def remove_segment(segment_id):
    load_router_configs()
    load_segment_configs()
    if segment_id not in segment_configs:
        return jsonify({"ok": False, "error": "segment introuvable"}), 404

    for m in segment_configs[segment_id]["members"]:
        rid = m["router_id"]
        if rid not in router_configs:
            continue
        cfg = router_configs[rid]
        cfg["segments"] = [s for s in cfg.get("segments", []) if s["segment_id"] != segment_id]
        save_config(cfg)
        if is_running(rid):
            post_admin(cfg["status_port"], "/admin/remove_segment", {"segment_id": segment_id})

    path = SEGMENTS_DIR / f"{segment_id}.json"
    if path.exists():
        path.unlink()

    load_router_configs()
    load_segment_configs()
    return jsonify({"ok": True})

if __name__ == "__main__":
    load_router_configs()
    app.run(host=HOST, port=5000, debug=False)