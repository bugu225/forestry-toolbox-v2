export async function extractTextFromPdfFile(file) {
  const pdfjsLib = await import("pdfjs-dist");
  if (pdfjsLib?.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
    } catch {
      // ignore: we'll still try no-worker mode below
    }
  }

  const data = new Uint8Array(await file.arrayBuffer());
  let pdf = null;
  try {
    // Keep PDF parsing stable across deployments by avoiding hard dependency on worker loading.
    pdf = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;
  } catch (error) {
    const msg = String(error?.message || "");
    if (msg.includes("workerSrc") || msg.includes("Setting up fake worker failed")) {
      // Retry with normal mode in case runtime expects an explicit worker source.
      pdf = await pdfjsLib.getDocument({ data }).promise;
    } else {
      throw error;
    }
  }
  const parts = [];
  const maxPages = 200;
  const n = Math.min(pdf.numPages, maxPages);
  for (let i = 1; i <= n; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => (item && typeof item.str === "string" ? item.str : ""))
      .filter(Boolean)
      .join(" ");
    if (line) {
      parts.push(line);
    }
  }
  if (pdf.numPages > maxPages) {
    parts.push(`\n\n（仅解析前 ${maxPages} 页，文档共 ${pdf.numPages} 页）`);
  }
  return parts.join("\n\n").trim();
}
