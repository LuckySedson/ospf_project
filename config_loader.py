import json


def load_config(path):
    with open(path, "r") as f:
        data = json.load(f)

    required = ("router_id", "port", "links")
    for key in required:
        if key not in data:
            raise ValueError(f"Config invalide, champ manquant: {key}")

    for link in data["links"]:
        if "peer_port" not in link or "cost" not in link:
            raise ValueError("Chaque lien doit avoir 'peer_port' et 'cost'")

    return data