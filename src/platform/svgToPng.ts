/**
 * SVG → PNG 位图转换（浏览器 canvas 路径,Web 与 Tauri WebView 通用）。
 * 用于 Office 导出嵌图与图表 PNG 下载。
 */

export async function svgElementToPng(svg: SVGSVGElement, scale = 2): Promise<Uint8Array> {
  const vb = svg.viewBox.baseVal;
  const w = (vb && vb.width) || svg.clientWidth || 960;
  const h = (vb && vb.height) || svg.clientHeight || 300;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const src = new XMLSerializer().serializeToString(clone);
  return svgMarkupToPng(src, w, h, scale);
}

export async function svgMarkupToPng(markup: string, w: number, h: number, scale = 2): Promise<Uint8Array> {
  let src = markup;
  if (!src.includes('xmlns=')) src = src.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  if (!/<svg[^>]*\swidth=/.test(src)) src = src.replace('<svg', `<svg width="${w}" height="${h}"`);
  const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('SVG 位图化失败'));
      im.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png'),
    );
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
