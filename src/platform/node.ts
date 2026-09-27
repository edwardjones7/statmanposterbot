// Node-side loading of render dependencies (fonts, WASM, brand assets) for local scripts.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import type { Brand } from "../render/brand.ts";
import type { RenderDeps } from "../render/render.ts";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, "../..");

let wasmReady: Promise<void> | undefined;

export async function loadBrand(file = path.join(ROOT, "brand.json")): Promise<Brand> {
  return JSON.parse(await readFile(file, "utf8")) as Brand;
}

export async function loadRenderDeps(brand: Brand): Promise<RenderDeps> {
  wasmReady ??= readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")).then((buf) => initWasm(buf));

  const [body, display, mono, monoBold, logo, texture] = await Promise.all([
    font("@fontsource/inter/files/inter-latin-400-normal.woff"),
    font("@fontsource/outfit/files/outfit-latin-700-normal.woff"),
    font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff"),
    font("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-700-normal.woff"),
    brand.footer.logo ? loadImage(brand.footer.logo) : undefined,
    brand.texture ? loadImage(brand.texture) : undefined,
    wasmReady,
  ]);

  return { fonts: { body, display, mono, monoBold }, Resvg, logo, texture };
}

async function font(specifier: string): Promise<ArrayBuffer> {
  const buf = await readFile(require.resolve(specifier));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function loadImage(ref: string): Promise<string> {
  if (ref.startsWith("data:")) return ref;
  const file = path.resolve(ROOT, ref);
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
}
