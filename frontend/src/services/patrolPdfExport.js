function isValidLngLat(row) {
  const lng = Number(row?.lng);
  const lat = Number(row?.lat);
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

function drawMiniMapDataUrl(points, events, eventTypeColor, width = 1000, height = 420) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#f7f8fa";
  ctx.fillRect(0, 0, width, height);
  const pts = (points || []).filter(isValidLngLat);
  if (!pts.length) return canvas.toDataURL("image/jpeg", 0.9);

  const lngs = pts.map((p) => Number(p.lng));
  const lats = pts.map((p) => Number(p.lat));
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const dx = Math.max(1e-9, maxLng - minLng);
  const dy = Math.max(1e-9, maxLat - minLat);
  const pad = 22;
  const toXY = (row) => {
    const x = pad + ((Number(row.lng) - minLng) / dx) * (width - pad * 2);
    const y = height - pad - ((Number(row.lat) - minLat) / dy) * (height - pad * 2);
    return [x, y];
  };

  ctx.strokeStyle = "#1989fa";
  ctx.lineWidth = 4;
  ctx.beginPath();
  pts.forEach((p, i) => {
    const [x, y] = toXY(p);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  for (const ev of (events || []).filter(isValidLngLat)) {
    const [x, y] = toXY(ev);
    ctx.fillStyle = eventTypeColor(ev.type);
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas.toDataURL("image/jpeg", 0.9);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image_load_failed"));
    img.src = dataUrl;
  });
}

function drawTextLines(ctx, text, x, y, maxWidth, lineHeight) {
  const chars = String(text || "").split("");
  let line = "";
  let lineCount = 0;
  chars.forEach((ch, idx) => {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lineCount * lineHeight);
      line = ch;
      lineCount += 1;
      return;
    }
    line = test;
    if (idx === chars.length - 1) ctx.fillText(line, x, y + lineCount * lineHeight);
  });
  return lineCount + 1;
}

async function buildReportImageDataUrl({
  title,
  patrolUser,
  patrolDate,
  areaText,
  generateTimeText,
  patrolStats,
  events,
  keyEventIds,
  mapDataUrlPreferred,
  points,
  eventTypeLabel,
  eventTypeColor,
  formatTime,
}) {
  const canvas = document.createElement("canvas");
  canvas.width = 1240;
  canvas.height = 1960;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.fillStyle = "#f3f4f6";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = "#111827";
  ctx.font = "bold 54px sans-serif";
  ctx.fillText(title || "智能巡护简报", 56, 92);
  ctx.font = "30px sans-serif";
  ctx.fillStyle = "#374151";
  ctx.fillText(`巡护员：${patrolUser || "护林员"}`, 56, 142);
  ctx.fillText(`日期：${patrolDate || "—"}`, 56, 182);
  ctx.fillText(`区域：${areaText || "—"}`, 56, 222);
  ctx.fillText(`生成时间：${generateTimeText || "—"}`, 56, 262);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(44, 290, 1152, 180);
  ctx.fillStyle = "#111827";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("核心数据", 68, 340);
  const distanceText = patrolStats.distanceMeters >= 1000
    ? `${(patrolStats.distanceMeters / 1000).toFixed(2)} km`
    : `${Math.round(patrolStats.distanceMeters)} m`;
  ctx.font = "30px sans-serif";
  ctx.fillText(`时长：${Math.round(patrolStats.durationMs / 60000)} 分钟`, 68, 394);
  ctx.fillText(`里程：${distanceText}`, 450, 394);
  ctx.fillText(`事件：${(events || []).length} 条`, 860, 394);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(44, 492, 1152, 560);
  ctx.fillStyle = "#111827";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("地图截图（轨迹+事件）", 68, 546);
  const mapDataUrl = mapDataUrlPreferred || drawMiniMapDataUrl(points, events, eventTypeColor, 1080, 460);
  try {
    const mapImg = await loadImage(mapDataUrl);
    ctx.drawImage(mapImg, 68, 570, 1104, 450);
  } catch {
    ctx.fillStyle = "#9ca3af";
    ctx.fillRect(68, 570, 1104, 450);
  }

  const selected = (events || []).filter((ev) => (keyEventIds || []).includes(ev.local_id));
  const keyEvents = selected.length ? selected : (events || []).slice(0, 3);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(44, 1076, 1152, 820);
  ctx.fillStyle = "#111827";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("重点事件", 68, 1130);
  ctx.font = "28px sans-serif";
  ctx.fillStyle = "#374151";
  let y = 1186;
  if (!keyEvents.length) {
    ctx.fillText("无事件记录", 68, y);
    y += 40;
  } else {
    keyEvents.forEach((ev, idx) => {
      ctx.fillStyle = eventTypeColor(ev.type);
      ctx.beginPath();
      ctx.arc(78, y - 8, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#374151";
      const titleLine = `${idx + 1}. ${eventTypeLabel(ev.type)} · ${formatTime(ev.recorded_at)}`;
      ctx.fillText(titleLine, 96, y);
      y += 36;
      const lines = drawTextLines(
        ctx,
        `坐标 ${Number(ev.lat).toFixed(5)}, ${Number(ev.lng).toFixed(5)}${ev.note ? `；备注：${ev.note}` : ""}`,
        96,
        y,
        1050,
        34
      );
      y += lines * 34 + 14;
    });
  }
  ctx.fillStyle = "#0f766e";
  ctx.font = "bold 30px sans-serif";
  ctx.fillText("行动建议：优先处理重点事件，复查同类高频区域。", 68, Math.min(1860, y + 22));
  return canvas.toDataURL("image/jpeg", 0.92);
}

export async function exportPatrolPdfReport({
  points,
  events,
  patrolStats,
  reportMeta,
  mapDataUrlPreferred,
  keyEventIds,
  eventTypeLabel,
  eventTypeColor,
  formatTime,
}) {
  const { jsPDF } = await import("jspdf");
  const imageDataUrl = await buildReportImageDataUrl({
    title: reportMeta?.title,
    patrolUser: reportMeta?.patrolUser,
    patrolDate: reportMeta?.patrolDate,
    areaText: reportMeta?.areaText,
    generateTimeText: reportMeta?.generateTimeText,
    patrolStats,
    events,
    keyEventIds,
    mapDataUrlPreferred,
    points,
    eventTypeLabel,
    eventTypeColor,
    formatTime,
  });
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  pdf.addImage(imageDataUrl, "JPEG", 0, 0, 210, 297);

  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  pdf.save(`巡护报告_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`);
}
