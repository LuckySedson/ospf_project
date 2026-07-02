    Requirements :
#pip install networkx

    Modules Python nécessaires :
- socket (UDP)
- threading (écoute + timers concurrents)
- json (sérialisation des messages et fichiers config)
- time (timestamps, timeouts)
- networkx (Dijkstra) → à installer : pip install networkx
- argparse (lire --config en CLI)
- logging (optionnel mais utile pour observer HELLO/LSA/flooding dans chaque terminal)

    test : (3 terminaux differents)
python router.py --config configs/R1.json
python router.py --config configs/R2.json
python router.py --config configs/R3.json