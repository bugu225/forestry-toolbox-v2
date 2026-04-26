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

function buildEventSummaryLines(events, eventTypeLabel, formatTime, limit = 12) {
  const rows = (events || [])
    .slice(0, limit)
    .map((ev, idx) => `${idx + 1}. ${eventTypeLabel(ev.type)} ${formatTime(ev.recorded_at)} ${ev.note ? `- ${ev.note}` : ""}`);
  return rows.length ? rows : ["无事件记录"];
}

export async function exportPatrolPdfReport({
  points,
  events,
  patrolStats,
  patrolStatusText,
  eventTypeLabel,
  eventTypeColor,
  formatTime,
}) {
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = 210;
  let y = 14;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.text("巡护报告", 14, y);
  y += 8;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  pdf.text(`导出时间：${formatTime(Date.now())}`, 14, y);
  y += 6;
  pdf.text(`巡护状态：${patrolStatusText}`, 14, y);
  y += 6;
  const distanceText = patrolStats.distanceMeters >= 1000
    ? `${(patrolStats.distanceMeters / 1000).toFixed(2)} km`
    : `${Math.round(patrolStats.distanceMeters)} m`;
  pdf.text(`统计：里程 ${distanceText}，时长 ${Math.round(patrolStats.durationMs / 60000)} 分钟，事件 ${(events || []).length} 条`, 14, y);
  y += 8;

  const mapDataUrl = drawMiniMapDataUrl(points, events, eventTypeColor);
  if (mapDataUrl) {
    pdf.setFont("helvetica", "bold");
    pdf.text("轨迹与事件地图", 14, y);
    y += 3;
    pdf.addImage(mapDataUrl, "JPEG", 14, y, pageW - 28, 78);
    y += 84;
  }

  pdf.setFont("helvetica", "bold");
  pdf.text("事件摘要", 14, y);
  y += 6;
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(10);
  const lines = buildEventSummaryLines(events, eventTypeLabel, formatTime, 12);
  for (const line of lines) {
    if (y > 285) {
      pdf.addPage();
      y = 16;
    }
    pdf.text(line, 14, y);
    y += 5.6;
  }

  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  pdf.save(`巡护报告_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.pdf`);
}
