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

let justDragged = false;

let nodePositions = {};
let draggingId = null;
let dragStart = null;
let dragMoved = false;

let activePackets = [];
let segmentsMeta = {};

let activePathGraph = {};

const modalIcon = document.getElementById("modal-icon");
const modalInput = document.getElementById("modal-input");

const modalSelect = document.getElementById("modal-select");

const BANDWIDTH_PRESETS = [
  { label: "10 Mbps", value: 10 },
  { label: "100 Mbps", value: 100 },
  { label: "1 Gbps", value: 1000 },
  { label: "10 Gbps", value: 10000 },
  { label: "100 Gbps", value: 100000 },
  { label: "Personnalisé...", value: "custom" },
];

function formatBandwidth(mbps) {
  if (!mbps) return "—";
  return mbps >= 1000 ? mbps / 1000 + " Gbps" : mbps + " Mbps";
}

function showModal({
  type = "confirm",
  title = "",
  message = "",
  icon = "⚠",
  iconClass = "icon-error",
  inputValue = "",
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  confirmClass = "btn-danger",
} = {}) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalIcon.textContent = icon;
    modalIcon.className = "modal-icon " + iconClass;

    modalConfirm.textContent = confirmLabel;
    modalConfirm.className = "btn " + confirmClass;

    if (type === "prompt") {
      modalInput.classList.remove("hidden");
      modalInput.value = inputValue;
    } else {
      modalInput.classList.add("hidden");
    }

    if (type === "alert") {
      modalCancel.classList.add("hidden");
    } else {
      modalCancel.classList.remove("hidden");
      modalCancel.textContent = cancelLabel;
    }

    modalOverlay.classList.remove("hidden");
    if (type === "prompt") setTimeout(() => modalInput.focus(), 50);

    const cleanup = (result) => {
      modalOverlay.classList.add("hidden");
      modalConfirm.removeEventListener("click", onConfirm);
      modalCancel.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlayClick);
      modalInput.removeEventListener("keydown", onKeydown);
      resolve(result);
    };

    const onConfirm = () => cleanup(type === "prompt" ? modalInput.value : true);
    const onCancel = () => cleanup(type === "prompt" ? null : false);
    const onOverlayClick = (e) => {
      if (e.target === modalOverlay) cleanup(type === "prompt" ? null : false);
    };
    const onKeydown = (e) => {
      if (e.key === "Enter") onConfirm();
    };

    modalConfirm.addEventListener("click", onConfirm);
    modalCancel.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlayClick);
    modalInput.addEventListener("keydown", onKeydown);
  });
}

function showConfirm(title, message) {
  return showModal({ type: "confirm", title, message, icon: "⚠", iconClass: "icon-error", confirmLabel: "Confirmer", confirmClass: "btn-danger" });
}

function showAlert(title, message, kind = "error") {
  const icons = { error: "✕", success: "✓", info: "ℹ" };
  const classes = { error: "icon-error", success: "icon-success", info: "icon-info" };
  return showModal({ type: "alert", title, message, icon: icons[kind], iconClass: classes[kind], confirmLabel: "OK", confirmClass: kind === "success" ? "btn-primary" : "btn-danger" });
}

function showPrompt(title, message, defaultValue) {
  return showModal({ type: "prompt", title, message, icon: "✎", iconClass: "icon-info", inputValue: defaultValue, confirmLabel: "Appliquer", confirmClass: "btn-primary" });
}

function showBandwidthModal(title, message, currentBandwidth) {
  return new Promise((resolve) => {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalIcon.textContent = "📶";
    modalIcon.className = "modal-icon icon-info";
    modalConfirm.textContent = "Appliquer";
    modalConfirm.className = "btn btn-primary";
    modalCancel.classList.remove("hidden");
    modalCancel.textContent = "Annuler";

    modalSelect.innerHTML = "";
    BANDWIDTH_PRESETS.forEach((opt) => {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      modalSelect.appendChild(o);
    });
    const preset = BANDWIDTH_PRESETS.find((o) => o.value === currentBandwidth);
    modalSelect.value = preset ? preset.value : "custom";
    modalSelect.classList.remove("hidden");

    const syncCustomInput = () => {
      if (modalSelect.value === "custom") {
        modalInput.classList.remove("hidden");
        modalInput.value = preset ? "" : currentBandwidth || "";
      } else {
        modalInput.classList.add("hidden");
      }
    };
    syncCustomInput();

    modalOverlay.classList.remove("hidden");

    const cleanup = (result) => {
      modalOverlay.classList.add("hidden");
      modalSelect.classList.add("hidden");
      modalInput.classList.add("hidden");
      modalConfirm.removeEventListener("click", onConfirm);
      modalCancel.removeEventListener("click", onCancel);
      modalOverlay.removeEventListener("click", onOverlayClick);
      modalSelect.removeEventListener("change", syncCustomInput);
      resolve(result);
    };

    const onConfirm = () => {
      const bw = modalSelect.value === "custom" ? parseInt(modalInput.value, 10) : parseInt(modalSelect.value, 10);
      if (!Number.isFinite(bw) || bw <= 0) {
        cleanup(null);
        return;
      }
      cleanup(bw);
    };
    const onCancel = () => cleanup(null);
    const onOverlayClick = (e) => { if (e.target === modalOverlay) cleanup(null); };

    modalSelect.addEventListener("change", syncCustomInput);
    modalConfirm.addEventListener("click", onConfirm);
    modalCancel.addEventListener("click", onCancel);
    modalOverlay.addEventListener("click", onOverlayClick);
  });
}

function friendlyError(rawError) {
  const map = {
    "champs manquants": "Merci de remplir tous les champs obligatoires.",
    "router_id deja utilise": "Ce nom de routeur (ID) est déjà utilisé par un autre routeur.",
    "port deja utilise": "Le port UDP ou le port de statut choisi est déjà utilisé par un autre routeur.",
    "adresse ip invalide": "L'adresse IP saisie n'est pas valide (format attendu : X.X.X.X).",
    "adresse ip deja utilisee": "Cette adresse IP est déjà utilisée par un autre routeur.",
  };
  return map[rawError] || rawError;
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

async function fetchSegments() {
  const res = await fetch("/api/segments");
  const data = await res.json();
  segmentsMeta = {};
  data.forEach((s) => { segmentsMeta[s.segment_id] = s; });
  return data;
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
  const confirmed = await showConfirm(
    "Supprimer le routeur",
    `Es-tu sûr de vouloir supprimer définitivement ${id} ? Cette action est irréversible.`
  );
  if (!confirmed) return;

  await fetch(`/api/routers/remove/${id}`, { method: "POST" });
  lastRouterIdsKey = "";
  await refresh();

  await showAlert("Routeur supprimé", `Le routeur ${id} a bien été supprimé.`, "success");
}

const editModalOverlay = document.getElementById("edit-modal-overlay");
const editRouterIdInput = document.getElementById("edit-router-id");
const editRouterPortInput = document.getElementById("edit-router-port");
const editRouterStatusPortInput = document.getElementById("edit-router-status-port");
const editModalConfirm = document.getElementById("edit-modal-confirm");
const editModalCancel = document.getElementById("edit-modal-cancel");

function openEditRouterModal(id) {
  const meta = routersMeta[id];
  const editRouterIpInput = document.getElementById("edit-router-ip");
  if (!meta) return;

  editRouterIdInput.value = id;
  editRouterPortInput.value = meta.port;
  editRouterStatusPortInput.value = meta.status_port;
  editRouterIpInput.value = meta.ip || "";
  editModalOverlay.classList.remove("hidden");

  const cleanup = () => {
    editModalOverlay.classList.add("hidden");
    editModalConfirm.removeEventListener("click", onConfirm);
    editModalCancel.removeEventListener("click", onCancel);
    editModalOverlay.removeEventListener("click", onOverlayClick);
  };

  const onConfirm = async () => {
    const newId = editRouterIdInput.value.trim();
    const newPort = parseInt(editRouterPortInput.value, 10);
    const newStatusPort = parseInt(editRouterStatusPortInput.value, 10);
    const newIp = editRouterIpInput.value.trim();

    if (!newId || !newPort || !newStatusPort) {
      await showAlert("Champs manquants", "Merci de remplir l'ID, le port UDP et le port de statut.", "error");
      return;
    }

    cleanup();

    const res = await fetch(`/api/routers/edit/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ router_id: newId, port: newPort, status_port: newStatusPort, ip: newIp }),
    });
    const data = await res.json();

    if (!data.ok) {
      await showAlert("Impossible de modifier le routeur", friendlyError(data.error), "error");
      return;
    }

    lastRouterIdsKey = "";
    if (nodePositions[id]) {
      nodePositions[newId] = nodePositions[id];
      delete nodePositions[id];
    }
    await refresh();
    await showAlert("Routeur modifié", `${id} a bien été mis à jour${newId !== id ? ` (nouveau nom : ${newId})` : ""}.`, "success");
  };

  const onCancel = () => cleanup();
  const onOverlayClick = (e) => { if (e.target === editModalOverlay) cleanup(); };

  editModalConfirm.addEventListener("click", onConfirm);
  editModalCancel.addEventListener("click", onCancel);
  editModalOverlay.addEventListener("click", onOverlayClick);
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
  const ip = document.getElementById("new-router-ip").value.trim();

  if (!router_id || !port || !status_port) {
    await showAlert("Champs manquants", "Merci de remplir l'ID, le port UDP et le port de statut.", "error");
    return;
  }

  const links = [];
  document.querySelectorAll(".link-checkbox").forEach((cb) => {
    if (cb.checked) {
      const peer = cb.dataset.peer;
      const bwSelect = document.querySelector(`.link-bandwidth[data-peer="${peer}"]`);
      links.push({ peer_id: peer, bandwidth: parseInt(bwSelect.value, 10) });
    }
  });

  const res = await fetch("/api/routers/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ router_id, port, status_port, ip, links }),
  });
  const data = await res.json();

  if (!data.ok) {
    await showAlert("Impossible d'ajouter le routeur", friendlyError(data.error), "error");
    return;
  }

  document.getElementById("new-router-id").value = "";
  document.getElementById("new-router-port").value = "";
  document.getElementById("new-router-status-port").value = "";
  lastRouterIdsKey = "";
  await refresh();

  await showAlert("Routeur ajouté", `Le routeur ${router_id} a été créé avec succès.`, "success");
  document.getElementById("new-router-ip").value = "";
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
        <select class="link-bandwidth" data-peer="${id}">
          <option value="10">10 Mbps</option>
          <option value="100">100 Mbps</option>
          <option value="1000" selected>1 Gbps</option>
          <option value="10000">10 Gbps</option>
          <option value="100000">100 Gbps</option>
        </select>
      `;
      container.appendChild(row);
    });
}

function renderAddSegmentForm() {
  const container = document.getElementById("new-segment-members");
  container.innerHTML = "";
  Object.keys(routersMeta).sort().forEach((id) => {
    const row = document.createElement("div");
    row.className = "segment-member-row";
    row.innerHTML = `
      <label><input type="checkbox" class="segment-member-checkbox" data-router="${id}" /> ${id}</label>
      Priorité <input type="number" class="segment-priority" data-router="${id}" value="1" min="0" />
      Coût <input type="number" class="segment-cost" data-router="${id}" value="1" min="1" />
    `;
    container.appendChild(row);
  });
}

document.getElementById("btn-add-segment").addEventListener("click", async () => {
  const segment_id = document.getElementById("new-segment-id").value.trim();
  const members = [];
  document.querySelectorAll(".segment-member-checkbox").forEach((cb) => {
    if (cb.checked) {
      const rid = cb.dataset.router;
      const priority = parseInt(document.querySelector(`.segment-priority[data-router="${rid}"]`).value, 10);
      const cost = parseInt(document.querySelector(`.segment-cost[data-router="${rid}"]`).value, 10);
      members.push({ router_id: rid, priority, cost });
    }
  });

  if (!segment_id || members.length < 2) {
    await showAlert("Champs manquants", "Un ID de segment et au moins 2 routeurs cochés sont requis.", "error");
    return;
  }

  const res = await fetch("/api/segments/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segment_id, members }),
  });
  const data = await res.json();
  if (!data.ok) {
    await showAlert("Impossible de créer le segment", friendlyError(data.error), "error");
    return;
  }

  document.getElementById("new-segment-id").value = "";
  await refresh();
  await showAlert("Segment créé", `Le segment ${segment_id} a été créé — l'élection DR/BDR démarre dès que les routeurs membres sont actifs.`, "success");
});

function ensurePositions(routerIds, segmentIds) {
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const radius = Math.min(cx, cy) - 60;
  const allIds = [...routerIds, ...segmentIds];
  const n = allIds.length || 1;

  allIds.forEach((id, i) => {
    if (!nodePositions[id]) {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      nodePositions[id] = {
        x: cx + radius * Math.cos(angle),
        y: cy + radius * Math.sin(angle),
      };
    }
  });

  Object.keys(nodePositions).forEach((id) => {
    if (!allIds.includes(id)) delete nodePositions[id];
  });
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

  const segmentIds = Object.keys(segmentsMeta);
  ensurePositions(routerIds, segmentIds);
  const positions = nodePositions;
  latestPositions = positions;

  segmentIds.forEach((sid) => {
    const segPos = nodePositions[sid];
    if (!segPos) return;

    let dr = null, bdr = null;
    for (const rid of segmentsMeta[sid].members.map((m) => m.router_id)) {
      const segState = state[rid] && state[rid].running && state[rid].segments && state[rid].segments[sid];
      if (segState && segState.dr) { dr = segState.dr; bdr = segState.bdr; break; }
    }

    const segIndexInPath = activeShortestPath.indexOf(sid);
    const segIsOnPath = segIndexInPath !== -1;

    segmentsMeta[sid].members.forEach((m) => {
      const memberPos = nodePositions[m.router_id];
      if (!memberPos) return;

      const memberIndexInPath = activeShortestPath.indexOf(m.router_id);
      const isPathLink = segIsOnPath && memberIndexInPath !== -1 && Math.abs(segIndexInPath - memberIndexInPath) === 1;

      if (isPathLink) {
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 12;
        drawEdge(segPos, memberPos, "#ffd700", false, m.cost);
        ctx.shadowBlur = 0;
        return;
      }

      const isDrLink = m.router_id === dr;
      const isBdrLink = m.router_id === bdr;
      const color = isDrLink ? "#ffd700" : isBdrLink ? "#c0c0c0" : "#3a4552";
      drawEdge(segPos, memberPos, color, !isDrLink && !isBdrLink, m.cost);
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(segPos.x - 22, segPos.y - 18, 44, 36);
    ctx.fillStyle = "#121821";
    ctx.strokeStyle = segIsOnPath ? "#ffd700" : "#3498db";
    ctx.lineWidth = 2;
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = segIsOnPath ? "#ffd700" : "#3498db";
    ctx.font = "11px Consolas";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(sid, segPos.x, segPos.y - 4);
    ctx.font = "8px Consolas";
    ctx.fillStyle = dr ? "#ffd700" : "#6b7d8f";
    ctx.fillText(dr ? `DR:${dr}` : "élection...", segPos.x, segPos.y + 10);
    ctx.restore();
  });

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
  card.id = `router-card-${id}`;
  card.className = "router-card";

  const neighborsRows = s && s.neighbors
  ? Object.entries(s.neighbors)
      .map(([port, n]) => {
        const linkCfg = routersMeta[id] && routersMeta[id].links.find((l) => String(l.peer_port) === String(port));
        const bwLabel = linkCfg ? formatBandwidth(linkCfg.bandwidth) : "—";
        return `<tr>
          <td>${n.peer_id ?? "-"}</td>
          <td class="${stateClass(n.state)}">${n.state}</td>
          <td>${bwLabel}</td>
          <td>${n.cost}</td>
        </tr>`;
      })
      .join("")
  : "";

  const segmentRows = s && s.segments
    ? Object.entries(s.segments)
        .map(([sid, seg]) => {
          const role = seg.dr === id ? "DR" : seg.bdr === id ? "BDR" : "Membre (2-WAY)";
          const drIp = routersMeta[seg.dr] ? ` (${routersMeta[seg.dr].ip})` : "";
          const bdrIp = routersMeta[seg.bdr] ? ` (${routersMeta[seg.bdr].ip})` : "";
          return `<tr>
            <td>${sid}</td>
            <td>${role}</td>
            <td>DR: ${seg.dr ?? "—"}${drIp} / BDR: ${seg.bdr ?? "—"}${bdrIp}</td>
            <td>${seg.cost}</td>
          </tr>`;
        })
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
        .map(([dest, r]) => {
          const destIp = routersMeta[dest] ? ` (${routersMeta[dest].ip})` : "";
          return `<tr>
            <td>${dest}${destIp}</td>
            <td>${r.next_hop}</td>
            <td>${r.cost}</td>
          </tr>`;
        })
        .join("")
    : "";

  card.innerHTML = `
    <div class="router-card-header">
      <h2>${id} <span style="font-size:11px;color:var(--muted);font-weight:normal;">${routersMeta[id] ? routersMeta[id].ip : ""}</span></h2>
      <div>
        <span class="badge ${running ? "running" : "stopped"}">${running ? "ACTIF" : "ARRETE"}</span>
        <span class="router-actions">
          <button class="btn btn-primary" data-action="start" data-id="${id}">Start</button>
          <button class="btn btn-danger" data-action="stop" data-id="${id}">Stop</button>
          <button class="btn btn-edit" data-action="edit" data-id="${id}">Modifier</button>
          <button class="btn btn-remove" data-action="remove" data-id="${id}">Suppr.</button>
        </span>
      </div>
    </div>

    <div class="section-label">Voisins</div>
    <table>
      <thead><tr><th>Peer</th><th>Etat</th><th>Bande passante</th><th>Cout</th></tr></thead>
      <tbody>${neighborsRows}</tbody>
    </table>

    <div class="section-label">Segments</div>
    <table>
      <thead><tr><th>Segment</th><th>Mon rôle</th><th>DR / BDR</th><th>Cout</th></tr></thead>
      <tbody>${segmentRows}</tbody>
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
      if (btn.dataset.action === "edit") openEditRouterModal(btn.dataset.id);
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

function buildGraphFromLsdb(lsdb) {
  const graph = {};
  const addEdge = (a, b, cost) => {
    if (!graph[a]) graph[a] = {};
    if (!graph[b]) graph[b] = {};
    if (graph[a][b] === undefined || cost < graph[a][b]) graph[a][b] = cost;
    if (graph[b][a] === undefined || cost < graph[b][a]) graph[b][a] = cost;
  };
  Object.entries(lsdb).forEach(([origin, entry]) => {
    Object.entries(entry.links).forEach(([neighbor, cost]) => addEdge(origin, neighbor, cost));
  });
  return graph;
}

function dijkstraPath(graph, source, target) {
  if (!(source in graph)) return null;
  const dist = {}, prev = {};
  Object.keys(graph).forEach((n) => { dist[n] = Infinity; });
  dist[source] = 0;
  const queue = new Set(Object.keys(graph));

  while (queue.size > 0) {
    let u = null, best = Infinity;
    queue.forEach((n) => { if (dist[n] < best) { best = dist[n]; u = n; } });
    if (u === null) break;
    queue.delete(u);
    if (u === target) break;

    Object.entries(graph[u] || {}).forEach(([v, w]) => {
      const alt = dist[u] + w;
      if (alt < dist[v]) { dist[v] = alt; prev[v] = u; }
    });
  }

  if (dist[target] === undefined || dist[target] === Infinity) return null;

  const path = [];
  let cur = target;
  while (cur !== undefined) {
    path.unshift(cur);
    if (cur === source) break;
    cur = prev[cur];
  }
  return path[0] === source ? path : null;
}

function costToSpeed(cost) {
  const MIN_SPEED = 0.006;
  const MAX_SPEED = 0.05;
  const speed = 0.06 / Math.sqrt(Math.max(cost, 1));
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
}

function computeActiveShortestPath() {
  activeShortestPath = [];
  if (!selectedSourceId || !selectedDestId) return;

  const rState = latestState[selectedSourceId];
  if (!rState || !rState.lsdb) {
    console.warn("[chemin] pas de LSDB disponible pour", selectedSourceId);
    return;
  }

  const graph = buildGraphFromLsdb(rState.lsdb);
  activePathGraph = graph;
  const path = dijkstraPath(graph, selectedSourceId, selectedDestId);

  if (!path) {
    console.warn(`[chemin] aucun chemin trouve entre ${selectedSourceId} et ${selectedDestId}`);
    return;
  }

  console.log("[chemin] chemin trouve:", path);
  activeShortestPath = path;
}

function findNodeAt(x, y) {
  for (const [id, pos] of Object.entries(nodePositions)) {
    if (!routersMeta[id]) continue;
    if (Math.hypot(x - pos.x, y - pos.y) < 26) return id;
  }
  return null;
}

function findDraggableAt(x, y) {
  for (const [id, pos] of Object.entries(nodePositions)) {
    if (Math.hypot(x - pos.x, y - pos.y) < 26) return id;
  }
  return null;
}

function findEdgeAt(x, y) {
  const links = [];
  Object.keys(routersMeta).forEach((id) => {
    const config = routersMeta[id];
    if (config && config.links) {
      config.links.forEach((link) => {
        const peerId = portToRouterId[link.peer_port];
        if (peerId && id < peerId) {
          links.push({ from: id, to: peerId, cost: link.cost, bandwidth: link.bandwidth });
        }
      });
    }
  });

  for (const link of links) {
    const n1 = nodePositions[link.from];
    const n2 = nodePositions[link.to];
    if (!n1 || !n2) continue;
    if (getDistanceToSegment(x, y, n1.x, n1.y, n2.x, n2.y) < 8) return link;
  }
  return null;
}

function findSegmentEdgeAt(x, y) {
  for (const sid of Object.keys(segmentsMeta)) {
    const segPos = nodePositions[sid];
    if (!segPos) continue;
    for (const m of segmentsMeta[sid].members) {
      const memberPos = nodePositions[m.router_id];
      if (!memberPos) continue;
      if (getDistanceToSegment(x, y, segPos.x, segPos.y, memberPos.x, memberPos.y) < 8) {
        return { segment_id: sid, router_id: m.router_id, priority: m.priority, cost: m.cost };
      }
    }
  }
  return null;
}

function scrollToRouterCard(id) {
  const card = document.getElementById(`router-card-${id}`);
  if (!card) return;

  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card.classList.add("router-card-highlight");
  setTimeout(() => card.classList.remove("router-card-highlight"), 1200);
}

function handleNodeClick(clickedId, shiftKey) {
  if (shiftKey) {
    if (selectedSourceId === clickedId) {
      alert("La destination ne peut pas être identique à la source !");
      return;
    }
    selectedDestId = clickedId;
  } else {
    if (!selectedSourceId) {
      selectedSourceId = clickedId;
    } else if (selectedSourceId && !selectedDestId) {
      selectedSourceId = clickedId === selectedSourceId ? null : selectedSourceId;
      if (clickedId !== selectedSourceId) selectedDestId = clickedId;
    } else {
      selectedSourceId = clickedId;
      selectedDestId = null;
    }
  }
  computeActiveShortestPath();
  scrollToRouterCard(clickedId);
}

async function handleEdgeClick(link) {
  const bw = await showBandwidthModal(
    "Modifier la bande passante",
    `Bande passante du lien ${link.from} ↔ ${link.to} (le coût OSPF est recalculé automatiquement) :`,
    link.bandwidth
  );
  if (bw === null) return;

  try {
    const response = await fetch("/api/update_link_bandwidth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ r1: link.from, r2: link.to, bandwidth: bw }),
    });
    const res = await response.json();
    if (res.ok) {
      if (routersMeta[link.from]) {
        const l = routersMeta[link.from].links.find((x) => portToRouterId[x.peer_port] === link.to);
        if (l) { l.cost = res.cost; l.bandwidth = bw; }
      }
      if (routersMeta[link.to]) {
        const l = routersMeta[link.to].links.find((x) => portToRouterId[x.peer_port] === link.from);
        if (l) { l.cost = res.cost; l.bandwidth = bw; }
      }
      computeActiveShortestPath();
      await showAlert("Lien mis à jour", `Bande passante : ${formatBandwidth(bw)} → coût OSPF calculé : ${res.cost}.`, "success");
    } else {
      await showAlert("Erreur", friendlyError(res.error), "error");
    }
  } catch (err) {
    console.error(err);
    await showAlert("Erreur réseau", "Impossible de contacter le serveur pour mettre à jour le lien.", "error");
  }
}

canvas.addEventListener("mousedown", (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hitId = findDraggableAt(x, y);
  if (hitId) {
    draggingId = hitId;
    dragMoved = false;
    dragStart = { x, y };
    canvas.style.cursor = "grabbing";
  }
});

window.addEventListener("mousemove", (event) => {
  if (!draggingId) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (!dragMoved && Math.hypot(x - dragStart.x, y - dragStart.y) > 4) {
    dragMoved = true;
  }

  const margin = 30;
  nodePositions[draggingId] = {
    x: Math.min(Math.max(x, margin), canvas.width - margin),
    y: Math.min(Math.max(y, margin), canvas.height - margin),
  };
});

window.addEventListener("mouseup", (event) => {
  if (!draggingId) return;
  const wasDrag = dragMoved;
  const releasedId = draggingId;
  draggingId = null;
  dragMoved = false;
  canvas.style.cursor = "default";

  if (wasDrag) {
    justDragged = true;
  } else if (routersMeta[releasedId]) {
    handleNodeClick(releasedId, event.shiftKey);
  }
});

canvas.addEventListener("click", (event) => {

  if (justDragged) {
    justDragged = false;
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (findNodeAt(x, y)) return;

  const segEdge = findSegmentEdgeAt(x, y);
  if (segEdge) {
    openEditSegmentMemberModal(segEdge.segment_id, segEdge.router_id, segEdge.priority, segEdge.cost);
    return;
  }

  const edge = findEdgeAt(x, y);
  if (edge) {
    handleEdgeClick(edge);
    return;
  }

  selectedSourceId = null;
  selectedDestId = null;
  activeShortestPath = [];
});

if (canvas) {
  canvas.addEventListener("mousemove", (event) => {
    if (draggingId) return;
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

    if (!isHovered) {
      for (const sid of Object.keys(segmentsMeta)) {
        const segPos = latestPositions[sid];
        if (!segPos) continue;
        for (const m of segmentsMeta[sid].members) {
          const memberPos = latestPositions[m.router_id];
          if (!memberPos) continue;
          if (getDistanceToSegment(mouseX, mouseY, segPos.x, segPos.y, memberPos.x, memberPos.y) < 8) {
            isHovered = true;
            break;
          }
        }
        if (isHovered) break;
      }
    }

    canvas.style.cursor = isHovered ? "pointer" : "default";

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

const editSegModalOverlay = document.getElementById("edit-segment-modal-overlay");
const editSegPriorityInput = document.getElementById("edit-segment-priority");
const editSegCostInput = document.getElementById("edit-segment-cost");
const editSegConfirm = document.getElementById("edit-segment-confirm");
const editSegCancel = document.getElementById("edit-segment-cancel");
const editSegTitle = document.getElementById("edit-segment-title");

function openEditSegmentMemberModal(segmentId, routerId, priority, cost) {
  editSegTitle.textContent = `Modifier ${routerId} sur ${segmentId}`;
  editSegPriorityInput.value = priority;
  editSegCostInput.value = cost;
  editSegModalOverlay.classList.remove("hidden");

  const cleanup = () => {
    editSegModalOverlay.classList.add("hidden");
    editSegConfirm.removeEventListener("click", onConfirm);
    editSegCancel.removeEventListener("click", onCancel);
    editSegModalOverlay.removeEventListener("click", onOverlayClick);
  };

  const onConfirm = async () => {
    const priority = parseInt(editSegPriorityInput.value, 10);
    const cost = parseInt(editSegCostInput.value, 10);
    if (!Number.isFinite(priority) || priority < 0 || !Number.isFinite(cost) || cost <= 0) {
      await showAlert("Valeurs invalides", "Priorité ≥ 0 et coût > 0 requis.", "error");
      return;
    }
    cleanup();

    const res = await fetch("/api/segments/update_member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment_id: segmentId, router_id: routerId, priority, cost }),
    });
    const data = await res.json();
    if (!data.ok) {
      await showAlert("Erreur", friendlyError(data.error), "error");
      return;
    }
    await refresh();
    await showAlert("Membre mis à jour", `${routerId} sur ${segmentId} : priorité=${priority}, coût=${cost}.`, "success");
  };
  const onCancel = () => cleanup();
  const onOverlayClick = (e) => { if (e.target === editSegModalOverlay) cleanup(); };

  editSegConfirm.addEventListener("click", onConfirm);
  editSegCancel.addEventListener("click", onCancel);
  editSegModalOverlay.addEventListener("click", onOverlayClick);
}

const renameSegModalOverlay = document.getElementById("rename-segment-modal-overlay");
const renameSegInput = document.getElementById("rename-segment-input");
const renameSegConfirm = document.getElementById("rename-segment-confirm");
const renameSegCancel = document.getElementById("rename-segment-cancel");

function openRenameSegmentModal(segmentId) {
  renameSegInput.value = segmentId;
  renameSegModalOverlay.classList.remove("hidden");

  const cleanup = () => {
    renameSegModalOverlay.classList.add("hidden");
    renameSegConfirm.removeEventListener("click", onConfirm);
    renameSegCancel.removeEventListener("click", onCancel);
    renameSegModalOverlay.removeEventListener("click", onOverlayClick);
  };

  const onConfirm = async () => {
    const newId = renameSegInput.value.trim();
    if (!newId) {
      await showAlert("Champ manquant", "Merci de saisir un nom.", "error");
      return;
    }
    cleanup();

    const res = await fetch(`/api/segments/edit/${segmentId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ segment_id: newId }),
    });
    const data = await res.json();
    if (!data.ok) {
      await showAlert("Erreur", friendlyError(data.error), "error");
      return;
    }
    if (nodePositions[segmentId]) {
      nodePositions[newId] = nodePositions[segmentId];
      delete nodePositions[segmentId];
    }
    await refresh();
    await showAlert("Segment renommé", `${segmentId} → ${newId}. L'élection DR/BDR redémarre sur ce segment.`, "success");
  };
  const onCancel = () => cleanup();
  const onOverlayClick = (e) => { if (e.target === renameSegModalOverlay) cleanup(); };

  renameSegConfirm.addEventListener("click", onConfirm);
  renameSegCancel.addEventListener("click", onCancel);
  renameSegModalOverlay.addEventListener("click", onOverlayClick);
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

  const cost = (activePathGraph[fromId] && activePathGraph[fromId][toId]) || 1;
  const speed = costToSpeed(cost);

  activePackets.push({
    fromId,
    toId,
    startX: startPos.x,
    startY: startPos.y,
    endX: endPos.x,
    endY: endPos.y,
    progress: 0,
    speed,
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
    await fetchSegments();
    renderSegmentsList();

    const idsKey = Object.keys(routersMeta).sort().join(",");
    if (idsKey !== lastRouterIdsKey) {
      renderAddRouterForm();
      renderAddSegmentForm();
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

function renderSegmentsList() {
  const container = document.getElementById("segments-list");
  if (!container) return;
  container.innerHTML = "";

  Object.keys(segmentsMeta).sort().forEach((sid) => {
    const row = document.createElement("div");
    row.className = "segment-member-row";
    const members = segmentsMeta[sid].members.map((m) => m.router_id).join(", ");
    row.innerHTML = `
      <span>${sid} (${members})</span>
      <button class="btn btn-edit" data-segment-edit="${sid}">Modifier</button>
      <button class="btn btn-remove" data-segment="${sid}">Suppr.</button>
    `;
    row.querySelector("[data-segment-edit]").addEventListener("click", () => openRenameSegmentModal(sid));
    row.querySelector("[data-segment]").addEventListener("click", async () => {
      const confirmed = await showConfirm("Supprimer le segment", `Supprimer définitivement ${sid} ?`);
      if (!confirmed) return;
      await fetch(`/api/segments/remove/${sid}`, { method: "POST" });
      await refresh();
      await showAlert("Segment supprimé", `${sid} a bien été supprimé.`, "success");
    });
    container.appendChild(row);
  });
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