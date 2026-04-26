export async function extractTextFromPdfFile(file) {
  const pdfjsLib = await import("pdfjs-dist");
  const workerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  const workerUrl = workerMod.default;
  if (typeof workerUrl === "string") {
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
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
