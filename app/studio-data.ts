import { providerRequest, studioFetch } from "./provider-settings";

export type Garment = {
  id: string;
  name: string;
  image: string;
  tags: string;
  note: string;
  parentId?: string;
};

export type Message = { role: "user" | "assistant"; text: string; versionId?: string };
export type StudioData = {
  versions: Garment[];
  wardrobe: Garment[];
  messages: Message[];
  preference: string;
  selectedId: string | null;
};

export const example: Garment = {
  id: "example-jacket", name: "苔绿亚麻短外套", image: "/studio/jacket.jpg",
  tags: "外套，亚麻，苔绿色", note: "参考亚麻质感和简洁翻领",
};

export const initialData: StudioData = {
  versions: [], wardrobe: [], messages: [], preference: "", selectedId: null,
};

export function localStudio(action: "load", owner?: string): Promise<StudioData | undefined>;
export function localStudio(action: "save", owner: string | undefined, data: StudioData): Promise<undefined>;
export async function localStudio(action: "load" | "save", owner?: string, data?: StudioData) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("yiyang-studio", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("workspace");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<StudioData | undefined>((resolve, reject) => {
      const transaction = db.transaction("workspace", action === "save" ? "readwrite" : "readonly");
      const store = transaction.objectStore("workspace");
      const key = owner ? `studio-user-${owner}` : "studio";
      const request = action === "save" ? store.put(data, key) : store.get(key);
      transaction.oncomplete = () => resolve(action === "load" ? request.result : undefined);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readImage(file: Blob): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 12 * 1024 * 1024) {
    throw new Error("请选择不超过 12 MB 的 JPG、PNG 或 WebP 图片。");
  }
  const bitmap = await createImageBitmap(file).catch(() => { throw new Error("无法读取这张图片，请换一张。"); });
  try {
    const scale = Math.min(1, 1440 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理图片。");
    context.fillStyle = "#faf8f3";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.89);
  } finally {
    bitmap.close();
  }
}

export async function imageData(image: string) {
  if (image.startsWith("data:")) return image;
  const response = await fetch(image);
  if (!response.ok) throw new Error("无法读取参考图片。");
  return readImage(await response.blob());
}

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await studioFetch(`/api/studio/${path}`) : await providerRequest(path, body);
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "请求失败，请稍后重试。");
  return result;
}

export function downloadImage(image: string) {
  const link = document.createElement("a");
  link.href = image;
  link.download = image.startsWith("data:image/png") ? "衣样-试穿.png" : "衣样-试穿.jpg";
  link.click();
}
