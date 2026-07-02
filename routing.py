import networkx as nx


def build_graph(lsdb_snapshot):
    graph = nx.Graph()
    for origin, entry in lsdb_snapshot.items():
        for neighbor, cost in entry["links"].items():
            if graph.has_edge(origin, neighbor):
                existing_cost = graph[origin][neighbor]["weight"]
                graph[origin][neighbor]["weight"] = min(existing_cost, cost)
            else:
                graph.add_edge(origin, neighbor, weight=cost)
    return graph


def compute_routing_table(graph, source):
    routing_table = {}
    if source not in graph:
        return routing_table

    lengths, paths = nx.single_source_dijkstra(graph, source, weight="weight")
    for dest, cost in lengths.items():
        if dest == source:
            continue
        path = paths[dest]
        next_hop = path[1] if len(path) > 1 else dest
        routing_table[dest] = {"next_hop": next_hop, "cost": cost}

    return routing_table