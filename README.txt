    Requirements :

Python version 3.14.5
#pip install networkx
#pip install colorama

    Lancement du projet :

1. Dans le repertoire :
cd ospf_project/

2.Créer un environnement virtuel :
python -m venv .venv

3. Activer l'environnement virtuel :
(PowerShell) : .venv\Scripts\Activate.ps1
(cmd) : .venv\Scripts\activate.bat

4. Reinstall les bibliotheques :
pip install flask networkx

5. Lancer le Flask Python :
#python orchestrator.py

-> http://127.0.0.1:5000

    Modules Python nécessaires :

- socket (UDP=520, AF_INET, socket.SOCK_DGRAM)
- threading (écoute + timers concurrents)
- networkx (Djikstra)

    bande passante :

10 Mbps = 10 000
100 Mbps = 1 000
1 Gbps = 100
10 Gbps = 10
100 Gbps = 1
