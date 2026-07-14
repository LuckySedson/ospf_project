import json
import subprocess
import sys
import urllib.request
import urllib.error
from pathlib import Path

from flask import Flask, jsonify, send_from_directory

BASE_DIR = Path(__file__).parent
CONFIGS_DIR = BASE_DIR / "configs"
STATIC_DIR = BASE_DIR / "static"
PYTHON = sys.executable
HOST = "127.0.0.1"

app = Flask(__name__, static_folder=None)

processes = {}
router_configs = {}


def load_router_configs():
    router_configs.clear()
    for path in sorted(CONFIGS_DIR.glob("*.json")):
        with open(path) as f:
            config = json.load(f)
        router_configs[config["router_id"]] = config


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


if __name__ == "__main__":
    load_router_configs()
    app.run(host=HOST, port=5000, debug=False)