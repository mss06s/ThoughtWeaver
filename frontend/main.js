// pick backend: local when you're on laptop, hosted when deployed
const API_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:5050"        // local Flask dev server
    : "https://thoughtweaver-backend.onrender.com";  // hosted backend

// ==== DOM refs ====
// Core UI elements wired up to JS logic
const inputEl = document.getElementById("input");
const genBtn = document.getElementById("gen");
const exportPngBtn = document.getElementById("exportPng");
const exportJsonBtn = document.getElementById("exportJson");
const graphEl = document.getElementById("graph");
const insList = document.getElementById("insList");
const useExampleBtn = document.getElementById("useExample");
const nodeInfoEl = document.getElementById("nodeInfo");

// Vis Network instance + last graph data cache
let network = null;
let lastGraph = null;

// store original node colors so we can dim / restore
let nodeBaseColors = {};
const EDGE_BASE_COLOR = { color: "rgba(200,210,230,0.6)" };

// ==== category → color map ====
// Base colors used to style nodes based on their conceptual category.
const CATEGORY_COLORS = {
  emotion:  { background: "#9b5de5", border: "#d0a9ff" },
  habit:    { background: "#f15bb5", border: "#ffb3da" },
  goal:     { background: "#00bbf9", border: "#82e9ff" },
  problem:  { background: "#f97316", border: "#fed7aa" },
  solution: { background: "#10b981", border: "#6ee7b7" },
};

// per-category glow colors (rgba) for node shadows
// Extend the category color objects in-place to include a soft glow for shadows.
Object.assign(CATEGORY_COLORS, {
  emotion: Object.assign({}, CATEGORY_COLORS.emotion, { glow: 'rgba(155,93,229,0.28)' }),
  habit:   Object.assign({}, CATEGORY_COLORS.habit,   { glow: 'rgba(241,91,181,0.28)' }),
  goal:    Object.assign({}, CATEGORY_COLORS.goal,    { glow: 'rgba(0,187,249,0.26)' }),
  problem: Object.assign({}, CATEGORY_COLORS.problem, { glow: 'rgba(249,115,22,0.26)' }),
  solution:Object.assign({}, CATEGORY_COLORS.solution,{ glow: 'rgba(16,185,129,0.26)' }),
});
 

// ==== render the graph + insights ====
// Create / update the Vis Network graph and render insights sidebar.
function renderGraph(data) {
  lastGraph = data;
  nodeBaseColors = {};

  // build nodes with category colors (fallback if no category)
  const nodes = new vis.DataSet(
    (data.nodes || []).map((n) => {
      // Choose category color or a neutral fallback
      const col = CATEGORY_COLORS[n.category] || {
        background: "#1f2937",
        border: "#334155",
        glow: 'rgba(255,255,255,0.06)'
      };
      nodeBaseColors[n.id] = col;
      const size = 18;
      return {
        id: n.id,
        label: n.label,
        category: n.category,
        color: col,
        shape: "dot",
        size,
        borderWidth: 2,
        // subtle glowing shadow that uses the category's glow color
        shadow: { enabled: true, color: col.glow || 'rgba(255,255,255,0.06)', size: 26, x: 0, y: 0 },
        origSize: size,  // baseline size for hover/expand animations
        expanded: false, // tracks whether node is in "expanded" state
      };
    })
  );

  // build edges (id added for easier updates)
  const edges = new vis.DataSet(
    (data.edges || []).map((e, idx) => {
      // make label readable: replace underscores with spaces
      const raw = e.relation || "";
      const labelText = String(raw).replace(/_/g, ' ');
      // choose an edge length proportional to label length so the label has room
      const baseLen = 120;
      const perChar = 10;
      const maxLen = 420;
      const length = Math.max(baseLen, Math.min(maxLen, baseLen + (labelText.length * perChar)));
      return {
        id: idx,                      // stable id so we can update this edge later
        from: e.from,
        to: e.to,
        label: labelText,
        width: 1 + 5 * (e.weight ?? 0.3), // thicker line for stronger relationships
        weight: e.weight ?? 0.3,
        color: EDGE_BASE_COLOR,
        // improved label visibility: white text with dark stroke and semi-opaque background for max contrast
        font: {
          size: 15,
          color: "#ffffff",
          strokeWidth: 6,
          strokeColor: "rgba(0,0,0,0.95)",
          background: 'rgba(0,0,0,0.66)',
          align: 'middle',
          vadjust: -8
        },
        length,
        smooth: true,
      };
    })
  );

  // destroy old graph if exists
  if (network) network.destroy();

  // create new network
  network = new vis.Network(
    graphEl,
    { nodes, edges },
    {
      physics: {
        solver: "forceAtlas2Based",          // nicer layout for small conceptual graphs
        stabilization: { iterations: 120 },  // let it settle before displaying
        minVelocity: 0.75,
      },
      nodes: {
        font: { color: "#ffffff", size: 14 },
        borderWidth: 2,
        shadow: true,
      },
      edges: {
        smooth: { type: "dynamic" },
      },
      interaction: {
          hover: true,
          dragView: false, // prevent panning the canvas off-screen
          dragNodes: true,
          zoomView: false, // disable zooming entirely to keep layout stable and readable
      },
    }
  );

  // once physics stabilizes, fit the whole graph into view so everything is readable
  network.once('stabilizationIterationsDone', function () {
    try {
      // stop stabilization to reduce motion after layout
      network.setOptions({ physics: { stabilization: false } });
    } catch (e) {}
    // fit nodes into view with small animation
    setTimeout(() => network.fit({ animation: { duration: 350 } }), 80);
  });

  // prevent nodes from being dragged outside the visible graph area
  network.on('dragEnd', function (params) {
    if (!params.nodes || !params.nodes.length) return;
    const rect = graphEl.getBoundingClientRect();
    const padding = 20; // keep nodes at least this many px from edges

    params.nodes.forEach((id) => {
      const positions = network.getPositions([id]);
      const pos = positions[id];
      if (!pos) return;
      // convert canvas coords to DOM coords
      const dom = network.canvasToDOM({ x: pos.x, y: pos.y });
      // clamp to bounding rect
      let clampedX = Math.max(padding, Math.min(rect.width - padding, dom.x));
      let clampedY = Math.max(padding, Math.min(rect.height - padding, dom.y));
      // if clamped, convert back to canvas coords and update node position
      if (clampedX !== dom.x || clampedY !== dom.y) {
        const canvasPos = network.DOMtoCanvas({ x: clampedX, y: clampedY });
        nodes.update({ id: id, x: canvasPos.x, y: canvasPos.y });
      }
    });
  });

  // reset node info text
  if (nodeInfoEl) {
    nodeInfoEl.textContent = "Click a node to inspect its connections.";
  }

  // click behaviour: highlight neighbors + show info
  network.on("click", (params) => {
    if (!params.nodes.length) {
      // clicked on empty space → reset everything
      nodes.forEach((n) => {
        nodes.update({ id: n.id, color: nodeBaseColors[n.id] });
      });
      edges.forEach((e) => {
        edges.update({
          id: e.id,
          width: 1 + 5 * (e.weight ?? 0.3),
          color: EDGE_BASE_COLOR,
        });
      });
      if (nodeInfoEl) {
        nodeInfoEl.textContent = "Click a node to inspect its connections.";
      }
      return;
    }

    const clickedId = params.nodes[0];
    const neighborIds = network.getConnectedNodes(clickedId);
    const activeNodes = new Set([clickedId, ...neighborIds]);
    const activeEdges = new Set(network.getConnectedEdges(clickedId));

    // dim non-neighbors, highlight selected + neighbors
    nodes.forEach((n) => {
      if (activeNodes.has(n.id)) {
        nodes.update({ id: n.id, color: nodeBaseColors[n.id] });
      } else {
        nodes.update({
          id: n.id,
          color: { background: "#020617", border: "#020617" },
        });
      }
    });

    // highlight edges connected to the clicked node
    edges.forEach((e) => {
      if (activeEdges.has(e.id)) {
        edges.update({
          id: e.id,
          width: 1 + 7 * (e.weight ?? 0.4),
          color: { color: "rgba(255,255,255,0.9)" },
        });
      } else {
        edges.update({
          id: e.id,
          width: 1 + 3 * (e.weight ?? 0.2),
          color: { color: "rgba(90,100,130,0.3)" },
        });
      }
    });

    // update node info panel with label, category, and neighbors
    if (nodeInfoEl) {
      const node = nodes.get(clickedId);
      const neighborLabels = neighborIds
        .map((id) => nodes.get(id)?.label)
        .filter(Boolean);

      const category = node.category || "uncategorized";
      nodeInfoEl.innerHTML =
        `<strong>${node.label}</strong> <span style="opacity:.8;">(${category})</span><br>` +
        (neighborLabels.length
          ? `<span style="opacity:.8;">Connected to: ${neighborLabels.join(
              ", "
            )}</span>`
          : `<span style="opacity:.8;">No direct connections.</span>`);
    }
  });

  // --- interactive node expand behaviour ---
  // enlarge on hover
  network.on("hoverNode", function (params) {
    const id = params.node;
    const node = nodes.get(id);
    if (!node) return;
    if (node.expanded) return;
    const newSize = Math.round((node.origSize || node.size) * 1.6);
    nodes.update({ id: id, size: newSize });
  });

  // restore on hover out
  network.on("blurNode", function (params) {
    const id = params.node;
    const node = nodes.get(id);
    if (!node) return;
    if (node.expanded) return; // keep expanded nodes enlarged
    nodes.update({ id: id, size: node.origSize || 18 });
  });

  // toggle expansion on select (click)
  network.on("selectNode", function (params) {
    const id = params.nodes && params.nodes[0];
    if (!id) return;
    const node = nodes.get(id);
    if (!node) return;
    if (node.expanded) {
      nodes.update({ id: id, size: node.origSize || 18, expanded: false });
    } else {
      const newSize = Math.round((node.origSize || node.size) * 1.8);
      nodes.update({ id: id, size: newSize, expanded: true });
    }
  });

  // if user clicks empty space (deselect), collapse expanded nodes
  network.on("deselectNode", function () {
    const all = nodes.get();
    const toRestore = all
      .filter((n) => n.expanded)
      .map((n) => ({ id: n.id, size: n.origSize || 18, expanded: false }));
    if (toRestore.length) nodes.update(toRestore);
  });

  // render insights list with styled dots
  insList.innerHTML = "";
  (data.insights || []).forEach((s, idx) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "ins-dot";
    const txt = document.createElement("div");
    txt.className = "ins-text";
    txt.textContent = s;
    li.appendChild(dot);
    li.appendChild(txt);
    insList.appendChild(li);
  });
}

// ==== button handlers ====
// Trigger graph generation when the user clicks "Generate Map"
genBtn.onclick = async () => {
  const text = inputEl.value.trim();
  if (!text) return alert("Type something first 😅");

  genBtn.disabled = true;
  genBtn.textContent = "Thinking...";

  try {
    const res = await fetch(`${API_BASE}/api/graph`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    renderGraph(data);
  } catch (e) {
    alert("Error: " + e.message);
  } finally {
    genBtn.disabled = false;
    genBtn.textContent = "Generate Map";
    // nothing to hide (skeleton removed)
  }
};

// fill the textarea with an example prompt when user clicks the example button
if (useExampleBtn) {
  useExampleBtn.addEventListener("click", () => {
    inputEl.value = "I keep staying up late scrolling, feel tired, which makes it hard to focus and I procrastinate. I want to sleep better and have more energy.";
  });
}

// Export the current graph canvas as a PNG file the user can download
exportPngBtn.onclick = () => {
  if (!network) return;
  const dataUrl = network.canvas.frame.canvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = "thoughtweaver.png";
  a.click();
};

// Export the raw graph data (nodes, edges, insights) as a JSON file
exportJsonBtn.onclick = () => {
  if (!lastGraph) return;
  const blob = new Blob([JSON.stringify(lastGraph, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "thoughtweaver.json";
  a.click();
};
