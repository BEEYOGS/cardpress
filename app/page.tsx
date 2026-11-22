"use client";

import JsBarcode from "jsbarcode";
import JSZip from "jszip";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Barcode,
  Check,
  ChevronDown,
  CreditCard,
  Eye,
  FileImage,
  FileUp,
  Hash,
  Images,
  Layers3,
  Printer,
  RotateCcw,
  SlidersHorizontal,
} from "lucide-react";
import Tesseract from "tesseract.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const WIDTH = 1028;
const HEIGHT = 650;
const PRINT_PPI = 300;
const SETTINGS_KEY = "cardpress.settings.v1";
const DEFAULT_FORMAT_MIGRATION_KEY = "cardpress.default-format.code93.v1";
const FULL_EAN_LAYOUT_MIGRATION_KEY = "cardpress.full-ean-layout.v3";
const DB_NAME = "cardpress.templates.v1";
const DB_STORE = "templates";
const CODE128_AUTO_REFERENCE_LAYOUT = {
  barsHeight: 0.43,
  top: 0.18,
  captionBaseline: 0.86,
  captionScale: 0.8,
} as const;

type Side = "front" | "back";
type Mode = "single" | "sequence" | "batch";
type PrintMode = "one-sided" | "two-sided";
type Template = { image: HTMLImageElement; url: string; name: string };
type Settings = {
  frontX: number;
  frontY: number;
  frontFont: number;
  barX: number;
  barY: number;
  barWidth: number;
  barHeight: number;
  barFont: number;
  barcodeFormat: "EAN13" | "CODE93" | "CODE128" | "CODE128C" | "ITF14";
  numberFormat: "grouped" | "plain" | "none";
  mirror: boolean;
};

const DEFAULTS: Settings = {
  frontX: 84,
  frontY: 116,
  frontFont: 34,
  barX: 307,
  barY: 370,
  barWidth: 415,
  barHeight: 126,
  barFont: 32,
  barcodeFormat: "CODE93",
  numberFormat: "grouped",
  mirror: false,
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Browser ini tidak mendukung penyimpanan template."));
      return;
    }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Database template tidak dapat dibuka."));
  });
}

async function storeTemplate(side: Side, blob: Blob, name: string) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put({ blob, name }, side);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Template gagal disimpan."));
    tx.onabort = () => reject(tx.error ?? new Error("Penyimpanan template dibatalkan."));
  });
  db.close();
}

async function readTemplates(): Promise<Array<[Side, { blob: Blob; name: string }]>> {
  const db = await openDatabase();
  const stored = await new Promise<{ keys: IDBValidKey[]; values: { blob: Blob; name: string }[] }>((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const request = tx.objectStore(DB_STORE).getAll();
    const keys = tx.objectStore(DB_STORE).getAllKeys();
    tx.oncomplete = () => resolve({ keys: keys.result, values: request.result });
    tx.onerror = () => reject(tx.error ?? new Error("Template tersimpan tidak dapat dibaca."));
  });
  db.close();
  return stored.keys.flatMap((key, index) =>
    key === "front" || key === "back" ? [[key, stored.values[index]] as [Side, { blob: Blob; name: string }]] : [],
  );
}

function loadImage(blob: Blob): Promise<{ image: HTMLImageElement; url: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ image, url });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("File gambar tidak dapat dibaca."));
    };
    image.src = url;
  });
}

function getNumbers(
  mode: Mode,
  single: string,
  startText: string,
  countText: string,
  batch: string,
  barcodeFormat: Settings["barcodeFormat"],
): { values: string[] } | { error: string } {
  const validateItf14 = (value: string) => {
    if (barcodeFormat !== "ITF14") return "";
    if (!/^\d{14}$/.test(value)) return "ITF-14 memerlukan tepat 14 digit.";
    const checkDigit = calculateItf14CheckDigit(value.slice(0, 13));
    return value.endsWith(checkDigit) ? "" : `ITF-14 tidak valid. Digit cek seharusnya ${checkDigit}.`;
  };
  const validateEan13 = (value: string) => {
    if (barcodeFormat !== "EAN13") return "";
    if (!/^\d{13}$/.test(value)) return "EAN-13 memerlukan tepat 13 digit.";
    const checkDigit = calculateEan13CheckDigit(value.slice(0, 12));
    return value.endsWith(checkDigit) ? "" : `EAN-13 tidak valid. Digit cek seharusnya ${checkDigit}.`;
  };
  const validateCode128C = (value: string) => {
    if (barcodeFormat !== "CODE128C") return "";
    return /^\d+$/.test(value) && value.length % 2 === 0
      ? ""
      : "Code 128 C memerlukan angka dengan jumlah digit genap.";
  };
  if (mode === "single") {
    const value = single.trim();
    if (!value) return { error: "Nomor kode tidak boleh kosong." } as const;
    if (!/^\d+$/.test(value)) return { error: "Nomor kode hanya boleh berisi angka." } as const;
    const code128CError = validateCode128C(value);
    if (code128CError) return { error: code128CError } as const;
    const eanError = validateEan13(value);
    if (eanError) return { error: eanError } as const;
    const itfError = validateItf14(value);
    if (itfError) return { error: itfError } as const;
    return { values: [value] } as const;
  }
  if (mode === "sequence") {
    const start = startText.trim();
    const count = Number(countText);
    if (!/^\d+$/.test(start)) return { error: "Nomor awal harus berisi angka saja." } as const;
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000) {
      return { error: "Jumlah kartu harus antara 1 dan 10.000." } as const;
    }
    const code128CError = validateCode128C(start);
    if (code128CError) return { error: code128CError } as const;
    if (barcodeFormat === "EAN13") {
      if (!/^\d{13}$/.test(start)) return { error: "Nomor awal EAN-13 harus tepat 13 digit." } as const;
      const startError = validateEan13(start);
      if (startError) return { error: startError } as const;
      const first = BigInt(start.slice(0, 12));
      const last = (first + BigInt(count - 1)).toString();
      if (last.length > 12) return { error: "Nomor urutan melampaui 12 digit data EAN-13." } as const;
      return {
        values: Array.from({ length: count }, (_, index) => {
          const data = (first + BigInt(index)).toString().padStart(12, "0");
          return `${data}${calculateEan13CheckDigit(data)}`;
        }),
      } as const;
    }
    if (barcodeFormat === "ITF14") {
      if (!/^\d{14}$/.test(start)) return { error: "Nomor awal ITF-14 harus tepat 14 digit." } as const;
      const startError = validateItf14(start);
      if (startError) return { error: startError } as const;
      const first = BigInt(start.slice(0, 13));
      const last = (first + BigInt(count - 1)).toString();
      if (last.length > 13) return { error: "Nomor urutan melampaui 13 digit data ITF-14." } as const;
      return {
        values: Array.from({ length: count }, (_, index) => {
          const data = (first + BigInt(index)).toString().padStart(13, "0");
          return `${data}${calculateItf14CheckDigit(data)}`;
        }),
      } as const;
    }
    const first = BigInt(start);
    if ((first + BigInt(count - 1)).toString().length > start.length) {
      return { error: "Nomor urutan melampaui jumlah digit nomor awal." } as const;
    }
    return {
      values: Array.from({ length: count }, (_, index) => (first + BigInt(index)).toString().padStart(start.length, "0")),
    } as const;
  }
  const lines = batch.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { error: "Tempel setidaknya satu nomor untuk membuat kartu." } as const;
  const invalid = lines.findIndex((line) => !/^\d+$/.test(line));
  if (invalid !== -1) return { error: `Baris ${invalid + 1} berisi karakter selain angka.` } as const;
  const invalidCode128C = lines.findIndex((line) => validateCode128C(line));
  if (invalidCode128C !== -1) return { error: `Baris ${invalidCode128C + 1}: ${validateCode128C(lines[invalidCode128C])}` } as const;
  if (barcodeFormat === "ITF14") {
    const invalidItf = lines.findIndex((line) => validateItf14(line));
    if (invalidItf !== -1) return { error: `Baris ${invalidItf + 1}: ${validateItf14(lines[invalidItf])}` } as const;
  }
  if (barcodeFormat === "EAN13") {
    const invalidEan = lines.findIndex((line) => validateEan13(line));
    if (invalidEan !== -1) return { error: `Baris ${invalidEan + 1}: ${validateEan13(lines[invalidEan])}` } as const;
  }
  return { values: lines } as const;
}

function groupedNumber(value: string) {
  return value.replace(/(\d{3})(?=\d)/g, "$1 ");
}

function calculateItf14CheckDigit(value: string) {
  const sum = Array.from(value).reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 3 : 1),
    0,
  );
  return String((10 - (sum % 10)) % 10);
}

function calculateEan13CheckDigit(value: string) {
  const sum = Array.from(value).reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return String((10 - (sum % 10)) % 10);
}

function drawImageCover(ctx: CanvasRenderingContext2D, image: HTMLImageElement) {
  const scale = Math.max(WIDTH / image.naturalWidth, HEIGHT / image.naturalHeight);
  const drawWidth = image.naturalWidth * scale;
  const drawHeight = image.naturalHeight * scale;
  ctx.drawImage(image, (WIDTH - drawWidth) / 2, (HEIGHT - drawHeight) / 2, drawWidth, drawHeight);
}

function drawTemplate(ctx: CanvasRenderingContext2D, template: Template | null) {
  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  if (template) {
    drawImageCover(ctx, template.image);
  } else {
    ctx.fillStyle = "#eef0ed";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
}

function renderFront(ctx: CanvasRenderingContext2D, template: Template | null, settings: Settings, number: string) {
  drawTemplate(ctx, template);
  ctx.save();
  if (settings.mirror) {
    ctx.translate(WIDTH, 0);
    ctx.scale(-1, 1);
  }
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `${settings.frontFont}px Arial, Helvetica, sans-serif`;
  ctx.fillText(number, settings.frontX, settings.frontY);
  ctx.restore();
}

async function renderBack(
  ctx: CanvasRenderingContext2D,
  template: Template | null,
  settings: Settings,
  number: string,
  isMirrored: boolean,
  shouldDraw?: () => boolean,
) {
  drawTemplate(ctx, template);
  const { barX: x, barY: y, barWidth: width, barHeight: totalHeight, barFont: textSize } = settings;
  const showText = settings.numberFormat !== "none" && textSize > 0;
  const isCode93 = settings.barcodeFormat === "CODE93";
  const isCode128Auto = settings.barcodeFormat === "CODE128";
  const captionScale = settings.barcodeFormat === "EAN13" || isCode93
    ? 0.8
    : isCode128Auto ? CODE128_AUTO_REFERENCE_LAYOUT.captionScale : 1;
  const captionHeight = isCode93 || isCode128Auto ? textSize * captionScale : textSize;
  const textHeight = showText ? Math.min(totalHeight * 0.35, captionHeight + 9) : 0;
  const barHeight = Math.max(12, totalHeight - textHeight);
  if (settings.barcodeFormat === "CODE128C" && (!/^\d+$/.test(number) || number.length % 2 !== 0)) {
    throw new Error("Code 128 C memerlukan angka dengan jumlah digit genap. Pilih CODE128 Auto atau ubah nomor.");
  }
  if (settings.barcodeFormat === "EAN13") {
    if (!/^\d{13}$/.test(number)) {
      throw new Error("EAN-13 memerlukan tepat 13 digit.");
    }
    if (number !== `${number.slice(0, 12)}${calculateEan13CheckDigit(number.slice(0, 12))}`) {
      throw new Error("Nomor EAN-13 memiliki digit cek yang tidak valid.");
    }
  }
  if (settings.barcodeFormat === "ITF14") {
    if (!/^\d{14}$/.test(number)) {
      throw new Error("ITF-14 memerlukan tepat 14 digit.");
    }
    if (number !== `${number.slice(0, 13)}${calculateItf14CheckDigit(number.slice(0, 13))}`) {
      throw new Error("Nomor ITF-14 memiliki digit cek yang tidak valid.");
    }
  }
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const barcodeMargin = settings.barcodeFormat === "EAN13" || isCode93 ? 10 : 30;
  try {
    JsBarcode(svg, number, {
      format: settings.barcodeFormat,
      displayValue: false,
      margin: isCode128Auto ? 0 : barcodeMargin,
      marginTop: isCode128Auto ? 0 : undefined,
      marginBottom: isCode128Auto ? 0 : undefined,
      marginLeft: isCode128Auto ? barcodeMargin : undefined,
      marginRight: isCode128Auto ? barcodeMargin : undefined,
      width: settings.barcodeFormat === "EAN13" ? 6 : isCode93 ? 4 : 3,
      height: barHeight,
      background: "transparent",
      lineColor: "#000000",
    });
  } catch {
    throw new Error(`Barcode tidak dapat dibuat untuk nomor ${number}.`);
  }
  const barcodeBlob = new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" });
  const barcode = await loadImage(barcodeBlob);
  try {
    if (shouldDraw && !shouldDraw()) return;
    ctx.save();
    if (isMirrored) {
      ctx.translate(WIDTH, 0);
      ctx.scale(-1, 1);
    }
    const eanScale = settings.barcodeFormat === "EAN13" ? 0.8 : 1;
    const code93WidthScale = isCode93 ? 0.92 : 1;
    const code93HeightScale = isCode93 ? 0.9 : 1;
    const maxBarWidth = width * (settings.barcodeFormat === "EAN13" ? eanScale : isCode93 ? code93WidthScale : 0.92);
    const drawnHeight = isCode128Auto
      ? totalHeight * CODE128_AUTO_REFERENCE_LAYOUT.barsHeight
      : barHeight * (settings.barcodeFormat === "EAN13" ? eanScale : code93HeightScale);
    const drawnWidth = Math.min(
      maxBarWidth,
      barcode.image.naturalWidth * (isCode128Auto ? 1 : drawnHeight / barcode.image.naturalHeight),
    );
    const barcodeX = x + (width - drawnWidth) / 2;
    const barcodeY = isCode128Auto
      ? y + totalHeight * CODE128_AUTO_REFERENCE_LAYOUT.top
      : y + Math.max(3, (barHeight - drawnHeight) / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(barcode.image, barcodeX, barcodeY, drawnWidth, drawnHeight);
    ctx.imageSmoothingEnabled = true;
    if (showText) {
      const captionSize = textSize * (isCode93 || isCode128Auto ? captionScale : eanScale);
      ctx.fillStyle = "#111111";
      ctx.font = `700 ${captionSize}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const captionY = isCode128Auto
        ? y + totalHeight * CODE128_AUTO_REFERENCE_LAYOUT.captionBaseline
        : settings.barcodeFormat === "EAN13" || isCode93
          ? barcodeY + drawnHeight + captionSize * 0.9
          : y + totalHeight - Math.max(5, (textHeight - textSize) / 2);
      if (settings.barcodeFormat === "EAN13") {
        ctx.textAlign = "left";
        ctx.fillText(number[0], Math.max(x + 4, barcodeX - captionSize * 1.15), captionY, captionSize);
        ctx.textAlign = "center";
        ctx.fillText(number.slice(1, 7), barcodeX + drawnWidth * 0.31, captionY, drawnWidth * 0.46);
        ctx.fillText(number.slice(7), barcodeX + drawnWidth * 0.80, captionY, drawnWidth * 0.38);
      } else {
        const caption = settings.numberFormat === "grouped" ? groupedNumber(number) : number;
        ctx.fillText(caption, barcodeX + drawnWidth / 2, captionY, Math.max(1, drawnWidth));
      }
    }
    ctx.restore();
  } finally {
    URL.revokeObjectURL(barcode.url);
  }
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("JPEG tidak dapat dibuat dari kanvas."));
        return;
      }
      try {
        resolve(await setJpegResolution(blob, PRINT_PPI));
      } catch (error) {
        reject(error);
      }
    }, "image/jpeg", 1);
  });
}

async function setJpegResolution(blob: Blob, ppi: number) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("Data hasil render bukan JPEG yang valid.");
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segmentLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
    if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
    const isJfif =
      marker === 0xe0 &&
      bytes[offset + 4] === 0x4a &&
      bytes[offset + 5] === 0x46 &&
      bytes[offset + 6] === 0x49 &&
      bytes[offset + 7] === 0x46 &&
      bytes[offset + 8] === 0;
    if (isJfif && segmentLength >= 16) {
      bytes[offset + 11] = 1;
      bytes[offset + 12] = (ppi >> 8) & 0xff;
      bytes[offset + 13] = ppi & 0xff;
      bytes[offset + 14] = (ppi >> 8) & 0xff;
      bytes[offset + 15] = ppi & 0xff;
      return new Blob([bytes], { type: "image/jpeg" });
    }
    offset += segmentLength + 2;
  }
  const jfif = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x01, (ppi >> 8) & 0xff, ppi & 0xff,
    (ppi >> 8) & 0xff, ppi & 0xff, 0x00, 0x00,
  ]);
  const output = new Uint8Array(bytes.length + jfif.length);
  output.set(bytes.subarray(0, 2), 0);
  output.set(jfif, 2);
  output.set(bytes.subarray(2), 2 + jfif.length);
  return new Blob([output], { type: "image/jpeg" });
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SectionTitle({ step, title, caption }: { step: ReactNode; title: string; caption?: string }) {
  return (
    <div className="panel-head">
      <div className="panel-title"><span className="step" aria-hidden="true">{step}</span><h2>{title}</h2></div>
      {caption && <span className="panel-caption">{caption}</span>}
    </div>
  );
}

function RangeControl({
  id, label, value, min, max, onChange,
}: {
  id: string; label: string; value: number; min: number; max: number; onChange: (value: number) => void;
}) {
  return (
    <div className="range-field">
      <label htmlFor={id}>{label}</label>
      <div className="range-line">
        <input id={id} type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
        <span className="range-value">{value} px</span>
      </div>
    </div>
  );
}

type SelectOption<T extends string> = { value: T; label: string };

function CustomSelect<T extends string>({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  className = "",
}: {
  id: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selectedOption = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsideClick);
    return () => window.removeEventListener("pointerdown", closeOnOutsideClick);
  }, [open]);

  const focusOption = (index: number) => {
    if (!options.length) return;
    const nextIndex = (index + options.length) % options.length;
    setActiveIndex(nextIndex);
    requestAnimationFrame(() => optionRefs.current[nextIndex]?.focus());
  };

  const openMenu = (index = selectedIndex) => {
    if (!options.length) return;
    setOpen(true);
    focusOption(index);
  };

  const choose = (option: SelectOption<T>) => {
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={`custom-select ${className}`} data-open={open} ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="custom-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-listbox`}
        onClick={() => open ? setOpen(false) : openMenu()}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(event.key === "ArrowDown" ? selectedIndex : selectedIndex - 1);
          } else if (event.key === "Escape" && open) {
            setOpen(false);
          }
        }}
      >
        <span>{selectedOption?.label ?? "Pilih opsi"}</span>
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && <div id={`${id}-listbox`} className="custom-select-menu" role="listbox" aria-label={ariaLabel ?? "Pilihan"}>
        {options.map((option, index) => (
          <button
            key={option.value}
            ref={(element) => { optionRefs.current[index] = element; }}
            type="button"
            className={`custom-select-option ${option.value === value ? "selected" : ""}`}
            role="option"
            aria-selected={option.value === value}
            tabIndex={activeIndex === index ? 0 : -1}
            onFocus={() => setActiveIndex(index)}
            onClick={() => choose(option)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                focusOption(index + 1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusOption(index - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                focusOption(0);
              } else if (event.key === "End") {
                event.preventDefault();
                focusOption(options.length - 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
              }
            }}
          >
            <span>{option.label}</span>
            {option.value === value && <Check size={15} aria-hidden="true" />}
          </button>
        ))}
        {!options.length && <div className="custom-select-empty">Belum ada pilihan</div>}
      </div>}
    </div>
  );
}

function UploadTile({ side, template, onUpload }: { side: Side; template: Template | null; onUpload: (side: Side, file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const label = side === "front" ? "Sisi depan" : "Sisi belakang";
  return (
    <div className="upload-tile">
      <div className="upload-icon"><FileImage size={22} strokeWidth={2.2} /></div>
      <div className="upload-info">
        <div className="upload-name">{label}</div>
        <div className="upload-file">{template?.name ?? "Memuat template..."}</div>
      </div>
      <button className="upload-action" type="button" onClick={() => inputRef.current?.click()}>
        Ganti
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onUpload(side, file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

function PreviewCard({
  side,
  canvasRef,
  included,
}: {
  side: Side;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  included: boolean;
}) {
  const front = side === "front";
  return (
    <div className="min-w-0">
      <div className="card-label">
        <strong className="inline-flex items-center gap-2">{front ? <CreditCard size={16} /> : <Barcode size={17} />}{front ? "DEPAN" : "BELAKANG"}</strong>
        <span>1028 × 650 px</span>
      </div>
      <div className={`canvas-wrap ${included ? "" : "excluded"}`}>
        <canvas ref={canvasRef} width={WIDTH} height={HEIGHT} />
        {!included && <span className="excluded-badge">Tidak diekspor</span>}
      </div>
    </div>
  );
}

export default function Home() {
  const frontCanvasRef = useRef<HTMLCanvasElement>(null);
  const backCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderTokenRef = useRef(0);
  const toastTimerRef = useRef<number | null>(null);
  const [mode, setMode] = useState<Mode>("single");
  const [printMode, setPrintMode] = useState<PrintMode>("two-sided");
  const [oneSidedSide, setOneSidedSide] = useState<Side>("back");
  const [templates, setTemplates] = useState<Record<Side, Template | null>>({ front: null, back: null });
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [singleNumber, setSingleNumber] = useState("8997007770017");
  const [startNumber, setStartNumber] = useState("8997007770017");
  const [sequenceCount, setSequenceCount] = useState("50");
  const [batchNumbers, setBatchNumbers] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [error, setError] = useState("");
  const [pdfStatus, setPdfStatus] = useState("PDF teks maupun scan · tinjau nomor hasil OCR sebelum ekspor.");
  const [toast, setToast] = useState("");
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [ready, setReady] = useState(false);

  const parsed = useMemo(
    () => getNumbers(mode, singleNumber, startNumber, sequenceCount, batchNumbers, settings.barcodeFormat),
    [mode, singleNumber, startNumber, sequenceCount, batchNumbers, settings.barcodeFormat],
  );
  const numbers: string[] = "values" in parsed ? parsed.values : [];
  const currentNumber = numbers[selectedIndex] ?? numbers[0] ?? "";

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  const installTemplate = useCallback(async (side: Side, blob: Blob, name: string, persist: boolean) => {
    const loaded = await loadImage(blob);
    setTemplates((previous) => {
      if (previous[side]) URL.revokeObjectURL(previous[side]!.url);
      return { ...previous, [side]: { ...loaded, name } };
    });
    if (persist) await storeTemplate(side, blob, name);
  }, []);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const savedSettings = localStorage.getItem(SETTINGS_KEY);
        if (savedSettings) {
          try {
            const values = JSON.parse(savedSettings) as Partial<Settings>;
            const migratedFormat = localStorage.getItem(DEFAULT_FORMAT_MIGRATION_KEY) !== "done";
            const migratedLayout = localStorage.getItem(FULL_EAN_LAYOUT_MIGRATION_KEY) !== "done";
            setSettings({
              ...DEFAULTS,
              ...values,
              barcodeFormat: migratedFormat ? "CODE93" : (values.barcodeFormat ?? "CODE93"),
              barX: migratedLayout ? DEFAULTS.barX : (values.barX ?? DEFAULTS.barX),
              barY: migratedLayout ? DEFAULTS.barY : (values.barY ?? DEFAULTS.barY),
              barWidth: migratedLayout ? DEFAULTS.barWidth : (values.barWidth ?? DEFAULTS.barWidth),
              barHeight: migratedLayout ? DEFAULTS.barHeight : (values.barHeight ?? DEFAULTS.barHeight),
              barFont: migratedLayout ? DEFAULTS.barFont : (values.barFont ?? DEFAULTS.barFont),
            });
            if (migratedFormat) localStorage.setItem(DEFAULT_FORMAT_MIGRATION_KEY, "done");
            if (migratedLayout) localStorage.setItem(FULL_EAN_LAYOUT_MIGRATION_KEY, "done");
          } catch (settingsError) {
            console.warn("Pengaturan tersimpan tidak dapat dibaca:", settingsError);
          }
        }
      } catch (storageError) {
        console.warn("Preferensi browser tidak dapat dibaca:", storageError);
      }

      try {
        const saved = await readTemplates();
        const storedSides = new Set<Side>();
        for (const [side, entry] of saved) {
          if (!active) return;
          if (side === "back" && entry.name === "template belakang.jpg") {
            const response = await fetch("/templates/back.jpg");
            if (!response.ok) throw new Error("Template belakang baru tidak dapat dimuat.");
            const blob = await response.blob();
            const name = "template belakang baru.jpg";
            await installTemplate(side, blob, name, false);
            await storeTemplate(side, blob, name);
          } else {
            await installTemplate(side, entry.blob, entry.name || "Template tersimpan", false);
          }
          storedSides.add(side);
        }
        for (const side of ["front", "back"] as const) {
          if (storedSides.has(side) || !active) continue;
          const response = await fetch(side === "front" ? "/templates/front.jpg" : "/templates/back.jpg");
          if (!response.ok) throw new Error(`Template ${side === "front" ? "depan" : "belakang"} tidak dapat dimuat.`);
          const blob = await response.blob();
          const name = side === "front" ? "template depan.jpg" : "template belakang baru.jpg";
          await installTemplate(side, blob, name, false);
          await storeTemplate(side, blob, name);
        }
      } catch (templateError) {
        console.error("Template tidak dapat dipulihkan:", templateError);
        if (active) showToast("Template gagal dimuat. Pilih file template untuk melanjutkan.");
      } finally {
        if (active) {
          setReady(true);
          setError("");
        }
      }
    }
    void initialize();
    return () => {
      active = false;
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    };
  }, [installTemplate, showToast]);

  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (storageError) {
      console.warn("Pengaturan tidak dapat disimpan:", storageError);
    }
  }, [settings, ready]);

  const paint = useCallback(async (number: string) => {
    const front = frontCanvasRef.current;
    const back = backCanvasRef.current;
    if (!front || !back) return;
    const frontCtx = front.getContext("2d");
    const backCtx = back.getContext("2d");
    if (!frontCtx || !backCtx) throw new Error("Canvas tidak tersedia di browser ini.");
    renderFront(frontCtx, templates.front, settings, number);
    const token = ++renderTokenRef.current;
    if (printMode === "two-sided" || oneSidedSide === "back") {
      await renderBack(backCtx, templates.back, settings, number, settings.mirror, () => token === renderTokenRef.current);
    } else {
      drawTemplate(backCtx, templates.back);
    }
    if (token !== renderTokenRef.current) return;
  }, [oneSidedSide, printMode, settings, templates]);

  useEffect(() => {
    if (!ready || !currentNumber || !numbers.length) {
      const frontCtx = frontCanvasRef.current?.getContext("2d");
      const backCtx = backCanvasRef.current?.getContext("2d");
      if (frontCtx) drawTemplate(frontCtx, templates.front);
      if (backCtx) drawTemplate(backCtx, templates.back);
      return;
    }
    setSelectedIndex((index) => Math.min(index, numbers.length - 1));
    void paint(currentNumber).catch((renderError: unknown) => {
      const message = renderError instanceof Error ? renderError.message : "Preview gagal dibuat.";
      setError(message);
    });
  }, [currentNumber, numbers.length, paint, ready, templates.front, templates.back]);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((previous) => ({ ...previous, [key]: value }));
  };

  const handleUpload = async (side: Side, file: File) => {
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      showToast("Pilih file gambar JPG atau PNG.");
      return;
    }
    try {
      const imageBlob = file.slice(0, file.size, file.type);
      await installTemplate(side, imageBlob, file.name, true);
      showToast(`Template ${side === "front" ? "depan" : "belakang"} tersimpan.`);
    } catch (uploadError) {
      console.error(uploadError);
      showToast(uploadError instanceof Error ? uploadError.message : "Template gagal disimpan.");
    }
  };

  const resetSettings = () => {
    setSettings(DEFAULTS);
    showToast("Posisi dan ukuran dikembalikan ke default.");
  };

  const importPdf = async (file: File) => {
    setPdfStatus("Membaca PDF...");
    try {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
      const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
      const extracted: string[] = [];
      let worker: Awaited<ReturnType<typeof import("tesseract.js").createWorker>> | null = null;
      let usedOcr = false;
      try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const content = await page.getTextContent();
          const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
          let matches = text.match(/\d{8,}/g) ?? [];
          if (!matches.length) {
            usedOcr = true;
            const { createWorker } = await import("tesseract.js");
            if (!worker) {
              setPdfStatus("PDF berupa scan · menyiapkan OCR...");
              worker = await createWorker("eng", 1);
              await worker.setParameters({ tessedit_char_whitelist: "0123456789", tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK });
            }
            const viewport = page.getViewport({ scale: Math.min(4.5, 3600 / Math.max(page.view[2], page.view[3])) });
            const pageCanvas = document.createElement("canvas");
            pageCanvas.width = Math.ceil(viewport.width);
            pageCanvas.height = Math.ceil(viewport.height);
            const context = pageCanvas.getContext("2d", { willReadFrequently: true });
            if (!context) throw new Error("Canvas OCR tidak tersedia.");
            await page.render({ canvas: pageCanvas, canvasContext: context, viewport }).promise;
            setPdfStatus(`OCR halaman ${pageNumber} dari ${pdf.numPages}...`);
            const result = await worker.recognize(pageCanvas);
            matches = result.data.text.match(/\d{8,}/g) ?? [];
            pageCanvas.width = 0;
            pageCanvas.height = 0;
          }
          extracted.push(...matches);
        }
      } finally {
        if (worker) await worker.terminate();
      }
      const unique = [...new Set(extracted)];
      if (!unique.length) throw new Error("Nomor tidak ditemukan. Pastikan PDF memiliki teks atau hasil scan yang jelas.");
      let normalized = unique;
      if (usedOcr) {
        const lengthCounts = new Map<number, number>();
        unique.forEach((value) => lengthCounts.set(value.length, (lengthCounts.get(value.length) ?? 0) + 1));
        const commonLength = [...lengthCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const reference = unique.find((value) => value.length === commonLength);
        if (commonLength === 13 && reference?.startsWith("1111111000")) {
          normalized = unique.map((value) =>
            value.length === 14 && value.slice(0, 9) === reference.slice(0, 9) && value[9] === "1" && value[10] === "0"
              ? value.slice(0, 9) + value.slice(10)
              : value,
          );
        }
      }
      setBatchNumbers(normalized.join("\n"));
      setMode("batch");
      setSelectedIndex(0);
      setPdfStatus(`${normalized.length} nomor terbaca${usedOcr ? " · hasil OCR, tinjau dahulu" : ""} · ${file.name}`);
      setError("");
      showToast(`${normalized.length} nomor berhasil diimpor dari PDF.`);
    } catch (pdfError) {
      console.error(pdfError);
      const message = pdfError instanceof Error ? pdfError.message : "PDF gagal dibaca.";
      setPdfStatus("Impor gagal.");
      setError(message);
      showToast(message);
    }
  };

  const downloadOne = async (side: Side) => {
    if (printMode === "one-sided" && side !== oneSidedSide) {
      showToast(`Pilih mode 2 sisi untuk mengunduh sisi ${side === "front" ? "depan" : "belakang"} juga.`);
      return;
    }
    if (!currentNumber) {
      setError("Perbaiki nomor kartu sebelum mengunduh.");
      return;
    }
    await paint(currentNumber);
    const canvas = side === "front" ? frontCanvasRef.current : backCanvasRef.current;
    if (!canvas) throw new Error("Preview kartu tidak tersedia.");
    saveBlob(await canvasBlob(canvas), `${String(selectedIndex + 1).padStart(3, "0")}_${side === "front" ? "depan" : "belakang"}.jpg`);
  };

  const downloadAll = async () => {
    if (!("values" in parsed) || !parsed.values.length) {
      const message = "error" in parsed ? parsed.error : "Tambahkan nomor kartu sebelum ekspor.";
      setError(message);
      return;
    }
    const outputSides: Side[] = printMode === "two-sided" ? ["front", "back"] : [oneSidedSide];
    if (outputSides.some((side) => !templates[side])) {
      showToast("Template untuk sisi yang dipilih harus tersedia.");
      return;
    }
    if (outputSides.includes("back") && settings.barcodeFormat === "CODE128C" && parsed.values.some((number) => !/^\d+$/.test(number) || number.length % 2 !== 0)) {
      showToast("Code 128 C memerlukan nomor dengan jumlah digit genap.");
      return;
    }
    if (outputSides.includes("back") && settings.barcodeFormat === "ITF14" && parsed.values.some((number) => {
      return !/^\d{14}$/.test(number) || number !== `${number.slice(0, 13)}${calculateItf14CheckDigit(number.slice(0, 13))}`;
    })) {
      showToast("Semua nomor untuk ITF-14 harus terdiri dari 14 digit dengan digit cek yang valid.");
      return;
    }
    if (outputSides.includes("back") && settings.barcodeFormat === "EAN13" && parsed.values.some((number) => {
      return !/^\d{13}$/.test(number) || number !== `${number.slice(0, 12)}${calculateEan13CheckDigit(number.slice(0, 12))}`;
    })) {
      showToast("Semua nomor untuk EAN-13 harus terdiri dari 13 digit dengan digit cek yang valid.");
      return;
    }
    setExporting(true);
    setProgress(0);
    setProgressLabel("Menyiapkan kartu...");
    const zip = new JSZip();
    const front = frontCanvasRef.current;
    const back = backCanvasRef.current;
    const frontCtx = front?.getContext("2d");
    const backCtx = back?.getContext("2d");
    if (!front || !back || !frontCtx || !backCtx) {
      setExporting(false);
      showToast("Canvas tidak tersedia di browser ini.");
      return;
    }
    try {
      for (let index = 0; index < parsed.values.length; index++) {
        const number = parsed.values[index];
        const prefix = String(index + 1).padStart(3, "0");
        if (outputSides.includes("front")) {
          renderFront(frontCtx, templates.front, settings, number);
          zip.file(`${prefix}_depan.jpg`, await canvasBlob(front));
        }
        if (outputSides.includes("back")) {
          await renderBack(backCtx, templates.back, settings, number, settings.mirror);
          zip.file(`${prefix}_belakang.jpg`, await canvasBlob(back));
        }
        setProgress(Math.round(((index + 1) / parsed.values.length) * 100));
        setProgressLabel(`Memproses kartu ${index + 1} dari ${parsed.values.length}`);
        if (index % 5 === 0) await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
      setProgressLabel("Menyusun arsip ZIP...");
      const archive = await zip.generateAsync({ type: "blob", compression: "STORE" }, (metadata) => {
        setProgress(Math.round(metadata.percent));
      });
      saveBlob(archive, `id-card-${parsed.values.length}-kartu.zip`);
      setProgressLabel(`Selesai · ${parsed.values.length} kartu · ${outputSides.length} sisi`);
      showToast(`ZIP berisi ${parsed.values.length} kartu (${outputSides.length} sisi) siap diunduh.`);
    } catch (exportError) {
      console.error(exportError);
      setProgressLabel("Ekspor gagal");
      showToast(exportError instanceof Error ? exportError.message : "Ekspor gagal. Periksa template dan format nomor.");
    } finally {
      setExporting(false);
      if (currentNumber) void paint(currentNumber).catch((paintError) => console.error(paintError));
    }
  };

  const onPdfFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void importPdf(file);
    event.target.value = "";
  };

  const inputError = "error" in parsed ? parsed.error : "";
  const frontIncluded = printMode === "two-sided" || oneSidedSide === "front";
  const backIncluded = printMode === "two-sided" || oneSidedSide === "back";
  const setModeAndResetIndex = (next: Mode) => {
    setMode(next);
    setSelectedIndex(0);
    setError("");
  };

  return (
    <main className="mx-auto min-h-screen w-full min-w-0 max-w-[1600px] px-4 pb-14 sm:px-6 lg:px-8">
      <header className="sticky top-0 z-20 -mx-4 mb-7 flex h-[76px] items-center border-b border-[var(--line)] bg-[color:var(--paper)]/95 px-4 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex items-center gap-3">
          <div className="brand-mark"><CreditCard size={22} strokeWidth={2.2} /></div>
          <div className="text-[15px] font-extrabold tracking-tight">cardpress <span className="font-normal text-[var(--muted)]">/ UV studio</span></div>
        </div>
      </header>

      <section className="hero animate-rise">
        <div className="hero-copy">
          <p className="step-kicker"><span className="hero-status" />STUDIO CETAK UV</p>
          <h1>Desain kartu,<br /><span>siap cetak.</span></h1>
          <p>Atur template dan nomor, lihat hasilnya langsung, lalu ekspor sesuai sisi pesanan.</p>
        </div>
        <div className="hero-spec">
          <div className="hero-card-icon"><CreditCard size={35} strokeWidth={1.7} /></div>
          <div><strong>300 <small>PPI</small></strong><span>Landscape · 8,7 × 5,5 cm</span><span>Kanvas 1028 × 650 px</span></div>
        </div>
      </section>

      <div className="grid w-full min-w-0 items-start gap-5 lg:grid-cols-[minmax(350px,410px)_minmax(0,1fr)]">
        <div className="grid min-w-0 gap-4">
          <section className="panel animate-rise overflow-hidden">
            <SectionTitle step={<Images size={17} />} title="Template kartu" caption="JPG / PNG" />
            <div className="grid gap-2.5 px-5 pb-5">
              <UploadTile side="front" template={templates.front} onUpload={handleUpload} />
              <UploadTile side="back" template={templates.back} onUpload={handleUpload} />
              <p className="muted-note leading-relaxed">Pilih template polos tanpa nomor atau barcode agar tidak tercetak rangkap.</p>
            </div>
          </section>

          <section className="panel animate-rise animate-delay-1 overflow-hidden">
            <SectionTitle step={<Hash size={17} />} title="Nomor kartu" caption={`${numbers.length || 0} kartu`} />
            <div className="tabs" role="tablist" aria-label="Mode input nomor">
              {([["single", "Satuan"], ["sequence", "Berurutan"], ["batch", "Batch"]] as const).map(([key, label]) => (
                <button key={key} type="button" role="tab" aria-selected={mode === key} className={`tab ${mode === key ? "active" : ""}`} onClick={() => setModeAndResetIndex(key)}>{label}</button>
              ))}
            </div>
            <div className="tab-content">
              {mode === "single" && (
                <div className="field">
                  <label htmlFor="singleNumber">Nomor kode</label>
                  <input id="singleNumber" type="text" inputMode="numeric" autoComplete="off" value={singleNumber} onChange={(event) => setSingleNumber(event.target.value)} />
                </div>
              )}
              {mode === "sequence" && (
                <div className="grid gap-3">
                  <div className="field">
                    <label htmlFor="startNumber">Nomor awal</label>
                    <input id="startNumber" type="text" inputMode="numeric" value={startNumber} onChange={(event) => setStartNumber(event.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="sequenceCount">Jumlah kartu</label>
                    <input id="sequenceCount" type="number" min={1} max={10000} value={sequenceCount} onChange={(event) => setSequenceCount(event.target.value)} />
                  </div>
                </div>
              )}
              {mode === "batch" && (
                <div className="grid gap-4">
                  <div className="field">
                    <label htmlFor="pdfFile">Impor nomor dari PDF</label>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="btn !min-h-9 cursor-pointer"><FileUp size={14} /> Pilih PDF member
                        <input id="pdfFile" className="hidden" type="file" accept="application/pdf,.pdf" onChange={onPdfFile} />
                      </label>
                      <span className="min-w-0 flex-1 text-[10px] leading-relaxed text-[var(--muted)]">{pdfStatus}</span>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="batchNumbers">Daftar nomor <span className="font-normal text-[var(--muted)]">satu nomor per baris</span></label>
                    <textarea id="batchNumbers" spellCheck={false} placeholder={"8997007770017\n8997007770024\n8997007770031"} value={batchNumbers} onChange={(event) => setBatchNumbers(event.target.value)} />
                  </div>
                </div>
              )}
            </div>
            {(error || inputError) && <div className="error-box" role="alert">{error || inputError}</div>}
          </section>

          <section className="panel animate-rise animate-delay-2">
            <SectionTitle step={<SlidersHorizontal size={17} />} title="Kalibrasi posisi" caption="px pada kanvas asli" />
            <div className="cal-section">
              <div className="cal-title"><strong>Teks nomor · depan</strong><span>1028 × 650 px</span></div>
              <div className="cal-grid">
                <RangeControl id="frontX" label="Posisi X" min={0} max={900} value={settings.frontX} onChange={(value) => updateSetting("frontX", value)} />
                <RangeControl id="frontY" label="Posisi Y" min={0} max={600} value={settings.frontY} onChange={(value) => updateSetting("frontY", value)} />
                <RangeControl id="frontFont" label="Ukuran font" min={8} max={80} value={settings.frontFont} onChange={(value) => updateSetting("frontFont", value)} />
              </div>
            </div>
            <div className="cal-section">
              <div className="cal-title"><strong>Barcode · belakang</strong><span>{settings.barcodeFormat === "ITF14" ? "ITF-14" : settings.barcodeFormat === "EAN13" ? "EAN-13" : settings.barcodeFormat === "CODE93" ? "Code 93" : settings.barcodeFormat === "CODE128" ? "Code 128 Auto" : settings.barcodeFormat === "CODE128C" ? "Code 128 C" : settings.barcodeFormat}</span></div>
              <div className="cal-grid">
                <RangeControl id="barX" label="Posisi X" min={0} max={638} value={settings.barX} onChange={(value) => updateSetting("barX", value)} />
                <RangeControl id="barY" label="Posisi Y" min={0} max={540} value={settings.barY} onChange={(value) => updateSetting("barY", value)} />
                <RangeControl id="barWidth" label="Lebar area" min={120} max={800} value={settings.barWidth} onChange={(value) => updateSetting("barWidth", value)} />
                <RangeControl id="barHeight" label="Tinggi total" min={50} max={240} value={settings.barHeight} onChange={(value) => updateSetting("barHeight", value)} />
                <RangeControl id="barFont" label="Ukuran teks angka" min={0} max={42} value={settings.barFont} onChange={(value) => updateSetting("barFont", value)} />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 px-5 pb-4 sm:grid-cols-2">
              <div className="field">
                <label htmlFor="barcodeFormat">Format barcode</label>
                <CustomSelect<Settings["barcodeFormat"]>
                  id="barcodeFormat"
                  value={settings.barcodeFormat}
                  options={[
                    { value: "CODE93", label: "Code 93" },
                    { value: "EAN13", label: "EAN-13 · 13 digit" },
                    { value: "CODE128", label: "Code 128 Auto · Set C/B" },
                    { value: "CODE128C", label: "Code 128 C · angka genap" },
                    { value: "ITF14", label: "ITF-14 · 14 digit" },
                  ]}
                  onChange={(value) => updateSetting("barcodeFormat", value)}
                />
                {settings.barcodeFormat === "CODE128" && (
                  <p className="muted-note">
                    Untuk 13 digit, otomatis memakai Set C untuk 12 digit pertama dan Set B untuk digit terakhir.
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor="numberFormat">Teks angka bawah</label>
                <CustomSelect<Settings["numberFormat"]>
                  id="numberFormat"
                  value={settings.numberFormat}
                  options={[{ value: "grouped", label: "Kelompok 3 digit" }, { value: "plain", label: "Tanpa spasi" }, { value: "none", label: "Tanpa teks" }]}
                  onChange={(value) => updateSetting("numberFormat", value)}
                />
              </div>
            </div>
            <label className="inline-check">
              <input type="checkbox" checked={settings.mirror} onChange={(event) => updateSetting("mirror", event.target.checked)} />
              Mirror horizontal untuk sisi depan &amp; belakang
            </label>
            <div className="reset-row"><button type="button" className="text-button inline-flex items-center gap-1.5" onClick={resetSettings}><RotateCcw size={12} /> Kembalikan posisi default</button></div>
          </section>
        </div>

        <div className="grid min-w-0 gap-4">
          <section className="panel animate-rise animate-delay-1">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
              <div className="flex items-center gap-2.5">
                <span className="step" aria-hidden="true"><Eye size={17} /></span>
                <div><div className="text-[15px] font-bold">Live preview</div><div className="preview-count">Kartu {numbers.length ? selectedIndex + 1 : 0} dari {numbers.length} {currentNumber && `· ${currentNumber}`}</div></div>
              </div>
              <div className="nav-group">
                <button className="nav-btn" type="button" aria-label="Kartu sebelumnya" disabled={selectedIndex <= 0} onClick={() => setSelectedIndex((index) => Math.max(0, index - 1))}><ArrowLeft size={14} /></button>
                <CustomSelect
                  id="previewNumber"
                  ariaLabel="Pilih kartu"
                  className="nav-custom-select"
                  value={String(selectedIndex)}
                  options={numbers.map((number, index) => ({ value: String(index), label: `${String(index + 1).padStart(3, "0")} · ${number}` }))}
                  onChange={(value) => setSelectedIndex(Number(value))}
                />
                <button className="nav-btn" type="button" aria-label="Kartu berikutnya" disabled={selectedIndex >= numbers.length - 1} onClick={() => setSelectedIndex((index) => Math.min(numbers.length - 1, index + 1))}><ArrowRight size={14} /></button>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-5 p-5 md:grid-cols-2">
              <PreviewCard side="front" canvasRef={frontCanvasRef} included={frontIncluded} />
              <PreviewCard side="back" canvasRef={backCanvasRef} included={backIncluded} />
            </div>
            <div className="preview-foot">
              <span className="muted-note">Kanvas penuh · 1028 × 650 px · 300 PPI</span>
              <div className="download-area">
                <button className="btn" type="button" disabled={!frontIncluded} onClick={() => void downloadOne("front").catch((downloadError) => showToast(downloadError.message))}><ArrowDownToLine size={13} /> Depan .jpg</button>
                <button className="btn" type="button" disabled={!backIncluded} onClick={() => void downloadOne("back").catch((downloadError) => showToast(downloadError.message))}><ArrowDownToLine size={13} /> Belakang .jpg</button>
              </div>
            </div>
          </section>

          <section className="panel animate-rise animate-delay-2 overflow-hidden">
            <div className="side-mode">
              <div className="side-mode-head"><strong><Layers3 size={16} /> Sisi yang dicetak</strong><span>Atur sesuai pesanan konsumen</span></div>
              <div className="side-mode-options">
                <button className={`side-choice ${printMode === "one-sided" ? "active" : ""}`} type="button" aria-pressed={printMode === "one-sided"} onClick={() => setPrintMode("one-sided")}>1 sisi</button>
                <button className={`side-choice ${printMode === "two-sided" ? "active" : ""}`} type="button" aria-pressed={printMode === "two-sided"} onClick={() => setPrintMode("two-sided")}>2 sisi</button>
              </div>
              {printMode === "one-sided" && <div className="one-side-pick" role="group" aria-label="Pilih sisi untuk dicetak">
                <span>Ekspor sisi:</span>
                <button className={`side-choice ${oneSidedSide === "front" ? "active" : ""}`} type="button" aria-pressed={oneSidedSide === "front"} onClick={() => setOneSidedSide("front")}>Depan</button>
                <button className={`side-choice ${oneSidedSide === "back" ? "active" : ""}`} type="button" aria-pressed={oneSidedSide === "back"} onClick={() => setOneSidedSide("back")}>Belakang · barcode</button>
              </div>}
            </div>
            <div className="export-panel">
              <div className="export-copy"><strong className="text-[13px]"><Printer size={16} /> Siap untuk dicetak?</strong><span>{numbers.length} kartu · {printMode === "two-sided" ? "2 sisi" : "1 sisi"} · {numbers.length * (printMode === "two-sided" ? 2 : 1)} JPEG · 300 PPI</span></div>
              <div className="export-actions flex-wrap justify-end">
                <button className="btn" type="button" onClick={async () => { try { const sides: Side[] = printMode === "two-sided" ? ["front", "back"] : [oneSidedSide]; for (const side of sides) await downloadOne(side); } catch (downloadError) { showToast(downloadError instanceof Error ? downloadError.message : "Unduh gagal."); } }}>Unduh kartu ini</button>
                <button className="btn btn-primary px-4" type="button" disabled={exporting} onClick={() => void downloadAll()}>
                  <ArrowDownToLine size={15} /> {exporting ? "Sedang menyiapkan..." : "Download Semua (.ZIP)"}
                </button>
              </div>
            </div>
            {exporting && <div className="progress-wrap" aria-live="polite">
              <div className="progress-meta"><span>{progressLabel}</span><span>{progress}%</span></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${progress}%` }} /></div>
            </div>}
          </section>
        </div>
      </div>

      {toast && <div className="toast show" role="status">{toast}</div>}
      <div className="sr-only" aria-live="polite">{ready ? "Aplikasi siap" : "Memuat template kartu"}</div>
    </main>
  );
}
