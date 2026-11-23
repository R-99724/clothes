import { useCallback, useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, LogOut, ScanLine, ShieldCheck } from "lucide-react";
import Studio from "../app/studio";
import { setStudioAccount } from "../app/provider-settings";

type Account = { id: string; username: string; role: "admin" | "member" };
type AuthState = { user: Account | null; needsSetup: boolean; registrationOpen: boolean };

async function authRequest(action: string, body?: object) {
  const response = await fetch(`/api/auth/${action}`, {
    cache: "no-store",
    ...(body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }),
  });
  const result = await response.json() as AuthState & { error?: string };
  if (!response.ok) throw new Error(result.error || "账号服务暂时不可用。");
  return result;
}

export default function AccountApp() {
  const [state, setState] = useState<AuthState | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [bootstrap, setBootstrap] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const apply = useCallback((next: AuthState) => {
    setStudioAccount(next.user?.id);
    setState(next);
  }, []);

  const refresh = useCallback(() => {
    authRequest("state").then(apply).catch((error) => setNotice(error.message));
  }, [apply]);

  useEffect(() => {
    refresh();
    const receive = (event: StorageEvent) => { if (event.key === "yiyang-auth-changed") refresh(); };
    const expired = () => { setNotice("会话已变更，请确认当前登录账号。"); refresh(); };
    window.addEventListener("storage", receive);
    window.addEventListener("yiyang-session-expired", expired);
    return () => {
      window.removeEventListener("storage", receive);
      window.removeEventListener("yiyang-session-expired", expired);
    };
  }, [refresh]);

  function announce() {
    try { localStorage.setItem("yiyang-auth-changed", crypto.randomUUID()); } catch { /* Account checks still run on API requests. */ }
  }

  const action = state?.needsSetup ? "setup" : state?.registrationOpen && mode === "register" ? "register" : "login";
  const title = action === "setup" ? "设置管理员" : action === "register" ? "注册账号" : "登录衣样";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setNotice("");
    if (action !== "login" && password !== repeat) { setNotice("两次输入的密码不一致。"); return; }
    setBusy(true);
    try {
      apply(await authRequest(action, { username, password, ...(action === "setup" ? { bootstrap } : {}) }));
      setPassword("");
      setRepeat("");
      setBootstrap("");
      announce();
    } catch (error) {
      setNotice((error as Error).message);
      if (action !== "login") refresh();
    } finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    try {
      apply(await authRequest("logout", {}));
      setMode("login");
      setNotice("");
      announce();
    } catch (error) { setNotice((error as Error).message); }
    finally { setBusy(false); }
  }

  if (state?.user) {
    const user = state.user;
    return <Studio admin={user.role==="admin"} key={user.id} accountId={user.id} accountMenu={<div className="account-menu">
      <details>
        <summary>{user.username}{user.role === "admin" && <ShieldCheck size={15} aria-label="管理员" />}</summary>
        <div className="account-dropdown">
          {user.role === "admin" && <button type="button" className="secondary" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const result = await authRequest("registration", { open: !state.registrationOpen });
              setState((current) => current ? { ...current, registrationOpen: result.registrationOpen } : current);
              setNotice("");
            } catch (error) { setNotice((error as Error).message); }
            finally { setBusy(false); }
          }}>{state.registrationOpen ? "关闭新账号注册" : "开放新账号注册"}</button>}
          <button type="button" className="secondary" disabled={busy} onClick={logout}><LogOut size={15} /> 退出登录</button>
          {notice && <p className="inline-error" role="alert">{notice}</p>}
        </div>
      </details>
    </div>} />;
  }

  return <main className="auth-shell">
    <section className="panel auth-card">
      <a className="auth-brand" href="/"><ScanLine size={22} /> 衣样 <span>YIYANG STUDIO</span></a>
      {state ? <>
        <h1>{title}</h1>
        <p className="muted">{action === "setup" ? "首次启动时创建管理员。初始化口令由启动终端提供。"
          : action === "register" ? "创建账号后即可使用个人工作区。" : "登录后继续设计和试穿。"}</p>
        <form className="auth-form" onSubmit={submit}>
          {action === "setup" && <label>初始化口令<input type="password" value={bootstrap} onChange={(e) => setBootstrap(e.target.value)}
            autoComplete="off" maxLength={256} required /></label>}
          <label>用户名<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username"
            autoCapitalize="off" spellCheck={false} minLength={3} maxLength={32} required /></label>
          <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={128}
            minLength={action === "login" ? 1 : 12} autoComplete={action === "login" ? "current-password" : "new-password"} required /></label>
          {action !== "login" && <label>确认密码<input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)}
            minLength={12} maxLength={128} autoComplete="new-password" required /></label>}
          {notice && <p className="inline-error" role="alert">{notice}</p>}
          <button className="primary" disabled={busy}>{busy && <LoaderCircle size={17} className="spin" />}{title}</button>
        </form>
        {!state.needsSetup && (state.registrationOpen || mode === "register") &&
          <button className="text-button" onClick={() => { setMode(action === "register" ? "login" : "register"); setNotice(""); setPassword(""); setRepeat(""); }}>
            {action === "register" ? "已有账号，返回登录" : "创建账号"}</button>}
      </> : <><p role="status">{notice || "正在连接账号服务…"}</p>{notice && <button className="secondary" onClick={refresh}>重试</button>}</>}
    </section>
  </main>;
}
