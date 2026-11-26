export interface TiffWriter {
  header: ArrayBuffer;
  width: number;
  height: number;
  rowsPerStrip: number;
  stripCount: number;
  stripByteCounts: number[];
  createBlob: (stripChunks: BlobPart[]) => Blob;
}

/**
 * Minimal little-endian grayscale TIFF writer. Pixel strips are supplied in
 * top-to-bottom order; no compression keeps 600 DPI export fast and random
 * access friendly for publishing workflows.
 */
export function createGrayscaleTiffWriter(
  width: number,
  height: number,
  dpi: number,
  rowsPerStrip = 1024,
): TiffWriter {
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  rowsPerStrip = Math.max(1, Math.min(height, Math.floor(rowsPerStrip)));
  const stripCount = Math.ceil(height / rowsPerStrip);
  const stripByteCounts = Array.from({ length: stripCount }, (_, i) => {
    const rows = Math.min(rowsPerStrip, height - i * rowsPerStrip);
    return width * rows;
  });

  const entryCount = 12;
  const ifdLength = 2 + entryCount * 12 + 4;
  const ifdOffset = 8;
  let extraOffset = ifdOffset + ifdLength;
  const xResOffset = extraOffset; extraOffset += 8;
  const yResOffset = extraOffset; extraOffset += 8;
  const offsetsTableOffset = extraOffset; extraOffset += stripCount * 4;
  const byteCountsTableOffset = extraOffset; extraOffset += stripCount * 4;
  const pixelOffset = (extraOffset + 1) & ~1;

  const buffer = new ArrayBuffer(pixelOffset);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949, true); // II
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entryCount, true);

  let entry = ifdOffset + 2;
  const shortEntry = (tag: number, value: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, 3, true);
    view.setUint32(entry + 4, 1, true);
    view.setUint16(entry + 8, value, true);
    view.setUint16(entry + 10, 0, true);
    entry += 12;
  };
  const longEntry = (tag: number, count: number, valueOrOffset: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, 4, true);
    view.setUint32(entry + 4, count, true);
    view.setUint32(entry + 8, valueOrOffset, true);
    entry += 12;
  };
  const rationalEntry = (tag: number, offset: number) => {
    view.setUint16(entry, tag, true);
    view.setUint16(entry + 2, 5, true);
    view.setUint32(entry + 4, 1, true);
    view.setUint32(entry + 8, offset, true);
    entry += 12;
  };

  longEntry(256, 1, width);
  longEntry(257, 1, height);
  shortEntry(258, 8);
  shortEntry(259, 1);
  shortEntry(262, 1);
  longEntry(273, stripCount, stripCount === 1 ? pixelOffset : offsetsTableOffset);
  shortEntry(277, 1);
  longEntry(278, 1, rowsPerStrip);
  longEntry(279, stripCount, stripCount === 1 ? stripByteCounts[0] : byteCountsTableOffset);
  rationalEntry(282, xResOffset);
  rationalEntry(283, yResOffset);
  shortEntry(296, 2);
  view.setUint32(entry, 0, true); // next IFD

  view.setUint32(xResOffset, Math.round(dpi), true);
  view.setUint32(xResOffset + 4, 1, true);
  view.setUint32(yResOffset, Math.round(dpi), true);
  view.setUint32(yResOffset + 4, 1, true);

  let cumulative = pixelOffset;
  for (let i = 0; i < stripCount; i++) {
    if (stripCount > 1) view.setUint32(offsetsTableOffset + i * 4, cumulative, true);
    if (stripCount > 1) view.setUint32(byteCountsTableOffset + i * 4, stripByteCounts[i], true);
    cumulative += stripByteCounts[i];
  }

  return {
    header: buffer,
    width,
    height,
    rowsPerStrip,
    stripCount,
    stripByteCounts,
    createBlob(stripChunks: BlobPart[]) {
      if (stripChunks.length !== stripCount) {
        throw new Error(`TIFF 分片数量应为 ${stripCount}，实际 ${stripChunks.length}`);
      }
      return new Blob([buffer, ...stripChunks] as BlobPart[], { type: 'image/tiff' });
    },
  };
}

export function imageDataToGrayscale(image: ImageData | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const data = image instanceof Uint8ClampedArray ? image : image.data;
  const out = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    // Luminance and preserve paper/ink contrast.
    out[p] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }
  return out;
}
