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

let selectedSourceId = null;
let selectedDestId = null;
let activeShortestPath = [];
let latestState = {};
let latestPositions = {};

let activePackets = [];

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

function getPhysicalLinks() {
  const links = [];
  const seen = new Set();
  Object.keys(routersMeta).forEach((id) => {
    const config = routersMeta[id];
    if (config && config.links) {
      config.links.forEach((link) => {
        const peerId = portToRouterId[link.peer_port];
        if (peerId) {
          const key = id < peerId ? `${id}-${peerId}` : `${peerId}-${id}`;
          if (!seen.has(key)) {
            links.push({ from: id, to: peerId, cost: link.cost });
            seen.add(key);
          }
        }
      });
    }
  });
  return links;
}

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

  if (state) {
    latestState = state;
  } else {
    state = latestState || {};
  }

  const routerIds = Object.keys(routersMeta).sort();
  if (routerIds.length === 0) return;

  const positions = computePositions(routerIds);
  latestPositions = positions;

  const drawnDashed = new Set();
  routerIds.forEach((id) => {
    const config = routersMeta[id];
    if (config && config.links) {
      config.links.forEach((link) => {
        const peerId = portToRouterId[link.peer_port];
        if (!peerId || !positions[peerId]) return;
        const key = id < peerId ? `${id}-${peerId}` : `${peerId}-${id}`;
        if (!drawnDashed.has(key)) {
          drawEdge(positions[id], positions[peerId], "#3a4552", true, null);
          drawnDashed.add(key);
        }
      });
    }
  });

  const drawnFull = new Set();
  routerIds.forEach((id) => {
    const s = state[id];
    if (!s || !s.neighbors) return;
    Object.values(s.neighbors).forEach((n) => {
      if (n.state === "FULL" && n.peer_id && positions[n.peer_id]) {
        const key = id < n.peer_id ? `${id}-${n.peer_id}` : `${n.peer_id}-${id}`;
        if (!drawnFull.has(key)) {
          const indexA = activeShortestPath.indexOf(id);
          const indexB = activeShortestPath.indexOf(n.peer_id);
          const isShortestPathLink = (indexA !== -1 && indexB !== -1 && Math.abs(indexA - indexB) === 1);

          if (isShortestPathLink) {
            ctx.shadowColor = "#ffd700";
            ctx.shadowBlur = 12;
            drawEdge(positions[id], positions[n.peer_id], "#ffd700", false, n.cost);
            ctx.shadowBlur = 0;
          } else {
            drawEdge(positions[id], positions[n.peer_id], "#33e6a8", false, n.cost);
          }
          drawnFull.add(key);
        }
      }
    });
  });

  routerIds.forEach((id) => {
    const pos = positions[id];
    const running = state[id] && state[id].running;
    
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 26, 0, 2 * Math.PI);

    if (id === selectedSourceId) {
      ctx.fillStyle = "#3498db";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
    } else if (id === selectedDestId) {
      ctx.fillStyle = "#e74c3c";
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 4;
    } else {
      ctx.fillStyle = running ? "#121821" : "#0b0f14";
      ctx.strokeStyle = running ? "#33e6a8" : "#3a4552";
      ctx.lineWidth = 2;
    }
    
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = (id === selectedSourceId || id === selectedDestId) ? "#ffffff" : (running ? "#d6e2ef" : "#6b7d8f");
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

function getDistanceToSegment(x, y, x1, y1, x2, y2) {
    const A = x - x1;
    const B = y - y1;
    const C = x2 - x1;
    const D = y2 - y1;

    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;

    let xx, yy;
    if (param < 0) {
        xx = x1;
        yy = y1;
    } else if (param > 1) {
        xx = x2;
        yy = y2;
    } else {
        xx = x1 + param * C;
        yy = y1 + param * D;
    }

    const dx = x - xx;
    const dy = y - yy;
    return Math.sqrt(dx * dx + dy * dy);
}

function computeActiveShortestPath() {
  if (!selectedSourceId || !selectedDestId) {
    activeShortestPath = [];
    return;
  }

  const path = [];
  let current = selectedSourceId;
  const visited = new Set();
  const maxHops = 10;

  while (current && current !== selectedDestId && path.length < maxHops) {
    if (visited.has(current)) break;
    visited.add(current);
    path.push(current);

    const rState = latestState[current];
    if (!rState || !rState.routing_table || !rState.routing_table[selectedDestId]) {
      activeShortestPath = [];
      return;
    }

    current = rState.routing_table[selectedDestId].next_hop;
  }

  if (current === selectedDestId) {
    path.push(selectedDestId);
    activeShortestPath = path;
  } else {
    activeShortestPath = [];
  }
}

canvas.addEventListener("click", async (event) => {
  const rect = canvas.getBoundingClientRect();
  
  const mouseX = (event.clientX - rect.left) * (canvas.width / rect.width);
  const mouseY = (event.clientY - rect.top) * (canvas.height / rect.height);

  let clickedRouter = null;

  for (const [id, pos] of Object.entries(latestPositions)) {
    const dist = Math.hypot(mouseX - pos.x, mouseY - pos.y);
    if (dist < 26) {
      clickedRouter = { router_id: id, x: pos.x, y: pos.y };
      break;
    }
  }

  if (clickedRouter) {
    const clickedId = clickedRouter.router_id;

    if (event.shiftKey) {
      if (selectedSourceId === clickedId) {
        alert("La destination ne peut pas être identique à la source !");
        return;
      }
      selectedDestId = clickedId;
    } else {
      if (!selectedSourceId) {
        selectedSourceId = clickedId;
      } else if (selectedSourceId && !selectedDestId) {
        if (clickedId === selectedSourceId) {
          selectedSourceId = null;
        } else {
          selectedDestId = clickedId;
        }
      } else {
        selectedSourceId = clickedId;
        selectedDestId = null;
      }
    }
    computeActiveShortestPath();
    drawTopology();
    return;
  }

  const links = getPhysicalLinks();

  for (const link of links) {
    const n1 = latestPositions[link.from];
    const n2 = latestPositions[link.to];
    if (!n1 || !n2) continue;

    const distToLink = getDistanceToSegment(mouseX, mouseY, n1.x, n1.y, n2.x, n2.y);
    if (distToLink < 8) {
      const newCostStr = prompt(`Modifier le coût du lien ${link.from} <-> ${link.to} :`, link.cost);
      if (newCostStr === null) return;

      const newCost = parseInt(newCostStr, 10);
      if (isNaN(newCost) || newCost <= 0) {
        alert("Veuillez entrer un coût entier strictement supérieur à 0.");
        return;
      }

      try {
        const response = await fetch("/api/update_link_cost", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ r1: link.from, r2: link.to, cost: newCost })
        });
        const res = await response.json();
        if (res.ok) {
          if (routersMeta[link.from]) {
            const l = routersMeta[link.from].links.find(x => portToRouterId[x.peer_port] === link.to);
            if (l) l.cost = newCost;
          }
          if (routersMeta[link.to]) {
            const l = routersMeta[link.to].links.find(x => portToRouterId[x.peer_port] === link.from);
            if (l) l.cost = newCost;
          }
          
          computeActiveShortestPath();
          drawTopology();
        } else {
          alert(`Erreur : ${res.error}`);
        }
      } catch (err) {
        console.error(err);
        alert("Erreur réseau lors de la mise à jour du coût.");
      }
      return;
    }
  }

  selectedSourceId = null;
  selectedDestId = null;
  activeShortestPath = [];
  drawTopology();
});

if (canvas) {
  canvas.addEventListener("mousemove", (event) => {
    const rect = canvas.getBoundingClientRect();
    
    const mouseX = (event.clientX - rect.left) * (canvas.width / rect.width);
    const mouseY = (event.clientY - rect.top) * (canvas.height / rect.height);

    let isHovered = false;

    for (const [id, pos] of Object.entries(latestPositions)) {
      const dist = Math.hypot(mouseX - pos.x, mouseY - pos.y);
      if (dist < 26) {
        isHovered = true;
        break;
      }
    }

    if (!isHovered) {
      const links = getPhysicalLinks();

      for (const link of links) {
        const n1 = latestPositions[link.from];
        const n2 = latestPositions[link.to];
        if (!n1 || !n2) continue;

        const distToLink = getDistanceToSegment(mouseX, mouseY, n1.x, n1.y, n2.x, n2.y);
        if (distToLink < 8) {
          isHovered = true;
          break;
        }
      }
    }

    canvas.style.cursor = isHovered ? "pointer" : "default";
  });
}

function spawnPacket(fromId, toId, type) {
  const startPos = latestPositions[fromId];
  const endPos = latestPositions[toId];
  if (!startPos || !endPos) return;

  activePackets.push({
    fromId,
    toId,
    startX: startPos.x,
    startY: startPos.y,
    endX: endPos.x,
    endY: endPos.y,
    progress: 0,
    speed: 0.012 + Math.random() * 0.01,
    color: type === "HELLO" ? "#33e6a8" : "#ffd700",
    size: type === "HELLO" ? 4.5 : 6
  });
}

function triggerPacketsFromState(state) {
  Object.keys(state).forEach((routerId) => {
    const rState = state[routerId];
    if (!rState || !rState.neighbors || !rState.running) return;

    Object.values(rState.neighbors).forEach((neighbor) => {
      if (neighbor.state === "FULL" && neighbor.peer_id) {
        const rand = Math.random();
        
        if (rand < 0.25) {
          spawnPacket(routerId, neighbor.peer_id, "HELLO");
        } 
        else if (rand < 0.35) {
          spawnPacket(routerId, neighbor.peer_id, "LSA");
        }
      }
    });
  });
}

function updateAndDrawPackets() {
  if (!ctx) return;
  
  activePackets = activePackets.filter((packet) => {
    packet.progress += packet.speed;
    
    if (packet.progress >= 1) {
      if (typeof packet.onArrive === "function") {
        packet.onArrive();
      }
      return false;
    }

    const currentX = packet.startX + (packet.endX - packet.startX) * packet.progress;
    const currentY = packet.startY + (packet.endY - packet.startY) * packet.progress;

    ctx.save();
    ctx.beginPath();
    ctx.arc(currentX, currentY, packet.size, 0, 2 * Math.PI);
    ctx.fillStyle = packet.color;
    
    ctx.shadowColor = packet.color;
    ctx.shadowBlur = 10;
    
    ctx.fill();
    ctx.restore();

    return true;
  });
}

function logToConsole(text, type = "info") {
  const consoleBody = document.getElementById("console-output");
  if (!consoleBody) return;
  
  const line = document.createElement("div");
  line.className = type + "-msg";
  
  const now = new Date();
  const timeStr = `[${now.toLocaleTimeString()}] `;
  
  line.textContent = timeStr + text;
  consoleBody.appendChild(line);
  
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

function clearConsole() {
  const consoleBody = document.getElementById("console-output");
  if (consoleBody) consoleBody.innerHTML = "";
}

function spawnPathPacket(path, index, isReply) {
  if (index >= path.length - 1) return;

  const fromId = path[index];
  const toId = path[index + 1];
  const startPos = latestPositions[fromId];
  const endPos = latestPositions[toId];
  if (!startPos || !endPos) return;

  activePackets.push({
    fromId,
    toId,
    startX: startPos.x,
    startY: startPos.y,
    endX: endPos.x,
    endY: endPos.y,
    progress: 0,
    speed: 0.025,
    color: isReply ? "#33e6a8" : "#3498db",
    size: 7,
    onArrive: () => {
      const stepType = isReply ? "RETOUR" : "ALLER";
      logToConsole(`[${stepType}] Transit : Routeur ${fromId} ➔ Routeur ${toId}`, "system");

      if (index + 1 < path.length - 1) {
        spawnPathPacket(path, index + 1, isReply);
      } 
      else if (!isReply) {
        logToConsole(`[DESTINATION] Routeur ${toId} a reçu l'Echo Request.`, "success");
        logToConsole(`Renvoi de l'Echo Reply (Pong vert)...`, "info");
        
        const replyPath = [...path].reverse();
        setTimeout(() => {
          spawnPathPacket(replyPath, 0, true);
        }, 300);
      } 
      else {
        const fakeRtt = Math.round((path.length - 1) * 15 + Math.random() * 10);
        
        logToConsole(`Réponse de Routeur ${selectedDestId} : octets=32 temps=${fakeRtt}ms TTL=64`, "success");
        logToConsole(`--------------------------------------------------`, "system");
        logToConsole(`Statistiques Ping : Envoyés = 1, Reçus = 1, Perdus = 0 (0% de perte)`, "success");
      }
    }
  });
}

function startPingSimulation() {
  const consoleEl = document.getElementById("ping-console");
  const leftCol = document.querySelector(".left-column");
  
  if (consoleEl) {
    consoleEl.classList.remove("hidden");
    consoleEl.classList.remove("minimized");
    
    if (leftCol) {
      leftCol.scrollTo({
        top: consoleEl.offsetTop - 10,
        behavior: "smooth"
      });
    }
  }
  
  clearConsole();
  
  if (!selectedSourceId || !selectedDestId || !activeShortestPath || activeShortestPath.length === 0) {
    logToConsole("ERREUR : Impossible de lancer la commande ping.", "warning");
    logToConsole("Raison : Aucune route active détectée.", "system");
    logToConsole("Action : Sélectionnez une Source (Clic gauche) et une Destination (Shift + Clic) sur un chemin valide (jaune).", "info");
    return;
  }

  const isSourceRunning = latestState[selectedSourceId] && latestState[selectedSourceId].running;
  const isDestRunning = latestState[selectedDestId] && latestState[selectedDestId].running;
  if (!isSourceRunning || !isDestRunning) {
    logToConsole("ERREUR : Échec de la transmission du ping.", "warning");
    logToConsole("Raison : La source ou la destination est éteinte.", "system");
    return;
  }
  
  logToConsole(`Envoi d'une requête ping sur Routeur ${selectedDestId} avec 32 octets de données :`, "info");
  logToConsole(`Route identifiée par OSPF : ${activeShortestPath.join(" ➔ ")}`, "system");
  
  spawnPathPacket(activeShortestPath, 0, false);
}

function animationLoop() {
  drawTopology();
  updateAndDrawPackets();
  
  requestAnimationFrame(animationLoop);
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
    latestState = state;
    
    triggerPacketsFromState(state);
    
    renderRouterCards(state);
  } catch (error) {
    console.error("CRASH DANS REFRESH:", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  refresh();
  setInterval(refresh, POLL_INTERVAL_MS);
  
  document.getElementById("btn-ping").addEventListener("click", startPingSimulation);
  
  const btnClose = document.getElementById("btn-close-terminal");
  if (btnClose) {
    btnClose.addEventListener("click", () => {
      document.getElementById("ping-console").classList.add("hidden");
    });
  }

  const btnMinimize = document.getElementById("btn-minimize-terminal");
  if (btnMinimize) {
    btnMinimize.addEventListener("click", () => {
      document.getElementById("ping-console").classList.toggle("minimized");
    });
  }
  
  requestAnimationFrame(animationLoop);
});