import json

HELLO = "HELLO"
LSA = "LSA"


def build_hello(origin, seen_neighbors):
    payload = {
        "type": HELLO,
        "origin": origin,
        "seen_neighbors": seen_neighbors,
    }
    return json.dumps(payload).encode()


def build_lsa(origin, seq, links):
    payload = {
        "type": LSA,
        "origin": origin,
        "seq": seq,
        "links": links,
    }
    return json.dumps(payload).encode()


def parse_message(data):
    try:
        return json.loads(data.decode())
    except (ValueError, UnicodeDecodeError):
        return None