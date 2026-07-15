const POLL_INTERVAL_MS = 1500;

const canvas = document.getElementById("topology");
const ctx = canvas ? canvas.getContext("2d") : null;
const routersPanel = document.getElementById("routers-panel");

const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalMessage = document.getElementById("modal-message");
const modalConfirm = document.getElementById("modal-confirm");
const modalCancel = document.getElementById("modal-cancel");

let routersMeta = {};
let portToRouterId = {};
let lastRouterIdsKey = "";

function showConfirmModal(title, message) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalOverlay.classList.remove("hidden");

    const cleanup = (result) => {
      modalOverlay.classList.add("hidden");
      modalConfirm.removeEventListener("click", onConfirm);
      modalCancel.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlayClick);
      resolve(result);
    };

    const onConfirm = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlayClick = (e) => {
      if (e.target === modalOverlay) cleanup(false);
    };

    modalConfirm.addEventListener("click", onConfirm);
    modalCancel.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlayClick);
  });
}

async function fetchRouters() {
  const res = await fetch("/api/routers");
  const data = await res.json();
  routersMeta = {};
  portToRouterId = {};
  data.forEach((r) => {
    routersMeta[r.router_id] = r;
    portToRouterId[r.port] = r.router_id;
  });
  return data;
}

async function fetchState() {
  const res = await fetch("/api/state");
  return res.json();
}

async function startRouter(id) {
  await fetch(`/api/start/${id}`, { method: "POST" });
  refresh();
}

async function stopRouter(id) {
  await fetch(`/api/stop/${id}`, { method: "POST" });
  refresh();
}

async function removeRouter(id) {
  const confirmed = await showConfirmModal(
    "Supprimer le routeur",
    `Es-tu sûr de vouloir supprimer définitivement ${id} ? Cette action est irréversible.`
  );
  if (!confirmed) return;

  await fetch(`/api/routers/remove/${id}`, { method: "POST" });
  lastRouterIdsKey = "";
  await refresh();
}

document.getElementById("btn-start-all").addEventListener("click", async () => {
  await fetch("/api/start_all", { method: "POST" });
  refresh();
});

document.getElementById("btn-stop-all").addEventListener("click", async () => {
  await fetch("/api/stop_all", { method: "POST" });
  refresh();
});

document.getElementById("btn-add-router").addEventListener("click", async () => {
  const router_id = document.getElementById("new-router-id").value.trim();
  const port = parseInt(document.getElementById("new-router-port").value, 10);
  const status_port = parseInt(document.getElementById("new-router-status-port").value, 10);

  if (!router_id || !port || !status_port) {
    alert("Merci de remplir l'ID, le port UDP et le port de statut.");
    return;
  }

  const links = [];
  document.querySelectorAll(".link-checkbox").forEach((cb) => {
    if (cb.checked) {
      const peer = cb.dataset.peer;
      const costInput = document.querySelector(`.link-cost[data-peer="${peer}"]`);
      links.push({ peer_id: peer, cost: parseInt(costInput.value, 10) || 1 });
    }
  });

  const res = await fetch("/api/routers/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ router_id, port, status_port, links }),
  });
  const data = await res.json();

  if (!data.ok) {
    alert("Erreur: " + data.error);
    return;
  }

  document.getElementById("new-router-id").value = "";
  document.getElementById("new-router-port").value = "";
  document.getElementById("new-router-status-port").value = "";
  lastRouterIdsKey = "";
  refresh();
});

function renderAddRouterForm() {
  const container = document.getElementById("new-router-links");
  container.innerHTML = "";
  Object.keys(routersMeta)
    .sort()
    .forEach((id) => {
      const row = document.createElement("div");
      row.className = "link-row";
      row.innerHTML = `
        <label>
          <input type="checkbox" class="link-checkbox" data-peer="${id}" />
          Lien vers ${id}
        </label>
        <input type="number" class="link-cost" data-peer="${id}" value="1" min="1" />
      `;
      container.appendChild(row);
    });
}

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
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const routerIds = Object.keys(routersMeta).sort();
  if (routerIds.length === 0) return;

  const positions = computePositions(routerIds);

  routerIds.forEach((id) => {
    const config = routersMeta[id];
    config.links.forEach((link) => {
      const peerId = portToRouterId[link.peer_port];
      if (!peerId || !positions[peerId]) return;
      drawEdge(positions[id], positions[peerId], "#3a4552", true, null);
    });
  });

  routerIds.forEach((id) => {
    const s = state[id];
    if (!s || !s.neighbors) return;
    Object.values(s.neighbors).forEach((n) => {
      if (n.state === "FULL" && n.peer_id && positions[n.peer_id]) {
        drawEdge(positions[id], positions[n.peer_id], "#33e6a8", false, n.cost);
      }
    });
  });

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
          <button class="btn" data-action="remove" data-id="${id}">Suppr.</button>
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
      if (btn.dataset.action === "remove") removeRouter(btn.dataset.id);
    });
  });

  return card;
}

function renderRouterCards(state) {
  routersPanel.innerHTML = "";
  Object.keys(routersMeta)
    .sort()
    .forEach((id) => {
      routersPanel.appendChild(renderRouterCard(id, state[id]));
    });
}

async function refresh() {
  try {
    await fetchRouters();

    const idsKey = Object.keys(routersMeta).sort().join(",");
    if (idsKey !== lastRouterIdsKey) {
      renderAddRouterForm();
      lastRouterIdsKey = idsKey;
    }

    const state = await fetchState();
    drawTopology(state);
    renderRouterCards(state);
  } catch (error) {
    console.error("CRASH DANS REFRESH:", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
});