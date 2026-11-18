"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, ArrowUpRight, Bookmark, Check, ChevronRight,
  CircleHelp, ScanLine, ImagePlus, Images, Layers3, LoaderCircle, MessageSquare, Plus, Search,
  Send, Shirt, SlidersHorizontal, Sparkles, Upload, UserRound, Video, X,
} from "lucide-react";
import LiveFitting from "./live-fitting";
import {
  api, downloadImage, example, imageData, initialData, localStudio, readImage,
  type Garment, type StudioData,
} from "./studio-data";

const pages = [
  { id: "try-on", name: "照片试穿", icon: ScanLine, group: "工作台" },
  { id: "live", name: "实时试穿", icon: Video, group: "工作台" },
  { id: "design", name: "对话设计", icon: MessageSquare, group: "工作台" },
  { id: "wardrobe", name: "参考衣橱", icon: Bookmark, group: "我的风格" },
  { id: "preferences", name: "风格偏好", icon: SlidersHorizontal, group: "我的风格" },
] as const;
type Page = typeof pages[number]["id"];
type Notice = { text: string; error?: boolean };
type Photo = { image: string; name: string; source?: string };
const examplePortrait = { image: "/studio/portrait.jpg", name: "示例人像" };
const prompts = ["设计一件苔绿色亚麻短外套", "设计一件米白色通勤衬衫", "设计一条深蓝色复古连衣裙"];

function UploadZone({ name, photo, icon, onPick, onClear }: {
  name: string; photo: Photo | null; icon: ReactNode;
  onPick: (file: File) => void; onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <div className={`drop-zone ${photo ? "has-photo" : ""} ${dragging ? "dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false);
        const file = event.dataTransfer.files[0];
        if (file) onPick(file);
      }}>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onPick(file);
          event.target.value = "";
        }} />
      <button type="button" className="drop-target" onClick={() => input.current?.click()} aria-label={photo ? `更换${name}` : `上传${name}`}>
        {photo ? <img src={photo.image} alt={photo.name} /> :
          <><span className="upload-icon">{icon}</span><strong>点击或拖入图片</strong><small>JPG、PNG、WebP · 最大 12 MB</small></>}
      </button>
      {photo && <button className="photo-clear icon-button" type="button" onClick={onClear} aria-label={`移除${name}`}><X size={15} /></button>}
    </div>
  );
}

export default function Studio() {
  const [page, setPage] = useState<Page>("try-on");
  const [data, setData] = useState<StudioData>(initialData);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [capabilities, setCapabilities] = useState<{ design: boolean; tryOn: boolean; live: boolean } | null>(null);
  const [person, setPerson] = useState<Photo | null>(null);
  const [garment, setGarment] = useState<Photo | null>(null);
  const [result, setResult] = useState<{ image: string; demo: boolean } | null>(null);
  const [running, setRunning] = useState(false);
  const [tryError, setTryError] = useState("");
  const [designing, setDesigning] = useState(false);
  const [designError, setDesignError] = useState("");
  const [draft, setDraft] = useState("");
  const [referenceIds, setReferenceIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [preferenceDraft, setPreferenceDraft] = useState("");
  const [picker, setPicker] = useState<"reference" | "try-on" | "live" | null>(null);
  const [editor, setEditor] = useState<Garment | null>(null);
  const [help, setHelp] = useState(false);
  const [tryPanel, setTryPanel] = useState<"result" | "compare">("result");
  const wardrobeUpload = useRef<HTMLInputElement>(null);
  const chatTail = useRef<HTMLDivElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);

  const selected = data.versions.find((item) => item.id === data.selectedId);
  const references = referenceIds.map((id) => data.wardrobe.find((item) => item.id === id)).filter((item): item is Garment => Boolean(item));
  const savedItems = [...new Map([...data.versions, ...data.wardrobe, example].map((item) => [item.id, item])).values()];

  useEffect(() => {
    const followHash = () => {
      const id = window.location.hash.slice(1);
      setPage(pages.find((item) => item.id === id)?.id || "try-on");
    };
    followHash();
    window.addEventListener("hashchange", followHash);
    localStudio("load").then((saved) => {
      if (!saved) return;
      setData(saved);
      setPreferenceDraft(saved.preference);
    }).catch(() => setNotice({ text: "无法读取浏览器里的作品。", error: true })).finally(() => setLoaded(true));
    api<{ design: boolean; tryOn: boolean; live: boolean }>("status").then(setCapabilities).catch(() => {});
    return () => window.removeEventListener("hashchange", followHash);
  }, []);

  useEffect(() => {
    if (loaded) localStudio("save", data).catch(() => setNotice({ text: "本次修改未能保存到浏览器。", error: true }));
  }, [data, loaded]);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (page === "design") chatTail.current?.scrollIntoView({ block: "nearest" });
  }, [data.messages, designing, page]);

  function navigate(next: Page) {
    setPage(next);
    window.location.hash = next;
    window.scrollTo(0, 0);
  }

  function clearResult() { setResult(null); setTryError(""); setTryPanel("result"); }

  async function setPhoto(kind: "person" | "garment", file: File) {
    if (running) return;
    try {
      const image = await readImage(file);
      (kind === "person" ? setPerson : setGarment)({ image, name: file.name });
      clearResult();
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    }
  }

  function useGarment(item: Garment, destination: "try-on" | "live" = "try-on") {
    if (running) return;
    setGarment({ image: item.image, name: item.name, source: item.id });
    clearResult();
    setPicker(null);
    navigate(destination);
  }

  function useExample() {
    setPerson(examplePortrait);
    setGarment({ ...example, source: example.id });
    setTryError("");
    setResult(null);
    setTryPanel("result");
  }

  async function startTryOn() {
    if (!person || !garment || running) return;
    setTryError("");
    if (person.image === examplePortrait.image && garment.image === example.image) {
      setResult({ image: "/studio/fitting.jpg", demo: true });
      return;
    }
    setRunning(true);
    setResult(null);
    try {
      const job = await api<{ token: string }>("try-on", {
        person: await imageData(person.image),
        garment: await imageData(garment.image),
      });
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1800));
        const status = await api<{ image?: string }>("try-on/status", { token: job.token });
        if (status.image) {
          setResult({ image: status.image, demo: false });
          return;
        }
      }
      throw new Error("试穿等待超时，请稍后再试。");
    } catch (error) {
      setTryError((error as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function sendDesign(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || designing || !loaded) return;
    setDesignError("");
    setDesigning(true);
    setDraft("");
    const messages = [...data.messages, { role: "user" as const, text }];
    setData((current) => ({ ...current, messages }));
    try {
      const answer = await api<{ text: string; image?: string; name?: string }>("design", {
        messages: messages.slice(-12).map(({ role, text: content }) => ({ role, content })),
        preference: data.preference,
        selected: selected ? { name: selected.name, image: await imageData(selected.image) } : undefined,
        references: await Promise.all(references.map(async ({ name, note, tags, image }) => ({
          name, note, tags, image: await imageData(image),
        }))),
      });
      const version = answer.image ? {
        id: crypto.randomUUID(), name: answer.name || "服装设计",
        image: answer.image, tags: "", note: "", parentId: selected?.id,
      } : undefined;
      setData((current) => ({
        ...current,
        versions: version ? [...current.versions, version] : current.versions,
        selectedId: version?.id ?? current.selectedId,
        messages: [...current.messages, { role: "assistant", text: answer.text, versionId: version?.id }],
      }));
    } catch (error) {
      setData((current) => ({ ...current, messages: current.messages.slice(0, -1) }));
      setDraft((current) => current || text);
      setDesignError((error as Error).message);
    } finally {
      setDesigning(false);
    }
  }

  function chooseVersion(id: string | null) {
    setData((current) => ({ ...current, selectedId: id }));
  }

  function addReference(item: Garment) {
    setReferenceIds((current) => current.includes(item.id) ? current : [...current, item.id].slice(-3));
    setPicker(null);
    navigate("design");
  }

  async function uploadReference(file: File) {
    try {
      const image = await readImage(file);
      setEditor({ id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, ""), image, tags: "", note: "" });
    } catch (error) {
      setNotice({ text: (error as Error).message, error: true });
    }
  }

  function saveReference(event: FormEvent) {
    event.preventDefault();
    if (!editor || !loaded) return;
    const item = { ...editor, name: editor.name.trim() };
    if (!item.name) return;
    setData((current) => ({
      ...current, wardrobe: current.wardrobe.some(({ id }) => id === item.id)
        ? current.wardrobe.map((entry) => entry.id === item.id ? item : entry)
        : [item, ...current.wardrobe],
    }));
    setEditor(null);
    setNotice({ text: "已保存到参考衣橱" });
  }

  const active = pages.find((item) => item.id === page)!;
  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a href="#try-on" className="brand" onClick={() => navigate("try-on")} aria-label="衣样首页">
          <span className="brand-mark"><ScanLine size={25} strokeWidth={1.5} /></span>
          <span><strong>衣样</strong><small>YIYANG STUDIO</small></span>
        </a>
        <nav aria-label="工作台导航">
          {["工作台", "我的风格"].map((group) => <div className="nav-group" key={group}>
            <p>{group}</p>
            {pages.filter((item) => item.group === group).map(({ id, name, icon: Icon }) =>
              <a className={page === id ? "nav-active" : ""} key={id} href={`#${id}`}
                onClick={() => navigate(id)} aria-current={page === id ? "page" : undefined}>
                <Icon size={18} strokeWidth={1.65} /><span>{name}</span>
                {page === id && <span className="nav-dot" />}
              </a>)}
          </div>)}
        </nav>
        <div className="sidebar-bottom"><button onClick={() => setHelp(true)}><CircleHelp size={17} /> 使用说明</button></div>
      </aside>

      <main className="main">
        <header className="topbar">
          <span className="breadcrumb">衣样工作室 <ChevronRight size={13} /><strong>{active.name}</strong></span>
          <button className="top-help icon-button" onClick={() => setHelp(true)} aria-label="使用说明"><CircleHelp size={19} /></button>
          <span className="profile-icon" title="本机工作区"><UserRound size={16} /></span>
        </header>
        <div className="workspace">
          {page === "try-on" && <>
            <section className="hero" aria-labelledby="try-heading">
              <div className="hero-copy">
                <span className="hero-label"><Sparkles size={13} /> AI 虚拟试衣</span>
                <h1 id="try-heading">先试穿，再决定。</h1>
                <p>打开摄像头实时试衣，或上传照片生成试穿效果。</p>
                <div className="hero-actions"><button className="primary" onClick={() => navigate("live")}><Video size={16} /> 摄像头试穿</button><button disabled={running} className="hero-button" onClick={useExample}>使用示例照片 <ArrowUpRight size={16} /></button></div>
              </div>
              <div className="hero-art">
                <img src="/studio/fitting.jpg" alt="苔绿色亚麻外套试穿示例" />
                <div className="hero-garment"><img src="/studio/jacket.jpg" alt="苔绿色亚麻外套平铺图" /></div>
              </div>
            </section>

            <section className="fitting" aria-label="试穿工作台">
              <div className="section-head"><h2>试穿工作台</h2><button className="text-button" onClick={() => navigate("design")}><Sparkles size={15} /> 设计一件新衣服 <ArrowRight size={14} /></button></div>
              <div className="fitting-grid">
                <article className="panel" inert={running}>
                  <div className="panel-head"><span className="panel-icon"><UserRound size={17} /></span><div><h3>人像照片</h3><p>选一张光线清晰的正面照片</p></div></div>
                  <UploadZone name="人像照片" photo={person} icon={<Upload size={22} />} onPick={(file) => setPhoto("person", file)} onClear={() => { setPerson(null); clearResult(); }} />
                </article>
                <article className="panel" inert={running}>
                  <div className="panel-head"><span className="panel-icon"><Shirt size={17} /></span><div><h3>服装图片</h3><p>上传服装图，或选用已保存的款式</p></div></div>
                  <UploadZone name="服装图片" photo={garment} icon={<ImagePlus size={22} />} onPick={(file) => setPhoto("garment", file)} onClear={() => { setGarment(null); clearResult(); }} />
                  <button className="panel-link" onClick={() => setPicker("try-on")}><Layers3 size={15} /> 从作品中选择 <ChevronRight size={14} /></button>
                </article>
                <article className="panel result-panel">
                  <div className="panel-head"><span className="panel-icon"><Sparkles size={17} /></span><div><h3>试穿预览</h3><p>{result?.demo ? "示例效果图" : "AI 生成效果"}</p></div></div>
                  {result ? <div className={`output ${tryPanel === "compare" ? "compare" : ""}`}>
                    {tryPanel === "compare" && <figure><img src={person?.image} alt="原始人像" /><figcaption>原始照片</figcaption></figure>}
                    <figure><img src={result.image} alt="试穿后的效果" /><figcaption>{result.demo ? "示例效果" : "试穿效果"}</figcaption></figure>
                  </div> : <div className="result-empty" aria-live="polite">
                    {running ? <><LoaderCircle className="spin" size={25} /><strong>正在生成试穿效果</strong><small>你可以稍等片刻</small></>
                      : <><Images size={28} strokeWidth={1.25} /><strong>试穿效果将显示在这里</strong><small>{person && garment ? "点击下方按钮开始试穿" : "准备好人像和服装后即可试穿"}</small></>}
                  </div>}
                  {result && <div className="result-actions">
                    <button className="text-button" onClick={() => setTryPanel(tryPanel === "compare" ? "result" : "compare")}>{tryPanel === "compare" ? "仅看结果" : "对比原图"}</button>
                    <button className="text-button" onClick={() => downloadImage(result.image)}><ArrowDownToLine size={15} /> 下载</button>
                  </div>}
                </article>
              </div>
              {tryError && <p className="inline-error" role="alert">{tryError}</p>}
              <div className="fitting-footer"><p>{person && garment && (person.image !== examplePortrait.image || garment.image !== example.image) ? "开始试穿后，照片将发送至 FASHN 处理。" : "照片试穿效果仅供造型参考。"}</p>
                {result && garment?.source && data.versions.some(({ id }) => id === garment.source) && <button className="secondary" onClick={() => { chooseVersion(garment.source!); navigate("design"); }}><ArrowLeft size={16} /> 返回改款</button>}
                <button className="primary" onClick={startTryOn} disabled={!person || !garment || running}>{running ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />} {running ? "正在试穿" : "开始试穿"}</button>
              </div>
            </section>
          </>}

          {page === "live" && <LiveFitting garment={garment} configured={capabilities?.live}>
            <div className="panel-head"><span className="panel-icon"><Shirt size={17} /></span><div><h3>试穿服装</h3><p>{garment?.name ?? "上传或选一件衣服"}</p></div></div>
            <UploadZone name="服装图片" photo={garment} icon={<ImagePlus size={22} />} onPick={(file) => setPhoto("garment", file)} onClear={() => { setGarment(null); clearResult(); }} />
            <button className="panel-link" onClick={() => setPicker("live")}><Layers3 size={15} /> 从作品或衣橱选择 <ChevronRight size={14} /></button>
            <button className="secondary live-example" disabled={running} onClick={() => useGarment(example, "live")}><Shirt size={16} /> 选用示例外套</button>
          </LiveFitting>}

          {page === "design" && <>
            <div className="page-head"><div><h1>对话设计</h1><p>描述你想要的衣服，或在已有款式上继续改。</p></div><button className="secondary" disabled={designing || !selected} onClick={() => { chooseVersion(null); promptInput.current?.focus(); }}><Plus size={17} /> 设计新款</button></div>
            <div className="design-grid">
              <section className="panel chat">
                <div className="chat-head"><span className="panel-icon"><MessageSquare size={17} /></span><strong>设计对话</strong></div>
                <div className="chat-scroll" aria-live="polite">
                  {data.messages.length === 0 && <div className="chat-welcome"><span className="upload-icon"><Sparkles size={22} /></span><h2>想设计什么样的衣服？</h2><div className="suggestions">{prompts.map((value) => <button key={value} onClick={() => { setDraft(value); promptInput.current?.focus(); }}>{value}<ArrowUpRight size={14} /></button>)}</div></div>}
                  {data.messages.map((message, index) => <div key={index} className={`message ${message.role}`}>
                    <div>{message.text}</div>
                    {message.versionId && <button className="text-button" onClick={() => chooseVersion(message.versionId!)}>查看这一版 <ArrowRight size={14} /></button>}
                  </div>)}
                  {designing && <div className="message assistant"><LoaderCircle size={16} className="spin" /> 正在处理设计请求</div>}
                  <div ref={chatTail} />
                </div>
                <form className="composer" onSubmit={sendDesign}>
                  {selected && <div className="current-version"><Shirt size={14} /> 当前款式 · {selected.name}</div>}
                  <div className="reference-row">
                    <button type="button" className="secondary small" onClick={() => setPicker("reference")}><Plus size={14} /> 引用参考</button>
                    {references.map((item) => <button key={item.id} className="chip" type="button" onClick={() => setReferenceIds((ids) => ids.filter((id) => id !== item.id))} aria-label={`移除参考 ${item.name}`}>{item.name}<X size={13} /></button>)}
                  </div>
                  <label className="sr-only" htmlFor="prompt">设计要求</label>
                  <div className="compose-input"><textarea id="prompt" ref={promptInput} value={draft} onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
                    maxLength={1200} placeholder="例如，把领口改成翻领…" rows={2} />
                    <button className="primary" disabled={!draft.trim() || designing || !loaded} aria-label="发送消息"><Send size={17} /> 发送</button></div>
                  {designError && <p className="inline-error" role="alert">{designError}</p>}
                </form>
              </section>
              <section className="panel design-preview">
                <div className="panel-head"><span className="panel-icon"><Shirt size={17} /></span><div><h3>服装预览</h3><p>{selected?.name ?? "生成后可以切换和对比不同版本"}</p></div></div>
                {selected ? <><img className="design-image" src={selected.image} alt={selected.name} /><div className="preview-actions"><button className="primary" onClick={() => useGarment(selected)} disabled={running}><Sparkles size={16} /> 照片试穿</button><button className="secondary" disabled={running} onClick={() => useGarment(selected, "live")}><Video size={16} /> 实时试穿</button><button className="secondary" onClick={() => setEditor(data.wardrobe.find(({ id }) => id === selected.id) ?? selected)}><Bookmark size={16} /> 加入衣橱</button></div></> :
                  <div className="result-empty design-empty"><Images size={34} strokeWidth={1.2} /><strong>{designing ? "等待设计结果" : "还没有选中的服装"}</strong><small>从一次对话开始，或选择已有版本</small></div>}
                {data.versions.length > 0 && <div className="versions" aria-label="服装版本">
                  {data.versions.map((item, index) => <button type="button" key={item.id} className={item.id === selected?.id ? "selected" : ""} aria-pressed={item.id === selected?.id} onClick={() => chooseVersion(item.id)}>
                    <img src={item.image} alt={item.name} /><span>版本 {index + 1}</span>
                  </button>)}
                </div>}
              </section>
            </div>
          </>}

          {page === "wardrobe" && <>
            <div className="page-head"><div><h1>参考衣橱</h1><p>收藏喜欢的款式，注明想参考的配色、材质或版型。</p></div>
              <button className="primary" onClick={() => wardrobeUpload.current?.click()}><Upload size={16} /> 上传参考图</button>
              <input ref={wardrobeUpload} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadReference(file); event.target.value = ""; }} /></div>
            <label className="search"><Search size={18} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、标签或备注" /></label>
            <div className="wardrobe-grid">
              {data.wardrobe.filter((item) => `${item.name} ${item.tags} ${item.note}`.toLowerCase().includes(query.trim().toLowerCase())).map((item) => <article className="panel garment-tile" key={item.id}>
                <img src={item.image} alt={item.name} /><h3>{item.name}</h3><p>{item.tags}</p>{item.note && <p className="reference-note">{item.note}</p>}
                <div className="tile-actions"><button className="secondary small" onClick={() => addReference(item)}>引用到对话 <ArrowRight size={14} /></button><button className="text-button" onClick={() => setEditor(item)}>编辑</button></div>
              </article>)}
              {!query.trim() && !data.wardrobe.some(({ id }) => id === example.id) && <article className="panel garment-tile">
                <img src={example.image} alt={example.name} /><h3>{example.name}</h3><p>示例参考 · 亚麻 · 外套</p><div className="tile-actions"><button className="secondary small" onClick={() => setEditor(example)}><Bookmark size={14} /> 加入衣橱</button><button className="text-button" disabled={running} onClick={() => useGarment(example)}>试穿</button></div>
              </article>}
              {query.trim() && !data.wardrobe.some((item) => `${item.name} ${item.tags} ${item.note}`.toLowerCase().includes(query.trim().toLowerCase())) && <p className="muted">没有找到匹配的参考图。</p>}
            </div>
          </>}

          {page === "preferences" && <>
            <div className="page-head"><div><h1>风格偏好</h1><p>记录你想长期沿用的审美。每次对话里的具体要求优先。</p></div></div>
            <form className="panel preferences" onSubmit={(event) => {
              event.preventDefault();
              setData((current) => ({ ...current, preference: preferenceDraft.trim() }));
              setNotice({ text: "风格偏好已保存" });
            }}>
              <label htmlFor="preferences">你的长期风格偏好</label>
              <textarea id="preferences" value={preferenceDraft} onChange={(event) => setPreferenceDraft(event.target.value)} rows={7} maxLength={1000} placeholder="例如，我喜欢低饱和配色、亚麻和宽松版型，尽量避免大 Logo。" />
              <p>偏好保存在当前浏览器，并会随设计对话一起发送。</p>
              <button className="primary" disabled={!loaded}><Check size={17} /> 保存偏好</button>
            </form>
          </>}
        </div>
      </main>

      {picker && <Modal title={picker === "reference" ? "选择参考图" : "选择一件衣服"} onClose={() => setPicker(null)}>
        {picker === "reference" && data.wardrobe.length === 0 && <div className="modal-empty"><p>先把喜欢的服装加入参考衣橱。</p><button className="secondary" onClick={() => { setPicker(null); navigate("wardrobe"); }}>打开参考衣橱 <ArrowRight size={15} /></button></div>}
        <div className="picker-grid">{(picker === "reference" ? data.wardrobe : savedItems).map((item) => <button className="picker-item" key={item.id} onClick={() => picker === "reference" ? addReference(item) : useGarment(item, picker)}><img src={item.image} alt="" /><strong>{item.name}</strong>{item.note && <small>{item.note}</small>}</button>)}</div>
      </Modal>}
      {editor && <Modal title="保存参考服装" onClose={() => setEditor(null)}>
        <form className="reference-editor" onSubmit={saveReference}>
          <img src={editor.image} alt="待保存的参考服装" />
          <label>服装名称<input required maxLength={64} value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></label>
          <label>标签<input maxLength={160} value={editor.tags} onChange={(event) => setEditor({ ...editor, tags: event.target.value })} placeholder="例如，通勤、亚麻、宽松" /></label>
          <label>想参考的细节<textarea maxLength={400} rows={3} value={editor.note} onChange={(event) => setEditor({ ...editor, note: event.target.value })} placeholder="例如，只参考面料纹理和翻领" /></label>
          <div className="modal-actions">
            {data.wardrobe.some(({ id }) => id === editor.id) && <button className="text-button danger" type="button" onClick={() => {
              setData((current) => ({ ...current, wardrobe: current.wardrobe.filter(({ id }) => id !== editor.id) }));
              setReferenceIds((ids) => ids.filter((id) => id !== editor.id)); setEditor(null);
              setNotice({ text: "已从参考衣橱移除" });
            }}>从衣橱移除</button>}
            <button className="primary" disabled={!editor.name.trim() || !loaded}>保存参考</button>
          </div>
        </form>
      </Modal>}
      {help && <Modal title="使用说明" onClose={() => setHelp(false)}>
        <div className="help-copy"><p><strong>实时试穿</strong>开启摄像头预览，选好服装后开始实时试穿。关闭摄像头或离开页面就会停止。</p><p><strong>照片试穿</strong>上传本人或已获授权的人像，再选择一件服装。也可以用示例照片体验对比和下载。</p><p><strong>对话设计</strong>用中文描述款式，生成后选中任意版本继续改，或直接把该款式送去试穿。</p><p><strong>参考衣橱</strong>保存喜欢的服装，注明想参考的细节，再从对话里引用。设计、收藏和偏好保存在当前浏览器。</p>{capabilities && (!capabilities.design || !capabilities.tryOn) && <p className="muted">当前可用服务 · 对话设计 {capabilities.design ? "已配置" : "待配置"} · 照片试穿 {capabilities.tryOn ? "已配置" : "待配置"}</p>}</div>
      </Modal>}
      {notice && <div className={`toast ${notice.error ? "toast-error" : ""}`} role="status">{notice.error ? <CircleHelp size={18} /> : <Check size={18} />}{notice.text}</div>}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return <dialog className="modal" ref={dialog} aria-labelledby="modal-title"
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal-inner"><header><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={20} /></button></header>{children}</div>
  </dialog>;
}
