console.log("=== [OSPF] script.js est chargé et s'exécute ! ===");

const POLL_INTERVAL_MS = 1500;

const canvas = document.getElementById("topology");
if (!canvas) {
  console.error("ERREUR CRITIQUE : L'élément <canvas id='topology'> est introuvable dans le HTML !");
}
const ctx = canvas ? canvas.getContext("2d") : null;
const routersPanel = document.getElementById("routers-panel");
if (!routersPanel) {
  console.error("ERREUR CRITIQUE : L'élément id 'routers-panel' est introuvable !");
}

let routersMeta = {};
let portToRouterId = {};

async function fetchRouters() {
  console.log("[API] Appel de /api/routers...");
  const res = await fetch("/api/routers");
  const data = await res.json();
  console.log("[API] Données reçues pour les routeurs :", data);
  routersMeta = {};
  portToRouterId = {};
  data.forEach((r) => {
    routersMeta[r.router_id] = r;
    portToRouterId[r.port] = r.router_id;
  });
  return data;
}

async function fetchState() {
  console.log("[API] Appel de /api/state...");
  const res = await fetch("/api/state");
  const data = await res.json();
  console.log("[API] État global reçu :", data);
  return data;
}

async function startRouter(id) {
  console.log(`[Action] Démarrage du routeur ${id}...`);
  await fetch(`/api/start/${id}`, { method: "POST" });
  refresh();
}

async function stopRouter(id) {
  console.log(`[Action] Arrêt du routeur ${id}...`);
  await fetch(`/api/stop/${id}`, { method: "POST" });
  refresh();
}

document.getElementById("btn-start-all")?.addEventListener("click", async () => {
  console.log("[Action Global] Démarrer tous les routeurs...");
  await fetch("/api/start_all", { method: "POST" });
  refresh();
});

document.getElementById("btn-stop-all")?.addEventListener("click", async () => {
  console.log("[Action Global] Arrêter tous les routeurs...");
  await fetch("/api/stop_all", { method: "POST" });
  refresh();
});

function computePositions(routerIds) {
  const positions = {};
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 60;
  const n = routerIds.length;
  routerIds.forEach((id, i) => {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    positions[id] = {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    };
  });
  return positions;
}

function drawTopology(state) {
  if (!ctx) return;
  console.log("[Canvas] Dessin de la topologie en cours...");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  const routerIds = Object.keys(routersMeta).sort();
  if (routerIds.length === 0) {
    console.warn("[Canvas] Aucun routeur à dessiner dans routersMeta.");
    return;
  }

  const positions = computePositions(routerIds);

  // liens configurés (potentiels) en pointillés gris
  routerIds.forEach((id) => {
    const config = routersMeta[id];
    config.links.forEach((link) => {
      const peerId = portToRouterId[link.peer_port];
      if (!peerId || !positions[peerId]) return;
      drawEdge(positions[id], positions[peerId], "#3a4552", true, null);
    });
  });

  // liens actifs (FULL) en vert plein, avec le coût
  routerIds.forEach((id) => {
    const s = state[id];
    if (!s || !s.neighbors) return;
    Object.values(s.neighbors).forEach((n) => {
      if (n.state === "FULL" && n.peer_id && positions[n.peer_id]) {
        drawEdge(positions[id], positions[n.peer_id], "#33e6a8", false, n.cost);
      }
    });
  });

  // noeuds
  routerIds.forEach((id) => {
    const pos = positions[id];
    const running = state[id] && state[id].running;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 26, 0, 2 * Math.PI);
    ctx.fillStyle = running ? "#121821" : "#0b0f14";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = running ? "#33e6a8" : "#3a4552";
    ctx.stroke();

    ctx.fillStyle = running ? "#d6e2ef" : "#6b7d8f";
    ctx.font = "13px Consolas";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(id, pos.x, pos.y);
  });
  console.log("[Canvas] Dessin terminé.");
}

function drawEdge(a, b, color, dashed, label) {
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = dashed ? 1 : 2;
  if (dashed) ctx.setLineDash([4, 4]);
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();

  if (label !== null && label !== undefined) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    ctx.fillStyle = "#33e6a8";
    ctx.font = "11px Consolas";
    ctx.textAlign = "center";
    ctx.fillText(String(label), mx, my - 6);
  }
}

function stateClass(state) {
  if (state === "FULL") return "state-full";
  if (state === "INIT") return "state-init";
  return "state-down";
}

function renderRouterCard(id, s) {
  const running = s && s.running;
  const card = document.createElement("div");
  card.className = "router-card";

  const neighborsRows = s && s.neighbors
    ? Object.values(s.neighbors)
        .map(
          (n) => `<tr>
            <td>${n.peer_id ?? "-"}</td>
            <td class="${stateClass(n.state)}">${n.state}</td>
            <td>${n.cost}</td>
          </tr>`
        )
        .join("")
    : "";

  const lsdbRows = s && s.lsdb
    ? Object.entries(s.lsdb)
        .map(
          ([origin, entry]) => `<tr>
            <td>${origin}</td>
            <td>${entry.seq}</td>
            <td>${Object.entries(entry.links).map(([k, v]) => `${k}:${v}`).join(", ")}</td>
          </tr>`
        )
        .join("")
    : "";

  const routingRows = s && s.routing_table
    ? Object.entries(s.routing_table)
        .map(
          ([dest, r]) => `<tr>
            <td>${dest}</td>
            <td>${r.next_hop}</td>
            <td>${r.cost}</td>
          </tr>`
        )
        .join("")
    : "";

  card.innerHTML = `
    <div class="router-card-header">
      <h2>${id}</h2>
      <div>
        <span class="badge ${running ? "running" : "stopped"}">${running ? "ACTIF" : "ARRETE"}</span>
        <span class="router-actions">
          <button class="btn btn-primary" data-action="start" data-id="${id}">Start</button>
          <button class="btn btn-danger" data-action="stop" data-id="${id}">Stop</button>
        </span>
      </div>
    </div>

    <div class="section-label">Voisins</div>
    <table>
      <thead><tr><th>Peer</th><th>Etat</th><th>Cout</th></tr></thead>
      <tbody>${neighborsRows}</tbody>
    </table>

    <div class="section-label">LSDB</div>
    <table>
      <thead><tr><th>Origine</th><th>Seq</th><th>Liens</th></tr></thead>
      <tbody>${lsdbRows}</tbody>
    </table>

    <div class="section-label">Table de routage</div>
    <table>
      <thead><tr><th>Dest</th><th>Next hop</th><th>Cout</th></tr></thead>
      <tbody>${routingRows}</tbody>
    </table>
  `;

  card.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.action === "start") startRouter(btn.dataset.id);
      if (btn.dataset.action === "stop") stopRouter(btn.dataset.id);
    });
  });

  return card;
}

function renderRouterCards(state) {
  if (!routersPanel) return;
  console.log("[DOM] Rendu des cartes routeurs...");
  routersPanel.innerHTML = "";
  Object.keys(routersMeta)
    .sort()
    .forEach((id) => {
      routersPanel.appendChild(renderRouterCard(id, state[id]));
    });
}

async function refresh() {
  try {
    console.log("=== [Cycle Refresh] Début ===");
    await fetchRouters();
    const state = await fetchState();
    drawTopology(state);
    renderRouterCards(state);
    console.log("=== [Cycle Refresh] Succès ===");
  } catch (error) {
    console.error("❌ CRASH DANS REFRESH :", error);
  }
}

// Lancement au chargement du DOM
window.addEventListener("DOMContentLoaded", () => {
  console.log("[DOM] Prêt, lancement du premier refresh.");
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
});